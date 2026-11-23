// Recurring bills: parse "every …", work out when the next payment is due, and give each
// occurrence its own bill reference so it can be paid at most once (the contract refuses a
// reference it has already paid, even after a restart or a retry). All times are UTC.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const MIN_INTERVAL_MINUTES = 5;
export const DEFAULT_TIME = { hour: 9, minute: 0 }; // 09:00 UTC for daily, weekly and monthly bills

const UNITS = { minute: "minute", minutes: "minute", min: "minute", mins: "minute", hour: "hour", hours: "hour", day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month" };

function parseTime(words) {
  const at = words.indexOf("at");
  if (at === -1) return { time: null, rest: words };
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(words[at + 1] || "");
  if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) return { error: "Write the time like “at 08:00” (UTC)." };
  return { time: { hour: Number(m[1]), minute: Number(m[2] || 0) }, rest: [...words.slice(0, at), ...words.slice(at + 2)] };
}

/** Parse the words after "every": "month on the 1st", "week on monday", "day at 08:00", "10 minutes". */
export function parseEvery(text) {
  let words = String(text).toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  const t = parseTime(words);
  if (t.error) return { error: t.error };
  words = t.rest;
  let n = 1;
  if (/^\d+$/.test(words[0] || "")) n = Number(words.shift());
  const unit = UNITS[words.shift()];
  if (!unit || !Number.isInteger(n) || n < 1 || n > 1000) return { error: "Say how often, like “every month on the 1st”, “every week on monday”, “every day at 08:00” or “every 10 minutes”." };
  const spec = { unit, n };
  if (unit === "minute" || unit === "hour") {
    if (t.time) return { error: "“at …” only works with days, weeks and months." };
    if ((unit === "minute" ? n : n * 60) < MIN_INTERVAL_MINUTES) return { error: `The shortest schedule is every ${MIN_INTERVAL_MINUTES} minutes.` };
  } else {
    spec.time = t.time || DEFAULT_TIME;
  }
  if (words[0] === "on") {
    words.shift();
    if (words[0] === "the") words.shift();
    if (unit === "week") {
      const day = WEEKDAYS.findIndex((d) => d.startsWith(words[0] || "#") && (words[0] || "").length >= 3);
      if (day === -1) return { error: "Name the day, like “every week on monday”." };
      spec.weekday = day;
      words.shift();
    } else if (unit === "month") {
      const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(words[0] || "");
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 31) return { error: "Give the day of the month, like “every month on the 1st”." };
      spec.monthday = Number(m[1]);
      words.shift();
    } else {
      return { error: "“on …” works with weeks (a weekday) and months (a date)." };
    }
  }
  if (words.length) return { error: `I didn't understand “${words.join(" ")}” in the schedule.` };
  return { spec };
}

const atTime = (date, time) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), time.hour, time.minute);
const daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The first run strictly after `after` (ms). `anchor` is when the schedule was created. */
export function nextRun(spec, after, anchor = after) {
  if (spec.unit === "minute" || spec.unit === "hour") {
    const step = spec.n * (spec.unit === "minute" ? MINUTE : HOUR);
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  if (spec.unit === "day") {
    let t = atTime(new Date(after), spec.time);
    while (t <= after) t += DAY;
    // Keep every n-th day counted from the anchor's day.
    const start = atTime(new Date(anchor), spec.time);
    while (Math.round((t - start) / DAY) % spec.n !== 0) t += DAY;
    return t;
  }
  if (spec.unit === "week") {
    const weekday = spec.weekday ?? new Date(anchor).getUTCDay();
    let t = atTime(new Date(after), spec.time);
    while (t <= after || new Date(t).getUTCDay() !== weekday) t += DAY;
    const first = (() => {
      let f = atTime(new Date(anchor), spec.time);
      while (f <= anchor || new Date(f).getUTCDay() !== weekday) f += DAY;
      return f;
    })();
    while (Math.round((t - first) / DAY / 7) % spec.n !== 0) t += 7 * DAY;
    return t;
  }
  // month
  const monthday = spec.monthday ?? new Date(anchor).getUTCDate();
  const a = new Date(anchor);
  for (let i = 0; i < 1200; i += spec.n) {
    const year = a.getUTCFullYear() + Math.floor((a.getUTCMonth() + i) / 12);
    const month = (a.getUTCMonth() + i) % 12;
    const t = Date.UTC(year, month, Math.min(monthday, daysInMonth(year, month)), spec.time.hour, spec.time.minute);
    if (t > after) return t;
  }
  throw new Error("No next run found");
}

const pad = (n) => String(n).padStart(2, "0");
const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "every month on the 1st at 09:00 UTC" */
export function describe(spec) {
  const every = spec.n === 1 ? `every ${spec.unit}` : `every ${spec.n} ${spec.unit}s`;
  if (spec.unit === "minute" || spec.unit === "hour") return every;
  const time = `at ${pad(spec.time.hour)}:${pad(spec.time.minute)} UTC`;
  if (spec.unit === "week" && spec.weekday !== undefined) return `${every} on ${WEEKDAYS[spec.weekday][0].toUpperCase()}${WEEKDAYS[spec.weekday].slice(1)} ${time}`;
  if (spec.unit === "month" && spec.monthday !== undefined) return `${every} on the ${ordinal(spec.monthday)} ${time}`;
  return `${every} ${time}`;
}

export const formatUtc = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** The bill reference for one occurrence: unique per schedule and due time. */
export function occurrenceRef(schedule, due) {
  const d = new Date(due);
  return `auto-${schedule.id}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}
