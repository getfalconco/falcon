import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeQuantLabConfig, type QuantLabConfig } from "./config.js";
import {
  assembleReport,
  computeHorizonStats,
  overfitWarning,
  splitWarning,
  splitWindow,
  variantWarning,
  verdictLine,
} from "./report.js";
import { seeded } from "./stats.js";
import { contextFrom, flatSeries, seriesFrom, tradingDays } from "./test-fixtures.js";
import { newStrategy } from "./strategy.js";
import type { HorizonStats, SampleStats, Signal, Strategy } from "./types.js";

const days = tradingDays(120);
const config = mergeQuantLabConfig(null);

const strategy: Strategy = newStrategy({
  strategy_id: "test",
  name: "Test rule",
  created_at: "2026-01-01T00:00:00.000Z",
  universe: { tickers: "tracked", min_history_sessions: 1 },
  trigger: { kind: "pattern", pattern: { names: ["compression"], state: "any" } },
  filters: [],
  entry: { when: "signal_close" },
  hold: { sessions: [5] },
  exit: { kind: "time_only" },
  direction: { kind: "long_only" },
  notes: "",
});

const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(119).fill(0.002) });
const { ctx, calendar } = contextFrom({ series: [flatSeries("SPY", days), ticker], sectors: {} });

/** n signals with an explicit sector-relative return each. */
function signalsWith(values: number[], startIndex = 10): Signal[] {
  return values.map((value, i) => ({
    ticker: "AAA",
    session: days[startIndex + i],
    entry_session: days[startIndex + i],
    entry_price: 100,
    entry_when: "signal_close" as const,
    sign: 1 as const,
    sector: "Chips",
    reason: "test",
    returns: [
      {
        sessions: 5,
        exit_session: days[startIndex + i + 5],
        exit_price: 101,
        raw: value,
        market_adjusted: value,
        sector_relative: value,
        degraded: [],
      },
    ],
  }));
}

function statsDeps(cfg: QuantLabConfig = config) {
  return {
    config: cfg,
    layer: "sector_relative" as const,
    strategy,
    baseRate: { ctx, calendar, multiplier: 5, rand: seeded(1) },
  };
}

describe("quantlab/report — the n<30 floor (§7)", () => {
  it("refuses point estimates below the floor but still shows the distribution", () => {
    const stats = computeHorizonStats(signalsWith(new Array(17).fill(0.01)), 5, statsDeps());
    assert.equal(stats.n, 17);
    assert.equal(stats.insufficient, true);
    assert.equal(stats.median, null);
    assert.equal(stats.mean, null);
    assert.equal(stats.hit_rate, null);
    assert.equal(stats.sharpe, null);
    assert.equal(stats.sortino, null);
    assert.equal(stats.ci_low, null);
    assert.ok(stats.deciles.length === 9, "the shape is still information");
  });

  it("reports point estimates at exactly the floor", () => {
    const stats = computeHorizonStats(signalsWith(new Array(30).fill(0.01)), 5, statsDeps());
    assert.equal(stats.insufficient, false);
    assert.ok(stats.median != null);
    assert.ok(stats.sharpe != null);
  });

  it("a lowered floor is honoured — the guard is config, not a literal", () => {
    const loose = mergeQuantLabConfig({ backtest: { minSignals: 5 } });
    const stats = computeHorizonStats(signalsWith(new Array(6).fill(0.01)), 5, statsDeps(loose));
    assert.equal(stats.insufficient, false);
  });

  it("counts distinct tickers alongside n", () => {
    const mixed = signalsWith([0.01, 0.02, 0.03]);
    mixed[1].ticker = "BBB";
    const stats = computeHorizonStats(mixed, 5, statsDeps());
    assert.equal(stats.n, 3);
    assert.equal(stats.n_tickers, 2);
  });
});

describe("quantlab/report — variant counter (§7)", () => {
  it("stays silent at or below the threshold", () => {
    assert.equal(variantWarning(1, config), null);
    assert.equal(variantWarning(10, config), null);
  });

  it("warns beyond it and names the number", () => {
    const warning = variantWarning(14, config);
    assert.ok(warning);
    assert.match(warning!, /variant 14/);
    assert.match(warning!, /hypothesis, not a finding/);
  });
});

describe("quantlab/report — IS/OOS (§7)", () => {
  function sample(label: SampleStats["label"], sharpe: number | null, n = 50): SampleStats {
    const horizon: HorizonStats = {
      sessions: 5,
      n,
      n_tickers: 1,
      median: 0.01,
      mean: 0.01,
      hit_rate: 0.6,
      sharpe,
      sortino: sharpe,
      max_drawdown: -0.1,
      ci_low: 0.005,
      ci_high: 0.015,
      deciles: [],
      base_rate_median: 0,
      base_rate_n: 100,
      insufficient: false,
    };
    return { label, from: days[0], to: days[60], horizons: [horizon] };
  }

  it("splits the window by date, not by signal count", () => {
    const split = splitWindow(calendar, days[0], days[99], 0.6)!;
    assert.equal(split.isFrom, days[0]);
    assert.equal(split.isTo, days[59]);
    assert.equal(split.oosFrom, days[60]);
    assert.equal(split.oosTo, days[99]);
  });

  it("flags an IS→OOS collapse as likely overfit", () => {
    const warning = overfitWarning(sample("in_sample", 1.8), sample("out_of_sample", 0.2), config);
    assert.ok(warning);
    assert.match(warning!, /likely overfit/);
  });

  it("also flags the reverse as regime-dependent rather than passing it as a win", () => {
    const warning = overfitWarning(sample("in_sample", 0.1), sample("out_of_sample", 1.9), config);
    assert.ok(warning);
    assert.match(warning!, /regime-dependent/);
  });

  it("stays silent when the two agree", () => {
    assert.equal(overfitWarning(sample("in_sample", 0.8), sample("out_of_sample", 0.6), config), null);
  });

  it("flags a degenerate split where one side holds nothing", () => {
    const signals = signalsWith(new Array(5).fill(0.01));
    const warning = splitWarning(signals, sample("in_sample", null, 0), sample("out_of_sample", 0.5, 5));
    assert.ok(warning);
    assert.match(warning!, /in-sample period holds no signals/);
    assert.match(warning!, /All 5 signals/);
  });

  it("stays silent when both sides have signals", () => {
    assert.equal(splitWarning(signalsWith([0.01]), sample("in_sample", 0.5, 3), sample("out_of_sample", 0.5, 3)), null);
  });
});

describe("quantlab/report — the verdict line", () => {
  function oosWith(over: Partial<HorizonStats>): SampleStats {
    return {
      label: "out_of_sample",
      from: days[0],
      to: days[60],
      horizons: [
        {
          sessions: 5,
          n: 64,
          n_tickers: 20,
          median: 0.004,
          mean: 0.004,
          hit_rate: 0.55,
          sharpe: 0.7,
          sortino: 0.9,
          max_drawdown: -0.1,
          ci_low: 0.002,
          ci_high: 0.006,
          deciles: [],
          base_rate_median: 0.001,
          base_rate_n: 500,
          insufficient: false,
          ...over,
        },
      ],
    };
  }

  it("names an edge when the interval clears the base rate", () => {
    const line = verdictLine(oosWith({}), config);
    assert.match(line, /OOS median \+0\.40%/);
    assert.match(line, /base rate \+0\.10%/);
    assert.match(line, /n=64/);
    assert.match(line, /Sharpe 0\.70/);
    assert.match(line, /edge/);
  });

  it("says 'no edge' when the interval contains the base rate", () => {
    const line = verdictLine(oosWith({ ci_low: -0.01, ci_high: 0.02 }), config);
    assert.match(line, /indistinguishable from it: no edge/);
  });

  it("calls out a negative edge", () => {
    const line = verdictLine(oosWith({ median: -0.01, ci_low: -0.015, ci_high: -0.005 }), config);
    assert.match(line, /negative edge/);
  });

  it("refuses a verdict below the floor", () => {
    const line = verdictLine(oosWith({ insufficient: true, n: 17 }), config);
    assert.match(line, /Insufficient out-of-sample signals \(n=17\)/);
  });

  it("is deterministic — the same stats give the same sentence", () => {
    assert.equal(verdictLine(oosWith({}), config), verdictLine(oosWith({}), config));
  });
});

describe("quantlab/report — assembly", () => {
  it("carries the caveats, the variant number and the OOS-peek flag", () => {
    const report = assembleReport({
      reportId: "r1",
      strategy: { ...strategy, created_after_oos_view: true },
      config,
      calendar,
      ctx,
      signals: signalsWith(new Array(40).fill(0.01)),
      window: { from: days[0], to: days[99] },
      excluded: [{ ticker: "ZZZ", reason: "no_series", detail: "none" }],
      variantNumber: 12,
      extraCaveats: ["extra note"],
      now: "2026-08-25T00:00:00.000Z",
    });
    assert.equal(report.variant_number, 12);
    assert.ok(report.variant_warning, "variant 12 is past the threshold");
    assert.equal(report.created_after_oos_view, true);
    assert.equal(report.headline_layer, "sector_relative");
    assert.ok(report.caveats.includes("extra note"));
    assert.ok(report.caveats.some((c) => /gross/.test(c)), "the gross-returns caveat is always present");
    assert.equal(report.excluded.length, 1);
    assert.ok(report.verdict.length > 0);
  });

  it("is reproducible — the same inputs give identical intervals", () => {
    const input = {
      reportId: "r1",
      strategy,
      config,
      calendar,
      ctx,
      signals: signalsWith(new Array(40).fill(0.01)),
      window: { from: days[0], to: days[99] },
      excluded: [],
      variantNumber: 1,
      extraCaveats: [],
      now: "2026-08-25T00:00:00.000Z",
    };
    const a = assembleReport(input);
    const b = assembleReport(input);
    assert.deepEqual(a.full, b.full, "a re-run must not move the confidence interval");
    assert.equal(a.verdict, b.verdict);
  });
});
