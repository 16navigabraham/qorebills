// Deploy BillAgentFactory to the QoreChain testnet from a deployer mnemonic file:
//   node scripts/deploy-factory.js <mnemonic-file>
// Registers the deployer's ML-DSA-87 key if needed, opens a short unscoped EVM window
// (contract creation needs one), deploys, then closes the window.
import fs from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createQoreAccount, loadOrCreateMnemonic } from "../src/qorechain.js";

const REST = process.env.QORE_REST || "https://api-testnet.qore.host";
const RPC = process.env.QORE_RPC || "https://rpc-testnet.qore.host";
const EVM_RPC = process.env.QORE_EVM_RPC || "https://evm-testnet.qore.host";
const CHAIN_ID = process.env.COSMOS_CHAIN_ID || "qorechain-diana";
const EVM_CHAIN_ID = Number(process.env.EVM_CHAIN_ID || 9800);

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/deploy-factory.js <mnemonic-file>");
const artifact = JSON.parse(
  fs.readFileSync(new URL("../../contracts/artifacts/contracts/BillAgentFactory.sol/BillAgentFactory.json", import.meta.url), "utf8"),
);

const { mnemonic } = loadOrCreateMnemonic(file);
const qore = await createQoreAccount({ mnemonic, rest: REST, rpc: RPC, chainId: CHAIN_ID });
console.log(`Deployer ${qore.address} (${qore.evmAddress})`);
const balance = await qore.balanceUqor();
console.log(`Balance ${Number(balance) / 1e6} QOR`);
if (balance < 2_000_000n) throw new Error("Fund the deployer with at least 2 QOR first.");

const reg = await qore.ensureRegistered();
console.log(reg.already ? "PQC key already registered" : `Registered ML-DSA-87 key with proof of possession: ${reg.txHash}`);

console.log("Opening a deploy window (unscoped, 600 blocks, 3 transactions, 5 QOR)…");
console.log(`  ${(await qore.openWindow({ blocks: 600, maxTxs: 3, maxValueUqor: 5_000_000n })).txHash}`);

const chain = defineChain({ id: EVM_CHAIN_ID, name: "QoreChain testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [EVM_RPC] } } });
const pub = createPublicClient({ chain, transport: http(EVM_RPC) });
const wallet = createWalletClient({ chain, transport: http(EVM_RPC), account: privateKeyToAccount(qore.privateKey) });
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [CHAIN_ID] });
console.log(`Deploying BillAgentFactory: ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (receipt.status !== "success") throw new Error("Deploy reverted");
const factory = receipt.contractAddress;
const deployer = await pub.readContract({ address: factory, abi: artifact.abi, functionName: "deployer" });
console.log(`BillAgentFactory  ${factory}`);
console.log(`BillAgentDeployer ${deployer}`);
console.log(`Gas used ${receipt.gasUsed}`);

await qore.closeWindow();
console.log("Deploy window closed.");
