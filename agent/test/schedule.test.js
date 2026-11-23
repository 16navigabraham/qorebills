import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, nextRun, occurrenceRef, parseEvery } from "../src/schedule.js";

const at = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

test("parses schedules", () => {
  assert.deepEqual(parseEvery("month on the 1st").spec, { unit: "month", n: 1, time: { hour: 9, minute: 0 }, monthday: 1 });
  assert.deepEqual(parseEvery("week on Monday at 18:30").spec, { unit: "week", n: 1, time: { hour: 18, minute: 30 }, weekday: 1 });
  assert.deepEqual(parseEvery("day at 8").spec, { unit: "day", n: 1, time: { hour: 8, minute: 0 } });
  assert.deepEqual(parseEvery("10 minutes").spec, { unit: "minute", n: 10 });
  assert.deepEqual(parseEvery("2 hours").spec, { unit: "hour", n: 2 });
  assert.deepEqual(parseEvery("3 months on the 31st").spec, { unit: "month", n: 3, time: { hour: 9, minute: 0 }, monthday: 31 });
  for (const bad of ["fortnight", "2 minutes", "minute", "day at 25:00", "week on funday", "month on the 40th", "10 minutes at 08:00", "day on monday", "day maybe"]) {
    assert.ok(parseEvery(bad).error, bad);
  }
});

test("describes schedules", () => {
  assert.equal(describe(parseEvery("month on the 1st").spec), "every month on the 1st at 09:00 UTC");
  assert.equal(describe(parseEvery("week on mon at 18:30").spec), "every week on Monday at 18:30 UTC");
  assert.equal(describe(parseEvery("10 minutes").spec), "every 10 minutes");
  assert.equal(describe(parseEvery("2 days at 07:05").spec), "every 2 days at 07:05 UTC");
});

test("works out the next run", () => {
  const now = at("2026-11-23T14:00:00Z"); // a Monday
  assert.equal(iso(nextRun(parseEvery("10 minutes").spec, now)), "2026-11-23T14:10");
  assert.equal(iso(nextRun(parseEvery("day at 08:00").spec, now)), "2026-11-24T08:00");
  assert.equal(iso(nextRun(parseEvery("day at 15:00").spec, now)), "2026-11-23T15:00");
  assert.equal(iso(nextRun(parseEvery("week on monday").spec, now)), "2026-11-30T09:00");
  assert.equal(iso(nextRun(parseEvery("week on friday").spec, now)), "2026-11-27T09:00");
  assert.equal(iso(nextRun(parseEvery("month on the 1st").spec, now)), "2026-12-01T09:00");
  assert.equal(iso(nextRun(parseEvery("month on the 23rd at 15:00").spec, now)), "2026-11-23T15:00");
  // The 31st falls on the last day of shorter months.
  const feb = parseEvery("month on the 31st").spec;
  assert.equal(iso(nextRun(feb, at("2027-02-01T00:00:00Z"))), "2027-02-28T09:00");
  // Intervals stay on their grid from the creation time.
  const every10 = parseEvery("10 minutes").spec;
  assert.equal(iso(nextRun(every10, at("2026-11-23T14:37:00Z"), now)), "2026-11-23T14:40");
  const every2days = parseEvery("2 days at 08:00").spec;
  // Created Monday 14:00, so the first 08:00 run is Wednesday, then every other day.
  assert.equal(iso(nextRun(every2days, now, now)), "2026-11-25T08:00");
  assert.equal(iso(nextRun(every2days, at("2026-11-25T08:00:00Z"), now)), "2026-11-27T08:00");
});

test("gives each occurrence its own reference", () => {
  assert.equal(occurrenceRef({ id: 3 }, at("2026-12-01T09:00:00Z")), "auto-3-202612010900");
  assert.notEqual(occurrenceRef({ id: 3 }, at("2026-12-01T09:00:00Z")), occurrenceRef({ id: 3 }, at("2027-01-01T09:00:00Z")));
});
