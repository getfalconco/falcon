import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexGraph } from "../propagation/engine/graph.js";
import type { GraphEdge } from "../propagation/types.js";
import { mergeGaugeConfig } from "../gauge/config.js";
import { mergeScreenConfig } from "../screen/config.js";
import { graphAsOf, neighboursOf } from "./graph-asof.js";
import { dollarVolume, generateSignals, screenUniverse, type SignalGenDeps } from "./signals.js";
import { contextFrom, filingEvent, flatSeries, seriesFrom, tradingDays } from "./test-fixtures.js";
import { newStrategy } from "./strategy.js";
import type { FilingEvent } from "./filings.js";
import type { Strategy } from "./types.js";

const days = tradingDays(60);

function edge(root: string, counterparty: string, filingDate: string, tier: "critical" | "important" | "marginal"): GraphEdge {
  return {
    id: `${root}-${counterparty}`,
    root_ticker: root,
    counterparty_id: counterparty,
    counterparty_name: counterparty,
    counterparty_ticker: counterparty,
    category: "supplier",
    subtype: "components",
    confidence: 0.9,
    strength_tier: tier,
    evidence_quote: "",
    source_url: "",
    valid_from: filingDate,
    filing_date: filingDate,
  };
}

function baseStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    ...newStrategy({
      strategy_id: "test",
      name: "test",
      created_at: "2026-01-01T00:00:00.000Z",
      universe: { tickers: "tracked", min_history_sessions: 1 },
      trigger: {
        kind: "event",
        event: { types: ["8k_item_2.02"], on: "root" },
      },
      filters: [],
      entry: { when: "signal_close" },
      hold: { sessions: [5] },
      exit: { kind: "time_only" },
      direction: { kind: "long_only" },
      notes: "",
    }),
    ...overrides,
  };
}

function depsFor(
  strategy: Strategy,
  filings: Map<string, FilingEvent[]>,
  edges: GraphEdge[] = [],
): SignalGenDeps {
  const rising = seriesFrom({ ticker: "AAA", days, returns: new Array(59).fill(0.01) });
  const peer = seriesFrom({ ticker: "BBB", days, returns: new Array(59).fill(0.002) });
  const { ctx, calendar } = contextFrom({ series: [flatSeries("SPY", days), rising, peer], sectors: {} });
  return {
    strategy,
    ctx,
    calendar,
    screenConfig: mergeScreenConfig(null),
    gaugeConfig: mergeGaugeConfig(null),
    r2Floor: 0.15,
    graph: indexGraph({ edges }),
    filingsByTicker: filings,
    earningsByTicker: new Map(),
    earningsKnowledgeHorizonSessions: 21,
    universe: ["AAA", "BBB"],
    from: days[0],
    to: days[59],
  };
}

describe("quantlab/signals — entry-timing enforcement (§6)", () => {
  const afterClose = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], true)]]]);
  const beforeClose = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);

  it("drops an after-close event when the strategy enters at the close, and counts it", () => {
    const result = generateSignals(depsFor(baseStrategy({ entry: { when: "signal_close" } }), afterClose));
    assert.equal(result.signals.length, 0, "a release accepted after the close is not tradable at that close");
    assert.equal(result.entry_timing_rejected, 1);
  });

  it("accepts the same event when the strategy enters at the next open", () => {
    const result = generateSignals(depsFor(baseStrategy({ entry: { when: "next_open" } }), afterClose));
    assert.equal(result.signals.length, 1);
    assert.equal(result.entry_timing_rejected, 0);
    assert.equal(result.signals[0].entry_session, days[21], "entry is the session after the event");
  });

  it("accepts a before-the-open release at that session's close", () => {
    const result = generateSignals(depsFor(baseStrategy({ entry: { when: "signal_close" } }), beforeClose));
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].entry_session, days[20]);
    assert.equal(result.entry_timing_rejected, 0);
  });

  it("never silently shifts a rejected candidate to the next open", () => {
    const result = generateSignals(depsFor(baseStrategy({ entry: { when: "signal_close" } }), afterClose));
    assert.equal(result.signals.length, 0, "shifting would turn an impossible trade into a possible one");
  });
});

describe("quantlab/signals — graph look-ahead (§3)", () => {
  const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);
  const graphStrategy = baseStrategy({
    trigger: {
      kind: "event",
      event: { types: ["8k_item_2.02"], on: "graph_neighbour" },
      graph: { edge_from_event_ticker: true, min_tier: "important", max_hops: 1 },
    },
  });

  it("uses an edge disclosed before the event session", () => {
    const result = generateSignals(depsFor(graphStrategy, filings, [edge("AAA", "BBB", days[5], "important")]));
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].ticker, "BBB");
  });

  it("IGNORES an edge disclosed after the event session", () => {
    const result = generateSignals(depsFor(graphStrategy, filings, [edge("AAA", "BBB", days[40], "important")]));
    assert.equal(result.signals.length, 0, "a relationship disclosed later was not known at the event");
  });

  it("ignores an edge below the tier floor", () => {
    const result = generateSignals(depsFor(graphStrategy, filings, [edge("AAA", "BBB", days[5], "marginal")]));
    assert.equal(result.signals.length, 0);
  });

  it("graphAsOf drops future and undated edges and reports both counts", () => {
    const index = indexGraph({
      edges: [
        edge("AAA", "BBB", days[5], "important"),
        edge("AAA", "CCC", days[40], "important"),
        { ...edge("AAA", "DDD", days[5], "important"), filing_date: undefined, valid_from: "" },
      ],
    });
    const result = graphAsOf(index, days[20]);
    assert.equal(result.kept, 1);
    assert.equal(result.future, 1);
    assert.equal(result.undated, 1, "an undated edge has no known disclosure moment, so it is excluded");
  });

  it("neighboursOf follows both directions but never crosses the as-of cut", () => {
    const index = indexGraph({ edges: [edge("AAA", "BBB", days[5], "critical")] });
    assert.deepEqual(
      neighboursOf(index, "BBB", "important", days[20]).map((n) => n.ticker),
      ["AAA"],
      "the reverse direction is a real link",
    );
    assert.deepEqual(neighboursOf(index, "BBB", "important", days[1]).map((n) => n.ticker), []);
  });
});

describe("quantlab/signals — filters", () => {
  const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);

  it("r2_floor rejects when r² is below the floor and counts the rejection", () => {
    const strategy = baseStrategy({ filters: [{ kind: "r2_floor", min: 0.9 }] });
    const result = generateSignals(depsFor(strategy, filings));
    assert.equal(result.signals.length, 0);
    assert.equal(result.filter_rejections.r2_floor, 1);
  });

  it("r2_floor passes when the fixture's r² clears it", () => {
    const strategy = baseStrategy({ filters: [{ kind: "r2_floor", min: 0.4 }] });
    assert.equal(generateSignals(depsFor(strategy, filings)).signals.length, 1);
  });

  it("no_earnings_within rejects a signal sitting on an announcement", () => {
    const strategy = baseStrategy({ filters: [{ kind: "no_earnings_within", sessions: 3 }] });
    const deps = depsFor(strategy, filings);
    deps.earningsByTicker = new Map([["AAA", [filingEvent("AAA", days[22], ["2.02"], false)]]]);
    const result = generateSignals(deps);
    assert.equal(result.signals.length, 0);
    assert.equal(result.filter_rejections.no_earnings_within, 1);
  });

  it("no_earnings_within ignores an announcement beyond the knowledge horizon", () => {
    const strategy = baseStrategy({ filters: [{ kind: "no_earnings_within", sessions: 40 }] });
    const deps = depsFor(strategy, filings);
    // 30 sessions ahead, horizon is 21 — nobody could have known.
    deps.earningsByTicker = new Map([["AAA", [filingEvent("AAA", days[50], ["2.02"], false)]]]);
    assert.equal(generateSignals(deps).signals.length, 1);
  });

  it("liquidity rejects below the dollar-volume floor", () => {
    const strategy = baseStrategy({ filters: [{ kind: "liquidity", min_dollar_volume_20d: 1e15 }] });
    const result = generateSignals(depsFor(strategy, filings));
    assert.equal(result.signals.length, 0);
    assert.equal(result.filter_rejections.liquidity, 1);
  });

  it("dollarVolume needs the whole window covered", () => {
    const series = seriesFrom({ ticker: "AAA", days, returns: new Array(59).fill(0), volumes: days.map(() => 1000) });
    assert.equal(dollarVolume(series, 5, 20), null, "an uncovered window is null, never a partial median");
    assert.equal(dollarVolume(series, 25, 20), 100 * 1000);
  });
});

describe("quantlab/signals — universe screening (§4)", () => {
  it("excludes a ticker with too little history and names the reason", () => {
    const strategy = baseStrategy({ universe: { tickers: "tracked", min_history_sessions: 500 } });
    const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);
    const { universe, excluded } = screenUniverse(depsFor(strategy, filings));
    assert.deepEqual(universe, []);
    assert.equal(excluded.length, 2);
    assert.equal(excluded[0].reason, "short_history");
    assert.match(excluded[0].detail, /60 sessions, 500 required/);
  });

  it("an excluded ticker produces no signals", () => {
    const strategy = baseStrategy({ universe: { tickers: "tracked", min_history_sessions: 500 } });
    const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);
    assert.equal(generateSignals(depsFor(strategy, filings)).signals.length, 0);
  });
});

describe("quantlab/signals — direction", () => {
  const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);

  it("long_only is always +1 and is not counted as a fallback", () => {
    const result = generateSignals(depsFor(baseStrategy(), filings));
    assert.equal(result.signals[0].sign, 1);
    assert.equal(result.direction_fallback_long, 0);
    assert.equal(result.direction_from_trigger, 0);
  });

  it("event_direction takes the sign of the event ticker's move", () => {
    const strategy = baseStrategy({ direction: { kind: "event_direction" } });
    const result = generateSignals(depsFor(strategy, filings));
    // AAA rises 1% that session, so the event reads positive.
    assert.equal(result.signals[0].sign, 1);
    assert.equal(result.direction_from_trigger, 1);
  });

  it("a falling event ticker gives a short signal", () => {
    const strategy = baseStrategy({ direction: { kind: "event_direction" } });
    const falling = seriesFrom({ ticker: "AAA", days, returns: new Array(59).fill(-0.01) });
    const deps = depsFor(strategy, filings);
    deps.ctx.seriesByTicker.set("AAA", falling);
    assert.equal(generateSignals(deps).signals[0].sign, -1);
  });
});

describe("quantlab/signals — window bounds", () => {
  it("an event outside the window produces nothing", () => {
    const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);
    const deps = depsFor(baseStrategy(), filings);
    deps.from = days[30];
    assert.equal(generateSignals(deps).signals.length, 0);
  });

  it("an unmatched item code produces nothing", () => {
    const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["7.01"], false)]]]);
    assert.equal(generateSignals(depsFor(baseStrategy(), filings)).signals.length, 0);
  });

  it("a bare item code and its 8k_item_ form mean the same thing", () => {
    const filings = new Map([["AAA", [filingEvent("AAA", days[20], ["2.02"], false)]]]);
    const strategy = baseStrategy({
      trigger: { kind: "event", event: { types: ["2.02"], on: "root" } },
    });
    assert.equal(generateSignals(depsFor(strategy, filings)).signals.length, 1);
  });
});
