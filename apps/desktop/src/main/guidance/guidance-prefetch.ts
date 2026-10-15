/**
 * Guidance pre-read: a held name's new earnings release read in the
 * background, so the morning handover's `peek` finds it on disk.
 *
 * Narrow on purpose, because every read is a model call:
 *
 *   - held names only, as the dashboard and the briefing last named them in
 *     this run; never the watchlist
 *   - a release is noticed from the EDGAR submissions index the other
 *     modules already read (`cachedFilings`, never a fetch of its own); only
 *     the newest 8-K item 2.02 filed in the last PREFETCH_LOOKBACK_DAYS
 *   - one read per accession; a failed read (the model down, one reading of
 *     two lost) is tried once more after RETRY_AFTER_MS, then given up
 *   - at most DAILY_READS reads a New York day
 *   - a company whose last NON_GUIDER_RELEASES releases guided nothing is
 *     left alone for NON_GUIDER_SKIP_MS
 *   - nothing while the model is not configured, and nothing while the app
 *     is closed (the timer lives in the main process)
 *
 * What it remembers sits in one small file beside the readings. Logs carry
 * counts only, never a ticker. Electron-free: everything is injected.
 */

import { readJson, writeJsonAtomic } from "../briefing/json-file";
import type { FilingRef } from "../agents/sources";
import type { GuidanceTrack } from "../../shared/guidance-types";
import { nyYmdOf } from "../../shared/earnings-time";
import { earningsReleases, type GuidanceService } from "./guidance-service";

/** A release is pre-read only while the handover can still show it. */
export const PREFETCH_LOOKBACK_DAYS = 3;
export const DAILY_READS = 10;
export const RETRY_AFTER_MS = 60 * 60_000;
/** A first read and one retry. */
export const MAX_ATTEMPTS = 2;
export const NON_GUIDER_RELEASES = 4;
export const NON_GUIDER_SKIP_MS = 90 * 24 * 60 * 60_000;
/** What is remembered of an accession is dropped after this long. */
const FORGET_AFTER_MS = 30 * 24 * 60 * 60_000;

type AccessionState = { attempts: number; lastAt: number; status: "done" | "failed" | "gave_up" };

export type PrefetchState = {
  accessions: Record<string, AccessionState>;
  /** Ticker to the instant its skip ends. */
  nonGuiders: Record<string, number>;
  day: { ymd: string; count: number };
};

export type PrefetchDeps = {
  guidance: Pick<GuidanceService, "track" | "peek">;
  /** The submissions index the EDGAR reader last kept for a company, or null; never fetches. */
  cachedFilings: (ticker: string) => FilingRef[] | null;
  /** The model is configured (a key is set). */
  configured: () => boolean;
  /** `<data root>/guidance/prefetch.json`. */
  file: string;
  now?: () => number;
};

export type GuidancePrefetch = {
  /** The reader's held names, as a module that was handed them last saw them. Replaces the list. */
  noteHeld(tickers: readonly string[]): void;
  /** One pass over the held names; resolves with the number of reads made. Never throws. */
  sweep(): Promise<number>;
};

function emptyState(): PrefetchState {
  return { accessions: {}, nonGuiders: {}, day: { ymd: "", count: 0 } };
}

function loadState(file: string): PrefetchState {
  const raw = readJson<Partial<PrefetchState>>(file);
  if (!raw || typeof raw !== "object") return emptyState();
  return {
    accessions: raw.accessions && typeof raw.accessions === "object" ? raw.accessions : {},
    nonGuiders: raw.nonGuiders && typeof raw.nonGuiders === "object" ? raw.nonGuiders : {},
    day: raw.day && typeof raw.day.ymd === "string" && typeof raw.day.count === "number" ? raw.day : { ymd: "", count: 0 },
  };
}

function ageDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** The track record holds this release: a reading of it was kept. */
function hasRelease(track: GuidanceTrack | null, release: FilingRef): boolean {
  return track !== null && track.latest !== null && track.latest >= release.filedAt;
}

/**
 * The company guided nothing in its last NON_GUIDER_RELEASES releases: all of
 * them read and kept, and no guide row dated by any of them.
 */
export function guidesNothing(track: GuidanceTrack | null, releases: readonly FilingRef[]): boolean {
  const last = releases.slice(0, NON_GUIDER_RELEASES);
  if (!track || last.length < NON_GUIDER_RELEASES || track.releases < NON_GUIDER_RELEASES) return false;
  if (!hasRelease(track, last[0]!)) return false;
  const dates = new Set(last.map((r) => r.filedAt));
  return !track.rows.some((row) => dates.has(row.guide.filedAt));
}

export function createGuidancePrefetch(deps: PrefetchDeps): GuidancePrefetch {
  const now = deps.now ?? Date.now;
  let held: string[] = [];
  let running: Promise<number> | null = null;

  function save(state: PrefetchState): void {
    const cutoff = now() - FORGET_AFTER_MS;
    for (const [accession, entry] of Object.entries(state.accessions)) if (entry.lastAt < cutoff) delete state.accessions[accession];
    for (const [ticker, until] of Object.entries(state.nonGuiders)) if (until <= now()) delete state.nonGuiders[ticker];
    try {
      writeJsonAtomic(deps.file, state);
    } catch (err) {
      console.warn(`[guidance] pre-read state not kept: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function pass(): Promise<number> {
    const names = [...held];
    if (names.length === 0) return 0;
    const state = loadState(deps.file);
    const today = nyYmdOf(now());
    if (state.day.ymd !== today) state.day = { ymd: today, count: 0 };
    let reads = 0;

    for (const ticker of names) {
      const skipUntil = state.nonGuiders[ticker];
      if (typeof skipUntil === "number" && skipUntil > now()) continue;
      const filings = deps.cachedFilings(ticker);
      if (!filings) continue;
      const releases = earningsReleases(filings);
      const newest = releases[0];
      if (!newest) continue;
      const age = ageDays(newest.filedAt, today);
      if (!(age >= 0 && age <= PREFETCH_LOOKBACK_DAYS)) continue;

      const entry = state.accessions[newest.accession];
      if (entry && (entry.status === "done" || entry.status === "gave_up")) continue;
      if (entry && entry.status === "failed" && now() - entry.lastAt < RETRY_AFTER_MS) continue;

      const before = deps.guidance.peek(ticker);
      if (hasRelease(before, newest)) {
        // A visit read it already.
        state.accessions[newest.accession] = { attempts: entry?.attempts ?? 0, lastAt: now(), status: "done" };
        if (guidesNothing(before, releases)) state.nonGuiders[ticker] = now() + NON_GUIDER_SKIP_MS;
        continue;
      }
      // The releases before this one, all read, guided nothing: this one is not worth a call.
      if (guidesNothing(before, releases.slice(1))) {
        state.nonGuiders[ticker] = now() + NON_GUIDER_SKIP_MS;
        continue;
      }
      if (state.day.count >= DAILY_READS) break;
      if (!deps.configured()) break;

      state.day.count += 1;
      reads += 1;
      const attempts = (entry?.attempts ?? 0) + 1;
      state.accessions[newest.accession] = { attempts, lastAt: now(), status: "failed" };
      save(state);
      try {
        await deps.guidance.track(ticker, { fresh: true });
      } catch {
        // Counted as a failed read below.
      }
      const after = deps.guidance.peek(ticker);
      if (hasRelease(after, newest)) {
        state.accessions[newest.accession] = { attempts, lastAt: now(), status: "done" };
        if (guidesNothing(after, releases)) state.nonGuiders[ticker] = now() + NON_GUIDER_SKIP_MS;
      } else {
        state.accessions[newest.accession] = { attempts, lastAt: now(), status: attempts >= MAX_ATTEMPTS ? "gave_up" : "failed" };
      }
      save(state);
    }
    save(state);
    if (reads > 0) console.info(`[guidance] pre-read ${reads} new earnings release${reads === 1 ? "" : "s"}`);
    return reads;
  }

  return {
    noteHeld(tickers) {
      held = [...new Set(tickers.map((t) => (typeof t === "string" ? t.trim().toUpperCase() : "")).filter((t) => t !== ""))];
    },
    sweep() {
      if (running) return running;
      running = pass()
        .catch((err) => {
          console.warn(`[guidance] pre-read pass failed: ${err instanceof Error ? err.message : String(err)}`);
          return 0;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
