import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ONBOARDING_TICKER_CAP,
  addTickers,
  catalogMatch,
  normalizeTicker,
  parseTickerInput,
} from "./onboarding-tickers";

describe("parseTickerInput", () => {
  it("splits on commas, semicolons and spaces, upper-cases, and drops a leading $", () => {
    assert.deepEqual(parseTickerInput("nvda, tsm  $aapl;msft"), { tickers: ["NVDA", "TSM", "AAPL", "MSFT"], rejected: [] });
  });

  it("keeps the first of a repeat, in the order typed", () => {
    assert.deepEqual(parseTickerInput("TSM nvda tsm").tickers, ["TSM", "NVDA"]);
  });

  it("takes class shares written with a dot or a dash", () => {
    assert.deepEqual(parseTickerInput("brk.b BRK-A").tickers, ["BRK.B", "BRK-A"]);
  });

  it("sets aside what is not shaped like a ticker", () => {
    assert.deepEqual(parseTickerInput("NVDA nvidia123 TOOLONG ^GSPC"), {
      tickers: ["NVDA"],
      rejected: ["nvidia123", "TOOLONG", "^GSPC"],
    });
    assert.deepEqual(parseTickerInput("  , ;  "), { tickers: [], rejected: [] });
  });

  it("normalizes one piece or says it is not a ticker", () => {
    assert.equal(normalizeTicker(" $pltr "), "PLTR");
    assert.equal(normalizeTicker("12AB"), null);
  });
});

describe("catalogMatch", () => {
  const results = [
    { symbol: "NVDA", companyName: "NVIDIA" },
    { symbol: "NVDS", companyName: "Some fund" },
    { symbol: "BRK.B", companyName: "Berkshire Hathaway" },
    { symbol: "^GSPC", companyName: "S&P 500" },
  ];

  it("counts only the exact symbol, not a substring hit", () => {
    assert.equal(catalogMatch("NVDA", results)?.companyName, "NVIDIA");
    assert.equal(catalogMatch("NVD", results), null);
  });

  it("reads a dash as the directory's dot", () => {
    assert.equal(catalogMatch("BRK-B", results)?.symbol, "BRK.B");
  });

  it("never matches an index", () => {
    assert.equal(catalogMatch("^GSPC", results), null);
  });
});

describe("addTickers", () => {
  it("adds in order, skips what is there already, and stops at the cap", () => {
    assert.deepEqual(addTickers(["NVDA"], ["TSM", "NVDA", "BRK.B"]), ["NVDA", "TSM", "BRK.B"]);
    assert.deepEqual(addTickers(["BRK.B"], ["BRK-B"]), ["BRK.B"]);
    const many = Array.from({ length: ONBOARDING_TICKER_CAP + 3 }, (_, i) => `T${String.fromCharCode(65 + i)}`);
    assert.equal(addTickers([], many).length, ONBOARDING_TICKER_CAP);
  });
});
