import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bandFor, blendScore, componentSentence, effectiveWeights, pickDriver, pickDriverKey } from "./blend.js";
import type { RiskComponents } from "./types.js";
import { cfg } from "./test-fixtures.js";

const config = cfg();
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function components(scores: Partial<Record<keyof RiskComponents, number | null>>, extra: Partial<RiskComponents> = {}): RiskComponents {
  return {
    concentration: { score: scores.concentration ?? 0, hhi: 0.21, top: [{ ticker: "NVDA", weight: 0.62 }] },
    market: { score: scores.market ?? 0, beta_eff: 1.48, beta_port: 1.6 },
    volatility: { score: scores.volatility ?? 0, port_vol_daily_pct: 2.14, spy_vol_daily_pct: 0.9, systematic_share: 0.4 },
    network: {
      score: scores.network ?? 0,
      linked_fraction: 0.34,
      pair_count: 3,
      excluded: [],
      top_links: [
        {
          a: "NVDA",
          b: "TSM",
          via: "direct",
          category: "supplier",
          tier: "critical",
          link: 1,
          edge_id: "e",
          edge_id_b: null,
          counterparty: null,
          counterparty_label: null,
          pair_weight: 0.1,
          evidence_quote: "q",
        },
      ],
    },
    event: {
      score: scores.event ?? 0,
      raw: 12,
      contributors: [{ ticker: "NVDA", kind: "earnings_window", detail: "2 sessions", contribution: 20, weighted: 10 }],
    },
    sharpe: {
      score: scores.sharpe === undefined ? 0 : scores.sharpe,
      sharpe: 0.42,
      sessions: 90,
      ann_return_pct: 12.4,
      ann_vol_pct: 19.8,
      risk_free_pct: 4,
      excluded: [],
    },
    ...extra,
  };
}

describe("risk/blend", () => {
  it("score = Σ component × weight, rounded; bands follow the thresholds", () => {
    const c = components({ concentration: 55, market: 70, volatility: 61, network: 72, event: 48, sharpe: 40 });
    // 9.9 + 11.9 + 10.98 + 15.84 + 6.24 + 4.8 = 59.66 → 60
    assert.equal(blendScore(c, config.weights), 60);
    assert.equal(bandFor(62, config.bands), "elevated");
    assert.equal(bandFor(0, config.bands), "low");
    assert.equal(bandFor(29, config.bands), "low");
    assert.equal(bandFor(30, config.bands), "moderate");
    assert.equal(bandFor(54, config.bands), "moderate");
    assert.equal(bandFor(55, config.bands), "elevated");
    assert.equal(bandFor(74, config.bands), "elevated");
    assert.equal(bandFor(75, config.bands), "high");
    assert.equal(bandFor(100, config.bands), "high");
  });

  it("a 72 is elevated, never low", () => {
    assert.notEqual(bandFor(72, config.bands), "low");
    assert.equal(bandFor(72, config.bands), "elevated");
  });

  it("driver = largest score × weight; tie → higher weight wins", () => {
    const c = components({ concentration: 55, market: 70, volatility: 61, network: 72, event: 48, sharpe: 40 });
    assert.equal(pickDriverKey(c, config.weights), "network"); // 15.84 vs 11.9
    // concentration 55 × .18 = 9.9 == network 45 × .22 = 9.9 → network (heavier)
    const tie = components({ concentration: 55, market: 0, volatility: 0, network: 45, event: 0, sharpe: 0 });
    assert.equal(pickDriverKey(tie, config.weights), "network");
    // concentration and volatility share .18 → canonical order picks the first
    const flat = components({ concentration: 50, market: 50, volatility: 50, network: 0, event: 0, sharpe: 0 });
    assert.equal(pickDriverKey(flat, config.weights), "concentration");
  });

  it("a component with no score leaves the blend and the rest are renormalised", () => {
    // Sharpe absent: the other five carry .88 of the config's weight, so each
    // is scaled by 1/.88 and the score keeps its 0-100 meaning.
    const c = components({ concentration: 55, market: 70, volatility: 61, network: 72, event: 48, sharpe: null });
    const raw = 55 * 0.18 + 70 * 0.17 + 61 * 0.18 + 72 * 0.22 + 48 * 0.13;
    assert.equal(blendScore(c, config.weights), Math.round(raw / 0.88));
    const effective = effectiveWeights(c, config.weights);
    assert.equal(effective.sharpe, 0);
    assert.ok(Math.abs(effective.network - 0.22 / 0.88) < 1e-12);
    assert.ok(Math.abs(Object.values(effective).reduce((s, w) => s + w, 0) - 1) < 1e-12);
    // ...and it can never be the driver.
    assert.notEqual(pickDriverKey(components({ sharpe: null, concentration: 10 }), config.weights), "sharpe");
  });

  it("sentences are descriptive templates filled from the payloads", () => {
    const c = components({ network: 72 });
    assert.equal(componentSentence("concentration", c, config), "62% of the portfolio sits in NVDA.");
    assert.equal(componentSentence("market", c, config), "The book moves about 1.48× the market.");
    assert.equal(componentSentence("volatility", c, config), "A typical day swings the book about 2.1%.");
    assert.equal(componentSentence("network", c, config), "NVDA and TSM share critical supply-chain exposure.");
    assert.equal(componentSentence("event", c, config), "NVDA reports earnings in 2 sessions.");
    assert.equal(componentSentence("sharpe", c, config), "The book's 90-session Sharpe is 0.42.");
    const driver = pickDriver(c, config);
    assert.equal(driver.component, "network");
    assert.equal(driver.sentence, "NVDA and TSM share critical supply-chain exposure.");
    assert.equal(driver.contribution, round3(72 * 0.22));
  });

  it("event sentences per contributor kind; shared-dependency network sentence", () => {
    const base = components({});
    const evt = (kind: RiskComponents["event"]["contributors"][number]["kind"], detail: string) =>
      componentSentence("event", { ...base, event: { score: 0, raw: 0, contributors: [{ ticker: "ZLAB", kind, detail, contribution: 1, weighted: 1 }] } }, config);
    assert.equal(evt("incident", "P1"), "ZLAB has an open P1 incident.");
    assert.equal(evt("earnings_window", "today"), "ZLAB reports earnings today.");
    assert.equal(evt("earnings_window", "1 session"), "ZLAB reports earnings in 1 session.");
    assert.equal(evt("insider_cluster", "sell cluster"), "ZLAB shows an active insider selling cluster.");
    assert.equal(evt("filing_overdue", "filing overdue"), "ZLAB has an overdue filing.");
    const shared = {
      ...base,
      network: { ...base.network, top_links: [{ ...base.network.top_links[0], a: "PFE", b: "MRK", via: "shared" as const, counterparty: "name:lonza", counterparty_label: "Lonza Group" }] },
    };
    assert.equal(componentSentence("network", shared, config), "PFE and MRK both depend on Lonza Group.");
    const none = { ...base, network: { ...base.network, top_links: [] }, event: { ...base.event, contributors: [] } };
    assert.equal(componentSentence("network", none, config), "No filing-backed links between held names.");
    assert.equal(componentSentence("event", none, config), "No open incidents or scheduled events on held names.");
  });

  it("never uses imperative or predictive language in the default templates", () => {
    const text = JSON.stringify(config.templates).toLowerCase();
    for (const banned of ["reduce", "trim", "consider", "should", "will ", "expect", "forecast", "predict", "likely", "may "]) {
      assert.ok(!text.includes(banned), `template contains "${banned}"`);
    }
  });
});
