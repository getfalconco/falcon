import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_QUANTLAB_CONFIG, mergeQuantLabConfig } from "./config.js";
import { LedgerStore, QuantLabConfigStore, ResultStore, SeriesStore, StrategyStore } from "./store.js";
import { newStrategy } from "./strategy.js";
import type { BacktestReport, LiveSignal, QuantSeries, Strategy } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quantlab-store-"));
}

const strategy: Strategy = newStrategy({
  strategy_id: "s1",
  name: "Rule",
  created_at: "2026-01-01T00:00:00.000Z",
  universe: { tickers: "tracked", min_history_sessions: 300 },
  trigger: { kind: "pattern", pattern: { names: ["compression"], state: "new" } },
  filters: [],
  entry: { when: "signal_close" },
  hold: { sessions: [5] },
  exit: { kind: "time_only" },
  direction: { kind: "long_only" },
  notes: "",
});

function report(over: Partial<BacktestReport> = {}): BacktestReport {
  const empty = { label: "full" as const, from: "2026-01-01", to: "2026-06-01", horizons: [] };
  return {
    report_id: "r1",
    strategy_id: "s1",
    strategy_version: 1,
    strategy_name: "Rule",
    created_at: "2026-08-01T00:00:00.000Z",
    window: { from: "2026-01-01", to: "2026-06-01" },
    headline_layer: "sector_relative",
    full: empty,
    in_sample: { ...empty, label: "in_sample" },
    out_of_sample: { ...empty, label: "out_of_sample" },
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
    ...over,
  };
}

describe("quantlab/store — config", () => {
  it("writes the defaults on first run and reads them back", () => {
    const dir = tmpDir();
    const store = new QuantLabConfigStore(dir);
    const loaded = store.load();
    assert.deepEqual(loaded, mergeQuantLabConfig(null));
    assert.ok(fs.existsSync(store.configFile), "first load writes the file");
  });

  it("a stored value wins over the code default", () => {
    const dir = tmpDir();
    const store = new QuantLabConfigStore(dir);
    store.load();
    const raw = JSON.parse(fs.readFileSync(store.configFile, "utf8"));
    raw.backtest.minSignals = 50;
    fs.writeFileSync(store.configFile, JSON.stringify(raw));
    assert.equal(store.load().backtest.minSignals, 50);
  });

  it("the schema version is always the code's, never the file's", () => {
    const dir = tmpDir();
    const store = new QuantLabConfigStore(dir);
    store.load();
    fs.writeFileSync(store.configFile, JSON.stringify({ schemaVersion: 99 }));
    assert.equal(store.load().schemaVersion, DEFAULT_QUANTLAB_CONFIG.schemaVersion);
  });

  it("a corrupt file falls back to the defaults instead of throwing", () => {
    const dir = tmpDir();
    const store = new QuantLabConfigStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(store.configFile, "{ not json");
    assert.equal(store.load().backtest.minSignals, DEFAULT_QUANTLAB_CONFIG.backtest.minSignals);
  });
});

describe("quantlab/store — series", () => {
  const series: QuantSeries = {
    ticker: "AAA",
    snapshots: [
      {
        d: "2026-01-02",
        open: 99,
        close: 100,
        volume: 1000,
        ret: null,
        bench_ret: null,
        volume_ratio: null,
        residual_move: null,
        residual_z: null,
        beta: 1,
        r2: 0.4,
        daily_vol: 0.02,
        vol_regime: 1,
        momentum_5d: null,
        momentum_20d: null,
        range_10s: null,
        pct_from_52w_high: null,
        pct_from_52w_low: null,
        history_sessions: 1,
      },
    ],
  };

  it("round-trips a series", () => {
    const store = new SeriesStore(tmpDir());
    store.save(series);
    assert.deepEqual(store.load("AAA"), series);
    assert.deepEqual(store.list(), ["AAA"]);
  });

  it("reports coverage", () => {
    const store = new SeriesStore(tmpDir());
    store.save(series);
    assert.deepEqual(store.coverage(), [{ ticker: "AAA", sessions: 1, from: "2026-01-02", to: "2026-01-02" }]);
  });

  it("returns null for an unknown ticker", () => {
    assert.equal(new SeriesStore(tmpDir()).load("ZZZ"), null);
  });

  it("refuses a ticker that could escape the series directory", () => {
    const store = new SeriesStore(tmpDir());
    assert.throws(() => store.load("../../etc/passwd"), /unsafe ticker/);
  });
});

describe("quantlab/store — strategies are an append-only audit trail (§5)", () => {
  it("appends versions and reads them back in order", () => {
    const store = new StrategyStore(tmpDir());
    store.append(strategy);
    store.append({ ...strategy, version: 2, parent_version: 1 });
    assert.deepEqual(store.versions("s1").map((s) => s.version), [1, 2]);
    assert.equal(store.latest("s1")!.version, 2);
    assert.equal(store.get("s1", 1)!.version, 1);
  });

  it("REFUSES to overwrite an existing version", () => {
    const store = new StrategyStore(tmpDir());
    store.append(strategy);
    assert.throws(() => store.append(strategy), /versions are immutable/);
  });

  it("heads returns one row per family", () => {
    const store = new StrategyStore(tmpDir());
    store.append(strategy);
    store.append({ ...strategy, version: 2, parent_version: 1 });
    store.append({ ...strategy, strategy_id: "s2", name: "Other" });
    assert.deepEqual(store.heads().map((s) => [s.strategy_id, s.version]), [
      ["Other", 1],
      ["Rule", 2],
    ].map(([name, v]) => [name === "Other" ? "s2" : "s1", v]));
  });

  it("the live toggle is mutable in place — flipping it must not mint a version", () => {
    const store = new StrategyStore(tmpDir());
    store.append(strategy);
    store.setLiveEnabled("s1", 1, true);
    assert.equal(store.get("s1", 1)!.live_enabled, true);
    assert.equal(store.versions("s1").length, 1, "enabling is not an edit to the rule");
    store.setLiveEnabled("s1", 1, false);
    assert.equal(store.get("s1", 1)!.live_enabled, false);
  });

  it("refuses to toggle a version that does not exist", () => {
    const store = new StrategyStore(tmpDir());
    assert.throws(() => store.setLiveEnabled("s1", 9, true), /not found/);
  });

  it("survives a reload from disk", () => {
    const dir = tmpDir();
    new StrategyStore(dir).append(strategy);
    assert.equal(new StrategyStore(dir).latest("s1")!.strategy_id, "s1");
  });
});

describe("quantlab/store — results and the variant counter (§7)", () => {
  it("counts the run about to happen, so the first report is variant 1", () => {
    const store = new ResultStore(tmpDir());
    assert.equal(store.nextVariantNumber("s1"), 1);
    store.save(report());
    assert.equal(store.nextVariantNumber("s1"), 2);
    store.save(report({ report_id: "r2" }));
    assert.equal(store.nextVariantNumber("s1"), 3);
  });

  it("counts across versions of the same family — the variant count is the search count", () => {
    const store = new ResultStore(tmpDir());
    store.save(report({ report_id: "r1", strategy_version: 1 }));
    store.save(report({ report_id: "r2", strategy_version: 2 }));
    assert.equal(store.nextVariantNumber("s1"), 3);
    assert.equal(store.nextVariantNumber("other"), 1, "a different family counts separately");
  });

  it("hasOosResult is false until a report carries out-of-sample signals", () => {
    const store = new ResultStore(tmpDir());
    store.save(report());
    assert.equal(store.hasOosResult("s1"), false);
    store.save(
      report({
        report_id: "r2",
        out_of_sample: {
          label: "out_of_sample",
          from: "2026-01-01",
          to: "2026-06-01",
          horizons: [
            {
              sessions: 5,
              n: 40,
              n_tickers: 5,
              median: 0.01,
              mean: 0.01,
              hit_rate: 0.5,
              sharpe: 0.5,
              sortino: 0.5,
              max_drawdown: -0.1,
              ci_low: 0,
              ci_high: 0.02,
              deciles: [],
              base_rate_median: 0,
              base_rate_n: 10,
              insufficient: false,
            },
          ],
        },
      }),
    );
    assert.equal(store.hasOosResult("s1"), true);
  });

  it("refuses an unsafe report id", () => {
    assert.throws(() => new ResultStore(tmpDir()).load("../escape"), /unsafe report id/);
  });
});

describe("quantlab/store — the live ledger", () => {
  function signal(id: string, complete = false): LiveSignal {
    return {
      id,
      strategy_id: "s1",
      strategy_version: 1,
      ticker: "AAA",
      session: "2026-08-01",
      entry_session: "2026-08-01",
      entry_price: 100,
      sign: 1,
      sector: null,
      reason: "test",
      recorded_at: "2026-08-01T21:00:00.000Z",
      returns: [],
      complete,
      backfilled: false,
    };
  }

  it("appends and reads back", () => {
    const store = new LedgerStore(tmpDir());
    store.append([signal("a"), signal("b")]);
    assert.deepEqual(store.read().map((s) => s.id), ["a", "b"]);
  });

  it("last write wins per id, so a forward-return fill supersedes the original row", () => {
    const store = new LedgerStore(tmpDir());
    store.append([signal("a")]);
    store.append([signal("a", true)]);
    const rows = store.read();
    assert.equal(rows.length, 1, "re-appending the same id is an update, not a duplicate");
    assert.equal(rows[0].complete, true);
  });

  it("survives a torn line rather than losing the whole ledger", () => {
    const dir = tmpDir();
    const store = new LedgerStore(dir);
    store.append([signal("a")]);
    fs.appendFileSync(store.file, "{ half a line\n");
    store.append([signal("b")]);
    assert.deepEqual(store.read().map((s) => s.id), ["a", "b"]);
  });

  it("compacts to the current state", () => {
    const store = new LedgerStore(tmpDir());
    store.append([signal("a"), signal("b")]);
    store.compact([signal("a", true)]);
    assert.deepEqual(store.read().map((s) => s.id), ["a"]);
  });

  it("an empty ledger reads as an empty list", () => {
    assert.deepEqual(new LedgerStore(tmpDir()).read(), []);
  });
});

describe("quantlab/store — the result index", () => {
  it("keeps the index free of signals while the full report retains them", () => {
    const dir = tmpDir();
    const store = new ResultStore(dir);
    const heavy = report({
      signals: [
        {
          ticker: "AAA",
          session: "2026-01-05",
          entry_session: "2026-01-05",
          entry_price: 100,
          entry_when: "signal_close",
          sign: 1,
          sector: null,
          reason: "test",
          returns: [],
        },
      ],
    });
    store.save(heavy);
    assert.equal(store.list()[0].signals.length, 0, "the index must not carry signals");
    assert.equal(store.load("r1")!.signals.length, 1, "the full report still does");
  });

  it("re-saving a report id updates its index entry rather than duplicating it", () => {
    const store = new ResultStore(tmpDir());
    store.save(report({ verdict: "first" }));
    store.save(report({ verdict: "second" }));
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].verdict, "second");
  });

  it("prune drops the full report but keeps the variant history", () => {
    const store = new ResultStore(tmpDir());
    store.save(report({ created_at: "2020-01-01T00:00:00.000Z" }));
    const removed = store.prune(30, Date.parse("2026-08-25T00:00:00.000Z"));
    assert.equal(removed, 1);
    assert.equal(store.load("r1"), null, "the bulk is gone");
    assert.equal(store.nextVariantNumber("s1"), 2, "the search history is not");
  });
});
