// Turns a chat message into a command. Plain commands are parsed here without
// any AI; free-form requests can go to the optional LLM parser (llm.js), whose
// output is checked by the same code before anything is paid.

const SIMPLE = {
  start: "help",
  help: "help",
  status: "status",
  limits: "status",
  balance: "status",
  billers: "billers",
  history: "history",
  cancel: "cancel",
};

const STOP_WORDS = new Set(["my", "the", "bill", "bills", "to", "for", "a", "an", "of", "please", "pay"]);

/** Parse "pay 15 fusd to ibedc electricity ref nov-26" (the leading slash is optional). */
export function parseCommand(text, tokens) {
  const trimmed = String(text || "").trim();
  const first = trimmed.split(/\s+/)[0]?.replace(/^\//, "").replace(/@\w+$/, "").toLowerCase();
  if (SIMPLE[first] && trimmed.split(/\s+/).length === 1) return { kind: SIMPLE[first] };
  if (first !== "pay") return { kind: "unknown" };

  let words = trimmed.split(/\s+/).slice(1);
  let ref = null;
  const refAt = words.findIndex((w) => /^ref:?$/i.test(w));
  if (refAt !== -1) {
    ref = words.slice(refAt + 1).join(" ") || null;
    words = words.slice(0, refAt);
  }
  const amount = words.shift();
  if (!amount || !/^\d+(\.\d+)?$/.test(amount)) return { kind: "pay_help" };
  let token = null;
  const symbol = tokens.find((t) => t.symbol.toLowerCase() === words[0]?.toLowerCase());
  if (symbol) {
    token = symbol.symbol;
    words.shift();
  }
  if (words[0]?.toLowerCase() === "to") words.shift();
  const billerQuery = words.join(" ").trim();
  if (!billerQuery) return { kind: "pay_help" };
  return { kind: "pay", amount, token, billerQuery, ref };
}

const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Find the allowlisted biller a request means. Returns { biller } on one clear
 * match, { candidates } when several match equally, or {} when none does.
 */
export function resolveBiller(query, billers) {
  const allowed = billers.filter((b) => b.allowed);
  const q = query.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const hit = allowed.find((b) => b.address.toLowerCase() === q.toLowerCase());
    return hit ? { biller: hit } : {};
  }
  const exact = allowed.find((b) => normalise(b.name) === normalise(q));
  if (exact) return { biller: exact };
  const words = normalise(q).split(" ").filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  if (!words.length) return {};
  const scored = allowed
    .map((b) => {
      const name = normalise(b.name);
      return { b, score: words.filter((w) => name.includes(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return {};
  const best = scored.filter((s) => s.score === scored[0].score);
  return best.length === 1 ? { biller: best[0].b } : { candidates: best.map((s) => s.b) };
}

/** A bill reference when the user gives none: one payment per biller per month. */
export function defaultRef(billerName, date = new Date()) {
  const month = date.toISOString().slice(0, 7);
  return `${normalise(billerName).replace(/ /g, "-")}-${month}`;
}
