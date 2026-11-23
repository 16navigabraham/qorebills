// End to end against a local Hardhat node: deploys BillAgentAccount from
// ../contracts, puts a mock of the QoreChain PQC precompiles at 0x…0A01 and
// 0x…0A02, then drives the agent and the approval API as the bot would.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { concat, createPublicClient, createWalletClient, http, keccak256, parseEther, parseUnits, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { createAgent } from "../src/agent.js";
import { createChain } from "../src/chain.js";
import { createWebServer } from "../src/web.js";

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const artifact = (name, dir = name) =>
  JSON.parse(fs.readFileSync(new URL(`artifacts/contracts/${dir}.sol/${name}.json`, CONTRACTS), "utf8"));
// Hardhat's well-known test keys (never used anywhere real).
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const POWER = "0x1000000000000000000000000000000000000001";
const WATER = "0x2000000000000000000000000000000000000002";
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const ownerPubkey = toHex(crypto.getRandomValues(new Uint8Array(2592)));

let node, server, agent, token, notices = [];

async function waitForNode() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Hardhat node did not start");
}

before(async () => {
  if (!fs.existsSync(new URL("artifacts/contracts/BillAgentAccount.sol/BillAgentAccount.json", CONTRACTS))) {
    execFileSync("npx", ["hardhat", "compile"], { cwd: CONTRACTS, stdio: "ignore" });
  }
  node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { cwd: CONTRACTS, stdio: "ignore" });
  await waitForNode();

  const chain = { ...hardhat, rpcUrls: { default: { http: [RPC] } } };
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const owner = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(OWNER_KEY) });
  const deploy = async (a, args = []) => {
    const hash = await owner.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const write = async (address, a, functionName, args) =>
    pub.waitForTransactionReceipt({ hash: await owner.writeContract({ address, abi: a.abi, functionName, args }) });

  const mockPqc = artifact("MockQorePQC", "test/MockQorePQC");
  const mockAddress = await deploy(mockPqc);
  const code = await pub.getCode({ address: mockAddress });
  for (const at of ["0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02"]) {
    await pub.request({ method: "hardhat_setCode", params: [at, code] });
  }
  await write("0x0000000000000000000000000000000000000a02", mockPqc, "setKey", [owner.account.address, true, 1, ownerPubkey, true]);

  const erc20 = artifact("MockERC20", "test/MockERC20");
  token = await deploy(erc20);
  const account = artifact("BillAgentAccount");
  const accountAddress = await deploy(account, [owner.account.address, "qorechain-diana"]);
  await write(token, erc20, "mint", [accountAddress, parseUnits("500", 6)]);
  await owner.sendTransaction({ to: accountAddress, value: parseEther("5") });
  const block = await pub.getBlock();
  await write(accountAddress, account, "setAgent", [privateKeyToAccount(AGENT_KEY).address, block.timestamp + 86400n]);
  await write(accountAddress, account, "setBiller", [POWER, true, "IBEDC electricity"]);
  await write(accountAddress, account, "setBiller", [WATER, true, "Water board"]);
  await write(accountAddress, account, "setLimits", [token, parseUnits("20", 6), parseUnits("100", 6), parseUnits("150", 6), true]);
  await write(accountAddress, account, "setMaxPaymentsPerDay", [10]);

  const tokens = [
    { symbol: "QOR", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
    { symbol: "fUSD", address: token, decimals: 6 },
  ];
  agent = createAgent({
    chain: createChain({ rpcUrl: RPC, evmChainId: 31337, accountAddress, privateKey: AGENT_KEY, tokens }),
    tokens,
    cosmosChainId: "qorechain-diana",
    publicUrl: "https://bills.example",
    notify: async (text) => notices.push(text),
    log: { warn() {}, error() {} },
  });
  server = createWebServer({ agent, log: { error() {} } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});

after(() => {
  server?.close();
  node?.kill();
});

const api = (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
// What the mock precompile accepts as the owner's signature, wrapped like QoreX's signArbitrary answer.
const walletSign = (message) => {
  const signed = toHex(concat([toBytes("qorechain-msg-v1|qorechain-diana|"), toBytes(message)]));
  const pq = Buffer.from(toBytes(keccak256(concat([ownerPubkey, signed])))).toString("base64");
  return { signatureType: "ml-dsa-87-hybrid", classical: { keyType: "secp256k1", publicKey: "", signature: "" }, pq: { algorithmId: 1, signature: pq } };
};

test("pays a small bill on its own", async () => {
  const reply = await agent.handle("pay 15 fUSD to ibedc");
  assert.match(reply.text, /^Paid 15 fUSD to IBEDC electricity \(ref ibedc-electricity-\d{4}-\d{2}\)\.\ntx 0x[0-9a-f]{64}$/);
});

test("will not pay the same bill twice", async () => {
  const reply = await agent.handle("pay 15 fUSD to ibedc");
  assert.match(reply.text, /already paid/);
});

test("refuses billers outside the allowlist", async () => {
  assert.match((await agent.handle("pay 5 fUSD to dstv")).text, /not on your allowlist/);
});

test("refuses above the hard per-payment cap", async () => {
  assert.match((await agent.handle("pay 101 fUSD to water board")).text, /most I can pay at once \(100 fUSD\)/);
});

test("shows status and billers", async () => {
  const status = (await agent.handle("status")).text;
  assert.match(status, /fUSD: balance 485 fUSD/);
  assert.match(status, /left today 135 fUSD of 150 fUSD/);
  assert.match(status, /Payments today: 1 of 10/);
  assert.match((await agent.handle("billers")).text, /Water board/);
});

test("asks for a post-quantum approval above the auto-pay limit, then pays", async () => {
  const reply = await agent.handle("pay 60 fUSD to water board ref NOV-RENT");
  assert.match(reply.text, /above your auto-pay limit of 20 fUSD/);
  const id = reply.link.url.split("/").pop();
  assert.match(reply.link.url, /^https:\/\/bills\.example\/approve\/[0-9a-f]{32}$/);

  const page = await api(`/approve/${id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign with QoreX/);

  const approval = await (await api(`/api/approvals/${id}`)).json();
  assert.equal(approval.status, "pending");
  assert.match(approval.message, /^QoreBills payment approval\n/);
  assert.match(approval.message, /\(Water board\)\ntoken: /);

  // A signature over other text is refused by the contract and the link stays usable.
  const bad = await api(`/api/approvals/${id}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: walletSign("something else") }),
  });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /did not verify/);

  const good = await api(`/api/approvals/${id}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: walletSign(approval.message) }),
  });
  const out = await good.json();
  assert.equal(good.status, 200, JSON.stringify(out));
  assert.match(out.txHash, /^0x[0-9a-f]{64}$/);
  assert.match(notices.at(-1), /Approved and paid: 60 fUSD to Water board \(ref NOV-RENT\)/);

  const again = await api(`/api/approvals/${id}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: walletSign(approval.message) }),
  });
  assert.equal(again.status, 409);
  assert.match((await agent.handle("history")).text, /60 fUSD to Water board \(approved by you\)/);
});

test("cancel drops the pending approval", async () => {
  const reply = await agent.handle("pay 30 fUSD to ibedc ref EXTRA-1");
  const id = reply.link.url.split("/").pop();
  assert.match((await agent.handle("cancel")).text, /Cancelled/);
  assert.equal((await (await api(`/api/approvals/${id}`)).json()).status, "cancelled");
});

test("rejects bad approval requests", async () => {
  assert.equal((await api("/api/approvals/" + "0".repeat(32))).status, 404);
  assert.equal((await api("/api/approvals/nothex")).status, 404);
  const big = await api("/api/approvals/" + "0".repeat(32), {
    method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(70_000),
  });
  assert.equal(big.status, 413);
});
