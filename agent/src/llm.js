// Optional: understand free-form requests ("pay the light bill, 15 dollars")
// with Gemini. The model only proposes a command; agent.js checks it against
// the allowlist and the on-chain limits, and the contract enforces them again.

const SCHEMA = {
  type: "OBJECT",
  properties: {
    kind: { type: "STRING", enum: ["pay", "status", "billers", "history", "cancel", "help", "unknown"] },
    amount: { type: "STRING", description: "Decimal amount, digits only, e.g. 15 or 2.5" },
    token: { type: "STRING", description: "Token symbol if the user named one" },
    billerQuery: { type: "STRING", description: "The biller the user means, in their words" },
    ref: { type: "STRING", description: "Bill or invoice reference if the user gave one" },
  },
  required: ["kind"],
};

export function createLlmParser({ apiKey, model, fetchImpl = fetch }) {
  return async function parseWithLlm(text, { billers, tokens }) {
    const prompt = [
      "You turn a bill-payment request into a command for a payment agent.",
      "Never invent an amount or a biller the user did not state; use kind \"unknown\" instead.",
      `Billers: ${billers.filter((b) => b.allowed).map((b) => b.name).join(", ") || "none"}.`,
      `Tokens: ${tokens.map((t) => t.symbol).join(", ")}. Treat "dollars" or "usd" as fUSD.`,
      `Request: ${JSON.stringify(String(text).slice(0, 500))}`,
    ].join("\n");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Gemini answered ${response.status}`);
    const data = await response.json();
    const out = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    if (out.kind !== "pay") return { kind: out.kind || "unknown" };
    if (!/^\d+(\.\d+)?$/.test(out.amount || "") || !out.billerQuery) return { kind: "pay_help" };
    const token = tokens.find((t) => t.symbol.toLowerCase() === String(out.token || "").toLowerCase());
    return { kind: "pay", amount: out.amount, token: token?.symbol || null, billerQuery: out.billerQuery, ref: out.ref || null };
  };
}
