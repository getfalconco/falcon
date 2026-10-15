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
 *      never changes, so each is read once. A failed call is not kept and is
 *      asked again on a later visit
 *   4. a kept release that holds no result for a figure an earlier release
 *      guided is read once more and the readings merged (a single pass can
 *      skip a table line); marked on disk, so never more than once
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
import { extractRelease, GUIDANCE_EXTRACT_VERSION, guidanceModel } from "./guidance-extract";
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

/** `rechecked`: read once more because a guided figure's result was missing from it (see `compute`). */
type Stored = { version: string; model: string; release: GuidanceRelease; rechecked?: boolean };
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
  /** `fresh` skips the answer kept in memory, so a release filed since the last visit is read (the pre-read). */
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
  const model = () => deps.model ?? guidanceModel();

  const fileFor = (accession: string) => path.join(deps.dir, `${accession.replace(/[^0-9A-Za-z-]/g, "")}.json`);
  const indexFor = (ticker: string) => path.join(deps.dir, "tickers", `${ticker.toUpperCase().replace(/[^0-9A-Z.-]/g, "")}.json`);

  /** What is kept on disk for a release under the current extraction version, or null. */
  function storedEntry(accession: string): Stored | null {
    const stored = readJson<Stored>(fileFor(accession));
    return stored && stored.version === GUIDANCE_EXTRACT_VERSION && stored.release ? stored : null;
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
   * a failed call marks nothing and is asked again on a later visit.
   */
  async function recheck(ticker: string, filing: FilingRef, stored: Stored): Promise<GuidanceRelease | null> {
    const exhibit = await exhibitText(filing);
    if (!exhibit) return null;
    const meta = { accession: filing.accession, filedAt: filing.filedAt, url: exhibit.url };
    try {
      const again = verifyExtraction(await extractRelease(deps.caller, { ticker, filedAt: filing.filedAt, text: exhibit.text, model: model() }), exhibit.text, meta);
      const merged = mergeReadings(stored.release, again);
      writeJsonAtomic(fileFor(filing.accession), { ...stored, release: merged, rechecked: true } satisfies Stored);
      return merged;
    } catch (err) {
      console.warn(`[guidance] ${ticker} ${filing.accession} not read again: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** One release, from disk or read now; null when it could not be read this time. */
  async function release(ticker: string, filing: FilingRef): Promise<GuidanceRelease | null> {
    const file = fileFor(filing.accession);
    const stored = storedRelease(filing.accession);
    if (stored) return stored;

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
      if (first.status === "rejected" && second.status === "rejected") throw first.reason;
      const checked =
        first.status === "fulfilled" && second.status === "fulfilled"
          ? mergeReadings(first.value, second.value)
          : first.status === "fulfilled"
            ? first.value
            : (second as PromiseFulfilledResult<GuidanceRelease>).value;
      // Kept only when both readings came back; with one, it serves this visit and is read again on the next.
      if (first.status === "fulfilled" && second.status === "fulfilled") {
        writeJsonAtomic(file, { version: GUIDANCE_EXTRACT_VERSION, model: model(), release: checked } satisfies Stored);
      }
      return checked;
    } catch (err) {
      console.warn(`[guidance] ${ticker} ${filing.accession} not read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async function compute(ticker: string): Promise<{ result: GuidanceTrackResult; complete: boolean }> {
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
    const read = await pooled(filings, PARALLEL, (f) => release(ticker, f).catch(() => null));
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
        const reread = await pooled(again, PARALLEL, ({ filing, stored }) => recheck(ticker, filing, stored).catch(() => null));
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
      const task = compute(ticker)
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
