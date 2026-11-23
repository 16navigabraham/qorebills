import crypto from "node:crypto";
import { formatUnits, getAddress, parseUnits, toHex, zeroAddress } from "viem";
import { Kind } from "./abi.js";
import { ContractRefusal } from "./chain.js";
import { defaultRef, parseCommand, resolveBiller } from "./parse.js";
import { describe as describeSchedule, formatUtc, nextRun, occurrenceRef, parseEvery } from "./schedule.js";

export const FAUCET_URL = "https://dashboard.qorechain.io/faucet";
const MAX_SCHEDULES = 10;

export const HELP = [
  "QoreBills pays your bills for you, within limits only you can change.",
  "",
  "💸 Pay",
  "pay 15 fUSD to electricity",
  "pay 0.5 QOR to water ref INV-204",
  "",
  "🔁 Recurring",
  "pay 0.5 QOR to rent every month on the 1st",
  "pay 0.2 QOR to data every week on monday",
  "schedules · stop 1",
  "",
  "📊 Your account",
  "status · fund · billers · history",
  "",
  "🔐 Settings (you approve each one in QoreX)",
  "pause · resume · renew 30 · revoke",
  "add biller Hostel 0x… · remove biller water",
  "limits fUSD 20 100 150 (auto-pay, max per bill, daily cap)",
  "payments per day 5 · withdraw 10 fUSD to 0x…",
  "",
  "Small bills are paid instantly. Anything above your auto-pay limit waits for your approval.",
].join("\n");

/** With Gemini on, people can just say what they want; the commands are the shortcut. */
const PLAIN_LANGUAGE = [
  "Just tell me what to pay, in your own words:",
  "“pay my light bill, 15 dollars”",
  "“send 0.5 QOR for rent every month on the 1st”",
  "“how much can I still spend today?”",
  "",
  "Or use the shortcuts below.",
].join("\n");

const SETTINGS_HELP = "Settings commands look like: add biller Campus hostel 0x…, limits fUSD 20 100 150, payments per day 5, renew 30, withdraw 10 fUSD to 0x…";
const NAME = /^[\x20-\x7e]{1,40}$/;

/** A request the owner sent that cannot be carried out as given. */
export class InputError extends Error {}

/** Turn a contract refusal into a sentence for the owner. */
export function explainRefusal(error, fmt = String) {
  const [a, b] = error.args || [];
  switch (error.errorName) {
    case "NotAgent":
      return "This account does not accept my key as its agent. Send “renew 30” to give me permission again.";
    case "AgentExpired":
      return "My permission to pay has expired. Send “renew 30” to extend it.";
    case "AccountPaused":
      return "The account is paused, so I cannot pay anything. Send “resume” to restart payments.";
    case "BillerNotAllowed":
      return "That biller is not on your allowlist.";
    case "TokenNotEnabled":
      return "That token is not enabled for payments.";
    case "ZeroAmount":
      return "The amount must be more than zero.";
    case "ZeroAddress":
      return "That address is empty.";
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
    case "SignatureExpired":
      return "The signature expired before it was used. Ask me again.";
    case "OwnerPqcKeyMissing":
      return "Your account has no post-quantum key registered with proof of possession, so your signature cannot be checked. Register it in QoreX first.";
    case "InvalidOwnerSignature":
      return "The signature did not verify against your registered post-quantum key. Make sure QoreX is on the account that owns this smart account.";
    case "InvalidLimits":
      return "Limits must go auto-pay ≤ max per bill ≤ daily cap, with a daily cap above zero.";
    case "InvalidName":
      return "Biller names must be 1 to 40 plain characters.";
    case "SetupAlreadyUsed":
      return "That setup was already used. Send “setup” to start a new one.";
    case "TooManyEntries":
      return "Too many billers or tokens for one setup (at most 12 billers and 4 tokens).";
    case "MessageTooLong":
      return "That is too much for one signature. Use fewer billers or shorter names.";
    case "NativeTransferFailed":
      return "The receiving address refused the QOR transfer.";
    default:
      return `The contract refused it (${error.errorName}).`;
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

/**
 * @param addresses { toEvm(qor1OrHex) -> 0x address, toBech32(0x) -> qor1 address }
 * @param factoryAddress shown in help only; the chain module holds the factory.
 */
export function createAgent({
  chain,
  factoryChain = chain, // sends createAccount (the agent's main key pays the gas)
  requests = new Map(), // shared by all users so the web pages can find any request by id
  userId = null,
  canStartSetup = async () => null, // returns a reason to refuse, or null
  tokens,
  demoBillers = [], // [{ name, address }] offered on the setup page
  cosmosChainId,
  publicUrl,
  addresses,
  state,
  requestMinutes = 30,
  parseWithLlm = null,
  notify = async () => {},
  onAccountReady = async () => {},
  now = () => Date.now(),
  log = console,
}) {
  const help = parseWithLlm ? HELP.replace("\n\n", `\n\n${PLAIN_LANGUAGE}\n\n`) : HELP;
  const defaultToken = tokens.find((t) => t.symbol === "fUSD") || tokens[0];
  const tokenBySymbol = (s) => tokens.find((t) => t.symbol.toLowerCase() === String(s).toLowerCase());
  const tokenByAddress = (a) => tokens.find((t) => t.address.toLowerCase() === String(a).toLowerCase());
  const fmtToken = (token) => (v) => `${formatUnits(BigInt(v), token.decimals)} ${token.symbol}`;
  const nowSeconds = () => Math.floor(now() / 1000);
  let pendingId = null; // the one request bound to the account's current nonce

  const saved = state.get();
  if (saved.account && !chain.accountAddress) chain.useAccount(saved.account);

  function amountOf(token, value) {
    if (!/^\d+(\.\d+)?$/.test(String(value))) throw new InputError(`“${value}” is not a valid ${token.symbol} amount.`);
    // parseUnits would round extra decimals away; refuse them so we never pay a different amount.
    if ((String(value).split(".")[1] || "").length > token.decimals) {
      throw new InputError(`“${value}” has too many decimals for ${token.symbol} (at most ${token.decimals}).`);
    }
    return parseUnits(String(value), token.decimals);
  }

  function evmAddress(value) {
    try {
      return getAddress(addresses.toEvm(String(value).trim()));
    } catch {
      throw new InputError(`“${value}” is not a valid 0x or qor1 address.`);
    }
  }

  function newRequest(fields) {
    const id = crypto.randomBytes(16).toString("hex");
    const request = { id, userId, status: "pending", ...fields };
    requests.set(id, request);
    if (request.nonce !== undefined) {
      if (pendingId && requests.get(pendingId)?.status === "pending") requests.get(pendingId).status = "replaced";
      pendingId = id;
    }
    return request;
  }

  async function parse(text) {
    const parsed = parseCommand(text, tokens);
    if (parsed.kind !== "unknown" || !parseWithLlm || !chain.accountAddress) return parsed;
    try {
      return await parseWithLlm(text, { billers: await chain.billers(), tokens });
    } catch (error) {
      log.warn?.("[agent] LLM parse failed:", error.message);
      return { kind: "llm_unavailable" };
    }
  }

  // ---------------------------------------------------------------- setup

  async function startSetup() {
    const refusal = await canStartSetup();
    if (refusal) return { text: refusal };
    const request = newRequest({ kind: "setup", status: "draft", deadline: nowSeconds() + requestMinutes * 60 });
    return {
      text: [
        chain.accountAddress ? "This creates a new account. Your current one keeps its money until you withdraw it." : "Get started in one step:",
        "Open the link in the QoreX browser, pick your billers and limits, and sign once. Setup is free; I cover the gas.",
      ].join("\n"),
      link: { label: "Set up in QoreX", url: `${publicUrl}/setup/${request.id}` },
    };
  }

  /** Check the setup form from the page and turn it into the contract's AccountConfig. */
  function setupConfig(form) {
    const billers = Array.isArray(form?.billers) ? form.billers : [];
    if (!billers.length) throw new InputError("Add at least one biller.");
    if (billers.length > 12) throw new InputError("At most 12 billers.");
    const seen = new Set();
    const billerConfigs = billers.map((b) => {
      const name = String(b?.name || "").trim();
      if (!NAME.test(name)) throw new InputError(`Biller name “${name}” must be 1 to 40 plain characters.`);
      const address = evmAddress(b?.address);
      if (seen.has(address)) throw new InputError(`${name}: that address is listed twice.`);
      seen.add(address);
      return { biller: address, name };
    });
    const tokenConfigs = [];
    for (const token of tokens) {
      const l = form?.limits?.[token.symbol];
      if (!l) continue;
      const [autoPayLimit, maxPerPayment, dailyCap] = [l.autoPay, l.maxPer, l.daily].map((v) => amountOf(token, v));
      if (!(autoPayLimit <= maxPerPayment && maxPerPayment <= dailyCap && dailyCap > 0n)) {
        throw new InputError(`${token.symbol}: limits must go auto-pay ≤ max per bill ≤ daily cap, with a daily cap above zero.`);
      }
      tokenConfigs.push({ token: token.address, autoPayLimit, maxPerPayment, dailyCap });
    }
    if (!tokenConfigs.length) throw new InputError("Enable at least one token.");
    const perDay = Number(form?.paymentsPerDay);
    if (!Number.isInteger(perDay) || perDay < 1 || perDay > 100) throw new InputError("Payments per day must be 1 to 100.");
    const days = Number(form?.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new InputError("The agent's permission must last 1 to 365 days.");
    return {
      agent: chain.agentAddress,
      agentExpiry: BigInt(nowSeconds() + days * 86400),
      maxPaymentsPerDay: perDay,
      tokens: tokenConfigs,
      billers: billerConfigs,
    };
  }

  async function draftSetup(id, { owner, form }) {
    const r = requests.get(id);
    if (!r || r.kind !== "setup") return { ok: false, status: 404, error: "Unknown setup." };
    if (!["draft", "pending"].includes(r.status)) return { ok: false, status: 409, error: `This setup is ${r.status}.` };
    if (nowSeconds() > r.deadline) return { ok: false, status: 410, error: "This setup link has expired. Send “setup” again." };
    try {
      const ownerAddress = evmAddress(owner);
      const config = setupConfig(form);
      const setupId = toHex(crypto.randomBytes(16));
      const message = await factoryChain.setupMessage({ owner: ownerAddress, config, setupId, deadline: r.deadline });
      Object.assign(r, {
        status: "pending",
        owner: ownerAddress,
        ownerBech32: addresses.toBech32(ownerAddress),
        config,
        setupId,
        message,
        summary: `New account: ${config.billers.length} biller(s), ${config.maxPaymentsPerDay} payments a day, agent for ${form.days} days`,
      });
      return { ok: true, message, summary: r.summary };
    } catch (error) {
      if (error instanceof InputError) return { ok: false, status: 400, error: error.message };
      if (error instanceof ContractRefusal) return { ok: false, status: 422, error: explainRefusal(error) };
      throw error;
    }
  }

  // ---------------------------------------------------------------- reading

  function fundText(account) {
    return [
      "To fund it, open QoreX → Send and send QOR to your account's address:",
      addresses.toBech32(account),
      "",
      `(The same account in EVM form: ${account}. Use that only from an EVM wallet.)`,
      "",
      `No test QOR yet? Get some free from the QoreChain faucet: ${FAUCET_URL}`,
    ].join("\n");
  }

  async function status() {
    const s = await chain.snapshot();
    const expiry = new Date(Number(s.agentExpiry) * 1000).toISOString().replace("T", " ").slice(0, 16);
    const lines = [
      `Your account: ${addresses.toBech32(chain.accountAddress)}`,
      `(EVM form ${chain.accountAddress})`,
      s.paused
        ? "PAUSED: I cannot pay anything."
        : s.agent.toLowerCase() !== chain.agentAddress.toLowerCase()
          ? "I am not this account's agent."
          : `I can pay until ${expiry} UTC.`,
      `Payments today: ${s.paymentsToday} of ${s.maxPaymentsPerDay}`,
    ];
    for (const t of s.tokens) {
      const f = fmtToken(t);
      lines.push(
        "",
        t.enabled ? `${t.symbol}: balance ${f(t.balance)}` : `${t.symbol}: not enabled (balance ${f(t.balance)})`,
        ...(t.enabled
          ? [`  auto-pay up to ${f(t.autoPayLimit)}, at most ${f(t.maxPerPayment)} per bill`, `  left today ${f(t.remainingToday)} of ${f(t.dailyCap)}`]
          : []),
      );
    }
    return { text: lines.join("\n") };
  }

  async function billers() {
    const list = (await chain.billers()).filter((b) => b.allowed);
    if (!list.length) return { text: "No billers are allowlisted. Add one with “add biller <name> <address>”." };
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
    const pending = pendingId && requests.get(pendingId);
    if (!pending || pending.status !== "pending") return { text: "Nothing is waiting for your signature." };
    pending.status = "cancelled";
    pendingId = null;
    return { text: "Cancelled. That signing link no longer works." };
  }

  // ---------------------------------------------------------------- paying

  async function payRequest(cmd) {
    const token = cmd.token ? tokenBySymbol(cmd.token) : defaultToken;
    if (!token) return { text: `I don't know the token ${cmd.token}. I know ${tokens.map((t) => t.symbol).join(", ")}.` };
    const amount = amountOf(token, cmd.amount);
    const f = fmtToken(token);
    const found = resolveBiller(cmd.billerQuery, await chain.billers());
    if (found.candidates) return { text: `Which one: ${found.candidates.map((b) => b.name).join(", ")}?` };
    if (!found.biller) return { text: `“${cmd.billerQuery}” is not on your allowlist. Send “billers” to see who I can pay.` };
    const biller = found.biller;
    const ref = (cmd.ref || defaultRef(biller.name, new Date(now()))).slice(0, 100);

    // Check the limits first so the owner gets a clear answer; the contract checks them again.
    const [state_, paid] = await Promise.all([chain.tokenState(token), chain.refPaid(ref)]);
    const refuse = (errorName, args) => ({ text: explainRefusal(new ContractRefusal(errorName, args), f) });
    if (!state_.enabled) return refuse("TokenNotEnabled");
    if (amount === 0n) return refuse("ZeroAmount");
    if (paid) return { text: `Bill “${ref}” to ${biller.name} is already paid. Add “ref …” with the new bill's reference to pay another one.` };
    if (amount > state_.maxPerPayment) return refuse("AboveMaxPerPayment", [amount, state_.maxPerPayment]);
    if (amount > state_.remainingToday) return { text: `That is more than is left of today's cap: ${f(state_.remainingToday)} of ${f(state_.dailyCap)}.` };
    if (amount > state_.balance) return { text: `The account holds only ${f(state_.balance)}.` };

    if (amount <= state_.autoPayLimit) {
      try {
        const { hash } = await chain.pay({ biller: biller.address, token: token.address, amount, ref });
        return { text: `Paid ${f(amount)} to ${biller.name} (ref ${ref}).\ntx ${hash}` };
      } catch (error) {
        if (error instanceof ContractRefusal) return { text: explainRefusal(error, f) };
        throw error;
      }
    }

    const nonce = await chain.nonce();
    const deadline = nowSeconds() + requestMinutes * 60;
    const message = await chain.approvalMessage({ biller: biller.address, token: token.address, amount, ref, deadline, nonce });
    const summary = `${f(amount)} to ${biller.name} (ref ${ref})`;
    const request = newRequest({
      kind: "payment",
      nonce,
      deadline,
      message,
      summary,
      ownerBech32: addresses.toBech32(await chain.owner()),
      fmt: f,
      run: (signature) => chain.payWithApproval({ biller: biller.address, token: token.address, amount, ref, deadline, signature }),
      doneText: `Approved and paid: ${summary}.`,
    });
    return {
      text: [
        `${f(amount)} to ${biller.name} is above your auto-pay limit of ${f(state_.autoPayLimit)}.`,
        `Approve it within ${requestMinutes} minutes by signing in QoreX with your post-quantum key. Open the link in the QoreX app's browser:`,
      ].join("\n"),
      link: { label: "Approve in QoreX", url: `${publicUrl}/approve/${request.id}` },
    };
  }

  // ---------------------------------------------------------------- recurring bills

  const schedules = () => state.get().schedules || [];
  const saveSchedules = (list) => state.set({ schedules: list });
  const scheduleLine = (s) => `#${s.id} ${s.amount} ${s.token} to ${s.billerName}, ${describeSchedule(s.every)} — next ${formatUtc(s.nextRun)}`;

  async function createSchedule(cmd) {
    const parsed = parseEvery(cmd.every);
    if (parsed.error) return { text: parsed.error };
    const active = schedules().filter((s) => s.active);
    if (active.length >= MAX_SCHEDULES) return { text: `You already have ${MAX_SCHEDULES} recurring bills. Stop one first (“schedules” lists them).` };
    const token = cmd.token ? tokenBySymbol(cmd.token) : defaultToken;
    if (!token) return { text: `I don't know the token ${cmd.token}. I know ${tokens.map((t) => t.symbol).join(", ")}.` };
    const amount = amountOf(token, cmd.amount);
    const f = fmtToken(token);
    const found = resolveBiller(cmd.billerQuery, await chain.billers());
    if (found.candidates) return { text: `Which one: ${found.candidates.map((b) => b.name).join(", ")}?` };
    if (!found.biller) return { text: `“${cmd.billerQuery}” is not on your allowlist. Send “billers” to see who I can pay.` };
    const limits = await chain.tokenState(token);
    const refuse = (errorName, args) => ({ text: explainRefusal(new ContractRefusal(errorName, args), f) });
    if (!limits.enabled) return refuse("TokenNotEnabled");
    if (amount === 0n) return refuse("ZeroAmount");
    if (amount > limits.maxPerPayment) return refuse("AboveMaxPerPayment", [amount, limits.maxPerPayment]);

    const created = now();
    const schedule = {
      id: (state.get().nextScheduleId ?? 1),
      amount: cmd.amount,
      token: token.symbol,
      billerAddress: found.biller.address,
      billerName: found.biller.name,
      every: parsed.spec,
      anchor: created,
      nextRun: nextRun(parsed.spec, created, created),
      active: true,
    };
    state.set({ nextScheduleId: schedule.id + 1 });
    // Keep stopped schedules out of the way once there are many.
    saveSchedules([...schedules().filter((s) => s.active).slice(-50), schedule]);
    return {
      text: [
        `Recurring bill #${schedule.id}: ${f(amount)} to ${schedule.billerName}, ${describeSchedule(schedule.every)}.`,
        `First payment: ${formatUtc(schedule.nextRun)}.`,
        amount <= limits.autoPayLimit
          ? "It is within your auto-pay limit, so I pay it myself each time and tell you."
          : `It is above your auto-pay limit of ${f(limits.autoPayLimit)}, so each time I send you an approval link to sign in QoreX.`,
        "Your on-chain daily cap and payments-per-day limit still apply. Send “stop " + schedule.id + "” to stop it.",
      ].join("\n"),
    };
  }

  function listSchedules() {
    const active = schedules().filter((s) => s.active);
    if (!active.length) return { text: "No recurring bills. Add one like: pay 0.5 QOR to electricity every month on the 1st" };
    return { text: ["Recurring bills (UTC):", ...active.map(scheduleLine), "", "Send “stop <number>” to stop one."].join("\n") };
  }

  function stopSchedule(id) {
    const list = schedules();
    const s = list.find((x) => x.id === id && x.active);
    if (!s) return { text: `There is no recurring bill #${id}. Send “schedules” to see them.` };
    saveSchedules(list.map((x) => (x.id === id ? { ...x, active: false } : x)));
    return { text: `Stopped recurring bill #${id} (${s.amount} ${s.token} to ${s.billerName}).` };
  }

  /**
   * Pay every recurring bill that is due. Each occurrence has its own bill reference, so the
   * contract pays it at most once even if this runs twice. After downtime, a missed bill is
   * paid once (not once per missed period) and the schedule moves on.
   * Returns the messages to send the owner.
   */
  async function runDueSchedules() {
    if (!chain.accountAddress) return [];
    const out = [];
    for (const s of schedules()) {
      const t = now();
      if (!s.active || s.nextRun > t) continue;
      const due = s.nextRun;
      // Move the schedule on before paying, so a crash mid-payment cannot repeat it.
      saveSchedules(schedules().map((x) => (x.id === s.id ? { ...x, nextRun: nextRun(s.every, t, s.anchor), lastRun: due } : x)));
      let reply;
      try {
        reply = await payRequest({ amount: s.amount, token: s.token, billerQuery: s.billerAddress, ref: occurrenceRef(s, due) });
      } catch (error) {
        if (error instanceof InputError) reply = { text: error.message };
        else {
          log.error?.(`[agent] recurring bill #${s.id} failed:`, error.shortMessage || error.message);
          reply = { text: "The network did not take it. I will try again at the next due time." };
        }
      }
      out.push({ ...reply, text: `Recurring bill #${s.id} (${describeSchedule(s.every)}):\n${reply.text}` });
    }
    return out;
  }

  // ---------------------------------------------------------------- settings

  const action = (kind, f = {}) => ({ kind, target: zeroAddress, token: zeroAddress, a: 0n, b: 0n, c: 0n, name: "", ...f });

  async function settingsAction(cmd) {
    switch (cmd.kind) {
      case "pause":
        return { act: action(Kind.Pause), summary: "Pause all payments" };
      case "resume":
        return { act: action(Kind.Unpause), summary: "Resume payments" };
      case "revoke":
        return { act: action(Kind.SetAgent), summary: "Remove the agent's permission to pay" };
      case "renew": {
        const until = nowSeconds() + cmd.days * 86400;
        return {
          act: action(Kind.SetAgent, { target: chain.agentAddress, a: BigInt(until) }),
          summary: `Let the agent pay until ${new Date(until * 1000).toISOString().slice(0, 10)}`,
        };
      }
      case "add_biller": {
        if (!NAME.test(cmd.name)) throw new InputError("Biller names must be 1 to 40 plain characters.");
        const address = evmAddress(cmd.address);
        return { act: action(Kind.SetBiller, { target: address, name: cmd.name }), summary: `Allow biller ${cmd.name} (${address})` };
      }
      case "remove_biller": {
        const found = resolveBiller(cmd.billerQuery, await chain.billers());
        if (found.candidates) throw new InputError(`Which one: ${found.candidates.map((b) => b.name).join(", ")}?`);
        if (!found.biller) throw new InputError(`“${cmd.billerQuery}” is not on your allowlist.`);
        return { act: action(Kind.RemoveBiller, { target: found.biller.address }), summary: `Remove biller ${found.biller.name}` };
      }
      case "set_limits": {
        const token = tokenBySymbol(cmd.token);
        const [a, b, c] = [cmd.autoPay, cmd.maxPer, cmd.daily].map((v) => amountOf(token, v));
        if (!(a <= b && b <= c && c > 0n)) throw new InputError(explainRefusal(new ContractRefusal("InvalidLimits")));
        const f = fmtToken(token);
        return {
          act: action(Kind.SetLimits, { token: token.address, a, b, c }),
          summary: `${token.symbol} limits: auto-pay ${f(a)}, max ${f(b)} per bill, ${f(c)} a day`,
        };
      }
      case "disable_token": {
        const token = tokenBySymbol(cmd.token);
        return { act: action(Kind.DisableToken, { token: token.address }), summary: `Stop payments in ${token.symbol}` };
      }
      case "set_max_payments":
        return { act: action(Kind.SetMaxPaymentsPerDay, { a: BigInt(cmd.count) }), summary: `At most ${cmd.count} payments a day` };
      case "withdraw": {
        const token = tokenBySymbol(cmd.token);
        const amount = amountOf(token, cmd.amount);
        if (amount === 0n) throw new InputError("The amount must be more than zero.");
        const to = evmAddress(cmd.address);
        const { balance } = await chain.tokenState(token);
        if (amount > balance) throw new InputError(`The account holds only ${fmtToken(token)(balance)}.`);
        return { act: action(Kind.Withdraw, { token: token.address, a: amount, target: to }), summary: `Withdraw ${fmtToken(token)(amount)} to ${to}` };
      }
      default:
        return null;
    }
  }

  async function settingsRequest(cmd) {
    const { act, summary } = await settingsAction(cmd);
    const nonce = await chain.nonce();
    const deadline = nowSeconds() + requestMinutes * 60;
    const message = await chain.actionMessage({ action: act, deadline, nonce });
    const request = newRequest({
      kind: "settings",
      nonce,
      deadline,
      message,
      summary,
      ownerBech32: addresses.toBech32(await chain.owner()),
      run: (signature) => chain.executeSigned({ action: act, deadline, signature }),
      doneText: `Done: ${summary}.`,
    });
    return {
      text: `${summary}.\nSign it in QoreX with your post-quantum key within ${requestMinutes} minutes:`,
      link: { label: "Sign in QoreX", url: `${publicUrl}/approve/${request.id}` },
    };
  }

  // ---------------------------------------------------------------- signing

  /** The request as the signing page shows it. */
  function getRequest(id) {
    const r = requests.get(id);
    if (!r) return null;
    const expired = ["pending", "draft"].includes(r.status) && nowSeconds() > r.deadline;
    return {
      kind: r.kind,
      status: expired ? "expired" : r.status,
      summary: r.summary || null,
      message: r.message || null,
      ownerBech32: r.ownerBech32 || null,
      cosmosChainId,
      expiresAt: r.deadline,
      txHash: r.txHash || null,
      error: r.error || null,
      ...(r.kind === "setup" ? { tokens: tokens.map((t) => t.symbol), tokenDecimals: Object.fromEntries(tokens.map((t) => [t.symbol, t.decimals])), demoBillers } : {}),
    };
  }

  async function submitSignature(id, signature) {
    const r = requests.get(id);
    if (!r) return { ok: false, status: 404, error: "Unknown request." };
    if (r.status !== "pending") return { ok: false, status: 409, error: `This request is ${r.status}.` };
    if (nowSeconds() > r.deadline) return { ok: false, status: 410, error: "This request has expired. Ask the bot again." };
    let bytes;
    try {
      bytes = pqSignatureBytes(signature);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (r.nonce !== undefined && (await chain.nonce()) !== r.nonce) {
      r.status = "stale";
      return { ok: false, status: 409, error: "Another signed request was used first. Ask the bot again." };
    }
    r.status = "submitting";
    try {
      let hash;
      if (r.kind === "setup") {
        const created = await factoryChain.createAccount({ owner: r.owner, config: r.config, setupId: r.setupId, deadline: r.deadline, signature: bytes });
        hash = created.hash;
        chain.useAccount(created.account);
        state.set({ account: created.account, owner: r.owner });
        // e.g. widen the agent's scoped EVM window to the new account before reporting success
        const note = await onAccountReady(created.account).catch((error) => {
          log.error?.("[agent] account follow-up failed:", error.message);
          return "I could not finish getting my own key ready yet; I will retry.";
        });
        r.doneText = [
          "Your bill account is ready.",
          "",
          fundText(created.account),
          "",
          "Then ask me to pay a bill, e.g. “pay 0.5 QOR to electricity”. Send “status” to see your limits.",
          ...(note ? ["", note] : []),
        ].join("\n");
      } else {
        ({ hash } = await r.run(bytes));
      }
      r.status = "done";
      r.txHash = hash;
      if (pendingId === id) pendingId = null;
      await notify(`${r.doneText}\nYour ML-DSA-87 signature was verified on chain.\ntx ${hash}`).catch(() => {});
      return { ok: true, txHash: hash };
    } catch (error) {
      if (!(error instanceof ContractRefusal)) {
        r.status = "pending";
        log.error?.("[agent] signed request failed:", error.shortMessage || error.message);
        return { ok: false, status: 502, error: "The network did not take it. Try again in a moment." };
      }
      r.status = error.errorName === "InvalidOwnerSignature" ? "pending" : "failed";
      r.error = explainRefusal(error, r.fmt);
      if (r.status === "failed") await notify(`Not done: ${r.error}`).catch(() => {});
      return { ok: false, status: 422, error: r.error };
    }
  }

  // ---------------------------------------------------------------- dispatch

  async function handle(text) {
    const cmd = await parse(text);
    if (cmd.kind === "setup") return startSetup();
    if (!chain.accountAddress) {
      const setup = await startSetup();
      if (!setup.link) return setup;
      return {
        ...setup,
        text: [
          "Welcome to QoreBills 👋",
          "Your bills, paid on time, from your own smart account.",
          "",
          "• Small bills: paid instantly",
          "• Recurring bills: paid on schedule",
          "• Big bills: wait for your approval",
          "Your limits live on QoreChain, and only your QoreX wallet can change them, with a post-quantum signature.",
          "",
          setup.text,
        ].join("\n"),
      };
    }
    try {
      switch (cmd.kind) {
        case "fund":
          return { text: fundText(chain.accountAddress) };
        case "help":
          return { text: help };
        case "status":
          return await status();
        case "billers":
          return await billers();
        case "history":
          return await history();
        case "cancel":
          return cancel();
        case "pay":
          return await payRequest(cmd);
        case "schedule":
          return await createSchedule(cmd);
        case "schedules":
          return listSchedules();
        case "stop_schedule":
          return stopSchedule(cmd.id);
        case "llm_unavailable":
          return { text: "My AI helper is busy right now, so I couldn't read that. Try again in a moment, or use a command like “pay 15 fUSD to electricity” (send “help” for the list)." };
        case "pay_help":
          return { text: "Say it like: pay 15 fUSD to IBEDC electricity" };
        case "settings_help":
          return { text: SETTINGS_HELP };
        default:
          if (["pause", "resume", "revoke", "renew", "add_biller", "remove_biller", "set_limits", "disable_token", "set_max_payments", "withdraw"].includes(cmd.kind)) {
            return await settingsRequest(cmd);
          }
          return { text: "I didn't catch that. Tell me a bill to pay, like “pay 15 fUSD to electricity”, or send “help”." };
      }
    } catch (error) {
      if (error instanceof InputError) return { text: error.message };
      throw error;
    }
  }

  return { handle, getRequest, draftSetup, submitSignature, runDueSchedules };
}
