import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeeper } from "../src/keeper.js";

const FACTORY = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

function fakeQore({ balance = 20_000_000n, registered = false, window = { live: false, allowedTargets: [] } } = {}) {
  const calls = [];
  return {
    calls,
    address: "qor1agent",
    evmAddress: "0xagent",
    balanceUqor: async () => balance,
    ensureRegistered: async () => {
      calls.push("register");
      const already = registered;
      registered = true;
      return { already, txHash: "0xreg" };
    },
    window: async () => window,
    openWindow: async (opts) => {
      calls.push(["open", opts.allowedTargets]);
      window = { live: true, allowedTargets: opts.allowedTargets, remainingBlocks: "17280", remainingTxs: "1000", remainingValue: "20000000" };
      return { txHash: "0xwin" };
    },
  };
}

const quiet = { info() {}, error() {} };

test("asks the owner for gas when the agent has none", async () => {
  const qore = fakeQore({ balance: 0n });
  const notes = [];
  const keeper = createKeeper({ qore, chain: { accountAddress: null }, factoryAddress: FACTORY, notify: async (t) => notes.push(t), log: quiet });
  assert.deepEqual(await keeper.run(), { ready: false, reason: "unfunded" });
  assert.match(notes[0], /Send about 20 QOR .*\nqor1agent/);
  await keeper.run();
  assert.equal(notes.length, 1, "asks at most every few hours");
  assert.deepEqual(qore.calls, []);
});

test("registers the key and opens a window scoped to the factory, then widens it to the account", async () => {
  const qore = fakeQore();
  const chain = { accountAddress: null };
  const keeper = createKeeper({ qore, chain, factoryAddress: FACTORY, notify: async () => {}, log: quiet });
  assert.deepEqual(await keeper.run(), { ready: true });
  assert.deepEqual(qore.calls, ["register", ["open", [FACTORY]]]);
  await keeper.run();
  assert.equal(qore.calls.filter((c) => c[0] === "open").length, 1, "no reopening while the window is fine");
  chain.accountAddress = ACCOUNT;
  await keeper.run();
  assert.deepEqual(qore.calls.at(-1), ["open", [FACTORY, ACCOUNT]]);
});

test("renews a window that is running out", async () => {
  const qore = fakeQore({
    registered: true,
    window: { live: true, allowedTargets: [FACTORY], remainingBlocks: "100", remainingTxs: "900", remainingValue: "9000000" },
  });
  const keeper = createKeeper({ qore, chain: { accountAddress: null }, factoryAddress: FACTORY, notify: async () => {}, log: quiet });
  await keeper.run();
  assert.deepEqual(qore.calls.at(-1), ["open", [FACTORY]]);
});
