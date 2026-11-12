import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RippleCard, RippleHit } from "@falcon/ripple";
import { revenueReleaseDate } from "../src/events.ts";
import {
  cardHistory,
  eventReactionIndex,
  matchQuarters,
  nySession,
  reactionIndex,
  summarizeMoves,
  windowMove,
  windowTradingDays,
} from "../src/history.ts";
import type { DailyClose, MarketData, ReportedQuarter } from "../src/market.ts";
import { earningsReleases, mayBeMonthlyRevenue, type PastEvent } from "../src/past-events.ts";
import type { Filing } from "../src/sec.ts";

/** Weekdays from `from` to `to`, less `holidays`. */
function sessions(from: string, to: string, holidays: string[] = []): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    const ymd = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.includes(ymd)) out.push(ymd);
  }
  return out;
}

describe("New York sessions", () => {
  it("reads EDGAR instants in New York time, daylight and winter", () => {
    // Microchip 2026-11-05 (EST): 16:18 New York.
    assert.deepEqual(nySession(Date.parse("2026-11-05T21:18:06Z")), { date: "2026-11-05", session: "after_close" });
    // Microchip 2024-08-01 (EDT): 16:12 New York.
    assert.deepEqual(nySession(Date.parse("2024-08-01T20:12:10Z")), { date: "2024-08-01", session: "after_close" });
    // Onto 2026-04-16 (EDT): 09:02, before the open.
    assert.deepEqual(nySession(Date.parse("2026-04-16T13:02:14Z")), { date: "2026-04-16", session: "before_open" });
    // TSMC's 6-K at 06:01 EST.
    assert.equal(nySession(Date.parse("2026-11-10T12:01:33Z")).session, "before_open");
  });

  it("puts the open and the close on the right side", () => {
    assert.equal(nySession(Date.parse("2026-07-15T13:29:59Z")).session, "before_open"); // 09:29 EDT
    assert.equal(nySession(Date.parse("2026-07-15T13:30:00Z")).session, "during"); // 09:30 EDT
    assert.equal(nySession(Date.parse("2026-07-15T19:59:00Z")).session, "during"); // 15:59 EDT
    assert.equal(nySession(Date.parse("2026-07-15T20:00:00Z")).session, "after_close"); // 16:00 EDT
    assert.equal(nySession(Date.parse("2026-01-15T14:29:00Z")).session, "before_open"); // 09:29 EST
    assert.equal(nySession(Date.parse("2026-01-15T21:00:00Z")).session, "after_close"); // 16:00 EST
  });

  it("dates a late-evening release by New York's calendar, not UTC's", () => {
    // 21:30 EDT on 2026-07-15 is 01:30 UTC on the 16th.
    assert.deepEqual(nySession(Date.parse("2026-07-16T01:30:00Z")), { date: "2026-07-15", session: "after_close" });
  });
});

describe("reaction days", () => {
  // 2026-07-03 is a market holiday (Independence Day observed).
  const cal = sessions("2026-06-29", "2026-07-17", ["2026-07-03"]);
  const day = (i: number | null) => (i === null ? null : cal[i]);

  it("trades a release before the open or during the session that day", () => {
    assert.equal(day(reactionIndex(cal, "2026-07-08", "before_open")), "2026-07-08");
    assert.equal(day(reactionIndex(cal, "2026-07-08", "during")), "2026-07-08");
  });

  it("trades a release after the close the next session", () => {
    assert.equal(day(reactionIndex(cal, "2026-07-08", "after_close")), "2026-07-09");
    // Thursday after the close, Friday a holiday: Monday.
    assert.equal(day(reactionIndex(cal, "2026-07-02", "after_close")), "2026-07-06");
  });

  it("moves a release on a weekend or holiday to the next session", () => {
    assert.equal(day(reactionIndex(cal, "2026-07-03", "before_open")), "2026-07-06");
    assert.equal(day(reactionIndex(cal, "2026-07-11", "during")), "2026-07-13");
  });

  it("needs a session before the reaction day and one on or after it", () => {
    assert.equal(reactionIndex(cal, "2026-06-29", "before_open"), null);
    assert.equal(day(reactionIndex(cal, "2026-06-29", "after_close")), "2026-06-30");
    assert.equal(reactionIndex(cal, "2026-07-17", "after_close"), null);
  });

  it("takes an earlier day from the release's own record, never a later one", () => {
    const edgar = Date.parse("2026-07-09T12:05:00Z"); // 08:05 EDT on the 9th
    assert.equal(day(eventReactionIndex(cal, edgar, null)), "2026-07-09");
    // Released the morning before, 8-K filed a day late.
    assert.equal(day(eventReactionIndex(cal, edgar, { date: "2026-07-08", time: "before_open" })), "2026-07-08");
    // Released after the close the day before: the 9th either way.
    assert.equal(day(eventReactionIndex(cal, edgar, { date: "2026-07-08", time: "after_close" })), "2026-07-09");
    // A record without a time, or dated later, does not move it.
    assert.equal(day(eventReactionIndex(cal, edgar, { date: "2026-07-08", time: "unknown" })), "2026-07-09");
    assert.equal(day(eventReactionIndex(cal, edgar, { date: "2026-07-10", time: "before_open" })), "2026-07-09");
  });
});

describe("windows", () => {
  it("measures up to the upper end of the hit's window, capped at 20 sessions", () => {
    assert.equal(windowTradingDays("1 to 5 trading days"), 5);
    assert.equal(windowTradingDays("1 to 4 weeks"), 20);
    assert.equal(windowTradingDays("1 to 3 months"), 20);
    assert.equal(windowTradingDays("2 weeks"), 10);
    assert.equal(windowTradingDays("1 day"), 1);
    assert.equal(windowTradingDays("the next few sessions"), 5);
  });

  const cal = sessions("2026-07-06", "2026-07-17");
  const closes = (xs: number[]) => new Map(cal.map((d, i) => [d, xs[i]!] as [string, number]).filter(([, v]) => v !== undefined));

  it("goes from the close before the reaction day to the close windowDays sessions on", () => {
    const hit = closes([100, 110, 99, 120, 121, 122, 130, 131, 132, 133]);
    const spy = closes([400, 404, 400, 400, 400, 400, 400, 400, 400, 400]);
    const one = windowMove(cal, 1, 1, hit, spy)!;
    assert.equal(one.fromDate, "2026-07-06");
    assert.equal(one.toDate, "2026-07-07");
    assert.ok(Math.abs(one.hitPct - 10) < 1e-9);
    assert.ok(Math.abs(one.benchPct - 1) < 1e-9);
    assert.ok(Math.abs(one.adjustedPct - 9) < 1e-9);
    const five = windowMove(cal, 1, 5, hit, spy)!;
    assert.equal(five.toDate, "2026-07-13");
    assert.ok(Math.abs(five.hitPct - 22) < 1e-9);
  });

  it("is null for a window not finished yet or a day with no close", () => {
    const hit = closes([100, 110, 99, 120, 121, 122, 130, 131, 132, 133]);
    const spy = closes([400, 404, 400, 400, 400, 400, 400, 400, 400, 400]);
    assert.equal(windowMove(cal, 8, 5, hit, spy), null);
    const gap = new Map(hit);
    gap.delete("2026-07-06");
    assert.equal(windowMove(cal, 1, 1, gap, spy), null);
  });
});

describe("stats", () => {
  const moves = (xs: number[]) => xs.map((adjustedPct) => ({ adjustedPct }));

  it("counts the implied way and keeps the average's own sign", () => {
    const xs = moves([2, 3, -1, 4, 0.5, -2, 1, 2.5, 5]);
    const up = summarizeMoves(xs, "up", 5)!;
    assert.equal(up.sample, 9);
    assert.equal(up.hitRate, 0.7778);
    assert.equal(Math.round(up.hitRate * up.sample), 7);
    assert.equal(up.avgMovePct, 1.67);
    assert.equal(up.windowDays, 5);
    const down = summarizeMoves(xs, "down", 5)!;
    assert.equal(Math.round(down.hitRate * down.sample), 2);
    assert.equal(down.avgMovePct, 1.67);
  });

  it("does not count a flat move as either way", () => {
    const h = summarizeMoves(moves([0, 0, 0, 1, -1, 2]), "up", 1)!;
    assert.equal(Math.round(h.hitRate * h.sample), 2);
  });

  it("is null under 6 events and for an unclear hit", () => {
    assert.equal(summarizeMoves(moves([1, 2, 3, 4, 5]), "up", 5), null);
    assert.equal(summarizeMoves(moves([1, 2, 3, 4, 5, 6]), "unclear", 5), null);
    assert.notEqual(summarizeMoves(moves([1, 2, 3, 4, 5, 6]), "up", 5), null);
  });
});

describe("past events", () => {
  const filing = (over: Partial<Filing>): Filing => ({
    cik: "0000827054",
    companyName: "MICROCHIP TECHNOLOGY INC",
    form: "8-K",
    accession: "a",
    filedAt: "2026-08-06",
    acceptedAt: "2026-08-06T20:17:56.000Z",
    items: ["2.02", "9.01"],
    primaryDocument: "x.htm",
    primaryDocDescription: "8-K",
    url: "https://www.sec.gov/x.htm",
    indexUrl: "https://www.sec.gov/x-index.htm",
    ...over,
  });

  it("takes 8-K item 2.02 filings as earnings releases", () => {
    const got = earningsReleases([
      filing({ accession: "a" }),
      filing({ accession: "b", items: ["5.02"] }),
      filing({ accession: "c", form: "10-Q" }),
      filing({ accession: "d", acceptedAt: null }),
    ]);
    assert.deepEqual(got.map((e) => e.accession), ["a"]);
  });

  it("looks for monthly revenue only in 6-Ks of the first half of a month", () => {
    assert.equal(mayBeMonthlyRevenue({ form: "6-K", filedAt: "2026-11-10" }), true);
    assert.equal(mayBeMonthlyRevenue({ form: "6-K", filedAt: "2026-11-24" }), false);
    assert.equal(mayBeMonthlyRevenue({ form: "8-K", filedAt: "2026-11-10" }), false);
  });

  it("matches each release to the EPS record within a day, the nearest once", () => {
    const ev = (accession: string, acceptedAt: string): PastEvent => ({ kind: "earnings", accession, acceptedAt, sign: null });
    const quarters: ReportedQuarter[] = [
      { date: "2025-02-06", time: "after_close", surprisePct: -25.9 },
      { date: "2025-05-08", time: "after_close", surprisePct: 0 },
      { date: "2025-08-08", time: "unknown", surprisePct: 4.2 },
    ];
    const got = matchQuarters(
      [
        ev("feb", "2025-02-06T21:16:35Z"),
        ev("prelim", "2025-04-01T20:00:00Z"),
        ev("may", "2025-05-08T20:17:05Z"),
        ev("aug", "2025-08-07T20:20:13Z"),
      ],
      quarters,
    );
    const sign = Object.fromEntries(got.map((g) => [g.event.accession, g.event.sign]));
    assert.deepEqual(sign, { feb: -1, prelim: null, may: 0, aug: 1 });
  });

  it("reads the release date from a Taiwan monthly report's own text", () => {
    assert.equal(revenueReleaseDate("TSMC October 2023 Revenue Report HSINCHU, Taiwan, R.O.C. - Nov. 10, 2023 - TSMC (TWSE: 2330) today announced"), "2023-11-10");
    assert.equal(revenueReleaseDate("Announces Monthly Net Revenues* Taipei, Taiwan, R.O.C., november 10, 2026 – ASE Technology"), "2026-11-10");
    assert.equal(revenueReleaseDate("99.1 Announcement on 2026/11/05: October Revenue Exhibit 99.1"), "2026-11-05");
    assert.equal(revenueReleaseDate("99.1 Announcement on 2026/09/03: UMC will attend investor conferences"), null);
  });
});

describe("a card's history", () => {
  const cal = sessions("2021-01-04", "2026-11-11", ["2026-07-03"]);
  // SPY flat; the hit +2% on the reaction day of a beat, -1% after a miss, flat otherwise.
  const spy: DailyClose[] = cal.map((date) => ({ date, close: 500 }));
  const beats = ["2024-02-01", "2024-05-02", "2024-08-01", "2024-10-31", "2025-01-30", "2025-05-01", "2025-07-31"];
  const misses = ["2025-10-30", "2026-01-29"];
  const reactionDays = new Map<string, number>();
  for (const d of beats) reactionDays.set(cal[cal.indexOf(d) + 1]!, 1.02);
  for (const d of misses) reactionDays.set(cal[cal.indexOf(d) + 1]!, 0.99);
  let level = 100;
  const hitCloses: DailyClose[] = cal.map((date) => {
    level *= reactionDays.get(date) ?? 1;
    return { date, close: level };
  });
  const quarters: ReportedQuarter[] = [
    ...beats.map((date) => ({ date, time: "after_close" as const, surprisePct: 5 })),
    ...misses.map((date) => ({ date, time: "after_close" as const, surprisePct: -5 })),
  ];
  const past: PastEvent[] = [
    ...[...beats, ...misses].map((d, i) => ({ kind: "earnings" as const, accession: `acc-${i}`, acceptedAt: `${d}T21:15:00Z`, sign: null })),
    // The card's own event and a preliminary release with no EPS on record.
    { kind: "earnings", accession: "own", acceptedAt: "2026-11-05T21:18:06Z", sign: null },
    { kind: "earnings", accession: "prelim", acceptedAt: "2026-01-05T21:27:37Z", sign: null },
  ];
  const market: MarketData = {
    name: "fixture",
    dailyCloses: async (t) => (t === "SPY" ? spy : t === "ARW" ? hitCloses : []),
    earnings: async () => quarters,
  };
  const hit = (over: Partial<RippleHit>): RippleHit => ({
    ticker: "ARW",
    companyName: "Arrow Electronics",
    relation: "customer",
    degree: 1,
    direction: "up",
    confidence: "medium",
    window: "1 to 5 trading days",
    mechanism: "m",
    evidence: [],
    history: null,
    ...over,
  });
  const card = (hits: RippleHit[]): RippleCard => ({
    id: "semis-MCHP-own",
    sector: "semis",
    generatedAt: "2026-11-12T16:00:00Z",
    event: {
      id: "MCHP-own",
      ticker: "MCHP",
      companyName: "Microchip",
      kind: "earnings_surprise",
      headline: "h",
      occurredAt: "2026-11-05T21:18:06Z",
      summary: "s",
      source: { title: "t", url: "https://www.sec.gov/x", publisher: "SEC EDGAR" },
    },
    hits,
  });
  const deps = { market, pastEvents: async () => past, nowMs: Date.parse("2026-11-12T16:00:00Z") };

  it("measures only past events of the same sign, before the card's own", async () => {
    const [r] = await cardHistory(card([hit({})]), { kind: "earnings", sign: 1 }, deps);
    assert.equal(r!.history?.sample, 7);
    assert.equal(r!.history?.hitRate, 1);
    assert.equal(r!.history?.avgMovePct, 2);
    assert.equal(r!.history?.windowDays, 5);
    assert.equal(r!.history?.benchmark, "SPY");
    assert.equal(r!.history?.from, "2024-02-02");
    assert.equal(r!.history?.to, "2025-08-01");
  });

  it("reads a miss against past misses, and stays null when there are too few", async () => {
    const [r] = await cardHistory(card([hit({ direction: "down" })]), { kind: "earnings", sign: -1 }, deps);
    assert.equal(r!.history, null);
    assert.equal(r!.moves.length, 2);
    assert.ok(r!.moves.every((m) => Math.abs(m.adjustedPct + 1) < 1e-9));
  });

  it("gives an unclear hit and an unknown event no history", async () => {
    const [u] = await cardHistory(card([hit({ direction: "unclear" })]), { kind: "earnings", sign: 1 }, deps);
    assert.equal(u!.history, null);
    const [n] = await cardHistory(card([hit({})]), { kind: "earnings", sign: null }, deps);
    assert.equal(n!.history, null);
    const [k] = await cardHistory(card([hit({})]), null, deps);
    assert.equal(k!.history, null);
  });

  it("leaves a hit with no prices at null and still measures the others", async () => {
    const r = await cardHistory(card([hit({ ticker: "XYZ" }), hit({})]), { kind: "earnings", sign: 1 }, deps);
    assert.equal(r[0]!.history, null);
    assert.equal(r[1]!.history?.sample, 7);
  });
});
