import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountWeights, capPairs, pairsFor, rankRows, scoreOf, WATCH_WEIGHT } from "./radar";
import type { LinkEdge } from "../../shared/earnings-links";
import type { ReadthroughRow, ReadthroughStats } from "../../shared/readthrough-types";

function edge(root: string, other: string, category: string, extra: Partial<LinkEdge> = {}): LinkEdge {
  return {
    root_ticker: root,
    counterparty_ticker: other,
    category,
    strength_tier: "critical",
    confidence: 0.9,
    evidence_quote: "a quote",
    source_url: `https://www.sec.gov/Archives/${root}`,
    accession_number: "0000000000-26-000001",
    filing_date: "2026-02-26",
    ...extra,
  };
}

const names = new Map([
  ["NVDA", { held: true }],
  ["AAPL", { held: false }],
]);

describe("pairsFor", () => {
  it("reads each link from the reader's side", () => {
    const pairs = pairsFor(
      [
        // NVDA's own 10-K names TSM as its supplier: TSM supplies NVDA.
        edge("NVDA", "TSM", "supplier"),
        // MSFT's 10-K names NVDA as its supplier: MSFT is NVDA's customer.
        edge("MSFT", "NVDA", "supplier"),
        // AMD names NVDA a competitor: a competitor either way.
        edge("AMD", "NVDA", "competitor"),
        // A partner is not one of the three.
        edge("NVDA", "ARM", "partner"),
      ],
      names,
    );
    const by = new Map(pairs.map((p) => [`${p.counterparty}>${p.holding}`, p]));
    assert.equal(by.get("TSM>NVDA")?.relation, "supplier");
    assert.equal(by.get("MSFT>NVDA")?.relation, "customer");
    assert.equal(by.get("AMD>NVDA")?.relation, "competitor");
    assert.equal(by.get("MSFT>NVDA")?.namedBy, "MSFT");
    assert.ok(!by.has("ARM>NVDA"));
  });

  it("keeps only filing-backed, confident, material links", () => {
    const pairs = pairsFor(
      [
        edge("NVDA", "TSM", "supplier", { source_url: "https://example.com/x" }),
        edge("NVDA", "SMCI", "customer", { confidence: 0.6 }),
        edge("NVDA", "DELL", "customer", { strength_tier: "marginal" }),
        edge("NVDA", "AVGO", "competitor", { strength_tier: "important" }),
      ],
      names,
    );
    assert.deepEqual(
      pairs.map((p) => [p.counterparty, p.tier]),
      [["AVGO", "important"]],
    );
  });

  it("keeps the closer link per pair and puts held names first", () => {
    const pairs = pairsFor(
      [
        edge("AAPL", "TSM", "supplier"),
        edge("NVDA", "TSM", "supplier", { strength_tier: "important", confidence: 0.95 }),
        edge("TSM", "NVDA", "customer", { confidence: 0.85 }),
      ],
      names,
    );
    assert.deepEqual(
      pairs.map((p) => `${p.counterparty}>${p.holding}:${p.tier}`),
      ["TSM>NVDA:critical", "TSM>AAPL:critical"],
    );
  });

  it("caps the companies read, keeping every pair of a kept company", () => {
    const pairs = pairsFor([edge("NVDA", "TSM", "supplier"), edge("AAPL", "TSM", "supplier"), edge("NVDA", "AMD", "competitor")], names);
    const capped = capPairs(pairs, 1);
    assert.equal(capped.truncated, true);
    assert.deepEqual(capped.pairs.map((p) => `${p.counterparty}>${p.holding}`), ["AMD>NVDA"]);
  });
});

describe("accountWeights", () => {
  it("weighs a held name by its share of the held value", () => {
    const closes: Record<string, number> = { NVDA: 100, AAPL: 200 };
    const w = accountWeights(
      [
        { ticker: "NVDA", shares: 30 },
        { ticker: "AAPL", shares: 10 },
      ],
      (t) => closes[t] ?? null,
    );
    // 3000 of 5000 and 2000 of 5000.
    assert.equal(w.get("NVDA"), 1.1);
    assert.equal(w.get("AAPL"), 0.9);
  });

  it("gives an unvalued position an even slice and still sums the shares to one", () => {
    const w = accountWeights(
      [
        { ticker: "NVDA", shares: 10 },
        { ticker: "XYZ", shares: null },
      ],
      (t) => (t === "NVDA" ? 100 : null),
    );
    assert.equal(w.get("NVDA"), 1);
    assert.equal(w.get("XYZ"), 1);
  });
});

function stats(sensitivity: number | null): ReadthroughStats {
  return {
    events: 8,
    withIt: 6,
    avgAbsMove: 0.02,
    avgAbsAbnormal: 0.015,
    avgFollow: 0.01,
    avgNextFollow: null,
    nextEvents: 0,
    normalAbsAbnormal: 0.01,
    sensitivity,
    surpriseEvents: 0,
    withSurprise: 0,
    beta: 1,
    betaFallback: false,
    from: "2024-08-01",
    to: "2026-07-20",
  };
}

function row(id: string, s: ReadthroughStats | null, weight: number, date: string, kind: ReadthroughRow["kind"] = "upcoming"): ReadthroughRow {
  const [counterparty, holding] = id.split(">") as [string, string];
  const r: ReadthroughRow = {
    id,
    counterparty,
    counterpartyName: null,
    holding,
    held: weight !== WATCH_WEIGHT,
    watchlist: weight === WATCH_WEIGHT,
    relation: "supplier",
    tier: "critical",
    namedBy: holding,
    form: "10-K",
    filingDate: null,
    sourceUrl: null,
    kind,
    date,
    time: "unknown",
    status: "confirmed",
    report: null,
    sample: s ? s.events : 2,
    stats: s,
    events: [],
    weight,
    score: 0,
  };
  r.score = scoreOf(r);
  return r;
}

describe("rankRows", () => {
  it("orders by sensitivity times weight, unmeasured last, then the nearer date", () => {
    const today = "2026-10-15";
    const ranked = rankRows(
      [
        row("A>H", stats(1.2), 1.5, "2026-10-20"), // 1.8
        row("B>H", stats(3.0), WATCH_WEIGHT, "2026-10-16"), // 0.75
        row("C>H", null, 1.5, "2026-10-16"), // unmeasured
        row("D>H", stats(2.0), 1, "2026-10-28"), // 2.0
        row("E>H", stats(2.0), 1, "2026-10-17"), // 2.0, nearer
        row("F>H", null, 1, "2026-10-15", "recent"), // unmeasured, nearer than C
      ],
      today,
    );
    assert.deepEqual(
      ranked.map((r) => r.counterparty),
      ["E", "D", "A", "B", "F", "C"],
    );
    assert.equal(ranked[2]!.score, 1.8);
  });
});

describe("pairsFor: unclassified strength (the classifier gave no tier)", () => {
  it("reads an unclassified link through as important, whatever tier it carries", () => {
    const pairs = pairsFor(
      [
        edge("NVDA", "TSM", "supplier", { strength_tier: "important", strength_basis: "unclassified" }),
        edge("NVDA", "UMC", "supplier", { strength_tier: "marginal", strength_basis: "unclassified" }),
        edge("NVDA", "INTC", "supplier", { strength_tier: "marginal" }),
      ],
      names,
    );
    const by = new Map(pairs.map((p) => [p.counterparty, p.tier]));
    assert.equal(by.get("TSM"), "important");
    assert.equal(by.get("UMC"), "important");
    assert.ok(!by.has("INTC"), "a measured marginal link does not read through");
  });
});
