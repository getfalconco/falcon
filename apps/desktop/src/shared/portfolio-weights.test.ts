import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeRiskSnapshot, DEFAULT_RISK_CONFIG, type RiskInputs } from "@meridian/research/risk";
import { accountWeight, formatWeightPct, paperAccountWeights, positionMarketValue, type PaperBook } from "./portfolio-weights.js";
import { concentrationShare, riskCardModel } from "./risk-card.js";
import type { RiskSnapshot } from "./risk-types.js";

/**
 * The bug this guards: the Positions card printed LLY at 24.8% of the account
 * while the Risk Score card said "30% of the portfolio sits in LLY", because the
 * engine divided by invested value alone (and priced at its own last close).
 * Both cards now read shared/portfolio-weights.ts over the same prints.
 */

/** A paper book with 17.3% of it in cash, LLY a quarter of it. */
const BOOK: PaperBook = {
  cash: 17_300,
  positions: {
    LLY: { symbol: "LLY", shares: 31, costUsd: 21_000 },
    NVDA: { symbol: "NVDA", shares: 120, costUsd: 18_000 },
    SPY: { symbol: "SPY", shares: 50, costUsd: 30_000 },
    XOM: { symbol: "XOM", shares: 20, costUsd: 2_100 },
  },
};
// LLY 24,800 · NVDA 24,000 · SPY 32,000 · XOM 1,900 = 82,700 invested;
// + 17,300 cash = 100,000 account.
const PRICES: Record<string, number> = { LLY: 800, NVDA: 200, SPY: 640, XOM: 95 };

/** The Positions card's weight cell, as PortfolioCard.tsx builds it. */
function positionsCardWeight(book: PaperBook, prices: Record<string, number>, symbol: string): string | null {
  const p = book.positions[symbol];
  const total = paperAccountWeights(book, prices).total;
  return formatWeightPct(accountWeight(positionMarketValue(p.shares, p.costUsd, prices[symbol]), total));
}

/** The Risk Score card's figure for the snapshot's concentration name. */
function riskCardWeight(book: PaperBook, prices: Record<string, number>, ticker: string) {
  const model = riskCardModel({ snapshot: snapshotDrivenBy(ticker), riskCardEnabled: true });
  return concentrationShare(model, paperAccountWeights(book, prices));
}

function snapshotDrivenBy(ticker: string): RiskSnapshot {
  return {
    schema_version: 1,
    computed_at: "2026-10-10T14:00:00.000Z",
    account: "paper",
    trigger: ["manual"],
    invested_fraction: 0.827,
    position_count: 4,
    score: 64,
    band: "elevated",
    components: {
      // As an older engine wrote it: the invested-only weight and nothing else.
      concentration: { score: 60, hhi: 0.28, top: [{ ticker, weight: 0.2999 }] },
      market: { score: 40, beta_eff: 1.1, beta_port: 1.3 },
      volatility: { score: 40, port_vol_daily_pct: 1.4, spy_vol_daily_pct: 0.9, systematic_share: 0.5 },
      network: { score: 10, linked_fraction: 0, pair_count: 0, excluded: [], top_links: [] },
      event: { score: 0, raw: 0, contributors: [] },
      sharpe: { score: null, sharpe: null, sessions: 0, ann_return_pct: 0, ann_vol_pct: 0, risk_free_pct: 4, excluded: [] },
    },
    driver: { component: "concentration", sentence: `30% of the portfolio sits in ${ticker}.`, contribution: 11 },
    weights: [],
    blend_weights: { concentration: 0.18, market: 0.17, volatility: 0.18, network: 0.22, event: 0.13, sharpe: 0.12 },
    degraded: [],
    graph_version: null,
    empty: false,
  } as RiskSnapshot;
}

describe("portfolio weights: one figure on both dashboard cards", () => {
  it("the Positions card and the Risk Score card print the same LLY weight, cash included", () => {
    assert.equal(positionsCardWeight(BOOK, PRICES, "LLY"), "24.8%");
    assert.deepEqual(riskCardWeight(BOOK, PRICES, "LLY"), { ticker: "LLY", pct: "24.8%" });
  });

  it("the engine, handed the same prints, writes the same figure into its own sentence", () => {
    const inputs: RiskInputs = {
      now: "2026-10-10T14:00:00.000Z",
      account: {
        account: "paper",
        cash: BOOK.cash,
        positions: Object.values(BOOK.positions).map((p) => ({
          ticker: p.symbol,
          shares: p.shares,
          cost_usd: p.costUsd,
          market_value: p.shares * PRICES[p.symbol],
        })),
        as_of: null,
      },
      quant: {},
      spy_daily_vol: 0.01,
      universe_median_vol: 0.02,
      graph: null,
      live: { open_incidents: [], anomalies: [], earnings: [] },
      bars: {},
    };
    const snap = computeRiskSnapshot(inputs, DEFAULT_RISK_CONFIG);
    const c = snap.components!.concentration;
    assert.equal(c.account_value, 100_000);
    for (const symbol of ["SPY", "LLY", "NVDA"]) {
      const row = c.top.find((t) => t.ticker === symbol)!;
      assert.equal(formatWeightPct(row.account_weight), positionsCardWeight(BOOK, PRICES, symbol), symbol);
    }
    // The invested-only share the HHI runs on is still there, and is the 30%.
    assert.equal(formatWeightPct(c.top.find((t) => t.ticker === "LLY")!.weight), "30.0%");
    if (snap.driver?.component === "concentration") {
      assert.equal(snap.driver.sentence, "32.0% of the portfolio sits in SPY.");
    }
  });

  it("no cash: the account is the holdings", () => {
    const book: PaperBook = { cash: 0, positions: { LLY: BOOK.positions.LLY, XOM: BOOK.positions.XOM } };
    assert.equal(positionsCardWeight(book, PRICES, "LLY"), "92.9%");
    assert.equal(riskCardWeight(book, PRICES, "LLY")?.pct, "92.9%");
  });

  it("negative cash (margin): the account is net of the debt, both cards alike", () => {
    const book: PaperBook = { cash: -1_900, positions: { LLY: BOOK.positions.LLY, XOM: BOOK.positions.XOM } };
    // 24,800 + 1,900 - 1,900 = 24,800 account: LLY is all of it.
    assert.equal(positionsCardWeight(book, PRICES, "LLY"), "100.0%");
    assert.equal(riskCardWeight(book, PRICES, "LLY")?.pct, "100.0%");
  });

  it("a short: negative on the Positions card, quoted by its size in the sentence", () => {
    // Short 20 TSLA at 250: the proceeds of 5,000 sit in cash.
    const book: PaperBook = {
      cash: 25_000,
      positions: { TSLA: { symbol: "TSLA", shares: -20, costUsd: -4_000 }, XOM: BOOK.positions.XOM },
    };
    const prices = { ...PRICES, TSLA: 250 };
    // 25,000 - 5,000 + 1,900 = 21,900.
    assert.equal(positionsCardWeight(book, prices, "TSLA"), "-22.8%");
    assert.equal(riskCardWeight(book, prices, "TSLA")?.pct, "22.8%");
  });

  it("an account worth nothing has no weight: n/a on one card, no figure in the other", () => {
    const book: PaperBook = { cash: -24_800, positions: { LLY: BOOK.positions.LLY } };
    assert.equal(positionsCardWeight(book, PRICES, "LLY"), null);
    assert.deepEqual(riskCardWeight(book, PRICES, "LLY"), { ticker: "LLY", pct: null });
  });

  it("an unpriced name is carried at cost on both cards", () => {
    const prices = { NVDA: 200, SPY: 640, XOM: 95 };
    const expected = formatWeightPct(21_000 / (17_300 + 21_000 + 24_000 + 32_000 + 1_900));
    assert.equal(positionsCardWeight(BOOK, prices, "LLY"), expected);
    assert.equal(riskCardWeight(BOOK, prices, "LLY")?.pct, expected);
  });

  it("falls back to the engine's sentence when the driver is not concentration or the name was sold", () => {
    assert.equal(riskCardWeight(BOOK, PRICES, "AAPL"), null);
    const network = riskCardModel({
      snapshot: { ...snapshotDrivenBy("LLY"), driver: { component: "network", sentence: "x", contribution: 1 } },
      riskCardEnabled: true,
    });
    assert.equal(network.kind === "score" ? network.concentration : "?", null);
    assert.equal(concentrationShare(network, paperAccountWeights(BOOK, PRICES)), null);
  });
});
