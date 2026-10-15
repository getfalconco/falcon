import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenForStockOpens, showStock } from "./stock-tab-nav";
import { STOCK_OPEN_EVENT } from "./stock-open";
import { createStockTabStore } from "./stock-tab-store";
import { createHomeTabStore } from "./home-tab-store";
import type { HomeTabId } from "./home-tabs";

describe("stock tab navigation", () => {
  it("an openStock() anywhere shows that stock in the Stock tab", () => {
    const target = new EventTarget();
    const stocks = createStockTabStore();
    const tabs = createHomeTabStore("calendar");
    const stop = listenForStockOpens(target, stocks, (id) => tabs.open(id));
    target.dispatchEvent(new CustomEvent(STOCK_OPEN_EVENT, { detail: { ticker: "AAPL", companyName: "Apple Inc." } }));
    assert.equal(tabs.get().tab, "stock");
    assert.deepEqual(tabs.get().mounted, ["calendar", "stock"]);
    assert.deepEqual(stocks.get().current, { symbol: "AAPL", companyName: "Apple Inc." });

    target.dispatchEvent(new CustomEvent(STOCK_OPEN_EVENT, { detail: { ticker: "nvda" } }));
    assert.equal(stocks.get().current?.symbol, "NVDA");
    assert.deepEqual(
      stocks.get().recent.map((r) => r.symbol),
      ["NVDA", "AAPL"],
    );

    stop();
    target.dispatchEvent(new CustomEvent(STOCK_OPEN_EVENT, { detail: { ticker: "MSFT" } }));
    assert.equal(stocks.get().current?.symbol, "NVDA");
  });

  it("ignores a request with no usable ticker and leaves the tab where it was", () => {
    const target = new EventTarget();
    const stocks = createStockTabStore();
    const opened: HomeTabId[] = [];
    listenForStockOpens(target, stocks, (id) => opened.push(id));
    target.dispatchEvent(new CustomEvent(STOCK_OPEN_EVENT, { detail: { ticker: "" } }));
    target.dispatchEvent(new CustomEvent(STOCK_OPEN_EVENT, { detail: null }));
    target.dispatchEvent(new CustomEvent(STOCK_OPEN_EVENT, { detail: { ticker: "not a ticker" } }));
    assert.deepEqual(opened, []);
    assert.equal(stocks.get().current, null);
  });

  it("a search pick goes through the same door, name and exchange kept", () => {
    const stocks = createStockTabStore();
    const opened: HomeTabId[] = [];
    assert.equal(showStock(stocks, (id) => opened.push(id), { symbol: "TSM", companyName: "Taiwan Semiconductor", exchange: "NYSE" }), true);
    assert.deepEqual(opened, ["stock"]);
    assert.deepEqual(stocks.get().current, { symbol: "TSM", companyName: "Taiwan Semiconductor", exchange: "NYSE" });
  });

  it("a stock opened from a dialog in another tab unmounts that tab, so the dialog goes with it", () => {
    const tabs = createHomeTabStore("dashboard");
    tabs.open("calendar");
    tabs.open("stock", "calendar");
    assert.equal(tabs.get().tab, "stock");
    assert.deepEqual(tabs.get().mounted, ["dashboard", "stock"]);
  });
});
