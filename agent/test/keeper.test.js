import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeeper } from "../src/keeper.js";

const FACTORY = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const quiet = { info() {}, error() {} };

function fakeQore({ balance = 20_000_000n, registered = false, window = { live: false, allowedTargets: [] } } = {}) {
  const calls = [];
  return {
    calls,
    address: "qor1agent",
    evmAddress: "0xagent",
    lock: (fn) => fn(),
    balanceUqor: async () => balance,
    setBalance: (b) => (balance = b),
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

test("calls onLowGas and stops while the key has nothing", async () => {
  const qore = fakeQore({ balance: 0n });
  const asked = [];
  const keeper = createKeeper({ qore, targets: () => [FACTORY], onLowGas: async (b) => asked.push(b), log: quiet });
  assert.deepEqual(await keeper.run(), { ready: false, reason: "unfunded" });
  assert.deepEqual(asked, [0n]);
  assert.deepEqual(qore.calls, []);
});

test("a top-up from onLowGas lets it carry on", async () => {
  const qore = fakeQore({ balance: 0n });
  const keeper = createKeeper({ qore, targets: () => [ACCOUNT], onLowGas: async () => qore.setBalance(1_000_000n), log: quiet });
  assert.deepEqual(await keeper.run(), { ready: true });
  assert.deepEqual(qore.calls, ["register", ["open", [ACCOUNT]]]);
});

test("waits for a target before registering or opening a window", async () => {
  const qore = fakeQore();
  const keeper = createKeeper({ qore, targets: () => [null], log: quiet });
  assert.deepEqual(await keeper.run(), { ready: false, reason: "no targets" });
  assert.deepEqual(qore.calls, []);
});

test("registers once, scopes the window to its targets and follows changes", async () => {
  const qore = fakeQore();
  const targets = [FACTORY];
  const keeper = createKeeper({ qore, targets: () => targets, log: quiet });
  assert.deepEqual(await keeper.run(), { ready: true });
  assert.deepEqual(qore.calls, ["register", ["open", [FACTORY]]]);
  await keeper.run();
  assert.equal(qore.calls.filter((c) => c[0] === "open").length, 1, "no reopening while the window is fine");
  targets.push(ACCOUNT);
  await keeper.run();
  assert.deepEqual(qore.calls.at(-1), ["open", [FACTORY, ACCOUNT]]);
});

test("renews a window that is running out", async () => {
  const qore = fakeQore({
    registered: true,
    window: { live: true, allowedTargets: [FACTORY], remainingBlocks: "100", remainingTxs: "900", remainingValue: "9000000" },
  });
  const keeper = createKeeper({ qore, targets: () => [FACTORY], log: quiet });
  await keeper.run();
  assert.deepEqual(qore.calls.at(-1), ["open", [FACTORY]]);
});
