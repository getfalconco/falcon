import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  driftScore,
  earningsRhythm,
  gapVol,
  median,
  medianFilingLag,
  olsBeta,
  overnightGaps,
  robustStd,
  robustVol,
  simpleReturns,
  trailingReturn,
  week52Context,
  zScore,
} from "./math.js";

/**
 * Golden vectors (§8.1): expected values below were derived independently
 * with a separate straight-line calculator script (textbook formulas), not by
 * re-running this implementation. Do not "fix" a failing test by re-pinning
 * from the implementation's own output.
 */

function assertClose(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual != null, `expected ${expected}, got null`);
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${expected}, got ${actual} (Δ=${Math.abs(actual - expected)})`,
  );
}

// 11-day synthetic close series → 10 daily returns.
const SPY_CLOSES = [100, 101, 100, 102, 103, 102, 104, 105, 104, 106, 107];
const TICK_CLOSES = [50, 51, 50.5, 52, 53, 52, 54, 55.5, 54.5, 56, 57];

describe("simpleReturns", () => {
  it("computes c_i/c_{i-1} − 1", () => {
    const r = simpleReturns(TICK_CLOSES);
    assert.equal(r.length, 10);
    assertClose(r[0], 0.02);
    assertClose(r[2], 0.0297029702970297);
    assertClose(r[9], 0.0178571428571428, 1e-12);
  });

  it("skips pairs containing non-finite values (missing days / NaN)", () => {
    assert.deepEqual(simpleReturns([100, NaN, 102]), []);
    const r = simpleReturns([100, 102, NaN, 104, 106]);
    assert.equal(r.length, 2); // (100,102) and (104,106) only
    assertClose(r[0], 0.02);
  });

  it("split-day behavior: adjusted series shows no split artifact", () => {
    // Raw series across a 2:1 split day vs the same series fully adjusted.
    const raw = simpleReturns([100, 102, 51, 52]);
    const adjusted = simpleReturns([50, 51, 51, 52]);
    assert.ok(Math.min(...raw) < -0.4, "raw series contains the −50% split artifact");
    assert.ok(
      Math.max(...adjusted.map(Math.abs)) < 0.05,
      "adjusted series must be artifact-free",
    );
  });
});

describe("olsBeta (beta_90d, r_squared, residuals)", () => {
  const y = simpleReturns(TICK_CLOSES);
  const x = simpleReturns(SPY_CLOSES);

  it("matches golden vector: beta / r² / residuals / robust residual std", () => {
    const res = olsBeta(y, x, 10);
    assert.ok(res != null);
    assertClose(res.beta, 1.66243886264681);
    assertClose(res.r2, 0.937568594935801);
    const goldenResiduals = [
      0.00138668977555, 0.00466694755266, -0.00553472855389, 0.000943427410758,
      -0.00471666299379, 0.0038757764195, 0.00980386711588, -0.00417418854317,
      -0.00643596394599, 0.000184835762491,
    ];
    assert.equal(res.residuals.length, 10);
    goldenResiduals.forEach((g, i) => assertClose(res.residuals[i], g));
    assertClose(res.residualRobustStd, 0.00655393418784567);
  });

  it("returns null when the window is not fully covered (§3.11)", () => {
    assert.equal(olsBeta(y, x, 90), null);
  });

  it("returns null when x has zero variance (division-by-zero guard)", () => {
    assert.equal(olsBeta(y, new Array(10).fill(0.01), 10), null);
  });

  it("constant y: beta 0, r² 0 by convention", () => {
    const res = olsBeta(new Array(10).fill(0.005), x, 10);
    assert.ok(res != null);
    assertClose(res.beta, 0);
    assertClose(res.r2, 0);
  });
});

describe("robust volatility (daily_vol_30d formula)", () => {
  it("matches golden vector on the tick return series (window 10)", () => {
    assertClose(robustVol(simpleReturns(TICK_CLOSES), 10), 0.0135287093170855);
  });

  it("matches golden vector on a standalone return set", () => {
    const rets = [0.01, -0.02, 0.015, 0.03, -0.01, 0.005, 0.02, -0.005, 0.0, 0.01];
    assertClose(median(rets), 0.0075);
    assertClose(robustStd(rets), 0.014826);
    assertClose(robustVol(rets, 10), 0.014826);
  });

  it("constant series: vol = 0, and z-scores against it are null", () => {
    assert.equal(robustVol(new Array(30).fill(0), 30), 0);
    assert.equal(zScore(0.01, 0), null);
    assert.equal(zScore(0.01, null), null);
    assertClose(zScore(0.034, 0.021), 1.61904761904762, 1e-12);
  });

  it("insufficient history returns null, never zero (§3.11)", () => {
    assert.equal(robustVol([0.01, 0.02], 30), null);
  });
});

describe("overnight gaps / gap_z", () => {
  const bars = [
    { o: 10, c: 10.2 },
    { o: 10.3, c: 10.1 },
    { o: 10.0, c: 10.4 },
    { o: 10.5, c: 10.3 },
    { o: 10.2, c: 10.6 },
    { o: 10.7, c: 10.5 },
  ];

  it("matches golden vector for gaps and robust gap_vol (window 5)", () => {
    const gaps = overnightGaps(bars);
    const golden = [
      0.00980392156863, -0.00990099009901, 0.00961538461538, -0.00970873786408,
      0.00943396226415,
    ];
    assert.equal(gaps.length, 5);
    golden.forEach((g, i) => assertClose(gaps[i], g));
    assertClose(gapVol(gaps, 5), 0.000548501664817315);
    assertClose(zScore(gaps[4], gapVol(gaps, 5)), 17.199514366639);
  });

  it("null with fewer gaps than the window (§3.11)", () => {
    assert.equal(gapVol(overnightGaps(bars), 60), null);
  });
});

describe("momentum / 52-week context / rhythms / lags / drift", () => {
  it("trailingReturn golden value (5d on the tick series)", () => {
    assertClose(trailingReturn(TICK_CLOSES, 5), 0.0961538461538463);
    assert.equal(trailingReturn(TICK_CLOSES, 20), null);
  });

  it("week52Context golden values (window 11)", () => {
    const ctx = week52Context(TICK_CLOSES, 11);
    assert.ok(ctx != null);
    assertClose(ctx.pctFromHigh, 0);
    assertClose(ctx.pctFromLow, 0.14);
    assert.equal(week52Context(TICK_CLOSES, 252), null);
  });

  it("earningsRhythm: mean |move|, ≥ 2 required", () => {
    assertClose(earningsRhythm([0.03, -0.05, 0.02, 0.04]), 0.035);
    assert.equal(earningsRhythm([0.03]), null);
  });

  it("medianFilingLag: median of lags, ≥ 4 required", () => {
    assertClose(medianFilingLag([30, 32, 29, 35]), 31);
    assert.equal(medianFilingLag([30, 32, 29]), null);
  });

  it("driftScore golden value: |m5| / (vol30 × √5)", () => {
    assertClose(driftScore(0.05, 0.02), 1.11803398874989);
    assert.equal(driftScore(0.05, 0), null);
    assert.equal(driftScore(null, 0.02), null);
  });
});
