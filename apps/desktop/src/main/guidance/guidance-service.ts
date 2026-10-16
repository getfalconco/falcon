/**
 * Guidance track record: a company's last earnings releases, read once each.
 *
 *   1. the releases: 8-Ks with item 2.02 (results of operations) from the
 *      EDGAR submissions index, newest first, amendments left out, two
 *      within SAME_REPORT_DAYS taken as one report (the newer kept)
 *   2. per release, its press release exhibit (EX-99.1, else the first
 *      EX-99.x), found by type on the filing's index page: exhibit file names
 *      follow no rule ("q2fy27pr.htm")
 *   3. the exhibit read twice by the model, each reading checked and the two
 *      merged (guidance-extract.ts, shared/guidance-verify.ts), kept on disk
 *      by accession: a filed release
 *      never changes, so each is read once. A failed read is not kept, but
 *      remembered in memory for FAILED_READ_MEMORY_MS, so a Stock tab or an
 *      Earnings drawer opened again meanwhile costs no model call. A release
 *      the model answered for UNREADABLE_AFTER visits running with nothing
 *      usable (not JSON, not the shape asked for) is set aside on disk for
 *      UNREADABLE_FOR_MS; a failed call (the route down, a timeout) never
 *      counts toward that. `fresh` (the pre-read) looks past both
 *   4. a kept release that holds no result for a figure an earlier release
 *      guided is read once more and the readings merged (a single pass can
 *      skip a table line); marked on disk, so never more than once. A failed
 *      call is remembered in memory the same way and asked again after that
 *   5. the comparison (shared/guidance-track.ts)
 *
 * Beside the readings, one small index per company (`tickers/<TICKER>.json`)
 * lists the accessions its last visit found, so `peek` can rebuild the track
 * record from disk alone: no EDGAR read, no model call. The morning handover
 * reads it that way (main/briefing/research-facts.ts).
 *
 * Every SEC request goes through the agents engine's EDGAR reader (its
 * User-Agent, its spacing, its submissions cache). Electron-free: the
 * readers, the model caller, the folder and the clock are injected.
 */

import path from "node:path";
import type { GlossModelCaller } from "@meridian/research/gloss";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { htmlToText, type FilingRef } from "../agents/sources";
import type { GuidanceRelease, GuidanceTrack, GuidanceTrackResult } from "../../shared/guidance-types";
import { mergeReadings, verifyExtraction } from "../../shared/guidance-verify";
import { buildTrack, unreadResults } from "../../shared/guidance-track";
import { extractRelease, GUIDANCE_EXTRACT_VERSION, guidanceModel, UnusableReading } from "./guidance-extract";
import { exhibitFromIndex } from "../edgar/exhibit-index";

export { exhibitFromIndex };

/** Releases read per company: seven quarters of guide against result, and the open guide. */
export const RELEASES = 8;
/** Two item 2.02 filings closer than this are one report (a preliminary release, a re-filed exhibit). */
const SAME_REPORT_DAYS = 20;
/** A finished answer is kept this long per company; one with a release still unread, shorter. */
const TRACK_TTL_MS = 6 * 60 * 60_000;
const PARTIAL_TTL_MS = 5 * 60_000;
/** Model calls in flight at once for one company. */
const PARALLEL = 3;
/** A release whose reading failed (or came back as one reading of two) is not read again for this long. */
export const FAILED_READ_MEMORY_MS = 30 * 60_000;
/** Visits whose readings all came back unusable before the release is set aside on disk ... */
export const UNREADABLE_AFTER = 2;
/** ... for this long. */
export const UNREADABLE_FOR_MS = 7 * 24 * 60 * 60_000;

/** `rechecked`: read once more because a guided figure's result was missing from it (see `compute`). */
type Stored = { version: string; model: string; release: GuidanceRelease; rechecked?: boolean };
/**
 * A release the model answered for without a usable reading, in place of its
 * reading. `until` is set once `failures` reaches UNREADABLE_AFTER. Read under
 * the same extraction version and model only: a new prompt or model tries again.
 */
type Unreadable = { version: string; model: string; unreadable: { failures: number; lastAt: number; until?: number } };
/** Which releases a company's last visit found, newest first. */
type TickerIndex = { ticker: string; at: string; accessions: string[] };

export type GuidanceDeps = {
  /** The submissions index, any form, newest first (agents/edgar `filingHistory`). */
  filings: (ticker: string) => Promise<FilingRef[]>;
  /** One file of a filing's folder, raw; null when it cannot be read (agents/edgar `filingFile`). */
  file: (filing: FilingRef, name: string | null) => Promise<string | null>;
  caller: GlossModelCaller;
  configured: () => boolean;
  /** `<data root>/guidance`. */
  dir: string;
  model?: string;
  now?: () => number;
};

export type GuidanceService = {
  /**
   * `fresh` skips the answer kept in memory, so a release filed since the last
   * visit is read (the pre-read), and reads a release again whatever its last
   * failure was: the one in memory and the setting aside on disk.
   */
  track(ticker: string, options?: { fresh?: boolean }): Promise<GuidanceTrackResult>;
  /**
   * The track record from what is already on disk: the releases the last
   * visit listed for this company and read in full. Never reads EDGAR, never
   * calls the model, never writes; null when nothing for it is kept.
   */
  peek(ticker: string): GuidanceTrack | null;
};

function dayMs(ymd: string): number {
  return Date.parse(`${ymd}T12:00:00Z`);
}

/** The company's last RELEASES earnings releases, newest first. */
export function earningsReleases(filings: readonly FilingRef[], limit = RELEASES): FilingRef[] {
  const out: FilingRef[] = [];
  const sorted = filings
    .filter((f) => f.form === "8-K" && f.items.includes("2.02") && /^\d{4}-\d{2}-\d{2}$/.test(f.filedAt))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(dayMs(last.filedAt) - dayMs(f.filedAt)) / 86_400_000 < SAME_REPORT_DAYS) continue;
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

function archiveBase(filing: FilingRef): string {
  return `https://www.sec.gov/Archives/edgar/data/${filing.cik.replace(/^0+/, "")}/${filing.accession.replace(/-/g, "")}`;
}

/** Run `work` over `items`, at most `limit` at a time, results in order. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  });
  await Promise.all(lanes);
  return out;
}

export function createGuidanceService(deps: GuidanceDeps): GuidanceService {
  const now = deps.now ?? Date.now;
  const answers = new Map<string, { at: number; ttl: number; result: GuidanceTrackResult }>();
  const inflight = new Map<string, Promise<GuidanceTrackResult>>();
  /** Accession to its last failed read: when, and the one reading of two that came back, if any. */
  const failedReads = new Map<string, { at: number; release: GuidanceRelease | null }>();
  /** Accession to when its last read once more failed. */
  const failedRechecks = new Map<string, number>();
  const model = () => deps.model ?? guidanceModel();

  /** Keep a failure in `map`, dropping the ones older than FAILED_READ_MEMORY_MS. */
  function remember<V>(map: Map<string, V>, accession: string, value: V, at: (v: V) => number): void {
    for (const [key, v] of map) if (now() - at(v) >= FAILED_READ_MEMORY_MS) map.delete(key);
    map.set(accession, value);
  }

  const fileFor = (accession: string) => path.join(deps.dir, `${accession.replace(/[^0-9A-Za-z-]/g, "")}.json`);
  const indexFor = (ticker: string) => path.join(deps.dir, "tickers", `${ticker.toUpperCase().replace(/[^0-9A-Z.-]/g, "")}.json`);

  /** What is kept on disk for a release under the current extraction version, or null. */
  function storedEntry(accession: string): Stored | null {
    const stored = readJson<Stored>(fileFor(accession));
    return stored && stored.version === GUIDANCE_EXTRACT_VERSION && stored.release ? stored : null;
  }

  /** What is kept of a release the model gave nothing usable for, under the current version and model, or null. */
  function unreadableEntry(accession: string): Unreadable["unreadable"] | null {
    const kept = readJson<Unreadable>(fileFor(accession));
    if (!kept || kept.version !== GUIDANCE_EXTRACT_VERSION || kept.model !== model()) return null;
    const u = kept.unreadable;
    return u && typeof u.failures === "number" && typeof u.lastAt === "number" ? u : null;
  }

  /** The release is set aside: read unusable UNREADABLE_AFTER visits running, not long ago. */
  function setAside(accession: string): boolean {
    const until = unreadableEntry(accession)?.until;
    return typeof until === "number" && until > now();
  }

  /** One more visit the model answered for with nothing usable; the release is set aside at UNREADABLE_AFTER. */
  function noteUnusable(ticker: string, accession: string): void {
    const prior = unreadableEntry(accession);
    // A setting aside that ran out starts the count again.
    const before = prior && !(typeof prior.until === "number" && prior.until <= now()) ? prior.failures : 0;
    const failures = before + 1;
    const unreadable: Unreadable["unreadable"] = { failures, lastAt: now() };
    if (failures >= UNREADABLE_AFTER) unreadable.until = now() + UNREADABLE_FOR_MS;
    try {
      writeJsonAtomic(fileFor(accession), { version: GUIDANCE_EXTRACT_VERSION, model: model(), unreadable } satisfies Unreadable);
      if (unreadable.until) console.warn(`[guidance] ${ticker} ${accession} set aside: no usable reading ${failures} visits running`);
    } catch (err) {
      console.warn(`[guidance] ${ticker} ${accession} failure not kept: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A reading kept on disk under the current extraction version, or null. */
  function storedRelease(accession: string): GuidanceRelease | null {
    return storedEntry(accession)?.release ?? null;
  }

  /** The release's press release text and address; null when it cannot be read this time. */
  async function exhibitText(filing: FilingRef): Promise<{ text: string; url: string } | null> {
    const index = await deps.file(filing, `${filing.accession}-index.htm`);
    if (index === null) return null;
    const name = exhibitFromIndex(index);
    if (!name) return null;
    const html = await deps.file(filing, name);
    if (html === null) return null;
    return { text: htmlToText(html), url: `${archiveBase(filing)}/${name}` };
  }

  /**
   * One more reading of a kept release whose reading holds no result for a
   * figure an earlier release guided (MU's fiscal fourth quarter of 2026: both
   * readings passed over the EPS the release prints in its table). Merged
   * into what is kept and marked, so a release is read this way at most once;
   * a failed call marks nothing and is asked again on a visit after
   * FAILED_READ_MEMORY_MS (or a `fresh` one).
   */
  async function recheck(ticker: string, filing: FilingRef, stored: Stored, fresh: boolean): Promise<GuidanceRelease | null> {
    const failedAt = failedRechecks.get(filing.accession);
    if (!fresh && failedAt !== undefined && now() - failedAt < FAILED_READ_MEMORY_MS) return null;
    const exhibit = await exhibitText(filing);
    if (!exhibit) return null;
    const meta = { accession: filing.accession, filedAt: filing.filedAt, url: exhibit.url };
    try {
      const again = verifyExtraction(await extractRelease(deps.caller, { ticker, filedAt: filing.filedAt, text: exhibit.text, model: model() }), exhibit.text, meta);
      const merged = mergeReadings(stored.release, again);
      writeJsonAtomic(fileFor(filing.accession), { ...stored, release: merged, rechecked: true } satisfies Stored);
      failedRechecks.delete(filing.accession);
      return merged;
    } catch (err) {
      remember(failedRechecks, filing.accession, now(), (at) => at);
      console.warn(`[guidance] ${ticker} ${filing.accession} not read again: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * One release, from disk or read now; null when it could not be read this
   * time. A read that failed lately is not tried again unless `fresh`: what
   * it gave (one reading of two, or nothing) stands in.
   */
  async function release(ticker: string, filing: FilingRef, fresh: boolean): Promise<GuidanceRelease | null> {
    const file = fileFor(filing.accession);
    const stored = storedRelease(filing.accession);
    if (stored) return stored;
    if (!fresh) {
      const failed = failedReads.get(filing.accession);
      if (failed && now() - failed.at < FAILED_READ_MEMORY_MS) return failed.release;
      if (setAside(filing.accession)) return null;
    }

    const index = await deps.file(filing, `${filing.accession}-index.htm`);
    if (index === null) return null;
    const name = exhibitFromIndex(index);
    const base = archiveBase(filing);
    if (!name) {
      // An item 2.02 8-K without a press release exhibit: nothing to read, and it never gains one.
      const empty: GuidanceRelease = { accession: filing.accession, filedAt: filing.filedAt, url: `${base}/`, reported: null, guides: [], actuals: [] };
      writeJsonAtomic(file, { version: GUIDANCE_EXTRACT_VERSION, model: "", release: empty } satisfies Stored);
      return empty;
    }
    if (!deps.configured()) return null;
    const html = await deps.file(filing, name);
    if (html === null) return null;
    const text = htmlToText(html);
    const url = `${base}/${name}`;
    try {
      const meta = { accession: filing.accession, filedAt: filing.filedAt, url };
      const read = async () => verifyExtraction(await extractRelease(deps.caller, { ticker, filedAt: filing.filedAt, text, model: model() }), text, meta);
      // A reading is kept for good and a single pass can pass over a line, so
      // the release is read twice and the checked figures of both are kept.
      const [first, second] = await Promise.allSettled([read(), read()]);
      if (first.status === "rejected" && second.status === "rejected") {
        remember(failedReads, filing.accession, { at: now(), release: null }, (v) => v.at);
        // Both answered and neither was usable: the release, not the route. A failed call never counts.
        if (first.reason instanceof UnusableReading && second.reason instanceof UnusableReading) noteUnusable(ticker, filing.accession);
        throw first.reason;
      }
      const checked =
        first.status === "fulfilled" && second.status === "fulfilled"
          ? mergeReadings(first.value, second.value)
          : first.status === "fulfilled"
            ? first.value
            : (second as PromiseFulfilledResult<GuidanceRelease>).value;
      // Kept only when both readings came back; with one, it serves this visit and is read again on the next.
      if (first.status === "fulfilled" && second.status === "fulfilled") {
        writeJsonAtomic(file, { version: GUIDANCE_EXTRACT_VERSION, model: model(), release: checked } satisfies Stored);
        failedReads.delete(filing.accession);
      } else {
        remember(failedReads, filing.accession, { at: now(), release: checked }, (v) => v.at);
      }
      return checked;
    } catch (err) {
      console.warn(`[guidance] ${ticker} ${filing.accession} not read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async function compute(ticker: string, fresh: boolean): Promise<{ result: GuidanceTrackResult; complete: boolean }> {
    let filings: FilingRef[];
    try {
      filings = earningsReleases(await deps.filings(ticker));
    } catch (err) {
      console.warn(`[guidance] ${ticker} filings not read: ${err instanceof Error ? err.message : String(err)}`);
      return { result: { ok: false, error: "unavailable" }, complete: false };
    }
    try {
      writeJsonAtomic(indexFor(ticker), { ticker, at: new Date(now()).toISOString(), accessions: filings.map((f) => f.accession) } satisfies TickerIndex);
    } catch (err) {
      // Only `peek` reads the index; the visit itself goes on without it.
      console.warn(`[guidance] ${ticker} index not kept: ${err instanceof Error ? err.message : String(err)}`);
    }
    const read = await pooled(filings, PARALLEL, (f) => release(ticker, f, fresh).catch(() => null));
    let releases = read.filter((r): r is GuidanceRelease => r !== null);
    const complete = releases.length === filings.length;
    // A guided figure whose result the period's release was read without: that release once more.
    if (deps.configured()) {
      const again = unreadResults(releases).flatMap((accession) => {
        const filing = filings.find((f) => f.accession === accession);
        const stored = storedEntry(accession);
        return filing && stored && !stored.rechecked ? [{ filing, stored }] : [];
      });
      if (again.length > 0) {
        const reread = await pooled(again, PARALLEL, ({ filing, stored }) => recheck(ticker, filing, stored, fresh).catch(() => null));
        const byAccession = new Map(reread.flatMap((r) => (r ? [[r.accession, r] as const] : [])));
        releases = releases.map((r) => byAccession.get(r.accession) ?? r);
      }
    }
    if (filings.length > 0 && releases.length === 0) return { result: { ok: false, error: "unavailable" }, complete: false };
    return { result: { ok: true, track: buildTrack(ticker, releases) }, complete };
  }

  return {
    async track(ticker, options) {
      const hit = answers.get(ticker);
      if (hit && !options?.fresh && now() - hit.at < hit.ttl) return hit.result;
      const running = inflight.get(ticker);
      if (running) return running;
      const task = compute(ticker, options?.fresh === true)
        .then(({ result, complete }) => {
          if (result.ok) answers.set(ticker, { at: now(), ttl: complete ? TRACK_TTL_MS : PARTIAL_TTL_MS, result });
          return result;
        })
        .finally(() => inflight.delete(ticker));
      inflight.set(ticker, task);
      return task;
    },

    peek(ticker) {
      const index = readJson<TickerIndex>(indexFor(ticker));
      if (!index || !Array.isArray(index.accessions)) return null;
      const releases = index.accessions
        .filter((a): a is string => typeof a === "string" && a !== "")
        .map(storedRelease)
        .filter((r): r is GuidanceRelease => r !== null);
      return releases.length > 0 ? buildTrack(ticker, releases) : null;
    },
  };
}
