// Try the native-spending-rule gas dispenser on the testnet with any funded owner key:
//   node scripts/try-gas-dispenser.js <owner-mnemonic-file>
// Links a dispenser key (index 999999 of the same mnemonic) to the owner with QoreChain's
// x/abstractaccount spending rule, makes one top-up within the rule and one above it, and
// prints what the chain recorded.
import { createGasDispenser, GAS_RULE } from "../src/gas.js";
import { createQoreAccount, loadOrCreateMnemonic } from "../src/qorechain.js";

const rest = process.env.QORE_REST || "https://api-testnet.qore.host";
const rpc = process.env.QORE_RPC || "https://rpc-testnet.qore.host";
const chainId = process.env.COSMOS_CHAIN_ID || "qorechain-diana";
const { mnemonic } = loadOrCreateMnemonic(process.argv[2]);
const account = (index) => createQoreAccount({ mnemonic, index, rest, rpc, chainId });
const owner = await account(0);
const dispenserAccount = await account(999_999);
const recipient = await account(999_998);
const log = { info: (...a) => console.log(...a) };
const gas = createGasDispenser({ owner, dispenser: dispenserAccount, rest, chainId, log });
const qor = (u) => `${Number(u) / 1e6} QOR`;

console.log(`owner ${owner.address}: ${qor(await owner.balanceUqor())}`);
console.log(`dispenser ${gas.address} (${gas.evmAddress})`);
await gas.ensureReady();
console.log("ready. rules:", JSON.stringify((await owner.spendingRules()).rules, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
console.log("linked keys:", JSON.stringify(await owner.authenticators(), (k, v) => (typeof v === "bigint" ? v.toString() : v)));

const before = await recipient.balanceUqor();
const ok = await gas.fund(recipient.address, 300_000n);
console.log(`within the rule: 0.3 QOR to ${recipient.address}: ${ok.txHash}, recipient ${qor(before)} -> ${qor(await recipient.balanceUqor())}`);

try {
  await gas.fund(recipient.address, BigInt(GAS_RULE.perTxLimit) + 500_000n);
  console.log("ABOVE THE RULE WAS NOT REFUSED (unexpected)");
} catch (error) {
  console.log(`above the rule (1.5 QOR): refused as expected: ${error.message}`);
}
console.log(`owner now ${qor(await owner.balanceUqor())}, recipient ${qor(await recipient.balanceUqor())}`);
