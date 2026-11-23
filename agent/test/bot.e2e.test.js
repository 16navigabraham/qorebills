// Two users on one bot, against a local Hardhat node with the PQC precompiles mocked:
// each gets their own account and their own agent key, and neither can act for the other.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { concat, createPublicClient, createWalletClient, http, keccak256, parseEther, parseUnits, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { createBot } from "../src/bot.js";
import { createChain } from "../src/chain.js";
import { memoryState } from "../src/state.js";
import { createWebServer } from "../src/web.js";

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const artifact = (name, file = name) => JSON.parse(fs.readFileSync(new URL(`artifacts/contracts/${file}.sol/${name}.json`, CONTRACTS), "utf8"));
// Hardhat's well-known test keys (never used anywhere real).
const OWNER_A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const MAIN_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OWNER_B = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const POWER = "0x1000000000000000000000000000000000000001";
const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const pubkeys = new Map([OWNER_A, OWNER_B].map((o) => [o.address, toHex(crypto.getRandomValues(new Uint8Array(2592)))]));
const addresses = { toEvm: (v) => (v.startsWith("qor1") ? `0x${v.slice(4)}` : v), toBech32: (h) => `qor1${h.slice(2).toLowerCase()}` };
const userKeyOf = (index) => keccak256(toBytes(`qorebills-test-user-${index}`));

let node, server, bot, pub, token, factory, store, notices = [];
let keeperRuns = [];

before(async () => {
  if (!fs.existsSync(new URL("artifacts/contracts/BillAgentFactory.sol/BillAgentFactory.json", CONTRACTS))) {
    execFileSync("npx", ["hardhat", "compile"], { cwd: CONTRACTS, stdio: "ignore" });
  }
  node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { cwd: CONTRACTS, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const hh = { ...hardhat, rpcUrls: { default: { http: [RPC] } } };
  pub = createPublicClient({ chain: hh, transport: http(RPC) });
  const wallet = createWalletClient({ chain: hh, transport: http(RPC), account: OWNER_A });
  const deploy = async (a, args = []) => (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress;
  const write = async (address, a, functionName, args) => pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: a.abi, functionName, args }) });

  const mockPqc = artifact("MockQorePQC", "test/MockQorePQC");
  const code = await pub.getCode({ address: await deploy(mockPqc) });
  for (const at of ["0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02"]) {
    await pub.request({ method: "hardhat_setCode", params: [at, code] });
  }
  for (const [owner, pubkey] of pubkeys) await write("0x0000000000000000000000000000000000000a02", mockPqc, "setKey", [owner, true, 1, pubkey, true]);
  const erc20 = artifact("MockERC20", "test/MockERC20");
  token = await deploy(erc20);
  factory = await deploy(artifact("BillAgentFactory"), ["qorechain-diana"]);
  globalThis.fund = async (account) => {
    await write(token, erc20, "mint", [account, parseUnits("500", 6)]);
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: account, value: parseEther("1") }) });
  };

  const tokens = [
    { symbol: "QOR", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
    { symbol: "fUSD", address: token, decimals: 6 },
  ];
  const keyFor = async (index) => {
    const privateKey = index === 0 ? MAIN_KEY : userKeyOf(index);
    const address = privateKeyToAccount(privateKey).address;
    await pub.request({ method: "hardhat_setBalance", params: [address, "0x56BC75E2D63100000"] }); // 100 ETH for gas
    const chain = createChain({ rpcUrl: RPC, evmChainId: 31337, privateKey, tokens, factoryAddress: factory });
    return { qore: { address: `qor1user${index}`, evmAddress: address, lock: (fn) => fn() }, chain };
  };
  store = memoryState();
  // The main key's chain sends createAccount.
  const mainKey = await keyFor(0);
  bot = createBot({
    main: mainKey,
    userKey: keyFor,
    createKeeper: ({ qore }) => ({ run: async () => (keeperRuns.push(qore.address), { ready: true }), start() {}, stop() {} }),
    store,
    factoryAddress: factory,
    maxUsers: 2,
    notifyUser: async (userId, text) => notices.push([userId, text]),
    log: { info() {}, warn() {}, error() {} },
    agentOptions: { tokens, cosmosChainId: "qorechain-diana", publicUrl: "https://bills.example", addresses, log: { warn() {}, error() {} } },
  });
  globalThis.mainKey = mainKey;
  globalThis.botOptions = { keyFor, tokens };
  server = createWebServer({ agent: bot, log: { error() {} } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});

after(() => {
  server?.close();
  node?.kill();
});

const api = (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const idOf = (reply) => reply.link.url.split("/").pop();
const signAs = (owner, message) => {
  const signed = toHex(concat([toBytes("qorechain-msg-v1|qorechain-diana|"), toBytes(message)]));
  const pq = Buffer.from(toBytes(keccak256(concat([pubkeys.get(owner.address), signed])))).toString("base64");
  return { signatureType: "ml-dsa-87-hybrid", pq: { algorithmId: 1, signature: pq } };
};
async function setUp(userId, owner) {
  const id = idOf(await bot.handle(userId, "hi"));
  const form = { billers: [{ name: "IBEDC electricity", address: POWER }], limits: { fUSD: { autoPay: "20", maxPer: "100", daily: "150" } }, paymentsPerDay: 5, days: 30 };
  const draft = await (await post(`/api/requests/${id}/draft`, { owner: addresses.toBech32(owner.address), form })).json();
  const r = await post(`/api/requests/${id}/sign`, { signature: signAs(owner, draft.message) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return store.get().users[userId];
}

test("each user gets their own account and their own agent key", async () => {
  const a = await setUp("111", OWNER_A);
  const b = await setUp("222", OWNER_B);
  assert.notEqual(a.account, b.account);
  assert.equal(a.owner, OWNER_A.address);
  assert.equal(b.owner, OWNER_B.address);
  assert.notEqual(a.index, b.index);
  const agentOf = (account) => pub.readContract({ address: account, abi: artifact("BillAgentAccount").abi, functionName: "agent" });
  assert.equal(await agentOf(a.account), privateKeyToAccount(userKeyOf(a.index)).address);
  assert.equal(await agentOf(b.account), privateKeyToAccount(userKeyOf(b.index)).address);
  assert.deepEqual(keeperRuns, [`qor1user${a.index}`, `qor1user${b.index}`], "each user's key is set up after their account exists");
  assert.match(notices.find(([u]) => u === "111")[1], /^Your bill account is ready/);
  await globalThis.fund(a.account);
  await globalThis.fund(b.account);
});

test("each user pays from their own account", async () => {
  assert.match((await bot.handle("111", "pay 5 fUSD to ibedc ref A-1")).text, /^Paid 5 fUSD to IBEDC electricity/);
  assert.match((await bot.handle("222", "pay 7 fUSD to ibedc ref B-1")).text, /^Paid 7 fUSD to IBEDC electricity/);
  assert.match((await bot.handle("111", "status")).text, /fUSD: balance 495 fUSD/);
  assert.match((await bot.handle("222", "status")).text, /fUSD: balance 493 fUSD/);
});

test("one user's wallet cannot approve another user's payment", async () => {
  const reply = await bot.handle("111", "pay 50 fUSD to ibedc ref A-BIG");
  const request = await (await api(`/api/requests/${idOf(reply)}`)).json();
  assert.equal(request.ownerBech32, addresses.toBech32(OWNER_A.address));
  const byB = await post(`/api/requests/${idOf(reply)}/sign`, { signature: signAs(OWNER_B, request.message) });
  assert.equal(byB.status, 422);
  const byA = await post(`/api/requests/${idOf(reply)}/sign`, { signature: signAs(OWNER_A, request.message) });
  assert.equal(byA.status, 200);
});

test("the demo stops taking new accounts at its limit", async () => {
  const reply = await bot.handle("333", "hi");
  assert.equal(reply.link, undefined);
  assert.match(reply.text, /demo is full/);
});

test("a restarted bot picks every user up again", async () => {
  const restarted = createBot({
    main: globalThis.mainKey,
    userKey: globalThis.botOptions.keyFor,
    createKeeper: () => ({ run: async () => ({ ready: true }), start() {}, stop() {} }),
    store,
    factoryAddress: factory,
    notifyUser: async () => {},
    log: { info() {}, warn() {}, error() {} },
    agentOptions: { tokens: globalThis.botOptions.tokens, cosmosChainId: "qorechain-diana", publicUrl: "https://bills.example", addresses, log: { warn() {}, error() {} } },
  });
  await restarted.start();
  assert.match((await restarted.handle("222", "history")).text, /7 fUSD to IBEDC electricity/);
  assert.match((await restarted.handle("111", "billers")).text, /IBEDC electricity/);
});
