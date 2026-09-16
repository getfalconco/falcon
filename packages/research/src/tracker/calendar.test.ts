import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addTradingDays,
  isCatchUpRun,
  classifySession,
  isEarlyClose,
  isInEarningsWindow,
  isMarketHoliday,
  isTradingDay,
  lastCompletedTradingDay,
  marketHolidays,
  nyWallTimeToUtc,
  previousTradingDay,
  sessionTimes,
  tradingDaysBetween,
} from "./calendar.js";

/** Expected dates below were derived by hand from published NYSE calendars. */

describe("US market holidays", () => {
  it("2026 full-day holidays (observed dates)", () => {
    const h = marketHolidays(2026);
    const expected = [
      "2026-01-01", // New Year's Day (Thu)
      "2026-01-19", // MLK Day
      "2026-02-16", // Washington's Birthday
      "2026-04-03", // Good Friday (Easter 2026 = Apr 5)
      "2026-05-25", // Memorial Day
      "2026-06-19", // Juneteenth (Fri)
      "2026-07-03", // Independence Day observed (Jul 4 = Sat)
      "2026-09-07", // Labor Day
      "2026-11-26", // Thanksgiving
      "2026-12-25", // Christmas (Fri)
    ];
    assert.deepEqual([...h].sort(), expected);
  });

  it("Sunday holidays observe Monday: Jul 4 2027 → Mon Jul 5", () => {
    assert.ok(isMarketHoliday("2027-07-05"));
    assert.ok(!isMarketHoliday("2027-07-04"));
  });

  it("Saturday Christmas observes Friday: Dec 25 2027 → Fri Dec 24", () => {
    assert.ok(isMarketHoliday("2027-12-24"));
  });

  it("Saturday New Year's is NOT observed (Jan 1 2022 rule)", () => {
    assert.ok(!isMarketHoliday("2021-12-31"));
    assert.ok(isTradingDay("2021-12-31"));
    assert.ok(!isMarketHoliday("2022-01-03"));
  });
});

describe("early-close days (13:00 ET)", () => {
  it("day after Thanksgiving 2026", () => {
    assert.ok(isEarlyClose("2026-11-27"));
  });

  it("Christmas Eve 2026 (Thu) is an early close", () => {
    assert.ok(isEarlyClose("2026-12-24"));
  });

  it("Jul 3 2026 is the observed holiday, NOT an early close", () => {
    assert.ok(!isEarlyClose("2026-07-03"));
    assert.ok(!isTradingDay("2026-07-03"));
  });

  it("Dec 24 2027 is the observed Christmas holiday, NOT an early close", () => {
    assert.ok(!isEarlyClose("2027-12-24"));
  });

  it("early-close close time is 18:00 UTC in November (13:00 EST)", () => {
    const times = sessionTimes("2026-11-27");
    assert.ok(times != null);
    assert.equal(times.closeUtc.toISOString(), "2026-11-27T18:00:00.000Z");
  });
});

describe("DST transitions (§8.1: NY–UTC offset shifts 4↔5 hours)", () => {
  it("open is 14:30 UTC under EST (Mar 6 2026), 13:30 UTC under EDT (Mar 9 2026)", () => {
    assert.equal(sessionTimes("2026-03-06")?.openUtc.toISOString(), "2026-03-06T14:30:00.000Z");
    assert.equal(sessionTimes("2026-03-09")?.openUtc.toISOString(), "2026-03-09T13:30:00.000Z");
  });

  it("close is 20:00 UTC under EDT (Oct 30 2026), 21:00 UTC under EST (Nov 2 2026)", () => {
    assert.equal(sessionTimes("2026-10-30")?.closeUtc.toISOString(), "2026-10-30T20:00:00.000Z");
    assert.equal(sessionTimes("2026-11-02")?.closeUtc.toISOString(), "2026-11-02T21:00:00.000Z");
  });

  it("nyWallTimeToUtc is correct on the DST-start day itself", () => {
    // Mar 8 2026, 13:00 NY wall time — already EDT → 17:00 UTC.
    assert.equal(
      nyWallTimeToUtc("2026-03-08", 13, 0).toISOString(),
      "2026-03-08T17:00:00.000Z",
    );
  });
});

describe("session classification", () => {
  it("regular / pre / post / closed on a normal day", () => {
    assert.equal(classifySession(new Date("2026-08-20T14:31:55Z")).session, "regular");
    assert.equal(classifySession(new Date("2026-08-20T12:00:00Z")).session, "pre");
    assert.equal(classifySession(new Date("2026-08-20T21:30:00Z")).session, "post");
    assert.equal(classifySession(new Date("2026-08-21T01:00:00Z")).session, "closed");
  });

  it("weekend is closed with no trading day", () => {
    const info = classifySession(new Date("2026-08-22T15:00:00Z"));
    assert.equal(info.session, "closed");
    assert.equal(info.tradingDayYmd, null);
  });

  it("early-close day: 13:30 ET is already post-session", () => {
    assert.equal(classifySession(new Date("2026-11-27T18:30:00Z")).session, "post");
  });
});

describe("trading-day arithmetic", () => {
  it("addTradingDays skips Thanksgiving and the weekend", () => {
    assert.equal(addTradingDays("2026-11-25", 1), "2026-11-27");
    assert.equal(addTradingDays("2026-11-25", 2), "2026-11-30");
    assert.equal(addTradingDays("2026-11-30", -2), "2026-11-25");
  });

  it("previousTradingDay skips MLK Monday + weekend", () => {
    assert.equal(previousTradingDay("2026-01-20"), "2026-01-16");
  });

  it("tradingDaysBetween counts (from, to]", () => {
    assert.equal(tradingDaysBetween("2026-11-24", "2026-11-30"), 3);
    assert.equal(tradingDaysBetween("2026-11-24", "2026-11-24"), 0);
  });

  it("lastCompletedTradingDay flips at the actual close", () => {
    assert.equal(lastCompletedTradingDay(new Date("2026-08-20T19:00:00Z")), "2026-08-19");
    assert.equal(lastCompletedTradingDay(new Date("2026-08-20T21:00:00Z")), "2026-08-20");
    // Early close: by 18:00 UTC on Nov 27 2026 the day is complete.
    assert.equal(lastCompletedTradingDay(new Date("2026-11-27T18:00:00Z")), "2026-11-27");
  });
});

describe("catch-up classification (T3)", () => {
  it("a close-run on the measured session's own NY date is live, not catch-up", () => {
    // 2026-08-20 16:05 ET — the normal post-close run.
    assert.equal(isCatchUpRun(new Date("2026-08-20T20:05:00Z"), "2026-08-20"), false);
    // Late evening of the same NY date still counts as live.
    assert.equal(isCatchUpRun(new Date("2026-08-21T02:00:00Z"), "2026-08-20"), false); // 22:00 ET Aug 20
  });

  it("a run after NY midnight is a catch-up for the prior session", () => {
    // 03:39 ET the next morning — the overnight-startup case from the stream.
    assert.equal(isCatchUpRun(new Date("2026-08-21T07:39:00Z"), "2026-08-20"), true);
  });

  it("weekend evaluation of Friday's session is a catch-up", () => {
    assert.equal(isCatchUpRun(new Date("2026-08-22T15:00:00Z"), "2026-08-21"), true);
  });
});

describe("earnings hot window", () => {
  const due = "2026-08-26T20:00:00.000Z"; // NVDA AMC
  const sched = [{ dueAt: due, confirmed: true }];

  it("opens two hours before the release and closes two hours after", () => {
    assert.equal(isInEarningsWindow(sched, new Date("2026-08-26T18:30:00.000Z"), 2), true);
    assert.equal(isInEarningsWindow(sched, new Date("2026-08-26T20:05:00.000Z"), 2), true);
    assert.equal(isInEarningsWindow(sched, new Date("2026-08-26T21:59:00.000Z"), 2), true);
    assert.equal(isInEarningsWindow(sched, new Date("2026-08-26T17:30:00.000Z"), 2), false);
    assert.equal(isInEarningsWindow(sched, new Date("2026-08-26T22:30:00.000Z"), 2), false);
  });

  it("only confirmed dates count — a provider projection must not open the lane", () => {
    const projected = [{ dueAt: due, confirmed: false }];
    assert.equal(isInEarningsWindow(projected, new Date("2026-08-26T20:00:00.000Z"), 2), false);
  });

  it("empty, missing and unparseable entries are simply not hot", () => {
    assert.equal(isInEarningsWindow([], new Date(due), 2), false);
    assert.equal(isInEarningsWindow(null, new Date(due), 2), false);
    assert.equal(isInEarningsWindow([{ dueAt: "not a date", confirmed: true }], new Date(due), 2), false);
  });

  it("the width is config — a wider window catches an early release", () => {
    const early = new Date("2026-08-26T16:00:00.000Z");
    assert.equal(isInEarningsWindow(sched, early, 2), false);
    assert.equal(isInEarningsWindow(sched, early, 5), true);
  });
});
