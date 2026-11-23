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
  setup: "setup",
  pause: "pause",
  resume: "resume",
  unpause: "resume",
  revoke: "revoke",
};

const ADDRESS = /^(0x[0-9a-fA-F]{40}|qor1[02-9ac-hj-np-z]{38})$/;
const AMOUNT = /^\d+(\.\d+)?$/;

const STOP_WORDS = new Set(["my", "the", "bill", "bills", "to", "for", "a", "an", "of", "please", "pay"]);

/** Parse "pay 15 fusd to ibedc electricity ref nov-26" (the leading slash is optional). */
export function parseCommand(text, tokens) {
  const trimmed = String(text || "").trim();
  const first = trimmed.split(/\s+/)[0]?.replace(/^\//, "").replace(/@\w+$/, "").toLowerCase();
  if (SIMPLE[first] && trimmed.split(/\s+/).length === 1) return { kind: SIMPLE[first] };
  const settings = parseSettings(trimmed.replace(/^\//, ""), tokens);
  if (settings) return settings;
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

const SETTINGS_HELP = { kind: "settings_help" };

/** Settings commands. They all end in a message the owner signs in QoreX. */
function parseSettings(text, tokens) {
  const words = text.split(/\s+/);
  const lower = words.map((w) => w.toLowerCase());
  const token = (w) => tokens.find((t) => t.symbol.toLowerCase() === String(w).toLowerCase())?.symbol;

  // renew 30  -> the agent may pay for 30 more days
  if (lower[0] === "renew") {
    const days = Number(words[1] ?? 30);
    return Number.isInteger(days) && days >= 1 && days <= 365 ? { kind: "renew", days } : SETTINGS_HELP;
  }
  // add biller Campus hostel 0x...
  if (lower[0] === "add" && lower[1] === "biller") {
    const address = words.at(-1);
    const name = words.slice(2, -1).join(" ");
    return ADDRESS.test(address) && name ? { kind: "add_biller", name, address } : SETTINGS_HELP;
  }
  // remove biller water board
  if (lower[0] === "remove" && lower[1] === "biller") {
    const billerQuery = words.slice(2).join(" ");
    return billerQuery ? { kind: "remove_biller", billerQuery } : SETTINGS_HELP;
  }
  // limits fUSD 20 100 150  (auto-pay, max per payment, daily cap); limits fUSD off
  if (lower[0] === "limits" && words.length > 1) {
    const symbol = token(words[1]);
    if (!symbol) return SETTINGS_HELP;
    if (lower[2] === "off" && words.length === 3) return { kind: "disable_token", token: symbol };
    const [autoPay, maxPer, daily] = words.slice(2);
    return words.length === 5 && [autoPay, maxPer, daily].every((v) => AMOUNT.test(v))
      ? { kind: "set_limits", token: symbol, autoPay, maxPer, daily }
      : SETTINGS_HELP;
  }
  // payments per day 5
  if (lower.slice(0, 3).join(" ") === "payments per day") {
    const n = Number(words[3]);
    return Number.isInteger(n) && n >= 0 && n <= 1000 && words.length === 4 ? { kind: "set_max_payments", count: n } : SETTINGS_HELP;
  }
  // withdraw 10 fUSD to 0x...
  if (lower[0] === "withdraw") {
    const [, amount, symbol, to, address] = words;
    return words.length === 5 && AMOUNT.test(amount) && token(symbol) && lower[3] === "to" && ADDRESS.test(address)
      ? { kind: "withdraw", amount, token: token(symbol), address }
      : SETTINGS_HELP;
  }
  return null;
}
