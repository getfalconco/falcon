import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nyInstantMs } from "../src/study/abnormal.ts";
import {
  abnormalReturn,
  dayReturns,
  eventDay,
  hasItem202,
  percentile,
  sameDayAccessions,
  twoDayReturn,
  windowSessions,
} from "../src/study/earnings-events.ts";

const ny = (ymd: string, hh: number, mm = 0, ss = 0) => nyInstantMs(ymd, hh * 60 + mm) + ss * 1000;

describe("eventDay", () => {
  it("before the open and during the session -> same day", () => {
    assert.equal(eventDay(ny("2024-01-25", 7, 0)), "2024-01-25"); // Thursday, pre-market
    assert.equal(eventDay(ny("2024-01-25", 12, 30)), "2024-01-25");
    assert.equal(eventDay(ny("2024-01-25", 15, 59, 59)), "2024-01-25");
  });

  it("at or after 16:00 -> next session", () => {
    assert.equal(eventDay(ny("2024-01-25", 16, 0)), "2024-01-26");
    assert.equal(eventDay(ny("2024-01-25", 16, 5)), "2024-01-26");
    assert.equal(eventDay(ny("2024-01-26", 16, 30)), "2024-01-29"); // Friday after close -> Monday
  });

  it("weekend -> Monday", () => {
    assert.equal(eventDay(ny("2024-01-27", 10, 0)), "2024-01-29"); // Saturday
    assert.equal(eventDay(ny("2024-01-28", 9, 0)), "2024-01-29"); // Sunday
  });

  it("holiday -> next session, and after close before a holiday skips it", () => {
    assert.equal(eventDay(ny("2024-07-04", 8, 0)), "2024-07-05"); // Independence Day
    assert.equal(eventDay(ny("2023-11-23", 8, 0)), "2023-11-24"); // Thanksgiving -> Friday (early close)
    assert.equal(eventDay(ny("2024-03-28", 16, 10)), "2024-04-01"); // Thursday before Good Friday
    assert.equal(eventDay(ny("2025-01-09", 8, 0)), "2025-01-10"); // national day of mourning (Carter)
  });

  it("early close: 13:00 is the close", () => {
    // 2023-11-24, day after Thanksgiving, closes 13:00
    assert.equal(eventDay(ny("2023-11-24", 12, 59)), "2023-11-24");
    assert.equal(eventDay(ny("2023-11-24", 13, 0)), "2023-11-27");
    assert.equal(eventDay(ny("2023-11-24", 14, 0)), "2023-11-27");
    // 2024-07-03 (Wednesday) closes 13:00; next session skips July 4
    assert.equal(eventDay(ny("2024-07-03", 13, 30)), "2024-07-05");
    // 2024-12-24 closes 13:00; Christmas closed
    assert.equal(eventDay(ny("2024-12-24", 13, 1)), "2024-12-26");
  });

  it("winter time: 16:00 EST is 21:00 UTC", () => {
    assert.equal(eventDay(Date.parse("2024-01-25T20:59:00Z")), "2024-01-25");
    assert.equal(eventDay(Date.parse("2024-01-25T21:00:00Z")), "2024-01-26");
    // summer: 16:00 EDT is 20:00 UTC
    assert.equal(eventDay(Date.parse("2024-07-25T19:59:00Z")), "2024-07-25");
    assert.equal(eventDay(Date.parse("2024-07-25T20:00:00Z")), "2024-07-26");
  });
});

describe("windowSessions", () => {
  it("base and d1 skip weekends and holidays", () => {
    assert.deepEqual(windowSessions("2024-01-29"), { base: "2024-01-26", d0: "2024-01-29", d1: "2024-01-30" });
    assert.deepEqual(windowSessions("2024-07-05"), { base: "2024-07-03", d0: "2024-07-05", d1: "2024-07-08" });
    assert.deepEqual(windowSessions("2024-03-27"), { base: "2024-03-26", d0: "2024-03-27", d1: "2024-03-28" });
    assert.deepEqual(windowSessions("2024-03-28"), { base: "2024-03-27", d0: "2024-03-28", d1: "2024-04-01" });
  });
});

describe("two-day abnormal return", () => {
  it("compounds d0 and d1", () => {
    // stock: 100 -> 110 (+10%) -> 99 (-10%) = -1%
    const s = twoDayReturn(100, 110, 99)!;
    assert.ok(Math.abs(s - -0.01) < 1e-12);
    assert.ok(Math.abs(s - ((1 + 0.1) * (1 - 0.1) - 1)) < 1e-12);
    // etf: 50 -> 51 (+2%) -> 52.02 (+2%) = 4.04%
    const e = twoDayReturn(50, 51, 52.02)!;
    assert.ok(Math.abs(e - 0.0404) < 1e-12);
    const a = abnormalReturn(s, e)!;
    assert.ok(Math.abs(a - (0.99 - 1.0404)) < 1e-12);
  });

  it("missing or bad closes give null", () => {
    assert.equal(twoDayReturn(null, 1, 1), null);
    assert.equal(twoDayReturn(1, undefined, 1), null);
    assert.equal(twoDayReturn(1, 1, 0), null);
    assert.equal(twoDayReturn(1, Number.NaN, 1), null);
    assert.equal(abnormalReturn(null, 0.1), null);
    assert.equal(abnormalReturn(0.1, null), null);
  });
});

describe("single-day returns", () => {
  it("d0 and d1 compose to the two-day return, to the bit", () => {
    const cases: Array<[number, number, number]> = [
      [100, 110, 99],
      [50, 51, 52.02],
      [182.63, 171.05, 168.29],
      [0.37, 0.41, 0.395],
      [1234.5, 1234.5, 1300.25],
    ];
    for (const [b, c0, c1] of cases) {
      const r = dayReturns(b, c0, c1);
      assert.equal(r.d0d1, twoDayReturn(b, c0, c1));
      assert.equal(r.d0d1, (1 + r.d0!) * (1 + r.d1!) - 1);
      assert.ok(Math.abs(r.d0! - (c0 / b - 1)) < 1e-15);
      assert.ok(Math.abs(r.d1! - (c1 / c0 - 1)) < 1e-15);
    }
    // stock 100 -> 110 -> 99, ETF 50 -> 51 -> 52.02: abnormal d0 = 10% - 2%, d1 = -10% - 2%.
    const s = dayReturns(100, 110, 99);
    const e = dayReturns(50, 51, 52.02);
    assert.ok(Math.abs(s.d0! - e.d0! - 0.08) < 1e-12);
    assert.ok(Math.abs(s.d1! - e.d1! - -0.12) < 1e-12);
    // The two-day abnormal compounds each leg first: not the sum of the single days.
    const two = abnormalReturn(s.d0d1, e.d0d1)!;
    assert.ok(Math.abs(two - (0.99 - 1.0404)) < 1e-12);
    assert.ok(Math.abs(two - ((s.d0! - e.d0!) + (s.d1! - e.d1!))) > 0.005);
  });

  it("d0 stands without d1; missing closes give nulls", () => {
    assert.deepEqual(dayReturns(100, 105, null), { d0: 0.050000000000000044, d1: null, d0d1: null });
    assert.deepEqual(dayReturns(null, 105, 110), { d0: null, d1: 110 / 105 - 1, d0d1: null });
    assert.deepEqual(dayReturns(100, 0, 110), { d0: null, d1: null, d0d1: null });
  });
});

describe("helpers", () => {
  it("item 2.02 detection", () => {
    assert.equal(hasItem202("2.02,9.01"), true);
    assert.equal(hasItem202("7.01, 2.02"), true);
    assert.equal(hasItem202("2.03,9.01"), false);
    assert.equal(hasItem202(""), false);
  });

  it("same-day groups", () => {
    const got = sameDayAccessions([
      { ticker: "A", accession: "1", eventDate: "2024-01-02" },
      { ticker: "A", accession: "2", eventDate: "2024-01-02" },
      { ticker: "A", accession: "3", eventDate: "2024-01-03" },
      { ticker: "B", accession: "4", eventDate: "2024-01-02" },
    ]);
    assert.deepEqual([...got].sort(), ["1", "2"]);
  });

  it("percentile", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.05), 1);
    assert.equal(percentile([], 0.5), null);
  });
});
