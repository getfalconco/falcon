import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { earningsHistoryFromFilings } from "./engine.js";
import { computeEarningsRhythm } from "./quant.js";
import { DEFAULT_TRACKER_CONFIG } from "./config.js";
import type { DailyBar, FilingRecord, TickerState } from "./types.js";
import { emptyTickerState } from "./store.js";

/**
 * Earnings announcement dates come from 8-K item 2.02 filings, and the EDGAR
 * acceptance timestamp decides whether the reaction lands on the same session
 * or the next one. Fixtures below are real NVDA acceptance times.
 */

function filing(overrides: Partial<FilingRecord>): FilingRecord {
  return {
    form: "8-K",
    accessionNumber: "0001045810-26-000001",
    filedAt: "2026-05-20",
    acceptedAt: "2026-05-20T20:21:19.000Z",
    reportDate: "2026-05-20",
    items: ["2.02", "9.01"],
    primaryDocument: "doc.htm",
    ...overrides,
  };
}

describe("earningsHistoryFromFilings", () => {
  it("keeps only 8-Ks carrying item 2.02", () => {
    const result = earningsHistoryFromFilings(
      [
        filing({ filedAt: "2026-05-20" }),
        filing({ filedAt: "2026-06-01", items: ["5.02"] }), // officer change
        filing({ filedAt: "2026-06-10", form: "10-Q", items: [] }),
      ],
      4,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].date, "2026-05-20");
  });

  it("returns the last N announcements in chronological order", () => {
    const dates = ["2025-05-28", "2025-08-27", "2025-11-19", "2026-02-25", "2026-05-20"];
    const result = earningsHistoryFromFilings(
      dates.map((d) => filing({ filedAt: d, reportDate: d, acceptedAt: `${d}T20:21:19.000Z` })),
      4,
    );
    assert.deepEqual(
      result.map((r) => r.date),
      ["2025-08-27", "2025-11-19", "2026-02-25", "2026-05-20"],
    );
  });

  it("classifies acceptance time into bmo / dmh / amc", () => {
    // 2026-05-20 is EDT: open 13:30Z, close 20:00Z.
    const amc = earningsHistoryFromFilings([filing({ acceptedAt: "2026-05-20T20:21:19.000Z" })], 4);
    const bmo = earningsHistoryFromFilings([filing({ acceptedAt: "2026-05-20T11:00:00.000Z" })], 4);
    const dmh = earningsHistoryFromFilings([filing({ acceptedAt: "2026-05-20T15:00:00.000Z" })], 4);
    assert.equal(amc[0].hour, "amc");
    assert.equal(bmo[0].hour, "bmo");
    assert.equal(dmh[0].hour, "dmh");
  });

  it("classifies against the early close, not a fixed 16:00 ET", () => {
    // 2026-11-27 is an early close (13:00 ET = 18:00Z).
    const result = earningsHistoryFromFilings(
      [filing({ filedAt: "2026-11-27", acceptedAt: "2026-11-27T18:30:00.000Z" })],
      4,
    );
    assert.equal(result[0].hour, "amc");
  });
});

describe("computeEarningsRhythm reaction session", () => {
  function stateWithBars(bars: DailyBar[], hours: Array<string | null>): TickerState {
    const state = emptyTickerState("TEST", "2026-08-17T00:00:00.000Z");
    state.bars = bars;
    state.earnings = hours.map((hour, i) => ({
      date: ["2026-08-10", "2026-08-12"][i],
      fiscalPeriod: "Q1",
      hour,
    }));
    return state;
  }

  const bar = (d: string, c: number): DailyBar => ({ d, o: c, h: c, l: c, c, v: 1000 });

  it("an amc release is measured on the NEXT session's move", () => {
    const bars = [
      bar("2026-08-07", 100),
      bar("2026-08-10", 101), // announcement day (after close)
      bar("2026-08-11", 111), // +9.90% reaction
      bar("2026-08-12", 112),
      bar("2026-08-13", 118), // +5.36% reaction
    ];
    const state = stateWithBars(bars, ["amc", "amc"]);
    const rhythm = computeEarningsRhythm(state, DEFAULT_TRACKER_CONFIG);
    assert.ok(rhythm != null);
    const expected = (Math.abs(111 / 101 - 1) + Math.abs(118 / 112 - 1)) / 2;
    assert.ok(Math.abs(rhythm - expected) < 1e-12, `${rhythm} vs ${expected}`);
  });

  it("a bmo release is measured on the same session's move", () => {
    const bars = [
      bar("2026-08-07", 100),
      bar("2026-08-10", 110), // +10% on the announcement day itself
      bar("2026-08-11", 111),
      bar("2026-08-12", 120), // +8.11%
    ];
    const state = stateWithBars(bars, ["bmo", "bmo"]);
    const rhythm = computeEarningsRhythm(state, DEFAULT_TRACKER_CONFIG);
    const expected = (Math.abs(110 / 100 - 1) + Math.abs(120 / 111 - 1)) / 2;
    assert.ok(rhythm != null && Math.abs(rhythm - expected) < 1e-12);
  });

  it("returns null with fewer than 2 usable observations (§3.11)", () => {
    const state = stateWithBars([bar("2026-08-10", 100), bar("2026-08-11", 105)], ["amc"]);
    state.earnings = state.earnings.slice(0, 1);
    assert.equal(computeEarningsRhythm(state, DEFAULT_TRACKER_CONFIG), null);
  });
});
