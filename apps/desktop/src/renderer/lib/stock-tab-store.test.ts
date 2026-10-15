import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECENT_STOCKS_MAX, createStockTabStore, normalizeOpenStock } from "./stock-tab-store";

describe("stock tab store", () => {
  it("starts with nothing open and the seeded recent picks", () => {
    const store = createStockTabStore([
      { symbol: "aapl", companyName: "Apple Inc." },
      { symbol: "AAPL", companyName: "dupe" },
      { symbol: "../x", companyName: "junk" },
      { symbol: "msft", companyName: "Microsoft" },
    ]);
    assert.equal(store.get().current, null);
    assert.deepEqual(
      store.get().recent.map((r) => r.symbol),
      ["AAPL", "MSFT"],
    );
  });

  it("opens a stock, moves it to the head of the recent list, and tells listeners", () => {
    const store = createStockTabStore();
    let told = 0;
    store.subscribe(() => told++);
    store.open({ symbol: "nvda", companyName: "NVIDIA" });
    store.open({ symbol: "AMD" });
    store.open({ symbol: "NVDA" });
    assert.equal(told, 3);
    assert.deepEqual(store.get().current, { symbol: "NVDA", companyName: "NVIDIA" });
    assert.deepEqual(
      store.get().recent.map((r) => r.symbol),
      ["NVDA", "AMD"],
    );
    assert.equal(store.get().recent[1]!.companyName, "AMD");
  });

  it("keeps a name a search gave a ticker when a ticker click opens it again", () => {
    const store = createStockTabStore([{ symbol: "TSM", companyName: "Taiwan Semiconductor", exchange: "NYSE" }]);
    assert.deepEqual(store.open({ symbol: "tsm" }), { symbol: "TSM", companyName: "Taiwan Semiconductor", exchange: "NYSE" });
  });

  it("does not tell anyone when the same stock is opened again", () => {
    const store = createStockTabStore();
    store.open({ symbol: "NVDA", companyName: "NVIDIA" });
    let told = 0;
    store.subscribe(() => told++);
    store.open({ symbol: "NVDA", companyName: "NVIDIA" });
    assert.equal(told, 0);
  });

  it("keeps the last five and refuses a symbol that is not one", () => {
    const store = createStockTabStore();
    for (const s of ["A", "B", "C", "D", "E", "F", "G"]) store.open({ symbol: s });
    assert.deepEqual(
      store.get().recent.map((r) => r.symbol),
      ["G", "F", "E", "D", "C"],
    );
    assert.equal(store.get().recent.length, RECENT_STOCKS_MAX);
    assert.equal(store.open({ symbol: "" }), null);
    assert.equal(store.open({ symbol: "a b" }), null);
    assert.equal(store.get().current?.symbol, "G");
  });

  it("normalizes an entry", () => {
    assert.deepEqual(normalizeOpenStock({ symbol: " brk.b ", companyName: "  ", exchange: " NYSE " }), {
      symbol: "BRK.B",
      companyName: "BRK.B",
      exchange: "NYSE",
    });
    assert.equal(normalizeOpenStock(null), null);
  });
});
