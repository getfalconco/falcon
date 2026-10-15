import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { GuidancePeekResult, GuidanceRow, GuidanceTrack } from "../../../shared/guidance-types";
import { guidanceStart, peekGuidanceTrack, peekStoredGuidance, resetGuidanceCache } from "./use-guidance";

const ROW = { metric: "revenue", basis: "unspecified", state: "resolved" } as unknown as GuidanceRow;
const TRACK: GuidanceTrack = { ticker: "NVDA", releases: 8, latest: "2026-08-26", rows: [ROW], patterns: [] };
const EMPTY: GuidanceTrack = { ticker: "KO", releases: 8, latest: "2026-07-22", rows: [], patterns: [] };

const globals = globalThis as unknown as { window?: unknown };

/** A bridge whose peek answers from `disk` and whose full read fails the test. */
function install(disk: Record<string, GuidancePeekResult | Error>, opts: { noPeek?: boolean } = {}) {
  const peeks: string[] = [];
  let reads = 0;
  const bridge: Record<string, unknown> = {
    getStockTabGuidance: async () => {
      reads++;
      throw new Error("the calendar path must never start a full read");
    },
  };
  if (!opts.noPeek) {
    bridge.getStockTabGuidancePeek = async (ticker: string) => {
      peeks.push(ticker);
      const hit = disk[ticker] ?? { ok: true, track: null };
      if (hit instanceof Error) throw hit;
      return hit;
    };
  }
  globals.window = { meridian: bridge };
  return { peeks, reads: () => reads };
}

describe("use-guidance: disk peek", () => {
  beforeEach(() => resetGuidanceCache());
  afterEach(() => {
    resetGuidanceCache();
    delete globals.window;
  });

  it("seeds the cache from main's disk peek so the Stock tab and Earnings drawer start from it", async () => {
    const bridge = install({ NVDA: { ok: true, track: TRACK } });
    assert.equal(peekGuidanceTrack("NVDA"), null);
    assert.deepEqual(guidanceStart("NVDA"), { state: { status: "loading" }, read: true });

    assert.deepEqual(await peekStoredGuidance(" nvda "), TRACK);
    assert.deepEqual(bridge.peeks, ["NVDA"]);
    assert.equal(bridge.reads(), 0);
    assert.deepEqual(peekGuidanceTrack("nvda"), TRACK);
    // Shown at once, but a view that may read still asks for the full answer.
    assert.deepEqual(guidanceStart("NVDA"), { state: { status: "ready", track: TRACK }, read: true });
  });

  it("asks main only while memory holds nothing, and once for concurrent asks", async () => {
    const bridge = install({ NVDA: { ok: true, track: TRACK } });
    const [a, b] = await Promise.all([peekStoredGuidance("NVDA"), peekStoredGuidance("NVDA")]);
    assert.deepEqual(a, TRACK);
    assert.deepEqual(b, TRACK);
    assert.equal(await peekStoredGuidance("NVDA"), TRACK);
    assert.deepEqual(bridge.peeks, ["NVDA"]);
    assert.equal(bridge.reads(), 0);
  });

  it("keeps no miss and no failure: the next open asks again", async () => {
    const bridge = install({ AAPL: { ok: false, error: "unavailable" }, MSFT: new Error("ipc down") });
    assert.equal(await peekStoredGuidance("TSLA"), null);
    assert.equal(await peekStoredGuidance("AAPL"), null);
    assert.equal(await peekStoredGuidance("MSFT"), null);
    assert.equal(await peekStoredGuidance("TSLA"), null);
    assert.deepEqual(bridge.peeks, ["TSLA", "AAPL", "MSFT", "TSLA"]);
    assert.equal(peekGuidanceTrack("TSLA"), null);
    assert.equal(bridge.reads(), 0);
  });

  it("keeps a track with no figures but shows nothing for it", async () => {
    const bridge = install({ KO: { ok: true, track: EMPTY } });
    assert.equal(await peekStoredGuidance("KO"), null);
    assert.equal(peekGuidanceTrack("KO"), null);
    assert.equal(await peekStoredGuidance("KO"), null);
    assert.deepEqual(bridge.peeks, ["KO"]);
    assert.deepEqual(guidanceStart("KO"), { state: { status: "loading" }, read: true });
  });

  it("answers null on an older main process without the channel", async () => {
    const bridge = install({}, { noPeek: true });
    assert.equal(await peekStoredGuidance("NVDA"), null);
    assert.equal(peekGuidanceTrack("NVDA"), null);
    assert.equal(bridge.reads(), 0);
  });
});
