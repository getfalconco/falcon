import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPositionHoverStore } from "./position-hover";

/** Hand-cranked timers: `run()` fires whatever is pending, as the delay elapsing would. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number);
    },
    run: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    count: () => pending.size,
  };
}

describe("position hover store", () => {
  it("enter publishes the ticker at once, upper case", () => {
    const store = createPositionHoverStore(fakeTimers());
    let calls = 0;
    store.subscribe(() => calls++);
    store.enter("nvda");
    assert.equal(store.get(), "NVDA");
    assert.equal(calls, 1);
  });

  it("leave clears only after the delay", () => {
    const timers = fakeTimers();
    const store = createPositionHoverStore(timers);
    store.enter("NVDA");
    store.leave("NVDA");
    assert.equal(store.get(), "NVDA", "still shown while the delay runs");
    timers.run();
    assert.equal(store.get(), null);
  });

  it("moving to the next row inside the delay never flashes the portfolio", () => {
    const timers = fakeTimers();
    const store = createPositionHoverStore(timers);
    const seen: Array<string | null> = [];
    store.subscribe(() => seen.push(store.get()));
    store.enter("NVDA");
    store.leave("NVDA");
    store.enter("JPM");
    timers.run();
    assert.equal(store.get(), "JPM");
    assert.deepEqual(seen, ["NVDA", "JPM"]);
    assert.equal(timers.count(), 0);
  });

  it("a late leave from the old row does not clear the new one", () => {
    const timers = fakeTimers();
    const store = createPositionHoverStore(timers);
    store.enter("NVDA");
    store.enter("JPM");
    store.leave("NVDA");
    timers.run();
    assert.equal(store.get(), "JPM");
  });

  it("re-entering the same row cancels its pending clear, without a second notification", () => {
    const timers = fakeTimers();
    const store = createPositionHoverStore(timers);
    let calls = 0;
    store.subscribe(() => calls++);
    store.enter("NVDA");
    store.leave("NVDA");
    store.enter("NVDA");
    timers.run();
    assert.equal(store.get(), "NVDA");
    assert.equal(calls, 1);
  });

  it("reset clears at once; unsubscribe stops notifications", () => {
    const store = createPositionHoverStore(fakeTimers());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.enter("NVDA");
    store.reset();
    assert.equal(store.get(), null);
    assert.equal(calls, 2);
    off();
    store.enter("JPM");
    assert.equal(calls, 2);
  });

  it("ignores a blank ticker", () => {
    const store = createPositionHoverStore(fakeTimers());
    store.enter("  ");
    assert.equal(store.get(), null);
  });
});
