// End to end against a local Hardhat node: deploys BillAgentFactory from ../contracts,
// puts a mock of the QoreChain PQC precompiles at 0x…0A01 and 0x…0A02, then drives the
// agent and the signing API the way the bot and the QoreX pages do: setup, payments,
// approvals and settings changes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { concat, createPublicClient, createWalletClient, getAddress, http, keccak256, parseEther, parseUnits, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { createAgent } from "../src/agent.js";
import { createChain } from "../src/chain.js";
import { memoryState } from "../src/state.js";
import { createWebServer } from "../src/web.js";

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const artifact = (name, file = name) =>
  JSON.parse(fs.readFileSync(new URL(`artifacts/contracts/${file}.sol/${name}.json`, CONTRACTS), "utf8"));
// Hardhat's well-known test keys (never used anywhere real).
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const POWER = "0x1000000000000000000000000000000000000001";
const WATER = "0x2000000000000000000000000000000000000002";
const HOSTEL = "0x3000000000000000000000000000000000000003";
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const ownerPubkey = toHex(crypto.getRandomValues(new Uint8Array(2592)));
const owner = privateKeyToAccount(OWNER_KEY);
// Stand-in for bech32: the tests only need a reversible, distinct spelling.
const addresses = { toEvm: (v) => (v.startsWith("qor1") ? `0x${v.slice(4)}` : v), toBech32: (h) => `qor1${h.slice(2).toLowerCase()}` };

let node, server, agent, agentState, chain, pub, token, notices = [];

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
  if (!fs.existsSync(new URL("artifacts/contracts/BillAgentFactory.sol/BillAgentFactory.json", CONTRACTS))) {
    execFileSync("npx", ["hardhat", "compile"], { cwd: CONTRACTS, stdio: "ignore" });
  }
  node = spawn("npx", ["hardhat", "node", "--port", String(PORT)], { cwd: CONTRACTS, stdio: "ignore" });
  await waitForNode();

  const hh = { ...hardhat, rpcUrls: { default: { http: [RPC] } } };
  pub = createPublicClient({ chain: hh, transport: http(RPC) });
  const wallet = createWalletClient({ chain: hh, transport: http(RPC), account: owner });
  const deploy = async (a, args = []) => {
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const mockPqc = artifact("MockQorePQC", "test/MockQorePQC");
  const code = await pub.getCode({ address: await deploy(mockPqc) });
  for (const at of ["0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02"]) {
    await pub.request({ method: "hardhat_setCode", params: [at, code] });
  }
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ address: "0x0000000000000000000000000000000000000a02", abi: mockPqc.abi, functionName: "setKey", args: [owner.address, true, 1, ownerPubkey, true] }),
  });
  token = await deploy(artifact("MockERC20", "test/MockERC20"));
  const factory = await deploy(artifact("BillAgentFactory"), ["qorechain-diana"]);

  const tokens = [
    { symbol: "QOR", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
    { symbol: "fUSD", address: token, decimals: 6 },
  ];
  chain = createChain({ rpcUrl: RPC, evmChainId: 31337, privateKey: AGENT_KEY, tokens, factoryAddress: factory });
  agent = createAgent({
    chain,
    tokens,
    cosmosChainId: "qorechain-diana",
    publicUrl: "https://bills.example",
    addresses,
    state: (agentState = memoryState()),
    notify: async (text) => notices.push(text),
    log: { warn() {}, error() {} },
  });
  server = createWebServer({ agent, log: { error() {} } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // Fund helpers for later tests.
  globalThis.fund = async (account) => {
    const erc20 = artifact("MockERC20", "test/MockERC20");
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: erc20.abi, functionName: "mint", args: [account, parseUnits("500", 6)] }) });
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: account, value: parseEther("5") }) });
  };
});

after(() => {
  server?.close();
  node?.kill();
});

const api = (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const idOf = (reply) => reply.link.url.split("/").pop();
// What the mock precompile accepts as the owner's signature, wrapped like QoreX's signArbitrary answer.
const walletSign = (message) => {
  const signed = toHex(concat([toBytes("qorechain-msg-v1|qorechain-diana|"), toBytes(message)]));
  const pq = Buffer.from(toBytes(keccak256(concat([ownerPubkey, signed])))).toString("base64");
  return { signatureType: "ml-dsa-87-hybrid", classical: { keyType: "secp256k1", publicKey: "", signature: "" }, pq: { algorithmId: 1, signature: pq } };
};
const sign = async (id) => {
  const request = await (await api(`/api/requests/${id}`)).json();
  return post(`/api/requests/${id}/sign`, { signature: walletSign(request.message) });
};

test("a new owner is sent to setup", async () => {
  const reply = await agent.handle("hi");
  assert.match(reply.text, /^Welcome to QoreBills/);
  assert.match(reply.link.url, /^https:\/\/bills\.example\/setup\/[0-9a-f]{32}$/);
  const page = await api(`/setup/${idOf(reply)}`);
  assert.match(await page.text(), /Set up QoreBills/);
  assert.match(await (await api("/qorex.js")).text(), /signArbitrary/);
});

test("setup checks the form before anything is signed", async () => {
  const id = idOf(await agent.handle("setup"));
  const bad = async (form, pattern) => {
    const r = await post(`/api/requests/${id}/draft`, { owner: addresses.toBech32(owner.address), form });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, pattern);
  };
  const base = { billers: [{ name: "IBEDC electricity", address: POWER }], limits: { fUSD: { autoPay: "20", maxPer: "100", daily: "150" } }, paymentsPerDay: 5, days: 30 };
  await bad({ ...base, billers: [] }, /at least one biller/);
  await bad({ ...base, billers: [{ name: "Bad\nname", address: POWER }] }, /plain characters/);
  await bad({ ...base, billers: [{ name: "X", address: "0x123" }] }, /not a valid/);
  await bad({ ...base, limits: { fUSD: { autoPay: "200", maxPer: "100", daily: "150" } } }, /auto-pay ≤ max/);
  await bad({ ...base, limits: {} }, /at least one token/);
  await bad({ ...base, days: 0 }, /1 to 365 days/);
});

test("the owner creates the account with one post-quantum signature", async () => {
  const id = idOf(await agent.handle("setup"));
  const form = {
    billers: [
      { name: "IBEDC electricity", address: POWER },
      { name: "Water board", address: addresses.toBech32(WATER) }, // qor1 addresses work too
    ],
    limits: { fUSD: { autoPay: "20", maxPer: "100", daily: "150" } },
    paymentsPerDay: 10,
    days: 30,
  };
  const draft = await (await post(`/api/requests/${id}/draft`, { owner: addresses.toBech32(owner.address), form })).json();
  assert.match(draft.message, /^QoreBills: create my bill account\nowner: /);
  assert.match(draft.message, /\nauto-pay up to: 20 tUSD\nmax per payment: 100 tUSD\ndaily cap: 150 tUSD\n/);
  assert.match(draft.message, /\nbiller: Water board 0x2000000000000000000000000000000000000002/);

  const bad = await post(`/api/requests/${id}/sign`, { signature: walletSign("not the setup") });
  assert.equal(bad.status, 422);
  const r = await sign(id);
  const out = await r.json();
  assert.equal(r.status, 200, JSON.stringify(out));
  assert.match(notices.at(-1), /^Your bill account is ready\.\n\nTo fund it, open QoreX → Send and send QOR to your account's address:\nqor1[0-9a-f]{40}\n/);
  assert.match((await agent.handle("fund")).text, new RegExp(`\n${addresses.toBech32(chain.accountAddress)}\n`));
  assert.match((await agent.handle("status")).text, /^Your account: qor1[0-9a-f]{40}\n\(EVM form 0x/);
  assert.ok(chain.accountAddress);
  await globalThis.fund(chain.accountAddress);
});

test("pays a small bill on its own", async () => {
  const reply = await agent.handle("pay 15 fUSD to ibedc");
  assert.match(reply.text, /^Paid 15 fUSD to IBEDC electricity \(ref ibedc-electricity-\d{4}-\d{2}\)\.\ntx 0x[0-9a-f]{64}$/);
  assert.match((await agent.handle("pay 15 fUSD to ibedc")).text, /already paid/);
});

test("refuses what the limits forbid", async () => {
  assert.match((await agent.handle("pay 5 fUSD to dstv")).text, /not on your allowlist/);
  assert.match((await agent.handle("pay 101 fUSD to water board")).text, /most I can pay at once \(100 fUSD\)/);
  assert.match((await agent.handle("pay 1.0000001 fUSD to water board")).text, /too many decimals/);
});

test("shows status and billers", async () => {
  const status = (await agent.handle("status")).text;
  assert.match(status, /I can pay until /);
  assert.match(status, /fUSD: balance 485 fUSD/);
  assert.match(status, /left today 135 fUSD of 150 fUSD/);
  assert.match((await agent.handle("billers")).text, /Water board/);
});

test("asks for a post-quantum approval above the auto-pay limit, then pays", async () => {
  const reply = await agent.handle("pay 60 fUSD to water board ref NOV-RENT");
  assert.match(reply.text, /above your auto-pay limit of 20 fUSD/);
  const id = idOf(reply);
  assert.match(await (await api(`/approve/${id}`)).text(), /Sign with QoreX/);
  const request = await (await api(`/api/requests/${id}`)).json();
  assert.equal(request.kind, "payment");
  assert.equal(request.ownerBech32, addresses.toBech32(owner.address));
  assert.match(request.message, /^QoreBills payment approval\nbiller: Water board 0x/);
  assert.match(request.message, /\namount: 60 tUSD\n/);

  const bad = await post(`/api/requests/${id}/sign`, { signature: walletSign("something else") });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /did not verify/);
  const good = await sign(id);
  assert.equal(good.status, 200);
  assert.match(notices.at(-1), /^Approved and paid: 60 fUSD to Water board \(ref NOV-RENT\)\./);
  assert.equal((await sign(id)).status, 409);
  assert.match((await agent.handle("history")).text, /60 fUSD to Water board \(approved by you\)/);
});

test("pays recurring bills when they are due", async () => {
  assert.match((await agent.handle("schedules")).text, /No recurring bills/);
  assert.match((await agent.handle("pay 5 fUSD to water every 2 minutes")).text, /shortest schedule is every 5 minutes/);
  assert.match((await agent.handle("pay 101 fUSD to water every week")).text, /most I can pay at once/);
  assert.match((await agent.handle("pay 5 fUSD to dstv every day")).text, /not on your allowlist/);

  const small = (await agent.handle("pay 5 fUSD to water board every 10 minutes")).text;
  assert.match(small, /^Recurring bill #1: 5 fUSD to Water board, every 10 minutes\.\nFirst payment: /);
  assert.match(small, /I pay it myself/);
  const big = (await agent.handle("pay 25 fUSD to ibedc every month on the 1st at 07:30")).text;
  assert.match(big, /^Recurring bill #2: 25 fUSD to IBEDC electricity, every month on the 1st at 07:30 UTC\./);
  assert.match(big, /send you an approval link/);
  assert.match((await agent.handle("schedules")).text, /#1 5 fUSD to Water board, every 10 minutes — next .*\n#2 25 fUSD/);

  assert.deepEqual(await agent.runDueSchedules(), []); // nothing is due yet
  // Pretend both are due.
  const due = (s) => ({ ...s, nextRun: Date.now() - 1000 });
  agentState.set({ schedules: agentState.get().schedules.map(due) });
  const [paid, approval] = await agent.runDueSchedules();
  assert.match(paid.text, /^Recurring bill #1 \(every 10 minutes\):\nPaid 5 fUSD to Water board \(ref auto-1-\d{12}\)\.\ntx 0x/);
  assert.match(approval.text, /^Recurring bill #2 .*\n25 fUSD to IBEDC electricity is above your auto-pay limit/);
  assert.match(approval.link.url, /\/approve\/[0-9a-f]{32}$/);
  assert.ok(agentState.get().schedules.every((s) => s.nextRun > Date.now()));
  assert.deepEqual(await agent.runDueSchedules(), []); // each occurrence runs once

  // The same occurrence is never paid twice, even if the schedule state were rolled back.
  const lastRun = agentState.get().schedules[0].lastRun;
  agentState.set({ schedules: agentState.get().schedules.map((s) => (s.id === 1 ? { ...s, nextRun: lastRun } : s)) });
  assert.match((await agent.runDueSchedules())[0].text, /already paid/);

  assert.match((await agent.handle("stop 2")).text, /^Stopped recurring bill #2/);
  assert.match((await agent.handle("stop schedule 1")).text, /^Stopped recurring bill #1/);
  assert.match((await agent.handle("stop 1")).text, /no recurring bill #1/);
  assert.match((await agent.handle("schedules")).text, /No recurring bills/);
  assert.match((await agent.handle("cancel")).text, /^Cancelled/); // the unsigned approval
});

test("changes settings only with the owner's signature", async () => {
  const run = async (text, expected) => {
    const reply = await agent.handle(text);
    assert.ok(reply.link, `${text}: ${reply.text}`);
    const request = await (await api(`/api/requests/${idOf(reply)}`)).json();
    assert.equal(request.kind, "settings");
    assert.match(request.message, expected);
    const r = await sign(idOf(reply));
    assert.equal(r.status, 200, `${text}: ${JSON.stringify(await r.json())}`);
  };
  await run(`add biller Campus hostel ${HOSTEL}`, /^QoreBills settings change\nallow biller: Campus hostel 0x3000/);
  assert.match((await agent.handle("billers")).text, /Campus hostel/);
  await run("remove biller water board", /remove biller: Water board/);
  assert.match((await agent.handle("pay 1 fUSD to water board")).text, /not on your allowlist/);
  await run("limits fUSD 5 50 200", /auto-pay up to: 5 tUSD\nmax per payment: 50 tUSD\ndaily cap: 200 tUSD/);
  assert.match((await agent.handle("pay 6 fUSD to hostel")).text, /above your auto-pay limit of 5 fUSD/);
  await run("pause", /pause all payments/);
  assert.match((await agent.handle("status")).text, /PAUSED/);
  await run("resume", /resume payments/);
  await run("payments per day 3", /payments per day: 3/);
  await run(`withdraw 10 fUSD to ${owner.address}`, /withdraw: 10 tUSD\nto: 0xf39f/);
  await run("renew 7", /agent: 0x7099/);
  assert.match((await agent.handle("withdraw 100000 fUSD to " + owner.address)).text, /holds only/);
  assert.match((await agent.handle("limits fUSD 50 5 200")).text, /auto-pay ≤ max/);
  assert.match((await agent.handle("add biller " + HOSTEL)).text, /Settings commands look like/);
});

test("a newer signing request replaces the older one", async () => {
  const first = idOf(await agent.handle("pause"));
  const second = idOf(await agent.handle("payments per day 4"));
  assert.equal((await (await api(`/api/requests/${first}`)).json()).status, "replaced");
  assert.equal((await sign(first)).status, 409);
  assert.match((await agent.handle("cancel")).text, /Cancelled/);
  assert.equal((await (await api(`/api/requests/${second}`)).json()).status, "cancelled");
});

test("revoking stops the agent", async () => {
  const reply = await agent.handle("revoke");
  assert.equal((await sign(idOf(reply))).status, 200);
  assert.match((await agent.handle("status")).text, /not this account's agent/);
  assert.match((await agent.handle("pay 1 fUSD to hostel ref after-revoke")).text, /does not accept my key/);
});

test("rejects bad requests", async () => {
  assert.equal((await api("/api/requests/" + "0".repeat(32))).status, 404);
  assert.equal((await api("/api/requests/nothex")).status, 404);
  const big = await api(`/api/requests/${"0".repeat(32)}/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(70_000) });
  assert.equal(big.status, 413);
  assert.equal((await post(`/api/requests/${"0".repeat(32)}/sign`, { signature: {} })).status, 404);
  assert.equal(getAddress(chain.agentAddress), privateKeyToAccount(AGENT_KEY).address);
});
