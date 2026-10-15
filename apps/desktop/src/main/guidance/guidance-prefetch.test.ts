import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { FilingRef } from "../agents/sources";
import type { GuidanceRow, GuidanceTrack } from "../../shared/guidance-types";
import { DAILY_READS, NON_GUIDER_SKIP_MS, RETRY_AFTER_MS, createGuidancePrefetch, guidesNothing } from "./guidance-prefetch";

/** Thursday 2026-10-15, 08:00 New York. */
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function release(accession: string, filedAt: string): FilingRef {
  return { cik: "0000000001", form: "8-K", accession, filedAt, acceptedAt: null, items: ["2.02", "9.01"], primaryDocument: "doc.htm", url: "u" };
}

/** A company's quarterly releases, newest first: the newest on `newest`, then every 91 days back. */
function history(ticker: string, newest: string, count = 5): FilingRef[] {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.parse(`${newest}T12:00:00Z`) - i * 91 * DAY).toISOString().slice(0, 10);
    return release(`${ticker}-${day}`, day);
  });
}

function guideRow(filedAt: string): GuidanceRow {
  return { guide: { quote: "q", url: "https://www.sec.gov/x", filedAt } } as unknown as GuidanceRow;
}

function track(ticker: string, releases: readonly FilingRef[], guides: boolean): GuidanceTrack {
  return {
    ticker,
    releases: releases.length,
    latest: releases[0]?.filedAt ?? null,
    rows: guides ? releases.map((r) => guideRow(r.filedAt)) : [],
    patterns: [],
  };
}

type World = {
  filings: Map<string, FilingRef[]>;
  /** What is on disk per ticker: the releases read so far. */
  disk: Map<string, FilingRef[]>;
  /** Tickers that guide. */
  guiders: Set<string>;
  /** The model fails while true. */
  modelDown: boolean;
  configured: boolean;
  clock: number;
  calls: Array<{ ticker: string; fresh: boolean }>;
};

function setup(over: Partial<World> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-prefetch-"));
  const world: World = {
    filings: new Map(),
    disk: new Map(),
    guiders: new Set(),
    modelDown: false,
    configured: true,
    clock: NOW,
    calls: [],
    ...over,
  };
  const make = () =>
    createGuidancePrefetch({
      guidance: {
        track: async (ticker, options) => {
          world.calls.push({ ticker, fresh: options?.fresh === true });
          if (world.modelDown) return { ok: false, error: "unavailable" };
          const all = world.filings.get(ticker) ?? [];
          world.disk.set(ticker, all.slice(0, 8));
          return { ok: true, track: track(ticker, all, world.guiders.has(ticker)) };
        },
        peek: (ticker) => {
          const read = world.disk.get(ticker);
          return read && read.length > 0 ? track(ticker, read, world.guiders.has(ticker)) : null;
        },
      },
      cachedFilings: (ticker) => world.filings.get(ticker) ?? null,
      configured: () => world.configured,
      file: path.join(dir, "prefetch.json"),
      now: () => world.clock,
    });
  return { world, prefetch: make(), make };
}

describe("guidance pre-read", () => {
  it("reads a held name's new release once, fresh, and remembers it across restarts", async () => {
    const { world, prefetch, make } = setup();
    world.filings.set("NVDA", history("NVDA", "2026-10-14"));
    world.guiders.add("NVDA");
    prefetch.noteHeld(["nvda", "NVDA"]);
    assert.equal(await prefetch.sweep(), 1);
    assert.equal(await prefetch.sweep(), 0);
    assert.deepEqual(world.calls, [{ ticker: "NVDA", fresh: true }]);

    const again = make();
    again.noteHeld(["NVDA"]);
    world.clock += 2 * HOUR;
    assert.equal(await again.sweep(), 0);
    assert.equal(world.calls.length, 1);
  });

  it("reads only the names last noted as held: the watchlist is never handed in, and a new list replaces the old", async () => {
    const { world, prefetch } = setup();
    world.filings.set("NVDA", history("NVDA", "2026-10-14"));
    world.filings.set("AMD", history("AMD", "2026-10-14"));
    prefetch.noteHeld(["NVDA"]);
    await prefetch.sweep();
    assert.deepEqual(world.calls.map((c) => c.ticker), ["NVDA"]);
    prefetch.noteHeld([]);
    world.filings.set("NVDA", history("NVDA", "2026-10-15"));
    assert.equal(await prefetch.sweep(), 0);
  });

  it("leaves alone a release older than the handover shows, one a visit already read, and a name with no index in memory", async () => {
    const { world, prefetch } = setup();
    world.filings.set("OLD", history("OLD", "2026-10-09"));
    world.filings.set("SEEN", history("SEEN", "2026-10-14"));
    world.disk.set("SEEN", history("SEEN", "2026-10-14"));
    world.guiders.add("SEEN");
    prefetch.noteHeld(["OLD", "SEEN", "NONE"]);
    assert.equal(await prefetch.sweep(), 0);
    assert.deepEqual(world.calls, []);
  });

  it(`stops at ${DAILY_READS} reads a New York day and goes on the next`, async () => {
    const { world, prefetch } = setup();
    const names = Array.from({ length: DAILY_READS + 2 }, (_, i) => `T${i}`);
    for (const t of names) {
      world.filings.set(t, history(t, "2026-10-14"));
      world.guiders.add(t);
    }
    prefetch.noteHeld(names);
    assert.equal(await prefetch.sweep(), DAILY_READS);
    world.clock += 2 * HOUR;
    assert.equal(await prefetch.sweep(), 0, "the cap holds for the rest of the day");
    world.clock = NOW + DAY;
    assert.equal(await prefetch.sweep(), 2);
    assert.equal(new Set(world.calls.map((c) => c.ticker)).size, names.length);
  });

  it("skips a company whose last four releases guided nothing, for 90 days", async () => {
    const { world, prefetch } = setup();
    const past = history("NOG", "2026-10-14", 6);
    world.filings.set("NOG", past);
    world.disk.set("NOG", past.slice(1));
    prefetch.noteHeld(["NOG"]);
    assert.equal(await prefetch.sweep(), 0);
    assert.deepEqual(world.calls, []);

    // A release after it, still inside the skip: not read.
    world.clock = NOW + 30 * DAY;
    world.filings.set("NOG", history("NOG", "2026-11-14", 6));
    assert.equal(await prefetch.sweep(), 0);

    // Past the skip, a new release is looked at again.
    world.clock = NOW + NON_GUIDER_SKIP_MS + DAY;
    const later = new Date(world.clock).toISOString().slice(0, 10);
    world.filings.set("NOG", history("NOG", later, 6));
    world.guiders.add("NOG");
    world.disk.set("NOG", []);
    assert.equal(await prefetch.sweep(), 1);
  });

  it("marks a company that turns out not to guide after a read, and does not read it again", async () => {
    const { world, prefetch } = setup();
    world.filings.set("NOG", history("NOG", "2026-10-14", 6));
    prefetch.noteHeld(["NOG"]);
    assert.equal(await prefetch.sweep(), 1);
    world.clock += DAY;
    world.filings.set("NOG", history("NOG", "2026-10-15", 6));
    assert.equal(await prefetch.sweep(), 0);
    assert.equal(world.calls.length, 1);
  });

  it("tries a failed read once more after an hour, then gives that release up", async () => {
    const { world, prefetch } = setup({ modelDown: true });
    world.filings.set("NVDA", history("NVDA", "2026-10-14"));
    world.guiders.add("NVDA");
    prefetch.noteHeld(["NVDA"]);
    assert.equal(await prefetch.sweep(), 1);
    world.clock += RETRY_AFTER_MS / 2;
    assert.equal(await prefetch.sweep(), 0, "not before the hour");
    world.clock += RETRY_AFTER_MS;
    assert.equal(await prefetch.sweep(), 1);
    world.clock += 5 * RETRY_AFTER_MS;
    world.modelDown = false;
    assert.equal(await prefetch.sweep(), 0, "given up");
    assert.equal(world.calls.length, 2);
  });

  it("asks nothing while the model is not configured, and spends no attempt on it", async () => {
    const { world, prefetch } = setup({ configured: false });
    world.filings.set("NVDA", history("NVDA", "2026-10-14"));
    world.guiders.add("NVDA");
    prefetch.noteHeld(["NVDA"]);
    assert.equal(await prefetch.sweep(), 0);
    world.configured = true;
    assert.equal(await prefetch.sweep(), 1);
  });

  it("runs one pass at a time", async () => {
    const { world, prefetch } = setup();
    world.filings.set("NVDA", history("NVDA", "2026-10-14"));
    prefetch.noteHeld(["NVDA"]);
    const [a, b] = await Promise.all([prefetch.sweep(), prefetch.sweep()]);
    assert.equal(a + b, 2, "the same pass answers both");
    assert.equal(world.calls.length, 1);
  });
});

describe("guidesNothing", () => {
  it("needs the last four releases read and none of them dated on a guide row", () => {
    const four = history("X", "2026-10-14", 4);
    assert.equal(guidesNothing(track("X", four, false), four), true);
    assert.equal(guidesNothing(track("X", four, true), four), false);
    assert.equal(guidesNothing(track("X", four.slice(0, 3), false), four), false, "fewer than four read");
    assert.equal(guidesNothing(track("X", four.slice(1), false), four), false, "the newest not read");
    assert.equal(guidesNothing(null, four), false);
  });
});
