import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TOKENS } from "../src/config.js";
import { pqSignatureBytes } from "../src/agent.js";
import { defaultRef, parseCommand, resolveBiller } from "../src/parse.js";

const billers = [
  { address: "0x1111111111111111111111111111111111111111", name: "IBEDC electricity", allowed: true },
  { address: "0x2222222222222222222222222222222222222222", name: "Water board", allowed: true },
  { address: "0x3333333333333333333333333333333333333333", name: "DSTV subscription", allowed: false },
  { address: "0x4444444444444444444444444444444444444444", name: "Campus water", allowed: true },
];

test("parses simple commands", () => {
  for (const [text, kind] of [["/start", "help"], ["status", "status"], ["/billers", "billers"], ["/history@QoreBillsBot", "history"], ["cancel", "cancel"]]) {
    assert.equal(parseCommand(text, DEFAULT_TOKENS).kind, kind, text);
  }
  assert.equal(parseCommand("what's up", DEFAULT_TOKENS).kind, "unknown");
});

test("parses pay commands", () => {
  assert.deepEqual(parseCommand("pay 15 fUSD to IBEDC electricity ref INV-9", DEFAULT_TOKENS), {
    kind: "pay", amount: "15", token: "fUSD", billerQuery: "IBEDC electricity", ref: "INV-9",
  });
  assert.deepEqual(parseCommand("/pay 0.5 qor water board", DEFAULT_TOKENS), {
    kind: "pay", amount: "0.5", token: "QOR", billerQuery: "water board", ref: null,
  });
  assert.deepEqual(parseCommand("pay 20 to ibedc", DEFAULT_TOKENS), {
    kind: "pay", amount: "20", token: null, billerQuery: "ibedc", ref: null,
  });
  assert.equal(parseCommand("pay lots to ibedc", DEFAULT_TOKENS).kind, "pay_help");
  assert.equal(parseCommand("pay 5 fusd", DEFAULT_TOKENS).kind, "pay_help");
});

test("resolves billers on the allowlist only", () => {
  assert.equal(resolveBiller("ibedc", billers).biller.name, "IBEDC electricity");
  assert.equal(resolveBiller("my electricity bill", billers).biller.name, "IBEDC electricity");
  assert.equal(resolveBiller("water board", billers).biller.name, "Water board");
  assert.deepEqual(resolveBiller("water", billers).candidates.map((b) => b.name), ["Water board", "Campus water"]);
  assert.deepEqual(resolveBiller("dstv", billers), {});
  assert.equal(resolveBiller("0x2222222222222222222222222222222222222222", billers).biller.name, "Water board");
  assert.deepEqual(resolveBiller("0x3333333333333333333333333333333333333333", billers), {});
});

test("default reference is one bill per biller per month", () => {
  assert.equal(defaultRef("IBEDC electricity", new Date("2026-11-23T10:00:00Z")), "ibedc-electricity-2026-11");
});

test("reads the post-quantum part of a QoreX signature", () => {
  const sig = { signatureType: "ml-dsa-87-hybrid", classical: {}, pq: { algorithmId: 1, signature: Buffer.from([1, 2, 3]).toString("base64") } };
  assert.deepEqual([...pqSignatureBytes(sig)], [1, 2, 3]);
  assert.deepEqual([...pqSignatureBytes(JSON.stringify(sig))], [1, 2, 3]);
  assert.throws(() => pqSignatureBytes({ pq: { algorithmId: 2, signature: "AQ==" } }), /ML-DSA-87/);
  assert.throws(() => pqSignatureBytes({}), /post-quantum/);
});

test("parses settings commands", () => {
  const p = (t) => parseCommand(t, DEFAULT_TOKENS);
  assert.deepEqual(p("setup"), { kind: "setup" });
  assert.deepEqual(p("pause"), { kind: "pause" });
  assert.deepEqual(p("/resume"), { kind: "resume" });
  assert.deepEqual(p("revoke"), { kind: "revoke" });
  assert.deepEqual(p("renew 14"), { kind: "renew", days: 14 });
  assert.deepEqual(p("renew"), { kind: "renew", days: 30 });
  assert.deepEqual(p("add biller Campus hostel 0x1111111111111111111111111111111111111111"), {
    kind: "add_biller", name: "Campus hostel", address: "0x1111111111111111111111111111111111111111",
  });
  assert.deepEqual(p("remove biller water board"), { kind: "remove_biller", billerQuery: "water board" });
  assert.deepEqual(p("limits fusd 20 100 150"), { kind: "set_limits", token: "fUSD", autoPay: "20", maxPer: "100", daily: "150" });
  assert.deepEqual(p("limits QOR off"), { kind: "disable_token", token: "QOR" });
  assert.deepEqual(p("limits"), { kind: "status" });
  assert.deepEqual(p("payments per day 5"), { kind: "set_max_payments", count: 5 });
  assert.deepEqual(p("withdraw 10 fUSD to 0x1111111111111111111111111111111111111111"), {
    kind: "withdraw", amount: "10", token: "fUSD", address: "0x1111111111111111111111111111111111111111",
  });
  for (const bad of ["renew 0", "renew forever", "add biller 0x1111111111111111111111111111111111111111", "limits fUSD 1 2", "limits xyz 1 2 3", "withdraw all", "payments per day lots"]) {
    assert.equal(p(bad).kind, "settings_help", bad);
  }
});

test("parses recurring bills", () => {
  const tokens = [{ symbol: "QOR" }, { symbol: "fUSD" }];
  assert.deepEqual(parseCommand("pay 0.5 QOR to electricity every month on the 1st", tokens), {
    kind: "schedule", amount: "0.5", token: "QOR", billerQuery: "electricity", every: "month on the 1st",
  });
  assert.deepEqual(parseCommand("pay 2 water every 10 minutes", tokens), { kind: "schedule", amount: "2", token: null, billerQuery: "water", every: "10 minutes" });
  assert.equal(parseCommand("pay 2 water ref X every week", tokens).kind, "pay_help");
  assert.equal(parseCommand("pay every week", tokens).kind, "pay_help");
  assert.deepEqual(parseCommand("schedules", tokens), { kind: "schedules" });
  assert.deepEqual(parseCommand("stop 3", tokens), { kind: "stop_schedule", id: 3 });
  assert.deepEqual(parseCommand("/stop schedule #12", tokens), { kind: "stop_schedule", id: 12 });
  assert.deepEqual(parseCommand("cancel", tokens), { kind: "cancel" });
});
