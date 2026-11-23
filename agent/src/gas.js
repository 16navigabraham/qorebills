// The gas dispenser: how the agent's main key (its gas treasury) funds per-user agent keys,
// bounded by QoreChain's NATIVE smart-account spending rules (x/abstractaccount).
//
// The main key is the owner. It links a separate dispenser key as an authenticator with only
// the "send" permission and a spending rule (per transfer and per UTC day, QOR only). Automatic
// top-ups are then MsgExecuteCosmos messages the dispenser signs and relays: QoreChain checks
// the rule before moving anything out of the treasury. Even if the bot were abused (setup spam)
// or misbehaved, the treasury cannot drain faster than the chain allows. The dispenser key is
// also its own relayer, paying the transaction fee from its own small balance.
import { cosmosAuthSignBytes, executeCosmosMsg, fetchAuthNonce } from "@qorechain/sdk";
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const GAS_RULE = {
  id: "agent-gas-topups",
  enabled: true,
  perTxLimit: "1000000", // 1 QOR per transfer
  dailyLimit: "10000000", // 10 QOR per UTC day
  allowedDenoms: ["uqor"],
};
const LINK_DAYS = 29; // the chain allows at most 30 days (720 h); ensureLinked re-links with under 7 days left
const DISPENSER_MIN_UQOR = 200_000n; // the dispenser refuels itself below 0.2 QOR

const hexBytes = (hex) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/**
 * @param owner     the main key's account (qorechain.js): owns the treasury
 * @param dispenser the dispenser key's own account (qorechain.js): linked key and relayer
 */
export function createGasDispenser({ owner, dispenser, rest, chainId, now = () => Date.now(), log = console }) {
  const signer = privateKeyToAccount(dispenser.privateKey);
  const pubkey = hexBytes(signer.address); // a secp256k1 authenticator is named by its 20-byte EVM address

  /** Is the dispenser linked to the treasury, unrevoked, unexpired, with our rule in force? */
  async function linked() {
    let keys, rules;
    try {
      [keys, rules] = await Promise.all([owner.authenticators(), owner.spendingRules()]);
    } catch (error) {
      // The module answers 404 for an address that has no smart-account record yet.
      if (/HTTP 404/.test(error.message)) return false;
      throw error;
    }
    const me = signer.address.slice(2).toLowerCase();
    const key = keys.find((k) => k.pubkeyHex.replace(/^0x/, "").toLowerCase() === me && !k.revoked);
    const expiry = Number(key?.expiryUnix ?? 0);
    const rule = rules.rules.find((r) => r.id === GAS_RULE.id && r.enabled);
    return Boolean(key && rule && expiry > now() / 1000 + 7 * 86400);
  }

  async function ensureLinked() {
    if (await linked()) return { linked: true, already: true };
    const { txHash } = await owner.lock(() =>
      owner.linkAuthenticator({
        privateKey: dispenser.privateKey,
        permissions: ["send"],
        expiryUnix: Math.floor(now() / 1000) + LINK_DAYS * 86400,
        label: "qorebills-gas-dispenser",
        rules: [GAS_RULE],
      }),
    );
    log.info?.(`[gas] linked the dispenser ${signer.address} to ${owner.address} with native spending rules: ${txHash}`);
    return { linked: true, already: false, txHash };
  }

  /** Move uqor from the treasury to `to` through the linked key; the chain enforces the rule. */
  async function transfer(to, uqor) {
    return dispenser.lock(async () => {
      const { nonce } = await fetchAuthNonce({ rest, address: owner.address, pubkey });
      const amount = `${uqor}uqor`;
      const digest = cosmosAuthSignBytes({ chainId, account: owner.address, pubkey, to, amount, nonce });
      const signature = hexBytes(await signer.signMessage({ message: { raw: toHex(digest) } }));
      const message = executeCosmosMsg({
        relayer: dispenser.address,
        account: owner.address,
        scheme: "secp256k1",
        pubkey,
        signature,
        to,
        amount,
        nonce: BigInt(nonce),
      });
      const result = await dispenser.submit([message], 400_000);
      // From chain v3.2.8 a refused authorised execution still lands with code 0: read its events.
      const events = await dispenser.txEvents(result.transactionHash);
      const failed = events.find((e) => e.type === "abstractaccount_execution_failed");
      if (failed) {
        const reason = failed.attributes?.map((a) => `${a.key}=${a.value}`).join(" ") || "refused";
        throw new Error(`The treasury's spending rule refused the transfer (${reason})`);
      }
      return { txHash: result.transactionHash };
    });
  }

  return {
    address: dispenser.address,
    evmAddress: signer.address,
    ensureLinked,

    /** Ready to dispense: linked, with a registered PQC key and gas of its own for fees. */
    async ensureReady() {
      if ((await dispenser.balanceUqor()) < DISPENSER_MIN_UQOR) {
        // Bootstrapping only: before the dispenser can relay at all, the owner funds it directly.
        if ((await dispenser.balanceUqor()) === 0n || !(await dispenser.pqcStatus()).registered) {
          await owner.lock(() => owner.sendQor(dispenser.address, 500_000n));
        } else {
          await transfer(dispenser.address, 500_000n);
        }
      }
      await dispenser.lock(() => dispenser.ensureRegistered());
      await ensureLinked();
    },

    /** Fund a user's agent key: at most 1 QOR per transfer, 10 QOR per day, by chain rule. */
    async fund(to, uqor) {
      await this.ensureReady();
      return transfer(to, uqor);
    },
  };
}
