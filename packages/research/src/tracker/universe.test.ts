import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { mergeTrackerConfig } from "./config.js";
import { discoverCachedTickers } from "./universe.js";

let root = "";

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-universe-"));
  const candles = path.join(root, "backtest", "candles");
  const edgar = path.join(root, "backtest", "edgar");
  const cache = path.join(root, "cache");
  for (const dir of [candles, edgar, cache]) fs.mkdirSync(dir, { recursive: true });

  for (const t of ["NVDA", "MSFT", "SPY", "BRK.B"]) {
    fs.writeFileSync(path.join(candles, `${t}.json`), "[]");
  }
  for (const t of ["NVDA", "LLY", "XOM"]) {
    fs.writeFileSync(path.join(edgar, `${t}.json`), "[]");
  }
  fs.writeFileSync(path.join(cache, "AVGO.0001730168-25-000121.txt"), "");
  fs.writeFileSync(path.join(cache, "AVGO.0001730168-25-000121.candidates.json"), "{}");
  fs.writeFileSync(path.join(cache, "INTC.0000050863-26-000010.txt"), "");
  // A ticker only the tracker itself still holds state for.
  const trackerState = path.join(root, "tracker", "state");
  fs.mkdirSync(trackerState, { recursive: true });
  fs.writeFileSync(path.join(trackerState, "ZLAB.json"), "{}");
  // Noise that must not be read as a ticker.
  fs.writeFileSync(path.join(candles, "notes.txt"), "");
  fs.writeFileSync(path.join(cache, "toolongsymbol.0001-2.txt"), "");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("discoverCachedTickers", () => {
  it("unions every cache and excludes the benchmark", () => {
    const result = discoverCachedTickers(root);
    assert.deepEqual(result.tickers, ["AVGO", "BRK.B", "INTC", "LLY", "MSFT", "NVDA", "XOM", "ZLAB"]);
    assert.ok(!result.tickers.includes("SPY"));
  });

  it("deduplicates a ticker present in several caches", () => {
    const result = discoverCachedTickers(root);
    assert.equal(result.tickers.filter((t) => t === "NVDA").length, 1);
  });

  it("reports per-source counts", () => {
    const result = discoverCachedTickers(root);
    assert.equal(result.sources.candles, 4); // includes SPY before exclusion
    assert.equal(result.sources.edgar, 3);
    assert.equal(result.sources.step1, 2); // AVGO counted once across its two files
    assert.equal(result.sources.tracked, 1);
  });

  it("ignores non-ticker filenames", () => {
    const result = discoverCachedTickers(root);
    assert.ok(!result.tickers.includes("NOTES"));
    assert.ok(!result.tickers.some((t) => t.length > 5 && !t.includes(".")));
  });

  it("honours a custom exclude list", () => {
    const result = discoverCachedTickers(root, { exclude: ["NVDA", "MSFT"] });
    assert.ok(!result.tickers.includes("NVDA"));
    assert.ok(!result.tickers.includes("MSFT"));
    assert.ok(result.tickers.includes("SPY")); // no longer excluded
  });

  it("keeps a ticker that only the tracker's own state still knows (once tracked, stays tracked)", () => {
    // Other caches were cleared, but the tracker state file remains → still in the universe.
    const result = discoverCachedTickers(root);
    assert.ok(result.tickers.includes("ZLAB"));
  });

  it("returns an empty list when nothing is cached", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-empty-"));
    try {
      assert.deepEqual(discoverCachedTickers(empty).tickers, []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("price tier config", () => {
  it("defaults to empty and survives a config written before it existed", () => {
    // The tracker has shipped a config.json for months with no such key; a
    // merge that left `undefined` here would crash the news gate on startup.
    assert.deepEqual(mergeTrackerConfig(null).priceTierTickers, []);
    assert.deepEqual(mergeTrackerConfig({ tickers: ["NVDA"] }).priceTierTickers, []);
    assert.deepEqual(
      mergeTrackerConfig({ priceTierTickers: ["TXN", "IBM"] }).priceTierTickers,
      ["TXN", "IBM"],
    );
  });

  it("copies the array rather than aliasing the caller's", () => {
    const stored = { priceTierTickers: ["TXN"] };
    const merged = mergeTrackerConfig(stored);
    merged.priceTierTickers.push("IBM");
    assert.deepEqual(stored.priceTierTickers, ["TXN"]);
  });
});
