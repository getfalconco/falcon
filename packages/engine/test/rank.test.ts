import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Confidence, Direction, RippleHistory, RippleHit } from "@falcon/ripple";
import type { DetectedEvent } from "../src/events.ts";
import type { GraphEdge, Path } from "../src/graph.ts";
import {
  cappedConfidence,
  cardScoreOf,
  confidenceCeiling,
  edgeStrength,
  eventSize,
  hitScore,
  coverageBoost,
  effectiveAnalysts,
  isNonObvious,
  pathStrength,
  rankHits,
  readRecord,
  recordStrength,
  wilsonLower,
  type Coverage,
} from "../src/rank.ts";
import { framingProblems, hitProblems } from "../src/validate.ts";
import { parseCoverage } from "../src/yahoo.ts";

function edge(over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: "e",
    from: "ONTO",
    to: "KLAC",
    toName: "KLA",
    category: "competitor",
    tier: "important",
    disclosedSharePct: null,
    quote: "In automated systems for the semiconductor industry, our principal competitors are KLA Corporation and Nova Ltd.",
    form: "10-K",
    filedAt: "2026-02-20",
    url: "https://www.sec.gov/Archives/edgar/data/1/x.htm",
    origin: "test",
    ...over,
  };
}

const LIST = edge({ tier: "marginal", quote: "We compete with Espressif, Infineon, MediaTek, Microchip, Nordic Semiconductor, NXP and others." });
const SHARE = edge({ category: "customer", tier: "critical", disclosedSharePct: 12, quote: "Arrow Electronics, our largest distributor, made up 12% and 10% of our net sales." });
const OVER_10 = edge({ category: "customer", tier: "critical", quote: "the following customers each accounted for more than 10% of total revenues" });
const SOLE = edge({ category: "supplier", tier: "critical", quote: "TSMC is our sole manufacturing partner for our integrated circuits." });

function hist(wins: number, sample: number, avgMovePct = 1): RippleHistory {
  return { sample, hitRate: Math.round((wins / sample) * 10_000) / 10_000, avgMovePct, windowDays: 5, benchmark: "SPY" };
}

function pair(ticker: string, e: GraphEdge, over: Partial<RippleHit> = {}, degree: 1 | 2 = 1): { hit: RippleHit; path: Path } {
  const path: Path =
    degree === 1
      ? { ticker, degree: 1, relation: e.category === "competitor" ? "competitor" : "supplier", edges: [e] }
      : { ticker, degree: 2, via: "MID", relation: "supplier", viaRelation: "customer", edges: [SHARE, e] };
  return {
    path,
    hit: {
      ticker,
      companyName: ticker,
      relation: path.relation,
      degree,
      ...(degree === 2 ? { via: "MID" } : {}),
      direction: "up",
      confidence: "medium",
      window: "1 to 5 trading days",
      mechanism: "A test mechanism that is long enough to pass the length check.",
      evidence: path.edges.map((x) => ({ quote: x.quote, form: x.form, filedAt: x.filedAt, url: x.url })),
      history: null,
      ...over,
    },
  };
}

const ONTO: Pick<DetectedEvent, "magnitudePct" | "event" | "pendingAcquisition"> = {
  magnitudePct: 6,
  pendingAcquisition: false,
  event: { kind: "earnings_surprise" } as DetectedEvent["event"],
};
const none = () => null;

describe("Wilson lower bound", () => {
  it("matches the textbook values at 95%", () => {
    assert.ok(Math.abs(wilsonLower(11, 14) - 0.524) < 0.002);
    assert.ok(Math.abs(wilsonLower(9, 14) - 0.388) < 0.002);
    assert.ok(Math.abs(wilsonLower(27, 50) - 0.404) < 0.002);
    assert.equal(wilsonLower(0, 0), 0);
    assert.equal(wilsonLower(0, 10), 0);
  });

  it("is tighter with more events at the same rate", () => {
    assert.ok(wilsonLower(70, 100) > wilsonLower(7, 10));
  });
});

describe("link strength", () => {
  it("reads disclosed shares, sole sources and 10% customers from the quote", () => {
    assert.deepEqual(edgeStrength(SHARE), { tier: "disclosed", why: "share" });
    assert.deepEqual(edgeStrength(SOLE), { tier: "disclosed", why: "sole_source" });
    assert.deepEqual(edgeStrength(OVER_10), { tier: "disclosed", why: "over_10pct" });
    assert.equal(edgeStrength(edge({ quote: "In fiscal year 2026, we exclusively used TSMC for semiconductor wafer production." })).tier, "disclosed");
    assert.equal(edgeStrength(edge()).tier, "named");
    assert.equal(edgeStrength(LIST).tier, "list");
  });

  it("takes the best quote at degree 1 and the weaker link at degree 2", () => {
    assert.equal(pathStrength({ degree: 1, edges: [LIST, SHARE] }).tier, "disclosed");
    assert.equal(pathStrength({ degree: 2, edges: [SHARE, LIST] }).tier, "list");
  });
});

describe("record", () => {
  it("calls a long record at about half a coin flip", () => {
    assert.equal(readRecord(hist(27, 50), "up").verdict, "coin_flip");
    assert.equal(readRecord(hist(11, 14), "up").verdict, "supports");
    assert.equal(readRecord(hist(9, 14), "up").verdict, "thin");
    assert.equal(readRecord(null, "up").verdict, "none");
    assert.equal(readRecord(hist(10, 12), "unclear").verdict, "none");
  });

  it("sees a record that leans the other way, in the hit's own direction", () => {
    assert.equal(readRecord(hist(4, 12, -1.76), "up").verdict, "leans_other_way");
    // A "down" hit: a positive average is the other way.
    assert.equal(readRecord(hist(6, 12, 0.5), "down").verdict, "leans_other_way");
    assert.equal(readRecord(hist(6, 12, -0.5), "down").verdict, "thin");
  });

  it("scores a supportive record above a coin flip above nothing, and halves an average against", () => {
    const s = (w: number, n: number, avg = 1, d: Direction = "up") => recordStrength(readRecord(hist(w, n, avg), d), hist(w, n, avg), d);
    assert.ok(s(11, 14) > s(27, 50));
    assert.ok(s(27, 50) > recordStrength(readRecord(null, "up"), null, "up"));
    assert.ok(Math.abs(s(27, 50, -1) - s(27, 50, 1) / 2) < 1e-9);
  });
});

describe("confidence caps", () => {
  it("caps a coin-flip record at low, whatever the judge said", () => {
    const v = readRecord(hist(27, 50), "up").verdict;
    for (const c of ["low", "medium", "high"] as Confidence[]) assert.equal(cappedConfidence(c, v), "low");
  });

  it("allows high only when the record beats a coin flip", () => {
    assert.equal(confidenceCeiling("supports"), "high");
    assert.equal(cappedConfidence("high", "supports"), "high");
    assert.equal(cappedConfidence("high", "none"), "medium");
    assert.equal(cappedConfidence("high", "thin"), "medium");
    assert.equal(cappedConfidence("high", "leans_other_way"), "low");
  });

  it("never raises the judge's call", () => {
    assert.equal(cappedConfidence("low", "supports"), "low");
    assert.equal(cappedConfidence("medium", "supports"), "medium");
  });
});

describe("coverage", () => {
  it("boosts a hit by 1 + 0.25 * clamp((20 - a) / 17, 0, 1)", () => {
    const b = (analysts: number | null, marketCapUsd: number | null = null) => Math.round(coverageBoost({ analysts, marketCapUsd }) * 1000) / 1000;
    assert.equal(b(3), 1.25);
    assert.equal(b(0), 1.25);
    assert.equal(b(8), 1.176);
    assert.equal(b(10), 1.147);
    assert.equal(b(12), 1.118);
    assert.equal(b(20), 1);
    assert.equal(b(56), 1);
  });

  it("falls back to 10 analysts under a $10 billion market value; unknown is no boost", () => {
    assert.equal(effectiveAnalysts({ analysts: null, marketCapUsd: 5e9 }), 10);
    assert.equal(effectiveAnalysts({ analysts: null, marketCapUsd: 2e10 }), null);
    assert.equal(effectiveAnalysts({ analysts: 8, marketCapUsd: 1e12 }), 8);
    assert.equal(coverageBoost({ analysts: null, marketCapUsd: 2e10 }), 1);
    assert.equal(coverageBoost(null), 1);
  });

  it("raises the hit score, capped at 100; only degree 2 marks a card non-obvious", () => {
    const base = { link: "disclosed" as const, record: 1, confidence: "high" as const, size: 1, direction: "up" as const };
    assert.equal(hitScore(base), 100);
    assert.equal(hitScore({ ...base, boost: 1.25 }), 100);
    const mid = { ...base, record: 0.5, size: 0.2 };
    assert.equal(hitScore({ ...mid, boost: 1.25 }), Math.round(hitScore(mid) * 1.25 * 10) / 10);
    assert.equal(isNonObvious({ degree: 2 }), true);
    assert.equal(isNonObvious({ degree: 1 }), false);
  });

  it("parses Yahoo's analyst count and US dollar market value", () => {
    const json = (currency: string) => ({ quoteSummary: { result: [{ financialData: { numberOfAnalystOpinions: { raw: 8 } }, price: { marketCap: { raw: 1.06e10 }, currency } }] } });
    assert.deepEqual(parseCoverage(json("USD")), { analysts: 8, marketCapUsd: 1.06e10 });
    assert.deepEqual(parseCoverage(json("TWD")), { analysts: 8, marketCapUsd: null });
    assert.equal(parseCoverage({ quoteSummary: { result: [{}] } }), null);
    assert.equal(parseCoverage({}), null);
  });
});

describe("scores", () => {
  it("weighs link, record, confidence and size, and halves an unclear hit", () => {
    const base = { link: "named" as const, record: 0.5, confidence: "medium" as Confidence, size: 0.2, direction: "up" as Direction };
    // 100 * (0.25 * 0.6 + 0.45 * 0.5 + 0.15 * 2/3 + 0.15 * 0.2) = 50.5
    assert.equal(hitScore(base), 50.5);
    assert.ok(hitScore({ ...base, link: "disclosed" }) > hitScore(base));
    assert.ok(hitScore({ ...base, record: 0.8 }) > hitScore(base));
    assert.equal(hitScore({ ...base, direction: "unclear" }), 25.3);
    assert.ok(hitScore({ link: "disclosed", record: 1, confidence: "high", size: 1, direction: "up" }) <= 100);
  });

  it("sizes an EPS surprise above a monthly revenue change point for point", () => {
    const eps = eventSize({ magnitudePct: 30, event: { kind: "earnings_surprise" } as DetectedEvent["event"] });
    const rev = eventSize({ magnitudePct: 60, event: { kind: "filing" } as DetectedEvent["event"] });
    assert.equal(eps, 1);
    assert.ok(Math.abs(rev - 1 / 3) < 1e-9);
  });

  it("scores a card by its best hits, with a bonus for a non-obvious one", () => {
    assert.equal(cardScoreOf([40, 20, 10, 99], { nonObvious: false, pendingAcquisition: false }), 99 + 20 + 5);
    assert.equal(cardScoreOf([40], { nonObvious: true, pendingAcquisition: false }), 50);
    assert.equal(cardScoreOf([40], { nonObvious: false, pendingAcquisition: true }), 12);
  });
});

describe("ranking a card", () => {
  it("orders the ONTO hits by their record: 11 of 14 first, 7 of 14 against last", () => {
    const r = rankHits(
      ONTO,
      [
        pair("CAMT", edge(), { history: hist(7, 14, -0.41) }),
        pair("NVMI", edge(), { history: hist(9, 14, 3.18) }),
        pair("KLAC", edge(), { confidence: "low", history: hist(11, 14, 2.81) }),
      ],
      none,
    );
    assert.deepEqual(r.hits.map((x) => x.hit.ticker), ["KLAC", "NVMI", "CAMT"]);
    assert.deepEqual(r.capped, [{ ticker: "CAMT", from: "medium", to: "low", why: "record leans the other way (7 of 14, lower bound 0.27)" }]);
    assert.equal(r.hits[2]!.hit.confidence, "low");
    assert.equal(r.dropped.length, 0);
  });

  it("caps a disclosed link with a coin-flip record and says why", () => {
    const r = rankHits(ONTO, [pair("KLAC", OVER_10, { history: hist(27, 50, 0.83) })], none);
    const h = r.hits[0]!.hit;
    assert.equal(h.confidence, "low");
    assert.equal(h.scoreReason, "A filing puts this link above 10% of revenue; went the implied way 27 of 50 times, no better than a coin flip.");
  });

  it("drops a list mention whose record does not beat a coin flip, keeps one with no record", () => {
    const r = rankHits(
      ONTO,
      [pair("NXPI", LIST, { confidence: "low", history: hist(5, 12, 0.97) }), pair("STM", LIST, { confidence: "low" }), pair("TXN", LIST, { confidence: "low", history: hist(20, 22) })],
      none,
    );
    assert.deepEqual(r.dropped.map((d) => d.ticker), ["NXPI"]);
    assert.deepEqual(r.hits.map((x) => x.hit.ticker).sort(), ["STM", "TXN"]);
  });

  it("leaves a card with no hit and no score when every hit is dropped", () => {
    const r = rankHits(ONTO, [pair("NXPI", LIST, { history: hist(11, 22) }), pair("SLAB", LIST, { history: hist(4, 12, 0.28) })], none);
    assert.equal(r.hits.length, 0);
    assert.equal(r.score, 0);
    assert.equal(r.dropped.length, 2);
  });

  it("keeps the best maxHits, boosts a low-coverage hit and marks a card with a degree 2 hit", () => {
    const cov = (t: string): Coverage | null => (t === "NVMI" ? { analysts: 8, marketCapUsd: 1e10 } : { analysts: 30, marketCapUsd: 1e11 });
    const hits = [pair("A", edge()), pair("B", edge()), pair("NVMI", edge(), { history: hist(9, 14, 3.18) })];
    const r = rankHits(ONTO, hits, cov, 2);
    assert.equal(r.hits.length, 2);
    assert.equal(r.hits[0]!.hit.ticker, "NVMI");
    assert.equal(r.hits[0]!.hit.analysts, 8);
    assert.equal(r.nonObvious, false);
    assert.match(r.hits[0]!.hit.scoreReason!, /8 analysts cover it\.$/);
    assert.deepEqual(r.dropped.map((d) => d.ticker), ["B"]);
    assert.equal(rankHits(ONTO, [pair("A", edge())], cov).nonObvious, false);
    assert.equal(rankHits(ONTO, [pair("D2", edge(), {}, 2)], cov).nonObvious, true);
  });

  it("writes reasons that pass the framing and contract checks", () => {
    const r = rankHits(
      ONTO,
      [
        pair("A", SHARE, { history: hist(4, 12, -1.76) }),
        pair("B", SOLE, { direction: "unclear", history: null }),
        pair("C", edge(), {}, 2),
        pair("D", edge(), { history: hist(11, 14) }),
      ],
      () => ({ analysts: 4, marketCapUsd: null }),
    );
    for (const { hit } of r.hits) {
      assert.deepEqual(framingProblems(hit.scoreReason!, "reason"), [], hit.scoreReason);
      assert.deepEqual(hitProblems(hit, hit.ticker), [], hit.ticker);
      assert.ok(/^[A-Z].*\.$/.test(hit.scoreReason!));
    }
    assert.equal(r.hits.find((x) => x.hit.ticker === "A")!.hit.scoreReason, "A filing states a 12% share for this link; went the implied way 4 of 12 times and the other way on average; 4 analysts cover it.");
  });

  it("rejects a score outside 0 to 100 and a reason with advice words", () => {
    const { hit } = pair("A", edge());
    assert.ok(hitProblems({ ...hit, score: 140 }, "h").some((p) => /score must be/.test(p)));
    assert.ok(hitProblems({ ...hit, scoreReason: "A strong buy signal now." }, "h").some((p) => /advice/.test(p)));
  });
});
