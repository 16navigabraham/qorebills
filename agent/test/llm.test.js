import assert from "node:assert/strict";
import { test } from "node:test";
import { createLlmParser } from "../src/llm.js";

// Gemini is stubbed: these tests check what the agent does with its answer, not the model.
const answering = (out) => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) });
const ctx = { billers: [{ name: "Hostel rent (demo)", allowed: true }], tokens: [{ symbol: "QOR" }, { symbol: "fUSD" }] };
const parse = (out) => createLlmParser({ apiKey: "k", model: "m", fetchImpl: answering(out) })("whatever", ctx);

test("free-form requests become the same commands as typed ones", async () => {
  assert.deepEqual(await parse({ kind: "pay", amount: "15", token: "fusd", billerQuery: "light" }), { kind: "pay", amount: "15", token: "fUSD", billerQuery: "light", ref: null });
  assert.deepEqual(await parse({ kind: "schedule", amount: "0.5", token: "QOR", billerQuery: "rent", every: "month on the 1st" }), {
    kind: "schedule", amount: "0.5", token: "QOR", billerQuery: "rent", every: "month on the 1st",
  });
  assert.deepEqual(await parse({ kind: "schedule", amount: "0.5", billerQuery: "rent" }), { kind: "pay_help" }); // no schedule given
  assert.deepEqual(await parse({ kind: "pay", amount: "lots", billerQuery: "rent" }), { kind: "pay_help" });
  assert.deepEqual(await parse({ kind: "fund" }), { kind: "fund" });
  assert.deepEqual(await parse({ kind: "schedules" }), { kind: "schedules" });
});
