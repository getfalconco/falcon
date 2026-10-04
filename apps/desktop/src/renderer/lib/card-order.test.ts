import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CARD_KINDS_KEY, CARD_ORDER_KEY, readCardOrder, writeCardOrder } from "./card-order";

const DEFAULTS = ["portfolio", "assets", "calendar", "news", "insight", "risk"] as const;

function memory(initial: Record<string, unknown> = {}) {
  const data = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    read: (k: string) => JSON.parse(data.get(k) ?? "null"),
  };
}

describe("card order", () => {
  it("starts from the defaults when nothing is saved", () => {
    assert.deepEqual(readCardOrder(memory(), DEFAULTS), [...DEFAULTS]);
  });

  it("keeps a deleted card deleted across a launch", () => {
    const store = memory();
    writeCardOrder(store, ["portfolio", "assets", "calendar", "insight", "risk"], DEFAULTS);
    assert.deepEqual(readCardOrder(store, DEFAULTS), ["portfolio", "assets", "calendar", "insight", "risk"]);
  });

  it("reads an arrangement saved before offered kinds were kept as offered everything", () => {
    // The old build wrote the full set back on every launch, so a card missing
    // from its saved order was deleted by the reader since the last launch.
    const store = memory({ [CARD_ORDER_KEY]: ["portfolio", "assets", "news", "risk"] });
    assert.deepEqual(readCardOrder(store, DEFAULTS), ["portfolio", "assets", "news", "risk"]);
  });

  it("offers a kind a later build introduced, once", () => {
    const store = memory({ [CARD_ORDER_KEY]: ["assets", "risk"], [CARD_KINDS_KEY]: ["assets", "risk", "insight"] });
    assert.deepEqual(readCardOrder(store, DEFAULTS), ["portfolio", "assets", "risk", "calendar", "news"]);
    // Offered now: deleting one of them afterwards sticks.
    writeCardOrder(store, ["portfolio", "assets", "risk", "news"], DEFAULTS);
    assert.deepEqual(readCardOrder(store, DEFAULTS), ["portfolio", "assets", "risk", "news"]);
  });

  it("does not bring the original back while a copy of it stays", () => {
    const store = memory();
    writeCardOrder(store, ["portfolio", "calendar#1790416738019", "news"], DEFAULTS);
    assert.deepEqual(readCardOrder(store, DEFAULTS), ["portfolio", "calendar#1790416738019", "news"]);
  });

  it("drops unknown ids and repeats, and lets every card go", () => {
    const store = memory({ [CARD_ORDER_KEY]: ["news", "news", "handover", 7, "briefing#12", "assets"] });
    assert.deepEqual(readCardOrder(store, DEFAULTS), ["news", "assets"]);
    writeCardOrder(store, [], DEFAULTS);
    assert.deepEqual(readCardOrder(store, DEFAULTS), []);
  });

  it("records every kind it knows as offered when it saves", () => {
    const store = memory({ [CARD_KINDS_KEY]: ["briefing"] });
    writeCardOrder(store, ["assets"], DEFAULTS);
    assert.deepEqual(store.read(CARD_KINDS_KEY), ["briefing", ...DEFAULTS]);
  });
});
