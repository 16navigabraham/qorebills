import crypto from "node:crypto";
import { formatUnits, parseUnits } from "viem";
import { ContractRefusal } from "./chain.js";
import { defaultRef, parseCommand, resolveBiller } from "./parse.js";

export const HELP = [
  "QoreBills pays your bills from your smart account, inside the limits you set on chain.",
  "",
  "pay 15 fUSD to IBEDC electricity — pay a bill (add “ref INV-123” for the bill's own reference)",
  "status — limits, balances and what is left today",
  "billers — who I am allowed to pay",
  "history — recent payments",
  "cancel — drop the approval waiting for your signature",
  "",
  "Above your auto-pay limit I ask for your approval, signed in QoreX with your post-quantum key.",
].join("\n");

/** Turn a contract refusal into a sentence for the owner. */
export function explainRefusal(error, fmt) {
  const [a, b] = error.args || [];
  switch (error.errorName) {
    case "NotAgent":
      return "This account does not accept my key as its agent. Set it with setAgent.";
    case "AgentExpired":
      return "My permission to pay has expired. Renew it with setAgent.";
    case "AccountPaused":
      return "The account is paused, so I cannot pay anything.";
    case "BillerNotAllowed":
      return "That biller is not on your allowlist.";
    case "TokenNotEnabled":
      return "That token is not enabled for payments.";
    case "ZeroAmount":
      return "The amount must be more than zero.";
    case "RefAlreadyPaid":
      return "That bill reference has already been paid. Add a different “ref …” if this is a new bill.";
    case "AboveMaxPerPayment":
      return `That is above the most I can pay at once (${fmt(b)}), even with your approval.`;
    case "NeedsOwnerApproval":
      return `That is above your auto-pay limit (${fmt(b)}), so it needs your approval.`;
    case "DailyCapExceeded":
      return `That would take today's spending to ${fmt(a)}, above the daily cap of ${fmt(b)}.`;
    case "DailyPaymentCountExceeded":
      return `I have already made the ${a} payments allowed today.`;
    case "ApprovalExpired":
      return "The approval expired before it was used. Ask me again.";
    case "OwnerPqcKeyMissing":
      return "Your account has no post-quantum key registered with proof of possession, so approvals cannot be checked.";
    case "InvalidOwnerSignature":
      return "The signature did not verify against your registered post-quantum key. Make sure you signed with the account that owns this smart account.";
    case "NativeTransferFailed":
      return "The biller's address refused the QOR transfer.";
    default:
      return `The contract refused the payment (${error.errorName}).`;
  }
}

/** Read the ML-DSA-87 part of a QoreX signArbitrary result (message signing v1). */
export function pqSignatureBytes(signature) {
  const sig = typeof signature === "string" ? JSON.parse(signature) : signature;
  const b64 = sig?.pq?.signature;
  if (sig?.pq?.algorithmId !== undefined && Number(sig.pq.algorithmId) !== 1) throw new Error("Not an ML-DSA-87 signature.");
  if (typeof b64 !== "string" || !b64) throw new Error("No post-quantum signature in the wallet's answer.");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function createAgent({
  chain,
  tokens,
  cosmosChainId,
  publicUrl,
  approvalMinutes = 30,
  parseWithLlm = null,
  notify = async () => {},
  now = () => Date.now(),
  log = console,
}) {
  const defaultToken = tokens.find((t) => t.symbol === "fUSD") || tokens[0];
  const tokenBySymbol = (s) => tokens.find((t) => t.symbol.toLowerCase() === String(s).toLowerCase());
  const tokenByAddress = (a) => tokens.find((t) => t.address.toLowerCase() === String(a).toLowerCase());
  const fmtToken = (token) => (v) => `${formatUnits(BigInt(v), token.decimals)} ${token.symbol}`;
  const approvals = new Map();
  let pendingId = null;

  async function parse(text) {
    const parsed = parseCommand(text, tokens);
    if (parsed.kind !== "unknown" || !parseWithLlm) return parsed;
    try {
      return await parseWithLlm(text, { billers: await chain.billers(), tokens });
    } catch (error) {
      log.warn?.("[agent] LLM parse failed:", error.message);
      return { kind: "unknown" };
    }
  }

  async function status() {
    const s = await chain.snapshot();
    const expiry = new Date(Number(s.agentExpiry) * 1000).toISOString().replace("T", " ").slice(0, 16);
    const lines = [
      `Smart account ${chain.accountAddress}`,
      s.paused ? "PAUSED: I cannot pay anything." : `I can pay until ${expiry} UTC.`,
      `Payments today: ${s.paymentsToday} of ${s.maxPaymentsPerDay}`,
    ];
    for (const t of s.tokens) {
      const f = fmtToken(t);
      lines.push(
        "",
        t.enabled ? `${t.symbol}: balance ${f(t.balance)}` : `${t.symbol}: not enabled`,
        ...(t.enabled
          ? [`  auto-pay up to ${f(t.autoPayLimit)}, at most ${f(t.maxPerPayment)} per bill`, `  left today ${f(t.remainingToday)} of ${f(t.dailyCap)}`]
          : []),
      );
    }
    return { text: lines.join("\n") };
  }

  async function billers() {
    const list = (await chain.billers()).filter((b) => b.allowed);
    if (!list.length) return { text: "No billers are allowlisted yet. Add one with setBiller." };
    return { text: ["I can pay:", ...list.map((b) => `• ${b.name} (${b.address})`)].join("\n") };
  }

  async function history() {
    const [payments, list] = await Promise.all([chain.recentPayments(), chain.billers()]);
    if (!payments.length) return { text: "No payments in the recent blocks." };
    const name = (a) => list.find((b) => b.address.toLowerCase() === a.toLowerCase())?.name || a;
    const lines = payments.slice(-10).reverse().map((p) => {
      const token = tokenByAddress(p.token);
      const amount = token ? fmtToken(token)(p.amount) : `${p.amount} (token ${p.token})`;
      return `• ${amount} to ${name(p.biller)}${p.ownerApproved ? " (approved by you)" : ""}\n  tx ${p.hash}`;
    });
    return { text: ["Recent payments:", ...lines].join("\n") };
  }

  function cancel() {
    const pending = pendingId && approvals.get(pendingId);
    if (!pending || pending.status !== "pending") return { text: "Nothing is waiting for your approval." };
    pending.status = "cancelled";
    pendingId = null;
    return { text: "Cancelled. That approval link no longer works." };
  }

  async function payRequest(cmd) {
    const token = cmd.token ? tokenBySymbol(cmd.token) : defaultToken;
    if (!token) return { text: `I don't know the token ${cmd.token}. I know ${tokens.map((t) => t.symbol).join(", ")}.` };
    let amount;
    try {
      amount = parseUnits(cmd.amount, token.decimals);
    } catch {
      return { text: `“${cmd.amount}” is not a valid ${token.symbol} amount.` };
    }
    const f = fmtToken(token);
    const found = resolveBiller(cmd.billerQuery, await chain.billers());
    if (found.candidates) return { text: `Which one: ${found.candidates.map((b) => b.name).join(", ")}?` };
    if (!found.biller) return { text: `“${cmd.billerQuery}” is not on your allowlist. Send “billers” to see who I can pay.` };
    const biller = found.biller;
    const ref = (cmd.ref || defaultRef(biller.name, new Date(now()))).slice(0, 100);

    // Check the limits first so the owner gets a clear answer; the contract checks them again.
    const [state, paid] = await Promise.all([chain.tokenState(token), chain.refPaid(ref)]);
    const refuse = (errorName, args) => ({ text: explainRefusal(new ContractRefusal(errorName, args), f) });
    if (!state.enabled) return refuse("TokenNotEnabled");
    if (amount === 0n) return refuse("ZeroAmount");
    if (paid) return { text: `Bill “${ref}” to ${biller.name} is already paid. Add “ref …” with the new bill's reference to pay another one.` };
    if (amount > state.maxPerPayment) return refuse("AboveMaxPerPayment", [amount, state.maxPerPayment]);
    if (amount > state.remainingToday) return { text: `That is more than is left of today's cap: ${f(state.remainingToday)} of ${f(state.dailyCap)}.` };
    if (amount > state.balance) return { text: `The account holds only ${f(state.balance)}.` };

    if (amount <= state.autoPayLimit) {
      try {
        const { hash } = await chain.pay({ biller: biller.address, token: token.address, amount, ref });
        return { text: `Paid ${f(amount)} to ${biller.name} (ref ${ref}).\ntx ${hash}` };
      } catch (error) {
        if (error instanceof ContractRefusal) return { text: explainRefusal(error, f) };
        throw error;
      }
    }
    return requestApproval({ biller, token, amount, ref, f, autoPayLimit: state.autoPayLimit });
  }

  async function requestApproval({ biller, token, amount, ref, f, autoPayLimit }) {
    const nonce = await chain.approvalNonce();
    const deadline = Math.floor(now() / 1000) + approvalMinutes * 60;
    const message = await chain.approvalMessage({ biller: biller.address, token: token.address, amount, ref, deadline, nonce });
    if (pendingId && approvals.get(pendingId)?.status === "pending") approvals.get(pendingId).status = "replaced";
    const id = crypto.randomBytes(16).toString("hex");
    approvals.set(id, { id, biller, token, amount, ref, deadline, nonce, message, status: "pending", summary: `${f(amount)} to ${biller.name} (ref ${ref})` });
    pendingId = id;
    return {
      text: [
        `${f(amount)} to ${biller.name} is above your auto-pay limit of ${f(autoPayLimit)}.`,
        `Approve it within ${approvalMinutes} minutes by signing in QoreX with your post-quantum key. Open the link in the QoreX app's browser:`,
      ].join("\n"),
      link: { label: "Approve in QoreX", url: `${publicUrl}/approve/${id}` },
    };
  }

  /** The approval as the signing page shows it. */
  function getApproval(id) {
    const a = approvals.get(id);
    if (!a) return null;
    const expired = a.status === "pending" && now() / 1000 > a.deadline;
    return {
      status: expired ? "expired" : a.status,
      summary: a.summary,
      message: a.message,
      cosmosChainId,
      expiresAt: a.deadline,
      txHash: a.txHash || null,
      error: a.error || null,
    };
  }

  async function submitApproval(id, signature) {
    const a = approvals.get(id);
    if (!a) return { ok: false, status: 404, error: "Unknown approval." };
    if (a.status !== "pending") return { ok: false, status: 409, error: `This approval is ${a.status}.` };
    if (now() / 1000 > a.deadline) return { ok: false, status: 410, error: "This approval has expired. Ask the bot again." };
    let bytes;
    try {
      bytes = pqSignatureBytes(signature);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if ((await chain.approvalNonce()) !== a.nonce) {
      a.status = "stale";
      return { ok: false, status: 409, error: "Another approval was used first. Ask the bot again." };
    }
    a.status = "submitting";
    const f = fmtToken(a.token);
    try {
      const { hash } = await chain.payWithApproval({
        biller: a.biller.address, token: a.token.address, amount: a.amount, ref: a.ref, deadline: a.deadline, signature: bytes,
      });
      a.status = "paid";
      a.txHash = hash;
      if (pendingId === id) pendingId = null;
      await notify(`Approved and paid: ${a.summary}.\nYour ML-DSA-87 signature was verified on chain.\ntx ${hash}`).catch(() => {});
      return { ok: true, txHash: hash };
    } catch (error) {
      if (!(error instanceof ContractRefusal)) {
        a.status = "pending";
        log.error?.("[agent] payWithApproval failed:", error.shortMessage || error.message);
        return { ok: false, status: 502, error: "The network did not take the payment. Try again in a moment." };
      }
      a.status = error.errorName === "InvalidOwnerSignature" ? "pending" : "failed";
      a.error = explainRefusal(error, f);
      if (a.status === "failed") await notify(`Approval not used: ${a.error}`).catch(() => {});
      return { ok: false, status: 422, error: a.error };
    }
  }

  async function handle(text) {
    const cmd = await parse(text);
    switch (cmd.kind) {
      case "help":
        return { text: HELP };
      case "status":
        return status();
      case "billers":
        return billers();
      case "history":
        return history();
      case "cancel":
        return cancel();
      case "pay":
        return payRequest(cmd);
      case "pay_help":
        return { text: "Say it like: pay 15 fUSD to IBEDC electricity" };
      default:
        return { text: `I didn't understand that.\n\n${HELP}` };
    }
  }

  return { handle, getApproval, submitApproval };
}
