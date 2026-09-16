import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bandHeadline, dominantSector, type BandCandidate } from "./band-headline.js";
import { DEFAULT_SCREEN_CONFIG } from "./config.js";
import { bannedWordHits } from "./templates.js";

const templates = DEFAULT_SCREEN_CONFIG.templates;
const sectors = DEFAULT_SCREEN_CONFIG.sectors;

function compression(tier1: BandCandidate[]) {
  return bandHeadline({ mode: "compression", tier1, sectors, templates });
}

/** Four semis and one retailer: a majority, so it clusters. */
const SEMI_CLUSTER: BandCandidate[] = [
  { ticker: "AVGO", value: 0.82 },
  { ticker: "TSM", value: 0.84 },
  { ticker: "INTC", value: 0.86 },
  { ticker: "AMD", value: 0.88 },
  { ticker: "COST", value: 0.89 },
];

describe("band headline / compression", () => {
  it("rule 1 — a complete 90-session low wins over everything else", () => {
    const tier1 = SEMI_CLUSTER.map((c, i) => (i === 0 ? { ...c, ninetyDayLow: true } : c));
    const out = compression(tier1);
    assert.equal(out.rule, "ninety_day_low");
    assert.equal(out.text, "AVGO is at its quietest in 90 days");
  });

  it("rule 1 does not fire on an incomplete series", () => {
    // ninetyDayLow is left undefined exactly when the series is not full.
    assert.notEqual(compression(SEMI_CLUSTER).rule, "ninety_day_low");
  });

  it("rule 2 — a sector majority of three or more names", () => {
    const out = compression(SEMI_CLUSTER);
    assert.equal(out.rule, "cluster");
    assert.equal(out.text, "Semis are coiling — AVGO, TSM and 3 more below 0.9×");
  });

  it("rule 3 — one name well past the threshold, no cluster", () => {
    const out = compression([
      { ticker: "QCOM", value: 0.57 },
      { ticker: "COST", value: 0.85 },
    ]);
    assert.equal(out.rule, "single");
    assert.equal(out.text, "QCOM trading at 0.57× its normal volatility");
  });

  it("rule 4 — broad but unremarkable", () => {
    const out = compression([
      { ticker: "COST", value: 0.85 },
      { ticker: "BLK", value: 0.87 },
      { ticker: "META", value: 0.88 },
    ]);
    assert.equal(out.rule, "broad");
    assert.equal(out.text, "3 names compressing — COST leads at 0.85×");
  });

  it("rule 5 — nothing cleared the threshold", () => {
    const out = compression([]);
    assert.equal(out.rule, "empty");
    assert.equal(out.text, "No unusual compression today");
  });

  it("the hero is whatever tier one puts first — a pinned name cannot reach it", () => {
    // The card also draws held/watched names, but they never enter tier one,
    // so they can never be the hero. Passing only tier one is the guarantee.
    const out = compression([{ ticker: "QCOM", value: 0.57 }]);
    assert.match(out.text, /^QCOM/);
  });
});

describe("band headline / volume", () => {
  const volume = (tier1: BandCandidate[]) =>
    bandHeadline({ mode: "volume", tier1, sectors, templates });

  it("rule 1 — heavy volume with the price going nowhere", () => {
    const out = volume([{ ticker: "AMKR", value: 2.1, sessions: 4, momentumZ: 0.3 }]);
    assert.equal(out.rule, "flat_price");
    assert.equal(out.text, "AMKR — 4 days of heavy volume, price flat");
  });

  it("rule 2 — a sector cluster once the price is moving", () => {
    const out = volume(
      SEMI_CLUSTER.map((c) => ({ ...c, value: 1.8, momentumZ: 2.2, sessions: 3 })),
    );
    assert.equal(out.rule, "cluster");
    assert.equal(out.text, "Volume building across Semis — AVGO, TSM and 3 more");
  });

  it("rule 3 — a single name, one decimal on the ratio", () => {
    const out = volume([
      { ticker: "PLTR", value: 2.34, momentumZ: 3.1, sessions: 5 },
      { ticker: "COST", value: 1.6, momentumZ: 2.0, sessions: 2 },
    ]);
    assert.equal(out.rule, "single");
    assert.equal(out.text, "PLTR turning 2.3× its usual volume");
  });

  it("rule 4 — empty", () => {
    assert.equal(volume([]).text, "No unusual volume today");
  });
});

describe("band headline / residual", () => {
  const residual = (tier1: BandCandidate[]) =>
    bandHeadline({ mode: "residual", tier1, sectors, templates });

  it("rule 1 — a run, with the word taken from the sign", () => {
    const up = residual([{ ticker: "CEG", value: 0.06, runSessions: 4, direction: 1 }]);
    assert.equal(up.rule, "run");
    assert.equal(up.text, "CEG pushing higher on its own — 4 sessions running");

    const down = residual([{ ticker: "CEG", value: -0.06, runSessions: 3, direction: -1 }]);
    assert.equal(down.text, "CEG sliding lower on its own — 3 sessions running");
  });

  it("a run shorter than three sessions is not a run", () => {
    const out = residual(
      SEMI_CLUSTER.map((c) => ({ ...c, runSessions: 2, direction: 1 as const })),
    );
    assert.equal(out.rule, "cluster");
    assert.equal(out.text, "Independent pressure in Semis — AVGO, TSM and 3 more");
  });

  it("rule 3 — empty", () => {
    assert.equal(residual([]).text, "Nothing moving independently today");
  });
});

describe("band headline / shared rules", () => {
  it("a sector needs a majority, not a plurality", () => {
    // Two semis, two pharma, one retailer: 2 of 5 is not more than half.
    const split: BandCandidate[] = [
      { ticker: "AVGO", value: 0.82 },
      { ticker: "TSM", value: 0.84 },
      { ticker: "LLY", value: 0.86 },
      { ticker: "MRK", value: 0.87 },
      { ticker: "COST", value: 0.88 },
    ];
    assert.equal(dominantSector(split, sectors), null);
    assert.equal(compression(split).rule, "broad");
  });

  it("two names never cluster, however alike", () => {
    assert.equal(
      dominantSector([{ ticker: "AVGO", value: 0.8 }, { ticker: "TSM", value: 0.81 }], sectors),
      null,
    );
  });

  it("regime prints two decimals and a multiplication sign; sessions print as digits", () => {
    assert.match(compression([{ ticker: "QCOM", value: 0.6 }]).text, /0\.60×/);
    const run = bandHeadline({
      mode: "residual",
      tier1: [{ ticker: "CEG", value: 0.06, runSessions: 4, direction: 1 }],
      sectors,
      templates,
    });
    assert.match(run.text, /\b4 sessions\b/);
    assert.doesNotMatch(run.text, /\bfour\b/i);
  });

  it("every band template is free of banned words", () => {
    const words = DEFAULT_SCREEN_CONFIG.bannedWords;
    const offenders: string[] = [];
    for (const [key, template] of Object.entries(templates)) {
      if (!key.startsWith("band_")) continue;
      const hits = bannedWordHits(template, words);
      if (hits.length) offenders.push(`${key}: ${hits.join(", ")}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("every rendered headline is free of banned words", () => {
    const words = DEFAULT_SCREEN_CONFIG.bannedWords;
    const rendered = [
      compression([{ ticker: "AVGO", value: 0.8, ninetyDayLow: true }]).text,
      compression(SEMI_CLUSTER).text,
      compression([{ ticker: "QCOM", value: 0.57 }]).text,
      compression([
        { ticker: "COST", value: 0.85 },
        { ticker: "BLK", value: 0.87 },
        { ticker: "META", value: 0.88 },
      ]).text,
      compression([]).text,
      bandHeadline({
        mode: "volume",
        tier1: [{ ticker: "AMKR", value: 2.1, sessions: 4, momentumZ: 0.3 }],
        sectors,
        templates,
      }).text,
      bandHeadline({
        mode: "residual",
        tier1: [{ ticker: "CEG", value: 0.06, runSessions: 4, direction: -1 }],
        sectors,
        templates,
      }).text,
    ];
    const offenders = rendered
      .map((text) => ({ text, hits: bannedWordHits(text, words) }))
      .filter((r) => r.hits.length > 0)
      .map((r) => `${r.text} → ${r.hits.join(", ")}`);
    assert.deepEqual(offenders, []);
  });

  it("a missing template is a loud failure, not a half-rendered sentence", () => {
    assert.throws(
      () => bandHeadline({ mode: "compression", tier1: [], sectors, templates: {} }),
      /missing template/,
    );
  });
});
