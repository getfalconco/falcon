import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG } from "../base/config.js";
import { emptyTickerState } from "../tracker/store.js";
import type { DailyBar, TickerState, TrackerMessage } from "../tracker/types.js";
import { anomaliesFromState, earningsFromState, gatherRiskInputs, heldTickersOf, quantFromState, type RiskTrackerSource } from "./gather.js";
import { account, position, syntheticGraph } from "./test-fixtures.js";

const NOW = "2026-08-24T15:00:00.000Z"; // Monday 11:00 ET

function bars(closes: number[], from = 1): DailyBar[] {
  return closes.map((c, i) => ({ d: `2026-07-${String(from + i).padStart(2, "0")}`, o: c, h: c, l: c, c, v: 1 }));
}

function state(ticker: string, overrides: Partial<TickerState> = {}): TickerState {
  const s = emptyTickerState(ticker, NOW);
  return { ...s, ...overrides };
}

function source(states: Record<string, TickerState>, messages: TrackerMessage[] = [], bench: DailyBar[] = []): RiskTrackerSource {
  return {
    tickers: () => Object.keys(states),
    state: (t) => states[t.toUpperCase()] ?? null,
    messages: (o) => (o?.ticker ? messages.filter((m) => m.ticker === o.ticker) : messages).slice(0, o?.limit ?? 1000),
    benchmarkBars: () => bench,
  };
}

describe("risk/gather", () => {
  it("heldTickersOf upper-cases, dedupes and drops flat positions", () => {
    assert.deepEqual(heldTickersOf(account([position("nvda", 1, 1), position("TSM", 0, 0), position("NVDA", 2, 2)])), ["NVDA"]);
    assert.deepEqual(heldTickersOf(null), []);
  });

  it("quantFromState maps Tracker quant with null passthrough and bar-close price fallback", () => {
    assert.equal(quantFromState(null), null);
    const s = state("NVDA", { bars: bars([100, 101]), quant: null });
    assert.deepEqual(quantFromState(s), { beta: null, r2: null, daily_vol: null, earnings_rhythm: null, last_price: 101 });
    const withQuant = state("NVDA", {
      bars: bars([100]),
      quant: { ...emptyQuant(), beta_90d: 1.9, r_squared: 0.4, daily_vol_30d: 0.033, earnings_rhythm: 0.028, last_price: 214.72 },
    });
    assert.deepEqual(quantFromState(withQuant), { beta: 1.9, r2: 0.4, daily_vol: 0.033, earnings_rhythm: 0.028, last_price: 214.72 });
  });

  it("anomaliesFromState reads edge detectors, unexplained on the last close day, insider cluster only when the latest cluster sold", () => {
    const s = state("ZLAB", { lastCloseComputedFor: "2026-08-21" });
    s.detectors.drift.active = true;
    s.detectors.filingOverdue.active = true;
    s.detectors.unexplained.lastFiredDay = "2026-08-21";
    s.detectors.insiderCluster.active = true;
    const sell = { type: "insider_cluster", ticker: "ZLAB", payload: { direction: "sell" } } as unknown as TrackerMessage;
    const buy = { type: "insider_cluster", ticker: "ZLAB", payload: { direction: "buy" } } as unknown as TrackerMessage;
    assert.deepEqual(
      anomaliesFromState(s, sell).map((a) => a.kind),
      ["insider_cluster", "drift", "filing_overdue", "unexplained_move"],
    );
    assert.deepEqual(
      anomaliesFromState(s, buy).map((a) => a.kind),
      ["drift", "filing_overdue", "unexplained_move"],
    );
    s.detectors.unexplained.lastFiredDay = "2026-08-14"; // stale fire → not active
    assert.ok(!anomaliesFromState(s, undefined).some((a) => a.kind === "unexplained_move"));
  });

  it("earningsFromState counts trading sessions to confirmed due dates only", () => {
    const s = state("NVDA", {
      scheduledEarnings: [
        { dueAt: "2026-08-26T20:00:00.000Z", fiscalPeriod: "Q2 2027", confirmed: true }, // Wed amc → 2 sessions from Mon
        { dueAt: "2026-11-17T21:00:00.000Z", fiscalPeriod: "Q3 2027", confirmed: false }, // projection → ignored
        { dueAt: "2026-08-20T20:00:00.000Z", fiscalPeriod: "old", confirmed: true }, // past → -1
      ],
    });
    const out = earningsFromState(s, "2026-08-24");
    assert.deepEqual(
      out.map((e) => [e.fiscal_period, e.sessions_until]),
      [
        ["Q2 2027", 2],
        ["old", -1],
      ],
    );
  });

  it("gatherRiskInputs assembles quant, SPY vol, median vol, graph, live state and close-day keys", () => {
    const spyCloses = Array.from({ length: 40 }, (_, i) => 500 + Math.sin(i) * 2);
    const nvda = state("NVDA", {
      bars: bars([200, 214.72]),
      quant: { ...emptyQuant(), beta_90d: 1.94, r_squared: 0.4, daily_vol_30d: 0.033, earnings_rhythm: 0.028, last_price: 214.72 },
      quantAsOf: "2026-08-21",
      lastCloseComputedFor: "2026-08-21",
      scheduledEarnings: [{ dueAt: "2026-08-26T20:00:00.000Z", fiscalPeriod: "Q2 2027", confirmed: true }],
    });
    const ceg = state("CEG", { bars: bars([270, 273.2]), quant: { ...emptyQuant(), beta_90d: 1.1, daily_vol_30d: 0.02, last_price: 273.2 }, quantAsOf: "2026-08-21" });
    ceg.detectors.drift.active = true;
    const other = state("AMD", { quant: { ...emptyQuant(), daily_vol_30d: 0.05 } });
    const g = gatherRiskInputs(account([position("NVDA", 10, 2000), position("CEG", 5, 1300)], 1000), NOW, {
      tracker: source({ NVDA: nvda, CEG: ceg, AMD: other }, [], bars(spyCloses)),
      graph: syntheticGraph(),
      baseConfig: DEFAULT_BASE_CONFIG,
    });
    assert.deepEqual(g.held, ["CEG", "NVDA"]);
    assert.deepEqual(g.closeDay, { CEG: "2026-08-21", NVDA: "2026-08-21" });
    assert.equal(g.inputs.quant.NVDA?.beta, 1.94);
    assert.equal(g.inputs.quant.CEG?.last_price, 273.2);
    assert.ok(g.inputs.spy_daily_vol != null && g.inputs.spy_daily_vol > 0);
    assert.equal(g.inputs.universe_median_vol, 0.033); // median of .033, .02, .05
    assert.equal(g.inputs.graph?.version.pipelineVersion, 5);
    assert.deepEqual(g.inputs.live.anomalies, [{ ticker: "CEG", kind: "drift" }]);
    assert.deepEqual(g.inputs.live.earnings.map((e) => [e.ticker, e.sessions_until]), [["NVDA", 2]]);
    assert.deepEqual(g.inputs.live.open_incidents, []); // no messages → no incidents
    assert.deepEqual(g.errors, []);
  });

  it("an untracked held ticker yields null quant and no close day; empty account gathers nothing live", () => {
    const g = gatherRiskInputs(account([position("XYZ", 1, 10)]), NOW, { tracker: source({}), graph: null, baseConfig: DEFAULT_BASE_CONFIG });
    assert.deepEqual(g.inputs.quant, { XYZ: null });
    assert.deepEqual(g.closeDay, { XYZ: null });
    assert.equal(g.inputs.spy_daily_vol, null);
    assert.equal(g.inputs.universe_median_vol, null);
    const empty = gatherRiskInputs(account([]), NOW, { tracker: source({}), graph: null, baseConfig: DEFAULT_BASE_CONFIG });
    assert.deepEqual(empty.held, []);
    assert.deepEqual(empty.inputs.live, { open_incidents: [], anomalies: [], earnings: [] });
  });
});

function emptyQuant(): NonNullable<TickerState["quant"]> {
  return {
    beta_90d: null,
    r_squared: null,
    daily_vol_30d: null,
    vol_regime: null,
    move_today: null,
    move_zscore: null,
    residual_move: null,
    residual_zscore: null,
    volume_ratio: null,
    volume_ratio_partial: false,
    momentum_5d: null,
    momentum_20d: null,
    momentum_60d: null,
    pct_from_52w_high: null,
    pct_from_52w_low: null,
    earnings_rhythm: null,
    prev_close: null,
    last_price: null,
    price_asof: null,
    session: "closed",
  };
}
