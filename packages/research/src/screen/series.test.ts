import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { olsBeta } from "../tracker/math.js";
import { buildSeriesView, completedBars, priorVolumeBaseline, residualAt } from "./series.js";
import { SESSION, barsFrom, cfg, synthetic, tradingDays } from "./test-fixtures.js";

const close = (a: number | null, b: number, tol = 1e-3) => {
  assert.ok(a != null, "expected a number");
  assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
};

describe("screen/series — volume ratio golden (10 sessions, 3-session baseline)", () => {
  const days = tradingDays(10);
  const volumes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const bars = barsFrom({ days, returns: new Array(9).fill(0), volumes });

  it("hand-computed: median of the 3 prior sessions, no self-inclusion", () => {
    // index 3: vol 40 / median(10,20,30)=20 → 2.0 ; index 9: 100 / median(70,80,90)=80 → 1.25
    assert.equal(priorVolumeBaseline(bars, 3, 3), 20);
    close(40 / priorVolumeBaseline(bars, 3, 3)!, 2.0);
    assert.equal(priorVolumeBaseline(bars, 9, 3), 80);
    close(100 / priorVolumeBaseline(bars, 9, 3)!, 1.25);
    // index 2 has only 2 prior sessions → window not covered
    assert.equal(priorVolumeBaseline(bars, 2, 3), null);
  });

  it("a zero-volume session inside the baseline window voids the baseline", () => {
    const broken = barsFrom({ days, returns: new Array(9).fill(0), volumes: [10, 0, 30, 40, 50, 60, 70, 80, 90, 100] });
    assert.equal(priorVolumeBaseline(broken, 3, 3), null);
    assert.equal(priorVolumeBaseline(broken, 5, 3), 40);
  });

  it("buildSeriesView threads the ratios through the session views", () => {
    const bench = barsFrom({ days, returns: new Array(9).fill(0), volumes: volumes.map(() => 1) });
    const view = buildSeriesView({ ticker: "X", bars, benchBars: bench, session: SESSION, windows: { ...cfg().windows, sessions: 5, volumeBaselineSessions: 3 } });
    assert.equal(view.sessions.length, 5);
    assert.deepEqual(
      view.sessions.map((s) => Number(s.volume_ratio!.toFixed(4))),
      [60 / 40, 70 / 50, 80 / 60, 90 / 70, 100 / 80].map((x) => Number(x.toFixed(4))),
    );
    assert.equal(view.as_of, SESSION);
    assert.equal(view.history_sessions, 10);
  });
});

describe("screen/series — residual golden (3-return regression window)", () => {
  it("hand-computed β, residual move and z for the last session", () => {
    // x = [0.01, −0.01, 0.02, 0.00], y = [0.02, −0.02, 0.04, 0.03]; window 3 ending at index 3:
    // x=[−0.01,0.02,0], y=[−0.02,0.04,0.03] → β = 0.000833/0.000467 = 1.7857
    // residual_move = y3 − β·x3 = 0.03; in-sample residuals [−0.012857, −0.006429, 0.019286]
    // robust std = 1.4826 × median|dev| = 1.4826 × 0.006429 = 0.009531 → z = 3.1476
    const x = [0.01, -0.01, 0.02, 0.0];
    const y = [0.02, -0.02, 0.04, 0.03];
    const r = residualAt(y, x, 3, 3);
    assert.ok(r);
    close(r.beta, 1.7857, 1e-3);
    close(r.residual_move, 0.03, 1e-9);
    close(r.residual_z, 3.1476, 2e-3);
    // Cross-check against Tracker's regression on the same window.
    const reg = olsBeta(y, x, 3)!;
    close(r.beta, reg.beta, 1e-12);
    close(r.residual_z, 0.03 / reg.residualRobustStd!, 1e-12);
  });

  it("window not covered → null (no fabricated residual)", () => {
    assert.equal(residualAt([0.01, 0.02], [0.01, 0.0], 1, 3), null);
    assert.equal(residualAt([0.01], [0.01], 5, 1), null);
  });

  it("per-session residual_z on a synthetic beta-linked series is small and finite; β ≈ the generator's", () => {
    const s = synthetic({ n: 200, seed: 11, beta: 1.3, noiseStd: 0.004 });
    const view = buildSeriesView({ ticker: "S", bars: s.ticker, benchBars: s.bench, session: SESSION, windows: cfg().windows });
    assert.equal(view.sessions.length, 5);
    for (const v of view.sessions) {
      assert.ok(v.residual_z != null && Number.isFinite(v.residual_z));
      assert.ok(Math.abs(v.residual_z) < 4);
      assert.ok(v.volume_ratio != null);
    }
    assert.ok(view.beta != null && Math.abs(view.beta - 1.3) < 0.25, `beta ${view.beta}`);
    assert.ok(view.r2 != null && view.r2 > 0.5);
    assert.ok(view.daily_vol != null && view.vol_regime != null && view.momentum_5d != null && view.momentum_20d != null);
    assert.ok(view.range_10s != null && view.range_10s > 0);
    // 200 < 252 → no 52w context yet (window not covered, not zero).
    assert.equal(view.pct_from_52w_high, null);
  });
});

describe("screen/series — no-lookahead", () => {
  it("drops bars after the scan session (intraday/partial bar never enters a window)", () => {
    const s = synthetic({ n: 120 });
    const future = { d: "2026-08-24", o: 1, h: 1, l: 1, c: 999, v: 999_000_000 };
    const bars = [...s.ticker, future];
    const completed = completedBars(bars, SESSION);
    assert.equal(completed[completed.length - 1].d, SESSION);
    assert.equal(completed.length, 120);
    const benchWithFuture = [...s.bench, { ...future, c: 1 }];
    const withFuture = buildSeriesView({ ticker: "S", bars, benchBars: benchWithFuture, session: SESSION, windows: cfg().windows });
    const without = buildSeriesView({ ticker: "S", bars: s.ticker, benchBars: s.bench, session: SESSION, windows: cfg().windows });
    assert.deepEqual(withFuture, without);
    assert.equal(withFuture.as_of, SESSION);
    assert.ok(withFuture.sessions.every((v) => v.d <= SESSION));
  });

  it("de-duplicates repeated dates and sorts out-of-order input", () => {
    const s = synthetic({ n: 40 });
    const shuffled = [...s.ticker].reverse();
    shuffled.push({ ...s.ticker[10] });
    assert.deepEqual(completedBars(shuffled, SESSION), s.ticker);
  });

  it("as_of lags when the ticker's last bar is older than the session", () => {
    const s = synthetic({ n: 40 });
    const lagged = s.ticker.slice(0, -1);
    const view = buildSeriesView({ ticker: "S", bars: lagged, benchBars: s.bench, session: SESSION, windows: cfg().windows });
    assert.equal(view.as_of, s.days[s.days.length - 2]);
  });
});
