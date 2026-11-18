// The pre-earnings straddle (src/options/earnings-straddle.ts) and the daily job's snapshot sessions (daily.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { earningsStraddle, releaseForSession, releaseSessions, releasesFromQuote, straddleExpiry, timeOfDayAt, usableMid, type StraddleRow } from "../src/options/earnings-straddle.ts";
import { snapshotsToFill, straddlesDue } from "../src/options/daily.ts";
import { fromMetrics, toMetrics } from "../src/options/store.ts";
import type { TickerOptions } from "../src/options/cards.ts";
import { straddleMovePct } from "../src/study/scoreboard.ts";

describe("release sessions (event-day rule of study/earnings-events.ts)", () => {
  it("after the close: the next session reacts, the snapshot is the release day", () => {
    // Thursday 2026-11-19 after the close.
    assert.deepEqual(releaseSessions({ date: "2026-11-19", time: "after_close" }), { reactEarliest: "2026-11-20", reactLatest: "2026-11-20", snapshotSession: "2026-11-19" });
  });

  it("before the open: that session reacts, the snapshot is the session before", () => {
    assert.deepEqual(releaseSessions({ date: "2026-11-17", time: "before_open" }), { reactEarliest: "2026-11-17", reactLatest: "2026-11-17", snapshotSession: "2026-11-16" });
    // A Monday before the open: Friday's 15:45.
    assert.equal(releaseSessions({ date: "2026-11-16", time: "before_open" }).snapshotSession, "2026-11-13");
    // During the session: it reacts the same day.
    assert.equal(releaseSessions({ date: "2026-11-17", time: "during" }).reactEarliest, "2026-11-17");
  });

  it("unknown time: snapshot before the earliest reaction, expiry past the latest", () => {
    const r = releaseSessions({ date: "2026-11-19", time: "unknown" });
    assert.deepEqual(r, { reactEarliest: "2026-11-19", reactLatest: "2026-11-20", snapshotSession: "2026-11-18" });
  });

  it("weekend and holiday releases react on the next session", () => {
    assert.equal(releaseSessions({ date: "2026-11-21", time: "before_open" }).reactEarliest, "2026-11-23");
    // Wednesday before Thanksgiving after the close: Friday 2026-11-27 (an early close) reacts.
    assert.deepEqual(releaseSessions({ date: "2026-11-25", time: "after_close" }), { reactEarliest: "2026-11-27", reactLatest: "2026-11-27", snapshotSession: "2026-11-25" });
  });
});

describe("straddleExpiry: the first listed expiry covering the reaction", () => {
  it("earnings Friday after the close: next week's expiry, not that Friday's", () => {
    assert.equal(straddleExpiry(["2026-11-20", "2026-11-27", "2026-12-18"], { date: "2026-11-20", time: "after_close" }), "2026-11-27");
  });
  it("earnings Thursday after the close: that Friday's expiry", () => {
    assert.equal(straddleExpiry(["2026-11-18", "2026-11-20", "2026-11-27"], { date: "2026-11-19", time: "after_close" }), "2026-11-20");
  });
  it("earnings before the open: the reaction day's own expiry covers it (it stops at that close)", () => {
    assert.equal(straddleExpiry(["2026-11-16", "2026-11-18", "2026-11-20"], { date: "2026-11-18", time: "before_open" }), "2026-11-18");
  });
  it("holiday Friday (Good Friday 2027-03-26): the Thursday weekly expires before a Thursday-evening release reacts", () => {
    // Thursday 2027-03-25 after the close reacts Monday 2027-03-29; the week's options expire Thursday.
    assert.equal(releaseSessions({ date: "2027-03-25", time: "after_close" }).reactEarliest, "2027-03-29");
    assert.equal(straddleExpiry(["2027-03-25", "2027-04-01", "2027-04-16"], { date: "2027-03-25", time: "after_close" }), "2027-04-01");
    // Before the open that Thursday: the Thursday expiry covers it.
    assert.equal(straddleExpiry(["2027-03-25", "2027-04-01"], { date: "2027-03-25", time: "before_open" }), "2027-03-25");
  });
  it("Thanksgiving Friday (an early close) is covered by its own expiry", () => {
    assert.equal(straddleExpiry(["2026-11-27", "2026-12-04"], { date: "2026-11-25", time: "after_close" }), "2026-11-27");
  });
  it("no listed expiry after the reaction: null", () => {
    assert.equal(straddleExpiry(["2026-11-20"], { date: "2026-11-20", time: "after_close" }), null);
  });
});

describe("straddle math", () => {
  const row = (right: "C" | "P", strike: number, expiration: string, bid: number | null, ask: number | null): StraddleRow => ({ right, strike, expiration, bid, ask });
  const meta = { asOfMs: Date.parse("2026-11-19T20:45:00Z"), sourceMinute: "2026-11-19 15:45 ET", source: "OPRA.PILLAR cbbo-1m via Databento" };
  const rows = [
    row("C", 145, "2026-11-20", 9, 9.4),
    row("P", 145, "2026-11-20", 3.9, 4.1),
    row("C", 150, "2026-11-20", 5.8, 6.2),
    row("P", 150, "2026-11-20", 5.6, 6.0),
    row("C", 155, "2026-11-20", 3.4, 3.6),
    row("P", 155, "2026-11-20", 8.2, 8.6),
    // An earlier expiry, nearer spot, that does not cover the reaction.
    row("C", 151, "2026-11-19", 1, 1.2),
    row("P", 151, "2026-11-19", 1, 1.2),
  ];

  it("(call mid + put mid) / spot at the strike nearest spot, in the covering expiry", () => {
    const s = earningsStraddle(rows, 151, { date: "2026-11-19", time: "after_close" }, meta)!;
    assert.equal(s.expiry, "2026-11-20");
    assert.equal(s.strike, 150);
    assert.equal(s.call_mid, 6);
    assert.equal(s.put_mid, 5.8);
    assert.equal(s.implied_move, Math.round((11.8 / 151) * 1e6) / 1e6);
    assert.equal(s.spot, 151);
    assert.equal(s.as_of, "2026-11-19T20:45:00.000Z");
    assert.equal(s.dte, 1.01);
    assert.equal(s.source_minute, "2026-11-19 15:45 ET");
    assert.equal(s.reaction_day, "2026-11-20");
    // The scoreboard reads it as is.
    assert.ok(Math.abs(straddleMovePct(s, "2026-11-20")! - (11.8 / 151) * 100) < 1e-3);
  });

  it("skips one-sided quotes; ties go to the lower strike; nothing usable is null", () => {
    const noBid = rows.map((r) => (r.strike === 150 && r.right === "P" ? { ...r, bid: 0 } : r));
    assert.equal(earningsStraddle(noBid, 151, { date: "2026-11-19", time: "after_close" }, meta)!.strike, 155);
    assert.equal(earningsStraddle(rows, 152.5, { date: "2026-11-19", time: "after_close" }, meta)!.strike, 150);
    assert.equal(earningsStraddle(rows.slice(0, 1), 151, { date: "2026-11-19", time: "after_close" }, meta), null);
    assert.equal(earningsStraddle(rows, 0, { date: "2026-11-19", time: "after_close" }, meta), null);
    assert.equal(usableMid(1, 0.9), null);
    assert.equal(usableMid(null, 1), null);
    assert.equal(usableMid(1, 1.2), 1.1);
  });
});

describe("releases from Yahoo's quote", () => {
  it("next and latest dates with their time of day; an estimate has no time", () => {
    // NVDA: 2026-11-17 21:00 UTC = 16:00 New York.
    assert.deepEqual(releasesFromQuote({ symbol: "NVDA", earningsTimestamp: 1794949200, earningsTimestampStart: 1794949200, isEarningsDateEstimate: false }), [{ date: "2026-11-17", time: "after_close" }]);
    // WMT before the open (13:30 UTC = 08:30 New York).
    assert.deepEqual(releasesFromQuote({ earningsTimestampStart: Date.parse("2026-11-19T13:30:00Z") / 1000 }), [{ date: "2026-11-19", time: "before_open" }]);
    const est = releasesFromQuote({ earningsTimestamp: Date.parse("2026-11-02T21:00:00Z") / 1000, earningsTimestampStart: Date.parse("2027-01-28T21:00:00Z") / 1000, isEarningsDateEstimate: true });
    assert.deepEqual(est, [{ date: "2026-11-02", time: "unknown" }, { date: "2027-01-28", time: "unknown" }]);
    assert.equal(timeOfDayAt("2026-11-27", 13 * 60 + 5), "after_close");
  });

  it("releaseForSession / straddlesDue: only the session before the reaction", () => {
    const rel = new Map([
      ["NVDA", [{ date: "2026-11-17", time: "after_close" as const }]],
      ["WMT", [{ date: "2026-11-19", time: "before_open" as const }]],
      ["HD", [{ date: "2026-11-17", time: "before_open" as const }]],
    ]);
    assert.deepEqual([...straddlesDue(rel, "2026-11-17").keys()], ["NVDA"]);
    assert.deepEqual([...straddlesDue(rel, "2026-11-16").keys()], ["HD"]);
    assert.deepEqual([...straddlesDue(rel, "2026-11-18").keys()], ["WMT"]);
    assert.equal(releaseForSession(rel.get("NVDA")!, "2026-11-16"), null);
  });
});

describe("the stored daily snapshot is always the session's 15:45 (12:45 early close)", () => {
  it("a late run (Tuesday 03:00 UTC) fills Monday and the sessions before at their 15:45", () => {
    const s = snapshotsToFill(Date.parse("2026-11-17T03:00:00Z"), Date.parse("2026-11-17T00:00:00Z"), 3);
    assert.deepEqual(s.map((x) => x.label), ["2026-11-12 15:45 ET", "2026-11-13 15:45 ET", "2026-11-16 15:45 ET"]);
    assert.ok(s.every((x) => x.minute === 945));
    assert.equal(s[2]!.asOfMs, Date.parse("2026-11-16T20:45:00Z"));
  });

  it("intraday, with Databento's range at the open: never today's latest minute, Friday's 15:45", () => {
    const s = snapshotsToFill(Date.parse("2026-11-16T19:00:00Z"), Date.parse("2026-11-16T14:30:00Z"), 1);
    assert.deepEqual(s.map((x) => x.label), ["2026-11-13 15:45 ET"]);
  });

  it("days later (a missed run, retried) still the same minute; early close at 12:45", () => {
    const s = snapshotsToFill(Date.parse("2026-12-01T12:00:00Z"), null, 4);
    // Tuesday 07:00 New York: that day's 15:45 has not happened; the four sessions to Monday 2026-11-30 are filled.
    assert.deepEqual(s.map((x) => x.label), ["2026-11-24 15:45 ET", "2026-11-25 15:45 ET", "2026-11-27 12:45 ET", "2026-11-30 15:45 ET"]);
  });

  it("toMetrics keeps earnings_straddle; fromMetrics gives it back", () => {
    const st = earningsStraddle(
      [
        { right: "C", strike: 100, expiration: "2026-11-20", bid: 2, ask: 2.2 },
        { right: "P", strike: 100, expiration: "2026-11-20", bid: 1.9, ask: 2.1 },
      ],
      100,
      { date: "2026-11-19", time: "after_close" },
      { asOfMs: Date.parse("2026-11-19T20:45:00Z"), sourceMinute: "2026-11-19 15:45 ET", source: "test" },
    )!;
    const rec: TickerOptions = { ticker: "X", date: "2026-11-19", asOf: "2026-11-19T20:45:00.000Z", spot: 100, spotSource: "itch", atmIv30: 0.5, skew: null, cpSpread: null, beta: null, vix: null, term: [{ expiration: "2026-11-20", days: 1, iv: 0.9 }], earningsStraddle: st };
    const m = toMetrics(rec);
    assert.equal(m.earnings_straddle?.implied_move, 0.041);
    assert.deepEqual(fromMetrics("X", "2026-11-19", JSON.parse(JSON.stringify(m))).earningsStraddle, st);
    assert.equal(toMetrics({ ...rec, earningsStraddle: undefined }).earnings_straddle, undefined);
  });
});
