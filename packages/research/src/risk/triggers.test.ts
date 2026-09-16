import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RiskRecomputeScheduler, computeTriggerKeys, diffTriggerKeys, type RiskTriggerKeys, type SchedulerTimers } from "./triggers.js";
import type { RiskTriggerReason } from "./types.js";

/** Deterministic timers: advance() fires due callbacks in order. */
function fakeTimers(): SchedulerTimers & { advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      queue.delete(h as number);
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, t] = due[0];
        queue.delete(id);
        now = t.at;
        t.fn();
      }
      now = target;
    },
    pending: () => queue.size,
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("risk/triggers — keys", () => {
  const base = {
    held: ["nvda", "TSM"],
    closeDay: { NVDA: "2026-08-21", TSM: "2026-08-21" },
    live: {
      open_incidents: [
        { ticker: "NVDA", band: "P2" as const, incident_id: "a" },
        { ticker: "NVDA", band: "P1" as const, incident_id: "b" },
        { ticker: "AMD", band: "P0" as const, incident_id: "c" },
      ],
      earnings: [
        { ticker: "NVDA", due_at: "x", sessions_until: 2, fiscal_period: null },
        { ticker: "TSM", due_at: "y", sessions_until: 9, fiscal_period: null },
      ],
    },
    horizonSessions: 5,
  };

  it("fingerprints held tickers' close day, highest open band, and horizon membership", () => {
    const keys = computeTriggerKeys(base);
    assert.equal(keys.close, "NVDA:2026-08-21,TSM:2026-08-21");
    assert.equal(keys.bands, "NVDA:P1,TSM:-");
    assert.equal(keys.horizon, "NVDA");
  });

  it("diff maps key changes to reasons; first observation never triggers", () => {
    const a = computeTriggerKeys(base);
    assert.deepEqual(diffTriggerKeys(null, a), []);
    assert.deepEqual(diffTriggerKeys(a, a), []);
    const closeMoved = computeTriggerKeys({ ...base, closeDay: { NVDA: "2026-08-24", TSM: "2026-08-21" } });
    assert.deepEqual(diffTriggerKeys(a, closeMoved), ["close_run"]);
    const bandMoved = computeTriggerKeys({ ...base, live: { ...base.live, open_incidents: [{ ticker: "NVDA", band: "P0", incident_id: "b" }] } });
    assert.deepEqual(diffTriggerKeys(a, bandMoved), ["band_change"]);
    const horizonLeft = computeTriggerKeys({ ...base, live: { ...base.live, earnings: [{ ticker: "NVDA", due_at: "x", sessions_until: 6, fiscal_period: null }] } });
    assert.deepEqual(diffTriggerKeys(a, horizonLeft), ["horizon_change"]);
    const horizonEntered = computeTriggerKeys({ ...base, live: { ...base.live, earnings: [...base.live.earnings, { ticker: "TSM", due_at: "z", sessions_until: 5, fiscal_period: null }] } });
    assert.deepEqual(diffTriggerKeys(a, horizonEntered), ["horizon_change"]);
    const both = computeTriggerKeys({ ...base, held: ["NVDA", "TSM", "CEG"], closeDay: { ...base.closeDay, CEG: null } });
    // a new held ticker changes the close fingerprint and the band fingerprint (new "-" slot)
    assert.deepEqual(diffTriggerKeys(a, both), ["close_run", "band_change"]);
  });

  it("a band change on an unheld ticker is invisible", () => {
    const a = computeTriggerKeys(base);
    const b = computeTriggerKeys({ ...base, live: { ...base.live, open_incidents: [...base.live.open_incidents, { ticker: "AMD", band: "P1", incident_id: "d" }] } });
    assert.deepEqual(diffTriggerKeys(a, b), []);
  });
});

describe("risk/triggers — scheduler", () => {
  it("debounces account changes into one recompute after debounceMs", async () => {
    const timers = fakeTimers();
    const calls: RiskTriggerReason[][] = [];
    const s = new RiskRecomputeScheduler({ debounceMs: 60_000, recompute: (r) => void calls.push(r), timers });
    s.accountChanged();
    timers.advance(30_000);
    s.accountChanged();
    timers.advance(30_000);
    assert.equal(calls.length, 0); // the second change reset the timer
    timers.advance(30_000);
    await flush();
    assert.deepEqual(calls, [["position_change"]]);
    assert.equal(timers.pending(), 0);
    s.dispose();
  });

  it("observe() recomputes at once on a key change; manual requests run immediately", async () => {
    const timers = fakeTimers();
    const calls: RiskTriggerReason[][] = [];
    const s = new RiskRecomputeScheduler({ debounceMs: 60_000, recompute: (r) => void calls.push(r), timers });
    const k1: RiskTriggerKeys = { close: "a", bands: "b", horizon: "c" };
    s.prime(k1);
    assert.deepEqual(s.observe(k1), []);
    assert.deepEqual(s.observe({ ...k1, close: "a2" }), ["close_run"]);
    await flush();
    assert.deepEqual(calls, [["close_run"]]);
    await s.request(["manual"]);
    assert.deepEqual(calls, [["close_run"], ["manual"]]);
  });

  it("reasons arriving during a running recompute are batched into one follow-up", async () => {
    const timers = fakeTimers();
    const calls: RiskTriggerReason[][] = [];
    let release: () => void = () => {};
    let first = true;
    const s = new RiskRecomputeScheduler({
      debounceMs: 0,
      timers,
      recompute: async (r) => {
        calls.push(r);
        if (first) {
          first = false;
          await new Promise<void>((res) => {
            release = res;
          });
        }
      },
    });
    const p = s.request(["manual"]);
    await flush();
    s.observe({ close: "x", bands: "y", horizon: "z" });
    s.prime({ close: "x", bands: "y", horizon: "z" });
    s.observe({ close: "x2", bands: "y", horizon: "z" });
    s.observe({ close: "x2", bands: "y2", horizon: "z" });
    release();
    await p;
    await flush();
    assert.deepEqual(calls, [["manual"], ["close_run", "band_change"]]);
  });
});
