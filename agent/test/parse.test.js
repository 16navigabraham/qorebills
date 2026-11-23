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
