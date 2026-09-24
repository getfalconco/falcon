import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INDEX_FAMILY_FUNDS, INDEX_FAMILY_LABEL, heldFundsTracking, indexFamilyOf } from "./index-map.js";
import type { IndexFamily } from "./types.js";

const FAMILIES: IndexFamily[] = ["sp", "nasdaq100", "russell", "msci"];

describe("INDEX_FAMILY_FUNDS", () => {
  it("covers every family, with upper-case symbols and no blanks", () => {
    assert.deepEqual(Object.keys(INDEX_FAMILY_FUNDS).sort(), [...FAMILIES].sort());
    for (const family of FAMILIES) {
      assert.ok(INDEX_FAMILY_FUNDS[family].length > 0, family);
      for (const symbol of INDEX_FAMILY_FUNDS[family]) {
        assert.match(symbol, /^[A-Z]+$/, symbol);
      }
    }
  });

  it("lists no symbol twice, within a family or across two", () => {
    const owner = new Map<string, IndexFamily>();
    for (const family of FAMILIES) {
      for (const symbol of INDEX_FAMILY_FUNDS[family]) {
        assert.equal(owner.get(symbol), undefined, `${symbol} is listed under ${owner.get(symbol)} and ${family}`);
        owner.set(symbol, family);
      }
    }
  });

  it("holds the initial map", () => {
    assert.equal(INDEX_FAMILY_FUNDS.sp.length, 30);
    assert.deepEqual([...INDEX_FAMILY_FUNDS.nasdaq100], ["QQQ", "QQQM", "TQQQ", "SQQQ"]);
    assert.deepEqual([...INDEX_FAMILY_FUNDS.russell], ["IWM", "IWB", "IWV", "TNA", "TZA"]);
    assert.equal(INDEX_FAMILY_FUNDS.msci.length, 12);
  });
});

describe("INDEX_FAMILY_LABEL", () => {
  it("names each family for the reader", () => {
    assert.deepEqual(INDEX_FAMILY_LABEL, {
      sp: "S&P 500 family",
      nasdaq100: "Nasdaq-100",
      russell: "Russell",
      msci: "MSCI",
    });
  });
});

describe("indexFamilyOf", () => {
  it("resolves every listed symbol to its own family", () => {
    for (const family of FAMILIES) {
      for (const symbol of INDEX_FAMILY_FUNDS[family]) assert.equal(indexFamilyOf(symbol), family, symbol);
    }
  });

  it("spot checks: sector SPDRs, mid caps and leveraged wrappers follow their index provider", () => {
    assert.equal(indexFamilyOf("SPY"), "sp");
    assert.equal(indexFamilyOf("XLRE"), "sp");
    assert.equal(indexFamilyOf("MDY"), "sp");
    // The same provider's mid, small and total-market indices reconstitute
    // into that same third-Friday close, so they belong to the same schedule.
    assert.equal(indexFamilyOf("IJH"), "sp");
    assert.equal(indexFamilyOf("IJR"), "sp");
    assert.equal(indexFamilyOf("ITOT"), "sp");
    assert.equal(indexFamilyOf("SPYG"), "sp");
    assert.equal(indexFamilyOf("SPXU"), "sp");
    assert.equal(indexFamilyOf("TQQQ"), "nasdaq100");
    assert.equal(indexFamilyOf("TZA"), "russell");
    assert.equal(indexFamilyOf("MCHI"), "msci");
  });

  it("ignores case and surrounding whitespace", () => {
    assert.equal(indexFamilyOf("spy"), "sp");
    assert.equal(indexFamilyOf("Qqq"), "nasdaq100");
    assert.equal(indexFamilyOf("  iwm "), "russell");
  });

  it("returns null for the funds that track CRSP, Dow Jones or FTSE indices", () => {
    for (const symbol of ["VTI", "SCHD", "VWO", "VEA", "VXUS", "VT", "vti"]) {
      assert.equal(indexFamilyOf(symbol), null, symbol);
    }
  });

  it("returns null for single stocks, blanks and non-strings", () => {
    assert.equal(indexFamilyOf("AAPL"), null);
    assert.equal(indexFamilyOf(""), null);
    assert.equal(indexFamilyOf("   "), null);
    assert.equal(indexFamilyOf(undefined as unknown as string), null);
    assert.equal(indexFamilyOf(42 as unknown as string), null);
  });
});

describe("heldFundsTracking", () => {
  it("returns the held funds of one family: upper-cased, de-duplicated, in input order", () => {
    const held = ["voo", "AAPL", "QQQ", "SPY", "Voo", " spy ", "XLK", "IWM", "VTI"];
    assert.deepEqual(heldFundsTracking("sp", held), ["VOO", "SPY", "XLK"]);
    assert.deepEqual(heldFundsTracking("nasdaq100", held), ["QQQ"]);
    assert.deepEqual(heldFundsTracking("russell", held), ["IWM"]);
    assert.deepEqual(heldFundsTracking("msci", held), []);
  });

  it("is empty for an empty or stock-only book, and survives malformed entries", () => {
    assert.deepEqual(heldFundsTracking("sp", []), []);
    assert.deepEqual(heldFundsTracking("sp", ["AAPL", "MSFT"]), []);
    assert.deepEqual(heldFundsTracking("sp", [null, "", "spy"] as unknown as string[]), ["SPY"]);
    assert.deepEqual(heldFundsTracking("sp", undefined as unknown as string[]), []);
  });

  it("does not mutate its input", () => {
    const held = ["spy", "spy"];
    heldFundsTracking("sp", held);
    assert.deepEqual(held, ["spy", "spy"]);
  });
});
