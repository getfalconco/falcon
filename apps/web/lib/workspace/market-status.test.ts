// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/market-status.test.ts
// Pure checks of the Dashboard market chip; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNyseEarlyClose, isNyseSession, nyseHolidays } from "../../../../packages/engine/src/study/abnormal.ts";
import { formatCountdown, marketStatus, nyDate } from "./market-status";

/** An instant from a New York wall clock with its offset, e.g. "2026-11-17T06:06:00-05:00". */
const at = (iso: string) => Date.parse(iso);

test("NYSE calendar 2026-2027 matches the published holidays and early closes", () => {
  // NYSE holiday and early-close schedule as published for 2026 and 2027.
  const published: Record<number, string[]> = {
    2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
    2027: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
  };
  for (const [year, days] of Object.entries(published)) {
    assert.deepEqual([...nyseHolidays(Number(year))].sort(), days, `holidays ${year}`);
    for (const d of days) assert.equal(isNyseSession(d), false, d);
  }
  const early: string[] = [];
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 86_400_000) {
    const d = new Date(ms).toISOString().slice(0, 10);
    if (isNyseEarlyClose(d)) early.push(d);
  }
  // July 3 2026 and December 24 2027 are full holidays (observed), so they are not early closes.
  assert.deepEqual(early, ["2026-11-27", "2026-12-24", "2027-11-26"]);
  // A Saturday New Year (2028) is not observed on the Friday before.
  assert.equal(isNyseSession("2027-12-31"), true);
});

test("countdown format", () => {
  assert.equal(formatCountdown((3 * 60 + 24) * 60_000), "3h 24m");
  assert.equal(formatCountdown(45 * 60_000), "45m");
  assert.equal(formatCountdown(2 * 3_600_000), "2h");
  assert.equal(formatCountdown(44 * 60_000 + 10_000), "45m", "partial minutes round up");
  assert.equal(formatCountdown(5_000), "1m", "never 0m");
});

test("pre-open, open and after the close on a normal session", () => {
  const pre = marketStatus(at("2026-11-17T06:06:00-05:00"));
  assert.equal(pre.state, "pre");
  assert.equal(pre.label, "US market opens in 3h 24m");
  assert.equal(pre.nextChangeMs, at("2026-11-17T09:30:00-05:00"));

  const open = marketStatus(at("2026-11-17T13:50:00-05:00"));
  assert.equal(open.state, "open");
  assert.equal(open.label, "Market open · closes in 2h 10m");

  assert.equal(marketStatus(at("2026-11-17T09:30:00-05:00")).state, "open", "the bell opens it");
  const after = marketStatus(at("2026-11-17T16:00:00-05:00"));
  assert.equal(after.state, "closed", "the close bell closes it");
  assert.equal(after.label, "Market closed · opens tomorrow 9:30 ET");
  assert.equal(after.nextChangeMs, at("2026-11-18T09:30:00-05:00"));
});

test("weekend, holiday and early close", () => {
  assert.equal(marketStatus(at("2026-11-20T17:00:00-05:00")).label, "Market closed · opens Mon 9:30 ET", "Friday evening");
  assert.equal(marketStatus(at("2026-11-22T11:00:00-05:00")).label, "Market closed · opens tomorrow 9:30 ET", "Sunday");
  assert.equal(marketStatus(at("2026-11-21T08:00:00-05:00")).label, "Market closed · opens Mon 9:30 ET", "Saturday morning: no countdown");

  const thanksgiving = marketStatus(at("2026-11-26T10:00:00-05:00"));
  assert.equal(thanksgiving.state, "closed");
  assert.equal(thanksgiving.label, "Market closed · opens tomorrow 9:30 ET");

  const black = marketStatus(at("2026-11-27T12:15:00-05:00"));
  assert.equal(black.state, "open");
  assert.equal(black.earlyClose, true);
  assert.equal(black.label, "Market open · closes in 45m");
  assert.equal(marketStatus(at("2026-11-27T13:00:00-05:00")).label, "Market closed · opens Mon 9:30 ET", "closed at 13:00");

  // Good Friday 2027 (March 26): Thursday evening names Monday.
  assert.equal(marketStatus(at("2027-03-25T18:00:00-04:00")).label, "Market closed · opens Mon 9:30 ET");
  // Christmas Eve 2026 closes at 13:00; Christmas is a holiday.
  assert.equal(marketStatus(at("2026-12-24T14:00:00-05:00")).label, "Market closed · opens Mon 9:30 ET");
  // July 3 2026 (observed Independence Day) is closed.
  assert.equal(marketStatus(at("2026-07-02T20:00:00-04:00")).label, "Market closed · opens Mon 9:30 ET");
});

test("New York time across daylight saving and from other time zones", () => {
  // 2026-03-09, first session after the spring change: 09:30 EDT = 13:30 UTC.
  assert.equal(marketStatus(Date.parse("2026-03-09T13:29:00Z")).label, "US market opens in 1m");
  assert.equal(marketStatus(Date.parse("2026-03-09T13:30:00Z")).state, "open");
  // 2026-11-02, first session after the autumn change: 09:30 EST = 14:30 UTC.
  assert.equal(marketStatus(Date.parse("2026-11-02T14:00:00Z")).label, "US market opens in 30m");
  // Istanbul (UTC+3) shortly after midnight on Wednesday is still Tuesday evening in New York.
  assert.equal(nyDate(Date.parse("2026-11-18T00:30:00+03:00")), "2026-11-17");
  assert.equal(marketStatus(Date.parse("2026-11-18T00:30:00+03:00")).label, "Market closed · opens tomorrow 9:30 ET");
});
