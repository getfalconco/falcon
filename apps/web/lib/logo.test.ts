// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/logo.test.ts
// Logos: colour first through our own route, mono as the fallback, and how a decoded logo looks (background, very dark, very light).
import assert from "node:assert/strict";
import { test } from "node:test";
import { logoLook, logoSources, logoUrl } from "./logo";

/** A w×h RGBA image filled by `at(x, y)`. */
function image(w: number, h: number, at: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(at(x, y), (y * w + x) * 4);
  return out;
}
const inner = (x: number, y: number) => x > 5 && x < 18 && y > 5 && y < 18;

test("our own URLs only, the style always named; options use the underlying, crypto its coin", () => {
  assert.equal(logoUrl({ kind: "stock", ticker: "AAPL", symbol: "AAPL" }), "/api/logo/AAPL?style=color");
  assert.equal(logoUrl({ kind: "etf", ticker: "SPY", symbol: "SPY" }, "mono"), "/api/logo/SPY?style=mono");
  assert.equal(logoUrl({ kind: "option", ticker: "NVDA", symbol: "NVDA261218C00150000" }), "/api/logo/NVDA?style=color");
  assert.equal(logoUrl({ kind: "crypto", ticker: null, symbol: "BTC-USD" }), "/api/logo/BTC?kind=crypto&style=color");
  assert.equal(logoUrl({ kind: "future", ticker: null, symbol: "ESZ6" }), null);
});

test("sources: colour from FMP (stocks, ETFs) and spothq (coins), mono from NVSTly; a class share also tried with a dash", () => {
  assert.deepEqual(logoSources("BRK.B", false), ["https://financialmodelingprep.com/image-stock/BRK.B.png", "https://financialmodelingprep.com/image-stock/BRK-B.png"]);
  assert.deepEqual(logoSources("AAPL", false, "mono"), ["https://raw.githubusercontent.com/nvstly/icons/main/ticker_icons/AAPL.png"]);
  assert.deepEqual(logoSources("BTC", true), ["https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/btc.png", "https://financialmodelingprep.com/image-stock/BTCUSD.png"]);
  assert.deepEqual(logoSources("BTC", true, "mono"), ["https://raw.githubusercontent.com/nvstly/icons/main/crypto_icons/BTC.png"]);
});

test("a free-standing mark has no background; a logo on its own box does; four different coloured corners (Microsoft) do not", () => {
  const mark = logoLook(image(24, 24, (x, y) => (inner(x, y) ? [24, 119, 242, 255] : [0, 0, 0, 0])), 24, 24);
  assert.deepEqual(mark, { background: false, dark: false, light: false });
  const boxed = logoLook(image(24, 24, (x, y) => (inner(x, y) ? [255, 255, 255, 255] : [40, 50, 140, 255])), 24, 24);
  assert.equal(boxed.background, true);
  const quads = logoLook(image(24, 24, (x, y) => (x < 12 ? (y < 12 ? [242, 80, 34, 255] : [0, 164, 239, 255]) : y < 12 ? [127, 186, 0, 255] : [255, 185, 0, 255])), 24, 24);
  assert.equal(quads.background, false);
});

test("very dark and very light marks are flagged, so each theme can keep them visible", () => {
  assert.equal(logoLook(image(24, 24, (x, y) => (inner(x, y) ? [10, 10, 10, 255] : [0, 0, 0, 0])), 24, 24).dark, true);
  assert.equal(logoLook(image(24, 24, (x, y) => (inner(x, y) ? [250, 250, 250, 255] : [0, 0, 0, 0])), 24, 24).light, true);
  const empty = logoLook(image(24, 24, () => [0, 0, 0, 0]), 24, 24);
  assert.deepEqual(empty, { background: false, dark: false, light: false });
});
