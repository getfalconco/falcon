import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DailyBar } from "../tracker/types.js";
import { evaluateCompression, evaluateIndependentTape, evaluateInsiderDivergence, evaluateQuietAccumulation, newsBurstInWindow, type PatternContext } from "./patterns.js";
import { buildSeriesView } from "./series.js";
import { R2_FLOOR, SESSION, barsFrom, cfg, cluster, noBurst, noCluster, synthetic } from "./test-fixtures.js";
import type { ScreenSeriesView } from "./types.js";

function ctx(extra: Partial<PatternContext> = {}): PatternContext {
  return { session: SESSION, config: cfg(), r2Floor: R2_FLOOR, news_burst: noBurst(), insider_cluster: noCluster(), ...extra };
}

function view(bars: DailyBar[], bench: DailyBar[], ticker = "T"): ScreenSeriesView {
  return buildSeriesView({ ticker, bars, benchBars: bench, session: SESSION, windows: cfg().windows });
}

/** Rebuild the ticker bars with the last `k` returns replaced. */
function withTailReturns(s: ReturnType<typeof synthetic>, tail: number[], volumes?: number[], band?: number | number[]): DailyBar[] {
  const returns = [...s.tickerReturns.slice(0, s.tickerReturns.length - tail.length), ...tail];
  return barsFrom({ days: s.days, returns, volumes, band });
}

// ---------------------------------------------------------------------------
// 3.1 quiet_accumulation
// ---------------------------------------------------------------------------

describe("screen/patterns — quiet_accumulation", () => {
  const s = synthetic({ n: 300, seed: 3 });
  const flatTail = [0.001, -0.001, 0.0005, -0.0005, 0.001];
  const baseVol = 1_000_000;
  const volumes = (spikes: number[]) => s.days.map((_, i) => (i >= s.days.length - 5 ? (spikes[i - (s.days.length - 5)] ?? 1) * baseVol : baseVol));

  it("trigger: 3 of 5 sessions at ≥1.5× volume, flat price, no burst", () => {
    const bars = withTailReturns(s, flatTail, volumes([2.0, 1.0, 2.5, 1.0, 1.8]));
    const e = evaluateQuietAccumulation(view(bars, s.bench), ctx());
    assert.equal(e.status, "present");
    assert.equal(e.values.sessions_qualifying, 3);
    assert.equal(e.qualifying_sessions.length, 3);
    assert.deepEqual(e.qualifying_sessions, [s.days[295], s.days[297], s.days[299]]);
    assert.ok((e.values.momentum_5d_z as number) < 1.0);
    assert.equal(e.values.news_burst_in_window, false);
    assert.match(e.read!, /volume arriving for 3 of the last 5 sessions/);
    assert.match(e.read!, /2\.1× its 20d median/);
  });

  it("near miss: only 2 qualifying sessions", () => {
    const bars = withTailReturns(s, flatTail, volumes([2.0, 1.0, 2.5, 1.0, 1.4]));
    const e = evaluateQuietAccumulation(view(bars, s.bench), ctx());
    assert.equal(e.status, "absent");
    assert.equal(e.values.sessions_qualifying, 2);
    assert.equal(e.read, null);
  });

  it("near miss: volume there but price moved (momentum z ≥ 1)", () => {
    const bars = withTailReturns(s, [0.02, 0.02, 0.02, 0.02, 0.02], volumes([2.0, 2.0, 2.0, 2.0, 2.0]));
    const e = evaluateQuietAccumulation(view(bars, s.bench), ctx());
    assert.equal(e.status, "absent");
    assert.equal(e.values.sessions_qualifying, 5);
    assert.ok((e.values.momentum_5d_z as number) >= 1.0);
  });

  it("near miss: a news_burst inside the window vetoes it", () => {
    const bars = withTailReturns(s, flatTail, volumes([2.0, 1.0, 2.5, 1.0, 1.8]));
    const burst = { active: false, last_fired_at: null, fired_days: [s.days[296]] };
    const e = evaluateQuietAccumulation(view(bars, s.bench), ctx({ news_burst: burst }));
    assert.equal(e.status, "absent");
    assert.equal(e.values.news_burst_in_window, true);
    // A burst before the window does not.
    const old = { active: false, last_fired_at: `${s.days[290]}T15:00:00.000Z`, fired_days: [s.days[280]] };
    assert.equal(evaluateQuietAccumulation(view(bars, s.bench), ctx({ news_burst: old })).status, "present");
    // An active burst does.
    assert.equal(evaluateQuietAccumulation(view(bars, s.bench), ctx({ news_burst: { ...noBurst(), active: true } })).status, "absent");
  });

  it("n_a: history window not full (degraded, never silent)", () => {
    const short = synthetic({ n: 20, seed: 3 });
    const e = evaluateQuietAccumulation(view(short.ticker, short.bench), ctx());
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /history window not yet full \(20 sessions on file, 25 needed\)/);
  });

  it("n_a: detector state unavailable", () => {
    const bars = withTailReturns(s, flatTail, volumes([2.0, 1.0, 2.5, 1.0, 1.8]));
    const e = evaluateQuietAccumulation(view(bars, s.bench), ctx({ news_burst: null }));
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /detector state unavailable/);
  });
});

describe("screen/patterns — newsBurstInWindow", () => {
  it("active, fired-day inside, last_fired_at inside → true; outside → false", () => {
    assert.equal(newsBurstInWindow({ active: true, last_fired_at: null, fired_days: [] }, "2026-08-17", "2026-08-21"), true);
    assert.equal(newsBurstInWindow({ active: false, last_fired_at: null, fired_days: ["2026-08-18"] }, "2026-08-17", "2026-08-21"), true);
    assert.equal(newsBurstInWindow({ active: false, last_fired_at: "2026-08-19T13:00:00.000Z", fired_days: [] }, "2026-08-17", "2026-08-21"), true);
    assert.equal(newsBurstInWindow({ active: false, last_fired_at: "2026-08-14T13:00:00.000Z", fired_days: ["2026-08-10"] }, "2026-08-17", "2026-08-21"), false);
    // A burst after the scan session (catch-up run) is outside the window too.
    assert.equal(newsBurstInWindow({ active: false, last_fired_at: null, fired_days: ["2026-08-24"] }, "2026-08-17", "2026-08-21"), false);
  });
});

// ---------------------------------------------------------------------------
// 3.2 compression
// ---------------------------------------------------------------------------

describe("screen/patterns — compression", () => {
  // 90 normal sessions then 30 quiet ones → vol30/vol90 well under 0.8.
  const s = synthetic({ n: 300, seed: 5, noiseStd: 0.012, benchStd: 0.01 });
  const quietTail = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.0015 : -0.0015));

  it("trigger: vol regime ≤ 0.8 and a 10-session range tighter than vol implies; no direction claimed", () => {
    const bars = withTailReturns(s, quietTail, undefined, 0.002);
    const e = evaluateCompression(view(bars, s.bench), ctx());
    assert.equal(e.status, "present", JSON.stringify(e.values));
    assert.ok((e.values.vol_regime as number) <= 0.8);
    assert.ok((e.values.range_ratio as number) <= 1.5);
    assert.match(e.read!, /coiled, no direction claimed/);
    assert.doesNotMatch(e.read!, /\b(up|down|higher|lower|bull|bear)\b/i);
    assert.deepEqual(e.modifiers, []);
  });

  it("near miss: regime compressed but the 10-session range is wide", () => {
    const bars = withTailReturns(s, quietTail, undefined, s.days.map((_, i) => (i >= s.days.length - 10 ? 0.08 : 0.002)));
    const e = evaluateCompression(view(bars, s.bench), ctx());
    assert.equal(e.status, "absent");
    assert.ok((e.values.vol_regime as number) <= 0.8);
    assert.ok((e.values.range_ratio as number) > 1.5);
  });

  it("near miss: tight range but the regime is not compressed", () => {
    const bars = barsFrom({ days: s.days, returns: s.tickerReturns, band: 0.001 });
    const e = evaluateCompression(view(bars, s.bench), ctx());
    assert.ok((e.values.vol_regime as number) > 0.8);
    assert.equal(e.status, "absent");
  });

  it("modifier: within 3% of the 52w high is payload, not condition", () => {
    // Quiet tail after a rising 52w → last close sits at the high.
    const rising = s.tickerReturns.map((r) => Math.abs(r) * 0.6);
    const returns = [...rising.slice(0, rising.length - 30), ...quietTail];
    const bars = barsFrom({ days: s.days, returns, band: 0.001 });
    const e = evaluateCompression(view(bars, s.bench), ctx());
    assert.equal(e.status, "present", JSON.stringify(e.values));
    assert.deepEqual(e.modifiers, ["near_52w_high"]);
  });

  it("n_a: fewer than 91 sessions → vol regime not computable", () => {
    const short = synthetic({ n: 60, seed: 5 });
    const e = evaluateCompression(view(short.ticker, short.bench), ctx());
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /91 needed/);
  });
});

// ---------------------------------------------------------------------------
// 3.3 independent_tape
// ---------------------------------------------------------------------------

describe("screen/patterns — independent_tape", () => {
  const s = synthetic({ n: 300, seed: 9, beta: 1.2, noiseStd: 0.006, benchStd: 0.01 });
  /** Ticker returns = β·bench + injected residual on the last 5 sessions. */
  const withResiduals = (res: number[]) => {
    const n = s.tickerReturns.length;
    const returns = s.tickerReturns.map((r, i) => (i >= n - 5 ? 1.2 * s.benchReturns[i] + res[i - (n - 5)] : r));
    return barsFrom({ days: s.days, returns });
  };

  it("trigger: 3 of 5 same-sign residuals ≥ 1σ and the net residual ≥ 1.5 × vol × √5", () => {
    const bars = withResiduals([0.03, 0.0, 0.03, 0.0, 0.03]);
    const e = evaluateIndependentTape(view(bars, s.bench), ctx());
    assert.equal(e.status, "present", JSON.stringify(e.values));
    assert.equal(e.values.sessions_qualifying, 3);
    assert.equal(e.values.direction, "up");
    assert.ok((e.values.net_residual_z as number) >= 1.5);
    assert.ok((e.values.r2 as number) >= R2_FLOOR);
    assert.deepEqual(e.qualifying_sessions, [s.days[295], s.days[297], s.days[299]]);
    assert.match(e.read!, /3 of the last 5 sessions moved upward on their own/);
  });

  it("trigger (down): the read names the downward direction", () => {
    const bars = withResiduals([-0.03, -0.03, 0.0, -0.03, 0.0]);
    const e = evaluateIndependentTape(view(bars, s.bench), ctx());
    assert.equal(e.status, "present");
    assert.equal(e.values.direction, "down");
    assert.match(e.read!, /moved downward on their own/);
  });

  it("near miss: only 2 qualifying residuals", () => {
    const bars = withResiduals([0.03, 0.0, 0.03, 0.0, 0.0]);
    const e = evaluateIndependentTape(view(bars, s.bench), ctx());
    assert.equal(e.status, "absent");
    assert.equal(e.values.sessions_qualifying, 2);
  });

  it("near miss: 3 qualifying residuals but the net residual is too small", () => {
    const bars = withResiduals([0.012, 0.0, 0.012, 0.0, 0.012]);
    const e = evaluateIndependentTape(view(bars, s.bench), ctx());
    assert.equal(e.values.sessions_qualifying, 3);
    assert.ok((e.values.net_residual_z as number) < 1.5, String(e.values.net_residual_z));
    assert.equal(e.status, "absent");
  });

  it("near miss: 3 small same-sign residuals swamped by 2 large opposite ones — net sign disagrees", () => {
    const bars = withResiduals([0.015, -0.08, 0.015, -0.08, 0.015]);
    const e = evaluateIndependentTape(view(bars, s.bench), ctx());
    assert.equal(e.status, "absent");
  });

  it("n_a: r² below the shared floor", () => {
    const noisy = synthetic({ n: 300, seed: 9, beta: 0.0, noiseStd: 0.02, benchStd: 0.01 });
    const e = evaluateIndependentTape(view(noisy.ticker, noisy.bench), ctx());
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /r² 0\.\d+ below the 0\.15 floor/);
    assert.equal(e.values.r2_floor, R2_FLOOR);
  });

  it("n_a: insufficient history for the regression window", () => {
    const short = synthetic({ n: 80, seed: 9 });
    const e = evaluateIndependentTape(view(short.ticker, short.bench), ctx());
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /95 needed/);
  });

  it("n_a: benchmark series unavailable", () => {
    const e = evaluateIndependentTape(view(s.ticker, []), ctx());
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /benchmark series unavailable/);
  });
});

// ---------------------------------------------------------------------------
// 3.4 insider_divergence
// ---------------------------------------------------------------------------

describe("screen/patterns — insider_divergence", () => {
  const s = synthetic({ n: 300, seed: 13, noiseStd: 0.01 });
  // Jittered so the robust vol (MAD) stays non-zero — a perfectly constant tail has MAD 0.
  const jitter = (i: number) => ((i % 3) - 1) * 0.002;
  const decline = Array.from({ length: 20 }, (_, i) => -0.006 + jitter(i));
  const advance = Array.from({ length: 20 }, (_, i) => 0.006 + jitter(i));

  it("trigger: buy cluster into a 20d decline ≥ 0.75σ", () => {
    const bars = withTailReturns(s, decline);
    const e = evaluateInsiderDivergence(view(bars, s.bench), ctx({ insider_cluster: cluster("buy") }));
    assert.equal(e.status, "present", JSON.stringify(e.values));
    assert.ok((e.values.momentum_20d as number) < 0);
    assert.ok((e.values.momentum_20d_z as number) >= 0.75);
    assert.match(e.read!, /insiders accumulating \(3 insiders over 10 business days, \$1\.3M\) into a 20d decline of −/);
  });

  it("trigger: sell cluster into a 20d advance", () => {
    const bars = withTailReturns(s, advance);
    const e = evaluateInsiderDivergence(view(bars, s.bench), ctx({ insider_cluster: cluster("sell", { insider_count: 4, total_notional: 80_000 }) }));
    assert.equal(e.status, "present");
    assert.match(e.read!, /insiders distributing \(4 insiders over 10 business days, \$80K\) into a 20d advance of \+/);
  });

  it("near miss: cluster with the tape (buy into an advance) → absent", () => {
    const bars = withTailReturns(s, advance);
    const e = evaluateInsiderDivergence(view(bars, s.bench), ctx({ insider_cluster: cluster("buy") }));
    assert.equal(e.status, "absent");
  });

  it("near miss: against the tape but the move is under 0.75σ", () => {
    const bars = withTailReturns(s, Array.from({ length: 20 }, (_, i) => -0.0002 + jitter(i)));
    const e = evaluateInsiderDivergence(view(bars, s.bench), ctx({ insider_cluster: cluster("buy") }));
    assert.equal(e.status, "absent");
    assert.ok((e.values.momentum_20d_z as number) < 0.75);
  });

  it("absent: no active cluster (state carried in values)", () => {
    const bars = withTailReturns(s, decline);
    const e = evaluateInsiderDivergence(view(bars, s.bench), ctx());
    assert.equal(e.status, "absent");
    assert.equal(e.values.cluster_active, false);
  });

  it("n_a: active cluster without a readable direction", () => {
    const bars = withTailReturns(s, decline);
    const e = evaluateInsiderDivergence(view(bars, s.bench), ctx({ insider_cluster: cluster("buy", { direction: null }) }));
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /direction unavailable/);
  });

  it("n_a: history too short for momentum_20d / vol", () => {
    const short = synthetic({ n: 15, seed: 13 });
    const e = evaluateInsiderDivergence(view(short.ticker, short.bench), ctx({ insider_cluster: cluster("buy") }));
    assert.equal(e.status, "n_a");
    assert.match(e.na_reason!, /history window not yet full/);
  });
});
