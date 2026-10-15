import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRiskSync, type RiskSyncBridge } from "./risk-sync.js";
import type { RiskAccountPush, RiskLatest, RiskSnapshot } from "../../shared/risk-types.js";

const SNAPSHOT: RiskSnapshot = {
  schema_version: 1,
  computed_at: "2026-10-15T14:00:00.000Z",
  account: "paper",
  trigger: ["manual"],
  invested_fraction: 0.6,
  position_count: 2,
  score: 41,
  band: "moderate",
  components: null,
  driver: { component: "concentration", sentence: "60% of the portfolio sits in NVDA.", contribution: 12 },
  weights: [],
  blend_weights: { concentration: 0.18, market: 0.17, volatility: 0.18, network: 0.22, event: 0.13, sharpe: 0.12 },
  degraded: [],
  graph_version: null,
  empty: false,
};

const HELD: RiskAccountPush = {
  account: "paper",
  cash: 1000,
  positions: [{ ticker: "NVDA", shares: 3, cost_usd: 500, market_value: null }],
  as_of: "2026-10-15T14:00:00.000Z",
  demo: false,
};

type Fake = {
  bridge: RiskSyncBridge;
  calls: string[];
  latest: RiskLatest;
  pushFails: number;
  recomputeResult: "snapshot" | "none" | "fail";
};

function fake(latest: RiskLatest): Fake {
  const f: Fake = {
    calls: [],
    latest,
    pushFails: 0,
    recomputeResult: "snapshot",
    bridge: {
      updateRiskAccount: async () => {
        f.calls.push("push");
        if (f.pushFails > 0) {
          f.pushFails--;
          return { ok: false, error: "not signed in yet" };
        }
        return { ok: true };
      },
      getRiskLatest: async () => {
        f.calls.push("latest");
        return { ok: true, ...f.latest };
      },
      recomputeRisk: async () => {
        f.calls.push("recompute");
        if (f.recomputeResult === "fail") return { ok: false, error: "engine timed out" };
        if (f.recomputeResult === "none") return { ok: true, snapshot: null, riskCardEnabled: true };
        f.latest = { snapshot: SNAPSHOT, riskCardEnabled: true };
        return { ok: true, ...f.latest };
      },
    },
  };
  return f;
}

/** Timers the test fires by hand. */
function manualTimers() {
  const queue: Array<{ fn: () => void; ms: number; handle: number }> = [];
  let next = 1;
  return {
    queue,
    setTimeout: (fn: () => void, ms: number) => {
      const handle = next++;
      queue.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout: (handle: unknown) => {
      const i = queue.findIndex((q) => q.handle === handle);
      if (i >= 0) queue.splice(i, 1);
    },
    fire: () => queue.shift()?.fn(),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("risk sync", () => {
  it("a user the engine has never scored gets a recompute right after the push", async () => {
    const f = fake({ snapshot: null, riskCardEnabled: true });
    let pushed = 0;
    const sync = createRiskSync({ bridge: f.bridge, build: () => HELD, onPushed: () => pushed++ });
    await sync.sync();
    assert.deepEqual(f.calls, ["push", "latest", "recompute"]);
    assert.equal(sync.state().failed, false);
    assert.equal(pushed, 2, "re-read after the push and again after the recompute");
  });

  it("a snapshot that already describes the book: no recompute (the debounce handles edits)", async () => {
    const f = fake({ snapshot: SNAPSHOT, riskCardEnabled: true });
    const sync = createRiskSync({ bridge: f.bridge, build: () => HELD });
    await sync.sync();
    assert.deepEqual(f.calls, ["push", "latest"]);
  });

  it("a demo push is never followed by a read or a recompute", async () => {
    const f = fake({ snapshot: null, riskCardEnabled: true });
    const sync = createRiskSync({ bridge: f.bridge, build: () => ({ ...HELD, demo: true }) });
    await sync.sync();
    assert.deepEqual(f.calls, ["push"]);
  });

  it("a failed push is reported and retried on the backoff", async () => {
    const f = fake({ snapshot: null, riskCardEnabled: true });
    f.pushFails = 1;
    const timers = manualTimers();
    const states: boolean[] = [];
    const sync = createRiskSync({
      bridge: f.bridge,
      build: () => HELD,
      onState: (s) => states.push(s.failed),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      retryDelaysMs: [5, 15],
    });
    await sync.sync();
    assert.equal(sync.state().failed, true);
    assert.equal(timers.queue.length, 1);
    assert.equal(timers.queue[0].ms, 5);
    timers.fire();
    await flush();
    await flush();
    assert.deepEqual(f.calls, ["push", "push", "latest", "recompute"]);
    assert.equal(sync.state().failed, false);
    assert.deepEqual(states, [true, false]);
    assert.equal(timers.queue.length, 0);
  });

  it("a recompute that fails, or comes back with no snapshot, is a failure", async () => {
    for (const result of ["fail", "none"] as const) {
      const f = fake({ snapshot: null, riskCardEnabled: true });
      f.recomputeResult = result;
      const timers = manualTimers();
      const sync = createRiskSync({ bridge: f.bridge, build: () => HELD, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, retryDelaysMs: [] });
      await sync.sync();
      assert.equal(sync.state().failed, true, result);
      assert.equal(timers.queue.length, 0, "backoff spent: waits for a manual retry");
    }
  });

  it("Try again clears the error at once and tries the whole thing again", async () => {
    const f = fake({ snapshot: null, riskCardEnabled: true });
    f.recomputeResult = "fail";
    const sync = createRiskSync({ bridge: f.bridge, build: () => HELD, retryDelaysMs: [] });
    await sync.sync();
    assert.equal(sync.state().failed, true);
    f.recomputeResult = "snapshot";
    const retry = sync.retry();
    assert.equal(sync.state().failed, false, "cleared before the push resolves");
    await retry;
    assert.equal(sync.state().failed, false);
    assert.deepEqual(f.calls.slice(-3), ["push", "latest", "recompute"]);
  });

  it("an older push's result never overwrites a newer one", async () => {
    const f = fake({ snapshot: SNAPSHOT, riskCardEnabled: true });
    let release: (() => void) | null = null;
    const slow = f.bridge.updateRiskAccount;
    let first = true;
    f.bridge.updateRiskAccount = (push) => {
      if (first) {
        first = false;
        return new Promise((resolve) => {
          release = () => resolve({ ok: false, error: "late failure" });
        });
      }
      return slow(push);
    };
    const sync = createRiskSync({ bridge: f.bridge, build: () => HELD, retryDelaysMs: [] });
    const a = sync.sync();
    await sync.sync();
    release!();
    await a;
    assert.equal(sync.state().failed, false);
  });

  it("dispose stops retries", async () => {
    const f = fake({ snapshot: null, riskCardEnabled: true });
    f.pushFails = 5;
    const timers = manualTimers();
    const sync = createRiskSync({ bridge: f.bridge, build: () => HELD, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    await sync.sync();
    assert.equal(timers.queue.length, 1);
    sync.dispose();
    assert.equal(timers.queue.length, 0);
  });
});
