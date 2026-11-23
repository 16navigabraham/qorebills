// QoreChain account set-up for an EVM key: register its ML-DSA-87 key (with proof of
// possession) and keep an EVM authorisation window open. On QoreChain an account's EVM
// transactions are only admitted inside such a window; a scoped window (allowed_targets)
// limits them to listed contracts, so even a stolen agent key can only call QoreBills.
import fs from "node:fs";
import path from "node:path";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  deriveUnifiedAccount,
  fetchEvmWindow,
  fetchAuthenticators,
  fetchPqcStatus,
  fetchSpendingRules,
  generateMnemonic,
  linkAuthenticatorMsgs,
  openEvmWindowMsg,
  signAuthenticatorLinkEip191,
  signProofOfPossession,
  validateMnemonic,
} from "@qorechain/sdk";

/** Read the agent's mnemonic, creating it (readable by this user only) the first time. */
export function loadOrCreateMnemonic(file) {
  try {
    const mnemonic = fs.readFileSync(file, "utf8").trim();
    if (!validateMnemonic(mnemonic)) throw new Error(`${file} does not hold a valid mnemonic.`);
    return { mnemonic, created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const mnemonic = generateMnemonic(256);
  fs.writeFileSync(file, `${mnemonic}\n`, { mode: 0o600, flag: "wx" });
  return { mnemonic, created: true };
}

/** Serialise async work on one account: its Cosmos sequence is also its EVM nonce. */
export function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** index 0 is the agent's main key; index n is the agent key of the n-th user. */
export async function createQoreAccount({ mnemonic, index = 0, rest, rpc, chainId, fetchImpl = fetch }) {
  const account = await deriveUnifiedAccount(mnemonic, index);
  const lock = createLock();
  const base = rest.replace(/\/+$/, "");
  const getJson = async (route) => {
    const r = await fetchImpl(`${base}${route}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${route}`);
    return r.json();
  };

  async function authInfo() {
    const { account: a } = await getJson(`/cosmos/auth/v1beta1/accounts/${account.cosmos}`);
    const baseAccount = a.base_account || a;
    return { accountNumber: BigInt(baseAccount.account_number), sequence: BigInt(baseAccount.sequence) };
  }

  async function broadcast(signer, messages, gas) {
    const transport = await StargateClient.connect(rpc);
    try {
      // 0.1 uqor per gas is the network's floor; pay a little more.
      const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.2)) }], gas: String(gas) };
      const result = await signer.signAndBroadcast(transport, { chainId, ...(await authInfo()), messages, fee });
      if (result.code !== 0) throw new Error(`Transaction refused (code ${result.code}): ${result.rawLog || ""}`.trim());
      return result;
    } finally {
      transport.disconnect();
    }
  }

  return {
    address: account.cosmos,
    evmAddress: account.evm,
    privateKey: account.privateKey,
    /** Run fn with this account's transactions serialised (EVM and Cosmos share one nonce). */
    lock,

    /** Spendable QOR in uqor (the account exists on chain once it has received funds). */
    async balanceUqor() {
      const { balances = [] } = await getJson(`/cosmos/bank/v1beta1/balances/${account.cosmos}`);
      return BigInt(balances.find((b) => b.denom === "uqor")?.amount || 0);
    },

    async pqcStatus() {
      return fetchPqcStatus({ rest, address: account.cosmos, fetch: fetchImpl });
    },

    /** Register the ML-DSA-87 key with a proof of possession, unless it is already registered. */
    async ensureRegistered() {
      const status = await this.pqcStatus();
      if (status.registered) return { registered: true, already: true };
      const classical = new EthNativeSigner(account, { signMode: "classical" });
      const result = await broadcast(
        classical,
        [
          buildRegisterPqcKeyMsg(account.cosmos, {
            pqcKeypair: account.pqc,
            ecdsaPubkey: Uint8Array.from(Buffer.from(account.publicKey.slice(2), "hex")),
            proofOfPossession: signProofOfPossession({ chainId, account: account.cosmos, keypair: account.pqc }),
          }),
        ],
        700_000,
      );
      return { registered: true, already: false, txHash: result.transactionHash };
    },

    async window() {
      return fetchEvmWindow({ rest, address: account.cosmos, fetch: fetchImpl });
    },

    /**
     * Open an EVM window (closing a live one first in the same transaction).
     * maxValueUqor counts transferred value plus each transaction's maximum fee.
     */
    async openWindow({ blocks, maxTxs, maxValueUqor, allowedTargets = [] }) {
      const current = await this.window().catch(() => null);
      const signer = new EthNativeSigner(account, { rest });
      const messages = [];
      if (current?.live) messages.push(closeEvmWindowMsg(account.cosmos));
      messages.push(
        openEvmWindowMsg({
          sender: account.cosmos,
          blocks,
          maxTxs,
          maxValue: String(maxValueUqor),
          ...(allowedTargets.length ? { allowedTargets } : {}),
        }),
      );
      const result = await broadcast(signer, messages, 400_000);
      return { txHash: result.transactionHash };
    },

    /** Sign (hybrid) and broadcast messages from this account; throws unless code 0. */
    submit: (messages, gas = 400_000) => broadcast(new EthNativeSigner(account, { rest }), messages, gas),

    /** A delivered transaction's events, from the REST API. */
    async txEvents(hash) {
      for (let i = 0; i < 10; i++) {
        try {
          const { tx_response: r } = await getJson(`/cosmos/tx/v1beta1/txs/${hash}`);
          return r.events || r.logs?.flatMap((l) => l.events) || [];
        } catch {
          await new Promise((res) => setTimeout(res, 1500));
        }
      }
      throw new Error(`Transaction ${hash} not found`);
    },

    /** QoreChain's native smart-account records for this address (x/abstractaccount). */
    spendingRules: () => fetchSpendingRules({ rest, address: account.cosmos, fetch: fetchImpl }),
    authenticators: () => fetchAuthenticators({ rest, address: account.cosmos, fetch: fetchImpl }),

    /**
     * Link another secp256k1 key (by its EVM address) to this account with native spending
     * rules, in ONE owner-signed transaction: MsgUpdateSpendingRules + MsgRegisterAuthenticator.
     * The linked key proves possession by signing QoreChain's link text (EIP-191).
     */
    async linkAuthenticator({ privateKey, permissions, expiryUnix, label, rules }) {
      const proof = signAuthenticatorLinkEip191({ chainId, account: account.cosmos, privateKey });
      const messages = linkAuthenticatorMsgs({
        owner: account.cosmos,
        chainId,
        scheme: proof.scheme,
        pubkey: proof.pubkey,
        possessionProof: proof.possessionProof,
        permissions,
        expiryUnix,
        label,
        spendingRules: rules,
      });
      const result = await broadcast(new EthNativeSigner(account, { rest }), messages, 700_000);
      return { txHash: result.transactionHash, pubkey: proof.pubkey };
    },

    /** Send native QOR (uqor) to a qor1 address, e.g. to fund a user's agent key. */
    async sendQor(to, uqor) {
      const signer = new EthNativeSigner(account, { rest });
      const transport = await StargateClient.connect(rpc);
      try {
        const fee = { amount: [{ denom: "uqor", amount: "60000" }], gas: "300000" };
        const result = await signer.bankSend(transport, to, [{ denom: "uqor", amount: String(uqor) }], { chainId, ...(await authInfo()), fee });
        if (result.code !== 0) throw new Error(`Transfer refused (code ${result.code})`);
        return { txHash: result.transactionHash };
      } finally {
        transport.disconnect();
      }
    },

    async closeWindow() {
      const signer = new EthNativeSigner(account, { rest });
      return broadcast(signer, [closeEvmWindowMsg(account.cosmos)], 300_000);
    },
  };
}
