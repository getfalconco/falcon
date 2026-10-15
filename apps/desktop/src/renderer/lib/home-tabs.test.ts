import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOME_TAB_ORDER_KEY, readHomeTabOrder, writeHomeTabOrder } from "./home-tabs";

function memory(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("home tabs", () => {
  it("starts from the default order when nothing is saved", () => {
    assert.deepEqual(readHomeTabOrder(memory()), ["dashboard", "calendar", "agents", "earnings"]);
    assert.deepEqual(readHomeTabOrder(null), ["dashboard", "calendar", "agents", "earnings"]);
  });

  it("adds a tab a later build introduced at the end of a saved order", () => {
    const store = memory();
    writeHomeTabOrder(store, ["agents", "calendar", "dashboard"]);
    assert.deepEqual(readHomeTabOrder(store), ["agents", "calendar", "dashboard", "earnings"]);
  });

  it("keeps a dragged order across a launch", () => {
    const store = memory();
    writeHomeTabOrder(store, ["agents", "earnings", "calendar", "dashboard"]);
    assert.deepEqual(readHomeTabOrder(store), ["agents", "earnings", "calendar", "dashboard"]);
  });

  it("drops unknown ids and repeats, and appends tabs the saved order lacks", () => {
    const store = memory({ [HOME_TAB_ORDER_KEY]: JSON.stringify(["calendar", "gone", "calendar", 4]) });
    assert.deepEqual(readHomeTabOrder(store), ["calendar", "dashboard", "agents", "earnings"]);
  });

  it("survives junk and a store that throws", () => {
    assert.deepEqual(readHomeTabOrder(memory({ [HOME_TAB_ORDER_KEY]: "{not json" })), ["dashboard", "calendar", "agents", "earnings"]);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readHomeTabOrder(broken), ["dashboard", "calendar", "agents", "earnings"]);
    assert.doesNotThrow(() => writeHomeTabOrder(broken, ["calendar", "dashboard"]));
  });
});
