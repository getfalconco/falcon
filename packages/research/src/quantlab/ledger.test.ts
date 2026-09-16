import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeQuantLabConfig } from "./config.js";
import { canEnable, completeSignals, fillForwardReturns, forwardSignals, liveSignalId } from "./ledger.js";
import { contextFrom, flatSeries, seriesFrom, tradingDays } from "./test-fixtures.js";
import { newStrategy } from "./strategy.js";
import type { BacktestReport, HorizonStats, LiveSignal, SampleStats, Strategy } from "./types.js";

const days = tradingDays(60);
const config = mergeQuantLabConfig(null);

const strategy: Strategy = newStrategy({
  strategy_id: "test",
  name: "Test",
  created_at: "2026-01-01T00:00:00.000Z",
  universe: { tickers: "tracked", min_history_sessions: 1 },
  trigger: { kind: "pattern", pattern: { names: ["compression"], state: "any" } },
  filters: [],
  entry: { when: "signal_close" },
  hold: { sessions: [1, 5] },
  exit: { kind: "time_only" },
  direction: { kind: "long_only" },
  notes: "",
});

function horizon(n: number): HorizonStats {
  return {
    sessions: 5,
    n,
    n_tickers: 5,
    median: 0.01,
    mean: 0.01,
    hit_rate: 0.6,
    sharpe: 0.5,
    sortino: 0.6,
    max_drawdown: -0.1,
    ci_low: 0,
    ci_high: 0.02,
    deciles: [],
    base_rate_median: 0,
    base_rate_n: 100,
    insufficient: n < config.backtest.minSignals,
  };
}

function report(over: { version?: number; oosN?: number } = {}): BacktestReport {
  const sample = (label: SampleStats["label"], n: number): SampleStats => ({
    label,
    from: days[0],
    to: days[59],
    horizons: [horizon(n)],
  });
  return {
    report_id: `r-${over.version ?? 1}-${over.oosN ?? 0}`,
    strategy_id: "test",
    strategy_version: over.version ?? 1,
    strategy_name: "Test",
    created_at: "2026-08-25T00:00:00.000Z",
    window: { from: days[0], to: days[59] },
    headline_layer: "sector_relative",
    full: sample("full", 100),
    in_sample: sample("in_sample", 60),
    out_of_sample: sample("out_of_sample", over.oosN ?? 0),
    variant_number: 1,
    variant_warning: null,
    overfit_warning: null,
    split_warning: null,
    created_after_oos_view: false,
    verdict: "",
    excluded: [],
    caveats: [],
    signals: [],
    equity: [],
  };
}

describe("quantlab/ledger — the enable gate (§8)", () => {
  it("refuses a strategy that has never been backtested", () => {
    const decision = canEnable(strategy, [], config);
    assert.equal(decision.ok, false);
    assert.match((decision as { reason: string }).reason, /no backtest has been run/);
  });

  it("refuses a strategy whose backtest produced no out-of-sample signals", () => {
    const decision = canEnable(strategy, [report({ oosN: 0 })], config);
    assert.equal(decision.ok, false);
    assert.match((decision as { reason: string }).reason, /no out-of-sample signals/);
  });

  it("refuses below the n floor and says by how much", () => {
    const decision = canEnable(strategy, [report({ oosN: 17 })], config);
    assert.equal(decision.ok, false);
    assert.match((decision as { reason: string }).reason, /n=17, below the 30-signal floor/);
  });

  it("allows a strategy with a sufficient out-of-sample result", () => {
    assert.deepEqual(canEnable(strategy, [report({ oosN: 64 })], config), { ok: true });
  });

  it("a new version cannot inherit the previous version's evidence", () => {
    const v2: Strategy = { ...strategy, version: 2, parent_version: 1 };
    const decision = canEnable(v2, [report({ version: 1, oosN: 64 })], config);
    assert.equal(decision.ok, false, "v2 is a different rule and must earn its own result");
    assert.match((decision as { reason: string }).reason, /v2/);
  });
});

describe("quantlab/ledger — identity and idempotence", () => {
  it("ids are deterministic, so re-evaluating a session cannot duplicate a row", () => {
    assert.equal(liveSignalId(strategy, "NVDA", days[10]), `test:1:NVDA:${days[10]}`);
    assert.equal(liveSignalId(strategy, "NVDA", days[10]), liveSignalId(strategy, "NVDA", days[10]));
  });

  it("a version bump changes the id, so the two versions never merge", () => {
    const v2: Strategy = { ...strategy, version: 2 };
    assert.notEqual(liveSignalId(strategy, "NVDA", days[10]), liveSignalId(v2, "NVDA", days[10]));
  });
});

describe("quantlab/ledger — forward return filling", () => {
  const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(59).fill(0.01) });
  const { ctx, calendar } = contextFrom({ series: [flatSeries("SPY", days), ticker], sectors: {} });
  const deps = { ctx, calendar, strategiesById: new Map([["test:1", strategy]]) };

  function pending(session: string): LiveSignal {
    return {
      id: liveSignalId(strategy, "AAA", session),
      strategy_id: "test",
      strategy_version: 1,
      ticker: "AAA",
      session,
      entry_session: session,
      entry_price: 100,
      sign: 1,
      sector: null,
      reason: "test",
      recorded_at: "2026-08-25T00:00:00.000Z",
      returns: [1, 5].map((sessions) => ({
        sessions,
        exit_session: null,
        exit_price: null,
        raw: null,
        market_adjusted: null,
        sector_relative: null,
        degraded: ["pending"],
      })),
      complete: false,
      backfilled: false,
    };
  }

  it("fills a matured horizon with the realised return", () => {
    const { updated, filled } = fillForwardReturns([pending(days[10])], deps);
    assert.equal(filled, 2);
    const one = updated[0].returns.find((r) => r.sessions === 1)!;
    assert.ok(Math.abs(one.raw! - 0.01) < 1e-12);
    assert.equal(one.exit_session, days[11]);
    assert.equal(updated[0].complete, true);
  });

  it("leaves an unmatured horizon pending rather than truncating it", () => {
    // Signalled 2 sessions before the end: the 1-session horizon can resolve,
    // the 5-session one cannot.
    const { updated } = fillForwardReturns([pending(days[57])], deps);
    const one = updated[0].returns.find((r) => r.sessions === 1)!;
    const five = updated[0].returns.find((r) => r.sessions === 5)!;
    assert.ok(one.raw != null);
    assert.equal(five.raw, null);
    assert.equal(updated[0].complete, false);
  });

  it("is idempotent — a second sweep fills nothing and changes nothing", () => {
    const first = fillForwardReturns([pending(days[10])], deps);
    const second = fillForwardReturns(first.updated, deps);
    assert.equal(second.filled, 0);
    assert.deepEqual(second.updated, first.updated);
  });

  it("signs the fill by the signal's own direction", () => {
    const short = { ...pending(days[10]), sign: -1 as const };
    const { updated } = fillForwardReturns([short], deps);
    const one = updated[0].returns.find((r) => r.sessions === 1)!;
    assert.ok(one.raw! < 0, "a short on a rising name is negative");
  });

  it("completeSignals only returns fully resolved rows", () => {
    const { updated } = fillForwardReturns([pending(days[10]), pending(days[57])], deps);
    assert.equal(completeSignals(updated).length, 1);
  });

  it("forwardSignals excludes replayed rows — they are not evidence", () => {
    const forward = pending(days[10]);
    const replayed = { ...pending(days[12]), backfilled: true };
    assert.deepEqual(forwardSignals([forward, replayed]).map((s) => s.session), [days[10]]);
  });
});
