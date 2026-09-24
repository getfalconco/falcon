import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MARKET_SYMBOLS, leadMarketRows, marketRow, marketRows } from "./markets.js";
import type { MarketSymbolDef } from "./markets.js";
import type { MarketSnapshot } from "./types.js";

// Friday 2026-09-18, 16:00 ET: the close the Monday 2026-09-21 report hands over from.
const SINCE = "2026-09-18T20:00:00.000Z";

function def(symbol: string): MarketSymbolDef {
  const found = MARKET_SYMBOLS.find((d) => d.symbol === symbol);
  assert.ok(found, `no definition for ${symbol}`);
  return found;
}

function snap(symbol: string, over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol,
    price: 100,
    previous_close: 100,
    market_time: "2026-09-21T06:00:00.000Z",
    in_regular_session: false,
    ...over,
  };
}

describe("briefing/markets: the symbol table", () => {
  it("lists the seventeen symbols once each, grouped in display order", () => {
    assert.equal(MARKET_SYMBOLS.length, 17);
    assert.equal(new Set(MARKET_SYMBOLS.map((d) => d.symbol)).size, 17);
    assert.deepEqual(
      MARKET_SYMBOLS.map((d) => d.group).filter((g, i, all) => i === 0 || all[i - 1] !== g),
      ["asia", "europe", "us_futures", "macro"],
    );
  });

  it("measures futures and the commodity contracts from a settlement", () => {
    const settled = MARKET_SYMBOLS.filter((d) => d.basis === "prior_settle").map((d) => d.symbol);
    assert.deepEqual(settled, ["ES=F", "NQ=F", "YM=F", "RTY=F", "CL=F", "GC=F"]);
  });

  it("quotes VIX in points, the 10-year in basis points and the rest in percent", () => {
    assert.equal(def("^VIX").unit, "pts");
    assert.equal(def("^TNX").unit, "bp");
    const others = MARKET_SYMBOLS.filter((d) => d.symbol !== "^VIX" && d.symbol !== "^TNX");
    assert.ok(others.every((d) => d.unit === "pct"));
  });

  it("keeps the labels free of long dashes", () => {
    const longDash = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const d of MARKET_SYMBOLS) assert.ok(!longDash.test(d.label), d.label);
  });
});

describe("briefing/markets: marketRow", () => {
  it("withholds the move when the last print predates the US close (Japanese holiday, 2026-09-21)", () => {
    // Respect for the Aged Day: Tokyo never opened, so the provider still
    // returns Friday's close with Friday's +1.2% attached.
    const row = marketRow(
      def("^N225"),
      snap("^N225", { price: 45500, previous_close: 44960, market_time: "2026-09-18T06:15:00.000Z" }),
      SINCE,
    );
    assert.equal(row.state, "stale");
    assert.equal(row.move, null);
    assert.equal(row.last, 45500);
    assert.equal(row.prev_close, 44960);
    assert.equal(row.as_of, "2026-09-18T06:15:00.000Z");
  });

  it("treats a missing or unreadable print time as stale", () => {
    const missing = marketRow(def("^HSI"), snap("^HSI", { market_time: null }), SINCE);
    assert.equal(missing.state, "stale");
    assert.equal(missing.move, null);
    assert.equal(missing.as_of, null);
    assert.equal(missing.last, 100);

    const garbage = marketRow(def("^HSI"), snap("^HSI", { market_time: "not a date" }), SINCE);
    assert.equal(garbage.state, "stale");
    assert.equal(garbage.as_of, null);
  });

  it("compares instants, so ISO strings with and without milliseconds agree", () => {
    const atClose = marketRow(def("^VIX"), snap("^VIX", { market_time: "2026-09-18T20:00:00Z" }), SINCE);
    assert.equal(atClose.state, "final");
    const justAfter = marketRow(def("^VIX"), snap("^VIX", { market_time: "2026-09-18T20:00:00.500Z" }), "2026-09-18T20:00:00Z");
    assert.equal(justAfter.state, "final");
    const justBefore = marketRow(def("^VIX"), snap("^VIX", { market_time: "2026-09-18T19:59:59Z" }), SINCE);
    assert.equal(justBefore.state, "stale");
  });

  it("is live while the symbol's own session trades and final once it has closed", () => {
    const live = marketRow(
      def("^STOXX50E"),
      snap("^STOXX50E", { price: 5050, previous_close: 5000, market_time: "2026-09-21T09:30:00.000Z", in_regular_session: true }),
      SINCE,
    );
    assert.equal(live.state, "live");
    assert.equal(live.move, 1);

    const final = marketRow(
      def("^HSI"),
      snap("^HSI", { price: 24750, previous_close: 25000, market_time: "2026-09-21T08:00:00.000Z" }),
      SINCE,
    );
    assert.equal(final.state, "final");
    assert.equal(final.move, -1);
    assert.equal(final.as_of, "2026-09-21T08:00:00.000Z");
  });

  it("keeps the state but drops the move when the previous close is missing, zero or negative", () => {
    for (const previous_close of [null, 0, -12, Number.NaN]) {
      const row = marketRow(def("ES=F"), snap("ES=F", { price: 6700, previous_close, in_regular_session: true }), SINCE);
      assert.equal(row.state, "live");
      assert.equal(row.move, null);
      assert.equal(row.prev_close, null);
      assert.equal(row.last, 6700);
    }
  });

  it("expresses VIX in points", () => {
    const row = marketRow(def("^VIX"), snap("^VIX", { price: 16.37, previous_close: 15.1 }), SINCE);
    assert.equal(row.unit, "pts");
    assert.equal(row.move, 1.27);
  });

  it("expresses the 10-year in basis points of a percent quote", () => {
    const up = marketRow(def("^TNX"), snap("^TNX", { price: 4.31, previous_close: 4.25 }), SINCE);
    assert.equal(up.unit, "bp");
    assert.equal(up.move, 6);
    const down = marketRow(def("^TNX"), snap("^TNX", { price: 4.187, previous_close: 4.25 }), SINCE);
    assert.equal(down.move, -6.3);
  });

  it("rounds percent moves to two decimals and never reports a negative zero", () => {
    const row = marketRow(def("NQ=F"), snap("NQ=F", { price: 24123.25, previous_close: 24000 }), SINCE);
    assert.equal(row.move, 0.51);
    const flat = marketRow(def("NQ=F"), snap("NQ=F", { price: 23999.99, previous_close: 24000 }), SINCE);
    assert.ok(Object.is(flat.move, 0));
  });

  it("is unavailable when there is no snapshot or no price", () => {
    const none = marketRow(def("GC=F"), null, SINCE);
    assert.deepEqual(none, {
      symbol: "GC=F",
      label: "Gold",
      group: "macro",
      unit: "pct",
      basis: "prior_settle",
      last: null,
      prev_close: null,
      move: null,
      state: "unavailable",
      as_of: null,
    });
    const noPrice = marketRow(def("GC=F"), snap("GC=F", { price: null }), SINCE);
    assert.equal(noPrice.state, "unavailable");
    assert.equal(noPrice.move, null);
    assert.equal(noPrice.as_of, null);
    const nanPrice = marketRow(def("GC=F"), snap("GC=F", { price: Number.NaN }), SINCE);
    assert.equal(nanPrice.state, "unavailable");
  });
});

describe("briefing/markets: marketRows", () => {
  it("returns one row per symbol in table order, whatever order the map was filled in", () => {
    const snapshots = new Map<string, MarketSnapshot | null>();
    for (const d of [...MARKET_SYMBOLS].reverse()) snapshots.set(d.symbol, snap(d.symbol));
    snapshots.set("CL=F", null);
    snapshots.delete("^FCHI");
    snapshots.set("NOT-IN-TABLE", snap("NOT-IN-TABLE"));

    const rows = marketRows(snapshots, SINCE);
    assert.deepEqual(rows.map((r) => r.symbol), MARKET_SYMBOLS.map((d) => d.symbol));
    assert.deepEqual(rows.map((r) => r.label), MARKET_SYMBOLS.map((d) => d.label));
    assert.equal(rows.find((r) => r.symbol === "CL=F")?.state, "unavailable");
    assert.equal(rows.find((r) => r.symbol === "^FCHI")?.state, "unavailable");
    assert.equal(rows.find((r) => r.symbol === "^GDAXI")?.state, "final");
  });
});

describe("briefing/markets: leadMarketRows", () => {
  it("keeps only the five lead symbols, futures first", () => {
    const snapshots = new Map<string, MarketSnapshot | null>();
    for (const d of MARKET_SYMBOLS) snapshots.set(d.symbol, snap(d.symbol, { price: 101 }));
    const lead = leadMarketRows(marketRows(snapshots, SINCE));
    assert.deepEqual(lead.map((r) => r.symbol), ["ES=F", "NQ=F", "^N225", "^STOXX50E", "^VIX"]);
  });

  it("drops stale and unavailable rows, and rows with no move to quote", () => {
    const snapshots = new Map<string, MarketSnapshot | null>();
    snapshots.set("ES=F", snap("ES=F", { price: 6710, previous_close: 6700, in_regular_session: true }));
    snapshots.set("NQ=F", snap("NQ=F", { previous_close: null }));
    snapshots.set("^N225", snap("^N225", { market_time: "2026-09-18T06:15:00.000Z" }));
    snapshots.set("^STOXX50E", null);
    snapshots.set("^VIX", snap("^VIX", { price: 15.6, previous_close: 15.1 }));

    const lead = leadMarketRows(marketRows(snapshots, SINCE));
    assert.deepEqual(lead.map((r) => r.symbol), ["ES=F", "^VIX"]);
    assert.ok(lead.every((r) => r.move !== null));
  });

  it("returns nothing for an empty table", () => {
    assert.deepEqual(leadMarketRows([]), []);
  });
});
