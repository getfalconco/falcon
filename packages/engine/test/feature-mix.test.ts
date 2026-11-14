/**
 * What the feed features: no event type fills every slot while other types
 * have cards (src/pipeline.ts featureCards), and the detectors get a model
 * budget by default (a budget of 0 left the 8-K, 13D and 4.02 detectors
 * reading nothing, so the feed held insider clusters only).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_DETECTOR_BUDGET_USD } from "../src/detectors/llm.ts";
import type { DetectorContext, DetectorEvent } from "../src/detectors/types.ts";
import { memoryJudgmentStore } from "../src/ledger.ts";
import { defaultMaxPerType, featureCards, runSightings, type RunOptions } from "../src/pipeline.ts";
import type { EvidenceRegistry } from "../src/quality.ts";
import { analysisLines } from "../src/summary.ts";

const REGISTRY: EvidenceRegistry = {
  version: 1,
  families: {
    F7: {
      eventType: "insider_cluster",
      label: "Insider purchase cluster",
      match: "exact",
      citation: "Cohen, Malloy & Pomorski (2012), Journal of Finance",
      url: "https://doi.org/10.1111/j.1540-6261.2012.01740.x",
      effect: "opportunistic insider purchases earned abnormal returns",
      period: "1986-2007",
      ownEstimate: { period: "2015-01 to 2026-06", n: 1000, nEvents: 500, windowDays: 20, meanAbnPct: 1, medianAbnPct: 1, tStat: 2.5, p: 0.01, benchmark: "beta_x_spy", computedAt: "2026-11-14" },
    },
    F6: {
      eventType: "distress_nt",
      label: "Late filing notice",
      match: "exact",
      citation: "Bartov & Konchitchki (2017)",
      url: "https://doi.org/10.2308/acch-51887",
      effect: "negative returns around NT filings",
      period: "2000-2008",
      ownEstimate: null,
    },
  },
};
const LIQUID = { price: 24.5, medianDollarVolume20d: 12_000_000 };

function ownEvent(i: number, over: Partial<DetectorEvent> = {}): DetectorEvent {
  const acc = `0000000000-26-${String(i).padStart(6, "0")}`;
  const ticker = `T${String.fromCharCode(65 + i)}`;
  return {
    id: `insider_cluster-${acc}`,
    eventType: "insider_cluster",
    family: "F7",
    cik: String(i).padStart(10, "0"),
    ticker,
    companyName: `Company ${ticker}`,
    acceptedAt: `2026-11-1${i % 3}T21:0${i % 10}:00Z`,
    accession: acc,
    form: "4",
    items: [],
    title: `2 insiders bought $${i + 1}00,000 of Company ${ticker} stock`,
    summary: ["Form 4 filings show open-market purchases by two officers."],
    sign: 1,
    magnitude: 0.5,
    facts: {},
    sources: [{ title: "Form 4", url: `https://www.sec.gov/Archives/edgar/data/${i}/${acc}-index.htm`, publisher: "SEC EDGAR", publishedAt: "2026-11-12T21:05:00Z" }],
    quotes: [`DOE JANE (Chief Executive Officer): Common Stock, 2026-11-10, code P, ${i + 1}000 shares at 24.10`],
    propagates: "own",
    watchOnlyReasons: [],
    ...over,
  };
}

function lateFiling(i: number): DetectorEvent {
  const base = ownEvent(i);
  return {
    ...base,
    id: `distress_nt-${base.accession}`,
    eventType: "distress_nt",
    family: "F6",
    form: "NT 10-Q",
    title: `Company ${base.ticker} said it cannot file its quarterly report on time`,
    summary: ["The company filed a notice of late filing for its quarterly report."],
    sign: -1,
    magnitude: null,
    quotes: ["The Registrant could not complete its quarterly report on Form 10-Q without unreasonable effort or expense."],
  };
}

const run = (events: DetectorEvent[], over: Partial<RunOptions> = {}) =>
  runSightings({
    sector: "semis",
    sinceMs: Date.parse("2026-11-07T00:00:00Z"),
    untilMs: Date.parse("2026-11-14T00:00:00Z"),
    maxCards: 5,
    judge: null,
    graph: { generatedAt: "2026-11-01", names: {}, edges: [] },
    judgments: memoryJudgmentStore(),
    legacyEvents: async () => [],
    detect: async () => events,
    liquidity: async () => LIQUID,
    registry: REGISTRY,
    familyStats: { version: 1, families: {} },
    interimDocumented: true,
    dryRun: true,
    ...over,
  });

describe("featured mix (featureCards)", () => {
  const types = (s: string) => s.split("").map((c) => ({ eventType: c === "i" ? "insider_cluster" : c === "d" ? "distress_nt" : "earnings_read_through" }));

  it("takes at most maxPerType of one event type while others have cards, in featured order", () => {
    const sorted = types("iiiiiiiiddde");
    const chosen = featureCards(sorted, 5, 2);
    assert.deepEqual([...chosen].sort((a, b) => a - b), [0, 1, 8, 9, 11]);
  });

  it("fills open slots with the cards passed over when no other type is left", () => {
    assert.deepEqual([...featureCards(types("iiiiiiii"), 5, 2)].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
    assert.deepEqual([...featureCards(types("iiiiid"), 5, 2)].sort((a, b) => a - b), [0, 1, 2, 3, 5]);
    assert.equal(featureCards(types("id"), 5, 2).size, 2);
  });

  it("defaults to 40% of the slots, rounded up", () => {
    assert.equal(defaultMaxPerType(15), 6);
    assert.equal(defaultMaxPerType(3), 2);
    assert.equal(defaultMaxPerType(1), 1);
  });
});

describe("runSightings featuring", () => {
  it("a day of many insider clusters leaves room for other event types, tiers unchanged", async () => {
    const events = [...Array.from({ length: 8 }, (_, i) => ownEvent(i)), lateFiling(20), lateFiling(21), lateFiling(22)];
    // 6 slots: at most 3 of one type (40%, rounded up).
    const r = await run(events, { maxCards: 6 });
    const byType = (t: string) => r.feed.cards.filter((c) => c.event.eventType === t);
    assert.equal(r.feed.cards.length, 6);
    assert.equal(byType("insider_cluster").length, 3);
    assert.equal(byType("distress_nt").length, 3);
    // Tiers are the evidence bar, never changed by featuring.
    assert.ok(byType("insider_cluster").every((c) => c.tier === "documented"));
    assert.ok(byType("distress_nt").every((c) => c.tier === "watch"));
    // Featured order keeps Documented ahead of Watch.
    assert.deepEqual(r.feed.cards.map((c) => c.tier), ["documented", "documented", "documented", "watch", "watch", "watch"]);
    assert.deepEqual(r.analysis?.featuredByType, { insider_cluster: 3, distress_nt: 3 });
    // The ledger and the ranking report agree with the feed.
    const featured = new Set(r.feed.cards.map((c) => c.id));
    assert.ok(r.ledger?.every((row) => row.published === featured.has(row.card_id)));
    assert.equal(r.ledger?.filter((row) => row.published).length, 6);
    assert.deepEqual(new Set(r.ranking.cards.filter((c) => c.chosen).map((c) => c.eventId)), new Set(r.feed.cards.map((c) => c.event.id)));
    assert.ok(analysisLines(r.analysis!).includes("featured by type: distress_nt 3, insider_cluster 3"));
  });

  it("every type is held to the quota before passed-over cards fill the open slots", async () => {
    const events = [...Array.from({ length: 8 }, (_, i) => ownEvent(i)), lateFiling(20), lateFiling(21), lateFiling(22)];
    // 5 slots, 2 per type: 2 insider + 2 late filings, then the best passed-over card (an insider cluster).
    const r = await run(events);
    assert.deepEqual(r.analysis?.featuredByType, { insider_cluster: 3, distress_nt: 2 });
  });

  it("with only insider clusters the feed is still full", async () => {
    const r = await run(Array.from({ length: 8 }, (_, i) => ownEvent(i)));
    assert.equal(r.feed.cards.length, 5);
    assert.ok(r.feed.cards.every((c) => c.event.eventType === "insider_cluster"));
  });

  it("maxPerType can be set per run", async () => {
    const events = [...Array.from({ length: 8 }, (_, i) => ownEvent(i)), lateFiling(20), lateFiling(21), lateFiling(22)];
    const r = await run(events, { maxPerType: 4 });
    assert.equal(r.feed.cards.filter((c) => c.event.eventType === "insider_cluster").length, 4);
  });
});

describe("detector model budget", () => {
  it("detectors get the default budget unless the run sets one", async () => {
    const seen: number[] = [];
    const detect = async (ctx: DetectorContext) => {
      seen.push(ctx.llmBudgetUsd);
      return [];
    };
    await run([], { detect });
    await run([], { detect, detectorBudgetUsd: 0.2 });
    assert.ok(DEFAULT_DETECTOR_BUDGET_USD > 0);
    assert.deepEqual(seen, [DEFAULT_DETECTOR_BUDGET_USD, 0.2]);
  });
});
