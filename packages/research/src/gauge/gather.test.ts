import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG } from "../base/config.js";
import { DEFAULT_TRACKER_CONFIG } from "../tracker/config.js";
import { emptyTickerState } from "../tracker/store.js";
import type { DailyBar, QuantContext, TickerState, TrackerMessage } from "../tracker/types.js";
import { gauge } from "./compute.js";
import { detectorsFromState, gatherGaugeInputs, nextEarningsFromState, quantFromState, type GaugeTrackerSource } from "./gather.js";
import { cfg } from "./test-fixtures.js";

const NOW = "2026-08-24T15:00:00.000Z"; // Monday 11:00 ET

function bars(n: number): DailyBar[] {
  return Array.from({ length: n }, (_, i) => ({ d: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, o: 1, h: 1, l: 1, c: 1, v: 1 }));
}

function emptyQuant(): QuantContext {
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

function state(ticker: string, overrides: Partial<TickerState> = {}): TickerState {
  return { ...emptyTickerState(ticker, NOW), ...overrides };
}

function source(states: Record<string, TickerState>, messages: TrackerMessage[] = []): GaugeTrackerSource {
  return {
    tickers: () => Object.keys(states),
    state: (t) => states[t.toUpperCase()] ?? null,
    messages: (o) => (o?.ticker ? messages.filter((m) => m.ticker === o.ticker) : messages).slice(0, o?.limit ?? 1000),
    benchmarkBars: () => [],
  };
}

const deps = (tracker: GaugeTrackerSource, extra: Partial<Parameters<typeof gatherGaugeInputs>[2]> = {}) => ({
  tracker,
  trackerConfig: DEFAULT_TRACKER_CONFIG,
  baseConfig: DEFAULT_BASE_CONFIG,
  ...extra,
});

describe("gauge/gather", () => {
  it("quantFromState maps every §3 field, fractions untouched, as_of from quantAsOf", () => {
    const s = state("NVDA", {
      quantAsOf: "2026-08-21",
      quant: { ...emptyQuant(), beta_90d: 1.94, r_squared: 0.403, daily_vol_30d: 0.0331, vol_regime: 1.36, momentum_5d: -0.046, momentum_20d: 0.038, momentum_60d: 0.011, volume_ratio: 0.82, volume_ratio_partial: true, pct_from_52w_high: -0.088, pct_from_52w_low: 0.30, earnings_rhythm: 0.0279, move_zscore: -0.3, residual_zscore: -1.2 },
    });
    const q = quantFromState(s)!;
    assert.equal(q.beta, 1.94);
    assert.equal(q.r2, 0.403);
    assert.equal(q.vol_regime, 1.36);
    assert.equal(q.momentum_5d, -0.046);
    assert.equal(q.volume_ratio_partial, true);
    assert.equal(q.pct_from_52w_high, -0.088);
    assert.equal(q.earnings_rhythm, 0.0279);
    assert.equal(q.as_of, "2026-08-21");
    assert.equal(quantFromState(state("X")), null);
  });

  it("detectorsFromState: edge flags from state, directions from the latest message, unexplained only on the last close day", () => {
    const s = state("ZLAB", { lastCloseComputedFor: "2026-08-21" });
    s.detectors.drift.active = true;
    s.detectors.insiderCluster.active = true;
    s.detectors.filingOverdue.active = true;
    s.detectors.newsBurst.active = true;
    s.detectors.unexplained.lastFiredDay = "2026-08-21";
    const msgs = [
      { type: "insider_cluster", ticker: "ZLAB", payload: { direction: "sell" } },
      { type: "drift_event", ticker: "ZLAB", payload: { direction: "down" } },
      { type: "unexplained_move", ticker: "ZLAB", payload: { direction: "up" } },
      { type: "insider_cluster", ticker: "ZLAB", payload: { direction: "buy" } }, // older → ignored
    ] as unknown as TrackerMessage[];
    const d = detectorsFromState(s, msgs)!;
    assert.deepEqual(d, {
      news_burst: true,
      drift: { active: true, direction: "down" },
      insider_cluster: { active: true, direction: "sell" },
      filing_overdue: true,
      unexplained_move: { active: true, direction: "up" },
    });
    s.detectors.unexplained.lastFiredDay = "2026-08-14";
    assert.equal(detectorsFromState(s, msgs)!.unexplained_move.active, false);
    // Inactive detectors never carry a direction even when old messages exist.
    s.detectors.insiderCluster.active = false;
    assert.deepEqual(detectorsFromState(s, msgs)!.insider_cluster, { active: false, direction: null });
  });

  it("nextEarningsFromState: nearest confirmed future date in trading sessions; past and projections ignored", () => {
    const s = state("NVDA", {
      scheduledEarnings: [
        { dueAt: "2026-11-17T21:00:00.000Z", fiscalPeriod: "Q3 2027", confirmed: true },
        { dueAt: "2026-08-26T20:00:00.000Z", fiscalPeriod: "Q2 2027", confirmed: true },
        { dueAt: "2026-08-25T20:00:00.000Z", fiscalPeriod: "proj", confirmed: false },
        { dueAt: "2026-08-20T20:00:00.000Z", fiscalPeriod: "old", confirmed: true },
      ],
    });
    assert.deepEqual(nextEarningsFromState(s, "2026-08-24"), { due_at: "2026-08-26T20:00:00.000Z", sessions_until: 2, fiscal_period: "Q2 2027" });
    assert.equal(nextEarningsFromState(state("X"), "2026-08-24"), null);
  });

  it("gatherGaugeInputs: untracked ticker → tracked:false, r² floor still carried", () => {
    const g = gatherGaugeInputs("amzn", NOW, deps(source({})));
    assert.equal(g.inputs.tracked, false);
    assert.equal(g.inputs.ticker, "AMZN");
    assert.equal(g.inputs.r2_floor, DEFAULT_TRACKER_CONFIG.thresholds.lowR2Fallback);
    assert.equal(gauge(g.inputs, cfg()).summary.sentence, "Not tracked — no gauge.");
  });

  it("gatherGaugeInputs: tracked ticker — r² floor comes from the Tracker config passed in, history from bars, no replay in standalone", () => {
    const s = state("NVDA", { bars: bars(40), quant: { ...emptyQuant(), r_squared: 0.2 }, quantAsOf: "2026-08-21" });
    let replayed = false;
    const tracker = source({ NVDA: s });
    const wrapped: GaugeTrackerSource = { ...tracker, messages: (o) => { if (!o?.ticker) replayed = true; return tracker.messages(o); } };
    const g = gatherGaugeInputs("NVDA", NOW, deps(wrapped, { trackerConfig: { thresholds: { ...DEFAULT_TRACKER_CONFIG.thresholds, lowR2Fallback: 0.25 } } }));
    assert.equal(g.inputs.tracked, true);
    assert.equal(g.inputs.r2_floor, 0.25);
    assert.equal(g.inputs.history_sessions, 40);
    assert.equal(g.inputs.quant?.r2, 0.2);
    assert.deepEqual(g.inputs.incidents, []);
    assert.equal(replayed, false);
    assert.equal(gauge(g.inputs, cfg()).checks[2].status, "caution"); // 0.2 < 0.25 floor
  });

  it("gatherGaugeInputs: includeIncidents runs the Base replay and keeps only open incidents on the ticker", () => {
    const s = state("NVDA", { bars: bars(300) });
    // An empty stream replays to zero incidents — the path runs without error.
    const g = gatherGaugeInputs("NVDA", NOW, deps(source({ NVDA: s }), { includeIncidents: true }));
    assert.deepEqual(g.inputs.incidents, []);
    assert.deepEqual(g.errors, []);
  });
});
