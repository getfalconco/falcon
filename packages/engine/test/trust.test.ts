/**
 * The rules that decide which cards a trader sees (README, "What reaches
 * the user"): weak signals, the record as a count, priced in, and
 * Opportunities eligibility.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cardConfidence,
  cardConfidenceOf,
  cardPricedIn,
  isWeakSignal,
  opportunityCard,
  recordLabel,
  splitWeakSignals,
  topConfidence,
  type Confidence,
  type RippleCard,
  type RippleHistory,
  type RippleHit,
} from "@falcon/ripple";
import type { GraphEdge, Path } from "../src/graph.ts";
import { cardHistory, moveSinceEvent, pricedInRead, sinceEventOf, PRICED_IN_SHARE } from "../src/history.ts";
import type { DailyClose, MarketData } from "../src/market.ts";
import type { PastEvent } from "../src/past-events.ts";
import { confidenceCeiling, opportunityEligible, rankHits, readRecord, SUPPORTS_LOWER_BOUND, wilsonLower } from "../src/rank.ts";
import { cardProblems, hitProblems } from "../src/validate.ts";

function hist(wins: number, sample: number, avgMovePct = 2): RippleHistory {
  return { sample, hitRate: Math.round((wins / sample) * 10_000) / 10_000, avgMovePct, windowDays: 5, benchmark: "SPY" };
}

function hit(over: Partial<RippleHit> = {}): RippleHit {
  return {
    ticker: "KLAC",
    companyName: "KLA",
    relation: "competitor",
    degree: 1,
    direction: "up",
    confidence: "medium",
    window: "1 to 5 trading days",
    mechanism: "A test mechanism that is long enough to pass the length check.",
    evidence: [{ quote: "TSMC is our sole manufacturing partner for our integrated circuits.", form: "10-K", filedAt: "2026-02-20", url: "https://www.sec.gov/Archives/edgar/data/1/x.htm" }],
    history: null,
    ...over,
  };
}

function card(hits: RippleHit[], over: Partial<RippleCard> = {}): RippleCard {
  return {
    id: "semis-X-1",
    sector: "semis",
    generatedAt: "2026-11-12T16:00:00Z",
    event: {
      id: "X-1",
      ticker: "TSM",
      companyName: "TSMC",
      kind: "filing",
      headline: "TSMC October revenue",
      occurredAt: "2026-11-10T12:01:33Z",
      summary: "Revenue rose from a year earlier.",
      source: { title: "6-K", url: "https://www.sec.gov/x", publisher: "SEC EDGAR" },
    },
    hits,
    ...over,
  };
}

describe("weak signals (card confidence)", () => {
  it("takes the highest confidence among the hits; low only when every hit is low", () => {
    assert.equal(topConfidence([hit({ confidence: "low" }), hit({ confidence: "medium" })]), "medium");
    assert.equal(topConfidence([hit({ confidence: "low" }), hit({ confidence: "low" })]), "low");
    assert.equal(topConfidence([]), "low");
    assert.equal(cardConfidence(card([hit({ confidence: "low" }), hit({ confidence: "high" })])), "high");
  });

  it("an unclear hit does not lift a card: no implied way, no record to back it", () => {
    const hits = [hit({ confidence: "low" }), hit({ ticker: "AMKR", direction: "unclear", confidence: "medium" })];
    assert.equal(cardConfidenceOf(hits), "low");
    assert.equal(isWeakSignal(card(hits)), true);
    assert.equal(cardConfidenceOf([hit({ direction: "unclear", confidence: "high" })]), "low");
    assert.equal(cardConfidenceOf([hit({ direction: "down", confidence: "medium" }), hit({ ticker: "B", direction: "unclear", confidence: "high" })]), "medium");
  });

  it("prefers the engine's card confidence and falls back for older cards", () => {
    assert.equal(cardConfidence(card([hit({ confidence: "high" })], { confidence: "low" })), "low");
    assert.equal(cardConfidence(card([hit({ confidence: "medium" })])), "medium");
  });

  it("groups low cards as weak signals, keeping each group's order", () => {
    const a = card([hit({ confidence: "low" })], { id: "a" });
    const b = card([hit({ confidence: "medium" })], { id: "b" });
    const c = card([hit({ confidence: "low" }), hit({ ticker: "NVDA", confidence: "high" })], { id: "c" });
    const d = card([hit({ confidence: "low" })], { id: "d", confidence: "low" });
    assert.equal(isWeakSignal(a), true);
    assert.equal(isWeakSignal(c), false);
    const { strong, weak } = splitWeakSignals([a, b, c, d]);
    assert.deepEqual(strong.map((x) => x.id), ["b", "c"]);
    assert.deepEqual(weak.map((x) => x.id), ["a", "d"]);
  });

  it("a coin-flip record caps a hit at low, so a card of coin flips is a weak signal", () => {
    // 27 of 50: lower bound 0.40, a settled coin flip.
    assert.equal(confidenceCeiling(readRecord(hist(27, 50), "up").verdict), "low");
  });
});

describe("the record as a count", () => {
  it("reads 'X of Y similar events' from the hit rate and sample", () => {
    assert.equal(recordLabel(hist(5, 6)), "5 of 6 similar events");
    assert.equal(recordLabel(hist(27, 50)), "27 of 50 similar events");
    assert.equal(recordLabel(hist(0, 7)), "0 of 7 similar events");
  });

  it("shows nothing below 6 events or without a record", () => {
    assert.equal(recordLabel(hist(4, 5)), null);
    assert.equal(recordLabel(null), null);
    assert.equal(recordLabel(undefined), null);
  });
});

describe("priced in", () => {
  it("is priced in past half the record's average move in the implied way", () => {
    assert.equal(PRICED_IN_SHARE, 0.5);
    // Up hit, record +3.0% on average: priced in past +1.5%.
    assert.deepEqual(pricedInRead(1.6, { avgMovePct: 3 }, "up"), { pricedIn: true, thresholdPct: 1.5 });
    assert.deepEqual(pricedInRead(1.5, { avgMovePct: 3 }, "up"), { pricedIn: false, thresholdPct: 1.5 });
    assert.deepEqual(pricedInRead(-4, { avgMovePct: 3 }, "up"), { pricedIn: false, thresholdPct: 1.5 });
    // Down hit, record -2.0%: priced in past -1.0%.
    assert.deepEqual(pricedInRead(-1.2, { avgMovePct: -2 }, "down"), { pricedIn: true, thresholdPct: -1 });
    assert.deepEqual(pricedInRead(0.5, { avgMovePct: -2 }, "down"), { pricedIn: false, thresholdPct: -1 });
  });

  it("is never priced in without a record in the implied way, or for an unclear hit", () => {
    assert.deepEqual(pricedInRead(9, null, "up"), { pricedIn: false, thresholdPct: null });
    assert.deepEqual(pricedInRead(9, { avgMovePct: -1 }, "up"), { pricedIn: false, thresholdPct: null });
    assert.deepEqual(pricedInRead(9, { avgMovePct: 3 }, "unclear"), { pricedIn: false, thresholdPct: null });
  });

  it("measures the market-adjusted move from the close before the reaction day to the latest close", () => {
    const cal = ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"];
    const hitCloses = new Map([["2026-11-06", 100], ["2026-11-09", 101], ["2026-11-10", 103], ["2026-11-11", 104]]);
    const spy = new Map([["2026-11-06", 500], ["2026-11-09", 500], ["2026-11-10", 505], ["2026-11-11", 505]]);
    const m = moveSinceEvent(cal, 2, hitCloses, spy)!;
    assert.equal(m.fromDate, "2026-11-09");
    assert.equal(m.reactionDate, "2026-11-10");
    assert.equal(m.toDate, "2026-11-11");
    // 104/101 - 1 = 2.97%, SPY 1.00%: 1.97% adjusted.
    assert.ok(Math.abs(m.adjustedPct - (104 / 101 - 1 - 0.01) * 100) < 1e-9);
    const s = sinceEventOf(m, { avgMovePct: 3 }, "up");
    assert.equal(s.pricedIn, true);
    assert.deepEqual(s.sinceEvent, { movePct: 1.97, fromDate: "2026-11-09", reactionDate: "2026-11-10", asOf: "2026-11-11", benchmark: "SPY", pricedInAtPct: 1.5 });
    // The reaction day has not closed yet.
    assert.equal(moveSinceEvent(cal, null, hitCloses, spy), null);
    assert.equal(moveSinceEvent(cal, 4, hitCloses, spy), null);
  });

  it("is measured for each hit of a card from its prices", async () => {
    // Weekdays, SPY flat; KLAC +3% on each past beat's reaction day, then +2% on this event's.
    const cal: string[] = [];
    for (let t = Date.parse("2021-01-04T12:00:00Z"); t <= Date.parse("2026-11-11T12:00:00Z"); t += 86_400_000) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) cal.push(d.toISOString().slice(0, 10));
    }
    const beats = ["2024-02-01", "2024-05-02", "2024-08-01", "2024-10-31", "2025-01-30", "2025-05-01", "2025-07-31"];
    const up = new Map<string, number>(beats.map((d) => [cal[cal.indexOf(d) + 1]!, 1.03]));
    up.set("2026-11-06", 1.02);
    let level = 100;
    const klac: DailyClose[] = cal.map((date) => ({ date, close: (level *= up.get(date) ?? 1) }));
    const spy: DailyClose[] = cal.map((date) => ({ date, close: 500 }));
    const past: PastEvent[] = beats.map((d, i) => ({ kind: "earnings", accession: `a${i}`, acceptedAt: `${d}T21:15:00Z`, sign: null }));
    const market: MarketData = {
      name: "fixture",
      dailyCloses: async (t) => (t === "SPY" ? spy : t === "KLAC" ? klac : []),
      earnings: async () => beats.map((date) => ({ date, time: "after_close" as const, surprisePct: 5 })),
    };
    const c = card([hit()], { event: { ...card([]).event, kind: "earnings_surprise", occurredAt: "2026-11-05T21:18:06Z" } });
    const [r] = await cardHistory(c, { kind: "earnings", sign: 1 }, { market, pastEvents: async () => past, nowMs: Date.parse("2026-11-12T16:00:00Z") });
    assert.equal(r!.history?.avgMovePct, 3);
    assert.equal(r!.since?.sinceEvent.movePct, 2);
    assert.equal(r!.since?.sinceEvent.asOf, "2026-11-11");
    assert.equal(r!.since?.sinceEvent.pricedInAtPct, 1.5);
    assert.equal(r!.since?.pricedIn, true);
  });

  it("marks a card priced in only when every hit with an implied way is", () => {
    assert.equal(cardPricedIn(card([hit({ pricedIn: true }), hit({ ticker: "ALAB", direction: "unclear" })])), true);
    assert.equal(cardPricedIn(card([hit({ pricedIn: true }), hit({ ticker: "NVDA", pricedIn: false })])), false);
    assert.equal(cardPricedIn(card([hit({ ticker: "ALAB", direction: "unclear" })])), false);
    assert.equal(cardPricedIn(card([hit()], { pricedIn: true })), true);
  });
});

describe("Opportunities eligibility", () => {
  const SOLE: GraphEdge = {
    id: "e",
    from: "TSM",
    to: "KLAC",
    toName: "KLA",
    category: "supplier",
    tier: "critical",
    disclosedSharePct: null,
    quote: "TSMC is our sole manufacturing partner for our integrated circuits.",
    form: "10-K",
    filedAt: "2026-02-20",
    url: "https://www.sec.gov/Archives/edgar/data/1/x.htm",
    origin: "test",
  };
  const path = (ticker: string): Path => ({ ticker, degree: 1, relation: "supplier", edges: [SOLE] });
  const ev = { magnitudePct: 10, event: card([]).event, pendingAcquisition: false };
  const rank = (over: Partial<RippleHit>) => rankHits(ev, [{ hit: hit(over), path: path(over.ticker ?? "KLAC") }], () => null).hits[0]!.hit;

  it("uses the same lower bound as the 'high' confidence bar", () => {
    assert.equal(SUPPORTS_LOWER_BOUND, 0.5);
    // 11 of 14: lower bound just above 0.5; 9 of 14 is not.
    assert.ok(wilsonLower(11, 14) > SUPPORTS_LOWER_BOUND);
    assert.ok(wilsonLower(9, 14) <= SUPPORTS_LOWER_BOUND);
    assert.equal(readRecord(hist(11, 14), "up").verdict, "supports");
    assert.equal(confidenceCeiling("supports"), "high");
  });

  it("lists a hit only with a record that clears it, not low, not unclear, not priced in", () => {
    assert.equal(rank({ history: hist(11, 14) }).opportunityEligible, true);
    assert.equal(rank({ history: hist(9, 14) }).opportunityEligible, false);
    assert.equal(rank({ history: hist(27, 50) }).opportunityEligible, false);
    assert.equal(rank({ history: null }).opportunityEligible, false);
    assert.equal(rank({ history: hist(11, 14), confidence: "low" }).opportunityEligible, false);
    assert.equal(rank({ history: hist(11, 14), pricedIn: true }).opportunityEligible, false);
    assert.equal(opportunityEligible({ verdict: "supports", lower: 0.6, sample: 20 }, "high", "unclear", false), false);
  });

  it("Opportunities keep only eligible hits, drop held tickers, and never take a weak card", () => {
    const eligible = hit({ ticker: "KLAC", opportunityEligible: true, history: hist(11, 14) });
    const other = hit({ ticker: "NVMI", opportunityEligible: false });
    const held = hit({ ticker: "NVDA", opportunityEligible: true, history: hist(11, 14) });
    const c = opportunityCard(card([eligible, other, held]), new Set(["NVDA"]));
    assert.deepEqual(c?.hits.map((h) => h.ticker), ["KLAC"]);
    assert.equal(opportunityCard(card([other])), null);
    assert.equal(opportunityCard(card([eligible], { confidence: "low" })), null);
    // Older cards without the flag never reach Opportunities.
    assert.equal(opportunityCard(card([hit({ history: hist(11, 14) })])), null);
  });

  it("the contract check refuses an eligible hit that is priced in or low", () => {
    const bad = (over: Partial<RippleHit>) => hitProblems(hit({ history: hist(11, 14), opportunityEligible: true, ...over }), "h").some((p) => /opportunityEligible/.test(p));
    assert.equal(bad({}), false);
    assert.equal(bad({ confidence: "low" }), true);
    assert.equal(bad({ history: null }), true);
    const confidence: Confidence = "medium";
    assert.ok(cardProblems(card([hit({ confidence })], { confidence: "low" })).some((p) => /highest of its directional hits/.test(p)));
  });
});
