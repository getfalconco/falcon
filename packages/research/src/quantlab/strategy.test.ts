import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_QUANTLAB_CONFIG, mergeQuantLabConfig } from "./config.js";
import { SEED_STRATEGIES } from "./seeds.js";
import { isBacktestable, newStrategy, nextVersion, unavailableComponents, validateStrategy } from "./strategy.js";
import type { Strategy } from "./types.js";

function valid(over: Partial<Strategy> = {}): Strategy {
  return {
    ...newStrategy({
      strategy_id: "s1",
      name: "Rule",
      created_at: "2026-01-01T00:00:00.000Z",
      universe: { tickers: "tracked", min_history_sessions: 300 },
      trigger: { kind: "pattern", pattern: { names: ["compression"], state: "new" } },
      filters: [{ kind: "r2_floor", min: 0.15 }],
      entry: { when: "signal_close" },
      hold: { sessions: [5, 10] },
      exit: { kind: "time_only" },
      direction: { kind: "long_only" },
      notes: "",
    }),
    ...over,
  };
}

const errorFields = (s: Partial<Strategy>) => validateStrategy(s).errors.map((e) => e.field);

describe("quantlab/strategy — validation", () => {
  it("accepts a well-formed strategy", () => {
    const result = validateStrategy(valid());
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("requires a name, a universe and a trigger", () => {
    assert.ok(errorFields({ ...valid(), name: "" }).includes("name"));
    assert.ok(errorFields({ ...valid(), universe: undefined }).includes("universe"));
    assert.ok(errorFields({ ...valid(), trigger: undefined }).includes("trigger"));
  });

  it("rejects an unknown pattern name", () => {
    const bad = valid({ trigger: { kind: "pattern", pattern: { names: ["nope" as never], state: "new" } } });
    assert.ok(errorFields(bad).includes("trigger.pattern.names"));
  });

  it("rejects a non-time-only exit — stops and targets are v2 (§5)", () => {
    const bad = valid({ exit: { kind: "stop_loss" as never } });
    const result = validateStrategy(bad);
    assert.equal(result.ok, false);
    assert.match(result.errors.find((e) => e.field === "exit.kind")!.message, /overfitting surface/);
  });

  it("rejects multi-hop graph traversal until the transmission matrix is validated", () => {
    const bad = valid({
      trigger: {
        kind: "event",
        event: { types: ["8k_item_2.02"], on: "graph_neighbour" },
        graph: { edge_from_event_ticker: true, min_tier: "important", max_hops: 2 },
      },
    });
    assert.ok(errorFields(bad).includes("trigger.graph.max_hops"));
  });

  it("rejects a graph_neighbour event with no graph block", () => {
    const bad = valid({
      trigger: { kind: "event", event: { types: ["8k_item_2.02"], on: "graph_neighbour" } },
    });
    assert.ok(errorFields(bad).includes("trigger.graph"));
  });

  it("rejects duplicate and malformed filters", () => {
    const dupes = valid({ filters: [{ kind: "r2_floor", min: 0.1 }, { kind: "r2_floor", min: 0.2 }] });
    assert.ok(errorFields(dupes).some((f) => f.startsWith("filters[1]")));
    const bad = valid({ filters: [{ kind: "r2_floor", min: 5 }] });
    assert.ok(errorFields(bad).includes("filters[0].min"));
  });

  it("requires at least one hold horizon", () => {
    assert.ok(errorFields(valid({ hold: { sessions: [] } })).includes("hold.sessions"));
    assert.ok(errorFields(valid({ hold: { sessions: [0] } })).includes("hold.sessions"));
  });

  it("warns — but does not block — an event trigger entering at the close", () => {
    const s = valid({
      trigger: { kind: "event", event: { types: ["8k_item_2.02"], on: "root" } },
      entry: { when: "signal_close" },
    });
    const result = validateStrategy(s);
    assert.equal(result.ok, true, "a before-the-open release IS tradable at that close");
    assert.ok(result.warnings.some((w) => w.field === "entry.when"));
  });

  it("warns when event_direction has no event to read", () => {
    const result = validateStrategy(valid({ direction: { kind: "event_direction" } }));
    assert.ok(result.warnings.some((w) => w.field === "direction.kind"));
  });
});

describe("quantlab/strategy — versioning (§5)", () => {
  const parent = valid();

  it("a new version links to its parent and bumps the number", () => {
    const v2 = nextVersion(parent, { name: "Rule v2" }, { createdAfterOosView: false, now: "2026-02-01T00:00:00.000Z" });
    assert.equal(v2.version, 2);
    assert.equal(v2.parent_version, 1);
    assert.equal(v2.strategy_id, parent.strategy_id);
    assert.equal(v2.name, "Rule v2");
    assert.equal(v2.created_at, "2026-02-01T00:00:00.000Z");
  });

  it("records that a version was minted after an OOS result was seen", () => {
    const v2 = nextVersion(parent, {}, { createdAfterOosView: true, now: "2026-02-01T00:00:00.000Z" });
    assert.equal(v2.created_after_oos_view, true);
  });

  it("never inherits the live toggle — an untested edit cannot start recording", () => {
    const enabled = { ...parent, live_enabled: true };
    const v2 = nextVersion(enabled, {}, { createdAfterOosView: false, now: "2026-02-01T00:00:00.000Z" });
    assert.equal(v2.live_enabled, false);
  });

  it("round-trips through JSON unchanged", () => {
    const parsed = JSON.parse(JSON.stringify(parent)) as Strategy;
    assert.deepEqual(parsed, parent);
    assert.equal(validateStrategy(parsed).ok, true);
  });
});

describe("quantlab/strategy — historical availability (§3)", () => {
  const config = mergeQuantLabConfig(null);

  it("names insider_cluster as unavailable and blocks backtesting", () => {
    const s = valid({ trigger: { kind: "pattern", pattern: { names: ["insider_divergence"], state: "new" } } });
    const components = unavailableComponents(s, config.unavailableHistorically);
    assert.equal(components.length, 1);
    assert.equal(components[0].component, "insider_cluster");
    assert.match(components[0].reason, /10-business-day window/);
    assert.equal(isBacktestable(s, config.unavailableHistorically), false);
  });

  it("names news_burst but still allows a backtest — the veto is only permissive", () => {
    const s = valid({ trigger: { kind: "pattern", pattern: { names: ["quiet_accumulation"], state: "new" } } });
    assert.equal(unavailableComponents(s, config.unavailableHistorically)[0].component, "news_burst");
    assert.equal(isBacktestable(s, config.unavailableHistorically), true);
  });

  it("a pure price/volume pattern has nothing unavailable", () => {
    assert.deepEqual(unavailableComponents(valid(), config.unavailableHistorically), []);
    assert.equal(isBacktestable(valid(), config.unavailableHistorically), true);
  });
});

describe("quantlab/seeds — the shipped library (§9)", () => {
  it("every seed validates", () => {
    for (const strategy of SEED_STRATEGIES) {
      const result = validateStrategy(strategy);
      assert.equal(result.ok, true, `${strategy.strategy_id}: ${JSON.stringify(result.errors)}`);
    }
  });

  it("every seed is version 1 with no parent and is not live-enabled", () => {
    for (const strategy of SEED_STRATEGIES) {
      assert.equal(strategy.version, 1, strategy.strategy_id);
      assert.equal(strategy.parent_version, null, strategy.strategy_id);
      assert.equal(strategy.live_enabled, false, `${strategy.strategy_id} must earn its OOS result first`);
    }
  });

  it("every seed states what would kill it", () => {
    for (const strategy of SEED_STRATEGIES) {
      assert.match(strategy.notes, /[Kk]ill condition/, `${strategy.strategy_id} has no kill condition`);
    }
  });

  it("ids are unique", () => {
    const ids = SEED_STRATEGIES.map((s) => s.strategy_id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("the insider seed is the one flagged unavailable", () => {
    const notTestable = SEED_STRATEGIES.filter(
      (s) => !isBacktestable(s, DEFAULT_QUANTLAB_CONFIG.unavailableHistorically),
    );
    assert.deepEqual(notTestable.map((s) => s.strategy_id), ["seed-insider-divergence"]);
  });
});
