import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSwrResource, type SwrEnv, type SwrLoadResult } from "./swr-resource";

/**
 * A clock, timers and a window you move by hand, so every rule of the store
 * (freshness, sharing one request, keeping the old list on a failure, the
 * timer stopping while the window is hidden) can be checked without waiting.
 */
function fakeEnv() {
  let now = 1_000_000;
  let visible = true;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const visibilityListeners = new Set<() => void>();
  const env: SwrEnv = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    isVisible: () => visible,
    onVisibilityChange: (fn) => {
      visibilityListeners.add(fn);
      return () => visibilityListeners.delete(fn);
    },
  };
  return {
    env,
    timers,
    /** Moves the clock, firing every timer that falls due on the way, in order. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
    setVisible(v: boolean) {
      visible = v;
      for (const fn of [...visibilityListeners]) fn();
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function counter<V>(answers: Array<SwrLoadResult<V>>) {
  let calls = 0;
  const pending: Array<() => void> = [];
  let hold = false;
  return {
    get calls() {
      return calls;
    },
    hold() {
      hold = true;
    },
    release() {
      hold = false;
      for (const fn of pending.splice(0)) fn();
    },
    load: () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls += 1;
      if (!hold) return Promise.resolve(answer);
      return new Promise<SwrLoadResult<V>>((resolve) => pending.push(() => resolve(answer)));
    },
  };
}

const STALE = 3 * 60_000;
const RETRY = 30_000;
const WARM = 30 * 60_000;

describe("swr resource", () => {
  it("asks once on first use and serves a remount inside the window from memory", async () => {
    const clock = fakeEnv();
    const src = counter([{ ok: true, value: ["a"] }]);
    const r = createSwrResource({ load: src.load, staleAfterMs: STALE, retryAfterMs: RETRY, keepWarmMs: WARM, env: clock.env });

    const release = r.retain();
    await settle();
    assert.equal(src.calls, 1);
    assert.deepEqual(r.getState().value, ["a"]);
    assert.equal(r.getState().settled, true);
    release();

    await clock.advance(60_000);
    const again = r.retain();
    await settle();
    assert.equal(src.calls, 1, "a remount a minute later asks for nothing");
    assert.deepEqual(r.getState().value, ["a"], "and has the list at once");
    again();
  });

  it("revalidates a stale value in the background and keeps showing it meanwhile", async () => {
    const clock = fakeEnv();
    const src = counter([
      { ok: true, value: ["old"] },
      { ok: true, value: ["new"] },
    ]);
    const r = createSwrResource({ load: src.load, staleAfterMs: STALE, retryAfterMs: RETRY, keepWarmMs: WARM, env: clock.env });
    r.retain()();
    await settle();

    // Hidden, so the keep-warm timer does not refresh it first.
    clock.setVisible(false);
    await clock.advance(STALE + 1);
    clock.setVisible(true);
    // Becoming visible inside the warm window catches up once.
    src.hold();
    await settle();
    assert.equal(src.calls, 2);
    assert.deepEqual(r.getState().value, ["old"], "the old list stays on screen while the request is out");
    assert.equal(r.getState().loading, true);
    src.release();
    await settle();
    assert.deepEqual(r.getState().value, ["new"]);
    assert.equal(r.getState().loading, false);
  });

  it("shares one request between callers", async () => {
    const clock = fakeEnv();
    const src = counter([{ ok: true, value: 1 }]);
    src.hold();
    const r = createSwrResource({ load: src.load, staleAfterMs: STALE, retryAfterMs: RETRY, keepWarmMs: WARM, env: clock.env });
    const a = r.retain();
    const b = r.retain();
    const p1 = r.revalidate();
    const p2 = r.revalidate();
    await settle();
    assert.equal(src.calls, 1);
    assert.equal(p1, p2);
    src.release();
    await p1;
    assert.equal(r.getState().value, 1);
    a();
    b();
  });

  it("keeps the last good value on a failure and backs off before asking again", async () => {
    const clock = fakeEnv();
    const src = counter<string[]>([
      { ok: true, value: ["kept"] },
      { ok: false, error: "engine down" },
      { ok: true, value: ["back"] },
    ]);
    const r = createSwrResource({ load: src.load, staleAfterMs: STALE, retryAfterMs: RETRY, keepWarmMs: WARM, env: clock.env });
    const release = r.retain();
    await settle();

    await clock.advance(STALE); // the timer refreshes, and fails
    assert.equal(src.calls, 2);
    assert.deepEqual(r.getState().value, ["kept"]);
    assert.equal(r.getState().error, "engine down");

    // Remounting right after the failure does not hammer the engine.
    release();
    const again = r.retain();
    await settle();
    assert.equal(src.calls, 2);

    await clock.advance(RETRY);
    assert.equal(src.calls, 3, "the back-off ran out and the timer asked again");
    assert.deepEqual(r.getState().value, ["back"]);
    assert.equal(r.getState().error, null);
    again();
  });

  it("refreshes on a timer while held, pauses while hidden, catches up when shown", async () => {
    const clock = fakeEnv();
    const src = counter([{ ok: true, value: 0 }]);
    const r = createSwrResource({ load: src.load, staleAfterMs: STALE, retryAfterMs: RETRY, keepWarmMs: WARM, env: clock.env });
    const release = r.retain();
    await settle();
    assert.equal(src.calls, 1);

    await clock.advance(STALE);
    assert.equal(src.calls, 2, "fresh again without anybody remounting");

    clock.setVisible(false);
    assert.equal(clock.timers.size, 0, "no timer while the window is hidden");
    await clock.advance(STALE * 5);
    assert.equal(src.calls, 2, "nothing asked while hidden");

    clock.setVisible(true);
    await settle();
    assert.equal(src.calls, 3, "one catch-up request when shown");
    release();
  });

  it("stays warm for a while after the card goes away, then stops", async () => {
    const clock = fakeEnv();
    const src = counter([{ ok: true, value: 0 }]);
    const r = createSwrResource({ load: src.load, staleAfterMs: STALE, retryAfterMs: RETRY, keepWarmMs: WARM, env: clock.env });
    r.retain()();
    await settle();
    assert.equal(src.calls, 1);

    // Ten refreshes fit in the warm window; then the timer goes quiet.
    await clock.advance(WARM);
    const warmCalls = src.calls;
    assert.ok(warmCalls >= 10 && warmCalls <= 11, `refreshed while warm (${warmCalls})`);
    await clock.advance(WARM * 3);
    assert.equal(src.calls, warmCalls, "nothing once dormant");
    assert.equal(clock.timers.size, 0);

    // Coming back after that wakes it and asks once, the value being stale.
    const release = r.retain();
    await settle();
    assert.equal(src.calls, warmCalls + 1);
    release();
  });

  it("shows the seed at once and asks only if the seed is stale", async () => {
    const clock = fakeEnv();
    const fresh = counter([{ ok: true, value: ["net"] }]);
    const r = createSwrResource({
      load: fresh.load,
      seed: async () => ({ value: ["disk"], fetchedAt: clock.env.now() - 60_000 }),
      staleAfterMs: STALE,
      retryAfterMs: RETRY,
      keepWarmMs: WARM,
      env: clock.env,
    });
    const release = r.retain();
    await settle();
    assert.deepEqual(r.getState().value, ["disk"]);
    assert.equal(fresh.calls, 0, "a one-minute-old copy is fresh enough");
    release();

    const old = counter([{ ok: true, value: ["net"] }]);
    old.hold();
    const r2 = createSwrResource({
      load: old.load,
      seed: async () => ({ value: ["disk"], fetchedAt: clock.env.now() - 60 * 60_000 }),
      staleAfterMs: STALE,
      retryAfterMs: RETRY,
      keepWarmMs: WARM,
      env: clock.env,
    });
    const release2 = r2.retain();
    await settle();
    assert.deepEqual(r2.getState().value, ["disk"], "the old copy shows while the request is out");
    assert.equal(old.calls, 1);
    old.release();
    await settle();
    assert.deepEqual(r2.getState().value, ["net"]);
    release2();
  });

  it("a failed first request with no seed settles with the error", async () => {
    const clock = fakeEnv();
    const r = createSwrResource<number>({
      load: async () => {
        throw new Error("boom");
      },
      seed: async () => null,
      staleAfterMs: STALE,
      retryAfterMs: RETRY,
      keepWarmMs: WARM,
      env: clock.env,
    });
    const release = r.retain();
    await settle();
    assert.equal(r.getState().value, null);
    assert.equal(r.getState().error, "boom");
    assert.equal(r.getState().settled, true);
    release();
  });
});
