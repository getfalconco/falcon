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
 *   4. the comparison (shared/guidance-track.ts)
 *
 * Every SEC request goes through the agents engine's EDGAR reader (its
 * User-Agent, its spacing, its submissions cache). Electron-free: the
 * readers, the model caller, the folder and the clock are injected.
 */

import path from "node:path";
import type { GlossModelCaller } from "@meridian/research/gloss";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { htmlToText, type FilingRef } from "../agents/sources";
import type { GuidanceRelease, GuidanceTrackResult } from "../../shared/guidance-types";
import { mergeReadings, verifyExtraction } from "../../shared/guidance-verify";
import { buildTrack } from "../../shared/guidance-track";
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

type Stored = { version: string; model: string; release: GuidanceRelease };

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

export type GuidanceService = { track(ticker: string): Promise<GuidanceTrackResult> };

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

  /** One release, from disk or read now; null when it could not be read this time. */
  async function release(ticker: string, filing: FilingRef): Promise<GuidanceRelease | null> {
    const file = fileFor(filing.accession);
    const stored = readJson<Stored>(file);
    if (stored && stored.version === GUIDANCE_EXTRACT_VERSION && stored.release) return stored.release;

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
    const read = await pooled(filings, PARALLEL, (f) => release(ticker, f).catch(() => null));
    const releases = read.filter((r): r is GuidanceRelease => r !== null);
    const complete = releases.length === filings.length;
    if (filings.length > 0 && releases.length === 0) return { result: { ok: false, error: "unavailable" }, complete: false };
    return { result: { ok: true, track: buildTrack(ticker, releases) }, complete };
  }

  return {
    async track(ticker) {
      const hit = answers.get(ticker);
      if (hit && now() - hit.at < hit.ttl) return hit.result;
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
  };
}
