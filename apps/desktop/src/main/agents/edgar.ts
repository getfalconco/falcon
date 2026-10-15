import { edgarAcceptanceIso, edgarIndexConvention, inEdgarRebuildWindow } from "@meridian/research/edgar-time";
import { secFetch as sharedSecFetch } from "@meridian/research/sec-fetch";
import { exhibitFromIndex } from "../edgar/exhibit-index";
import { htmlToText, parseForm4, type FilingRef, type FilingText, type InsiderTxn } from "./sources";

/**
 * SEC EDGAR for agents: ticker to CIK, a company's recent filings, and a
 * filing's text.
 *
 * The Tracker has its own EDGAR reader (`packages/research/src/tracker/
 * sources.ts`), but it keeps only four forms and is not exported from the
 * package; an agent may watch any form (13D, S-1, DEF 14A) and needs the
 * press release exhibit of an 8-K, so this is a small reader of its own with
 * the same manners: a descriptive User-Agent, requests spaced out through
 * the one SEC queue the whole process shares (SEC asks for no more than ten a
 * second; the queue starts at most four), and caches so ten agents on one
 * company make one request.
 */

const SEC_UA = process.env.SEC_EDGAR_USER_AGENT?.trim() || "Meridian Falcon Agents research@getfalcon.co";
const TIMEOUT_MS = 15_000;
const TICKERS_TTL_MS = 24 * 60 * 60_000;
const SUBMISSIONS_TTL_MS = 4 * 60_000;
const TEXT_MAX_CHARS = 120_000;
const RECENT_COUNT = 60;
/**
 * The newest entries kept whatever their form. Past them an index keeps all
 * but the offering paperwork (`BULK_FORMS`): a bank's `filings.recent` holds
 * a year of filings, some twenty-five thousand for JPM, nearly all 424B2
 * pricing supplements for structured notes, with its 10-K some eighteen
 * thousand entries down.
 */
const HISTORY_COUNT = 1000;
/** Prospectus supplements and free writing prospectuses: nothing past the newest HISTORY_COUNT reads them. */
const BULK_FORMS = /^(424[A-Z0-9]*|FWP)(\/A)?$/i;
/** An older page of the index (`filings.files[]`) is kept a day: SEC only adds to the newest. */
const PAGE_TTL_MS = 24 * 60 * 60_000;
/** Older pages kept at most (with BULK_FORMS left out, a few dozen to a few hundred filings each). */
const PAGE_KEEP_MAX = 240;
/** Older pages read for one need at most: JPM's run about a month each, so this is four years. */
const PAGES_MAX = 48;
/** Older pages asked for at once (the SEC queue still spaces them). */
const PAGES_PARALLEL = 4;

/**
 * Through the process-wide SEC queue (@meridian/research/sec-fetch), shared
 * with the Tracker, step1 and every other EDGAR reader in this process: at
 * most four request starts a second in all. The queue survives a failed request.
 */
function secFetch(url: string, accept = "application/json"): Promise<Response> {
  return sharedSecFetch(url, { userAgent: SEC_UA, accept, timeoutMs: TIMEOUT_MS });
}

let tickers: { at: number; map: Map<string, string> } | null = null;
let tickersInflight: Promise<Map<string, string>> | null = null;

async function tickerMap(): Promise<Map<string, string>> {
  if (tickers && Date.now() - tickers.at < TICKERS_TTL_MS) return tickers.map;
  if (tickersInflight) return tickersInflight;
  tickersInflight = (async () => {
    const res = await secFetch("https://www.sec.gov/files/company_tickers.json");
    if (!res.ok) throw new Error(`SEC ticker list failed (${res.status})`);
    const data = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
    const map = new Map<string, string>();
    for (const e of Object.values(data)) map.set(e.ticker.toUpperCase(), String(e.cik_str).padStart(10, "0"));
    tickers = { at: Date.now(), map };
    return map;
  })().finally(() => {
    tickersInflight = null;
  });
  return tickersInflight;
}

/** The company's CIK; null when EDGAR lists no such ticker (funds, foreign listings). */
export async function resolveCik(ticker: string): Promise<string | null> {
  const map = await tickerMap();
  const t = ticker.toUpperCase();
  return map.get(t) ?? map.get(t.replace(".", "-")) ?? map.get(t.replace("-", ".")) ?? null;
}

/** One older page of the index as `filings.files[]` lists it, newest first. */
export type SubmissionsPageRef = { name?: string; filingCount?: number; filingFrom?: string; filingTo?: string };

type KeptIndex = { at: number; filings: FilingRef[]; files: SubmissionsPageRef[] };

const submissions = new Map<string, KeptIndex>();
/**
 * A kept index (the newest thousand filings and the rest of its year but the
 * offering paperwork) is dropped after a day, and no more than
 * SUBMISSIONS_KEEP_MAX are kept: the insiders card alone reads some sixty
 * companies. A day still covers `cachedFilingHistory`'s readers, which
 * follow names read every few hours.
 */
export const SUBMISSIONS_KEEP_MS = 24 * 60 * 60_000;
export const SUBMISSIONS_KEEP_MAX = 120;

/** Drops kept indexes older than `keepMs`, then the oldest beyond `max`. Insertion order is age order. */
export function pruneKept<T extends { at: number }>(map: Map<string, T>, nowMs: number, keepMs = SUBMISSIONS_KEEP_MS, max = SUBMISSIONS_KEEP_MAX): void {
  for (const [key, entry] of map) if (nowMs - entry.at > keepMs) map.delete(key);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
const submissionsInflight = new Map<string, Promise<KeptIndex>>();

/** Older pages by file name; `ttl` is short for a page read while SEC may not have rebuilt it yet. */
const pages = new Map<string, { at: number; ttl: number; filings: FilingRef[] }>();
const pagesInflight = new Map<string, Promise<FilingRef[]>>();

function archiveBase(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${accession.replace(/-/g, "")}`;
}

/** The newest filings (up to 60), any form, newest first. */
export async function recentFilings(ticker: string): Promise<FilingRef[]> {
  return (await filingHistory(ticker)).slice(0, RECENT_COUNT);
}

/**
 * What a reader needs from the older pages of the index. `filings.recent`
 * covers at least a year, and for most companies many more; a heavy filer
 * (a bank issuing structured notes) has only a year there and its earlier
 * filings in `filings.files[]`, about a month to a page for JPM.
 */
export type HistoryNeed = {
  /** The oldest filing day the reader looks at ("YYYY-MM-DD"): a page wholly before it is never read. */
  since: string;
  /** Whether the filings so far (newest first) already answer: no older page is read once it holds. */
  enough?: (filings: readonly FilingRef[]) => boolean;
};

/**
 * Every filing the submissions index lists in `filings.recent` (the newest
 * thousand of any form, and past them all but the offering paperwork), newest
 * first. Same request and cache as `recentFilings`.
 *
 * With `need`, the older pages the reader still needs are read too (newest
 * first, only those reaching `need.since`, stopping once `need.enough`
 * holds) and their filings follow: the Stock tab's years of 8-K releases,
 * Filing changes' annual report before the latest.
 */
export async function filingHistory(ticker: string, need?: HistoryNeed): Promise<FilingRef[]> {
  const cik = await resolveCik(ticker);
  if (!cik) return [];
  const index = await submissionsIndex(cik);
  return need ? withOlderPages(cik, index, need) : index.filings;
}

async function submissionsIndex(cik: string): Promise<KeptIndex> {
  const cached = submissions.get(cik);
  if (cached && Date.now() - cached.at < SUBMISSIONS_TTL_MS) return cached;
  const inflight = submissionsInflight.get(cik);
  if (inflight) return inflight;
  const request = (async () => {
    const res = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    if (!res.ok) throw new Error(`SEC filings request failed (${res.status})`);
    const data = (await res.json()) as { filings?: { recent?: SubmissionsRecent; files?: SubmissionsPageRef[] } };
    // The acceptance stamp's clock depends on this read of the file (research/edgar-time.ts).
    const filings = filingsFromSubmissions(cik, data.filings?.recent, Date.now());
    const files = data.filings?.files;
    const kept: KeptIndex = { at: Date.now(), filings, files: Array.isArray(files) ? files : [] };
    submissions.delete(cik);
    submissions.set(cik, kept);
    pruneKept(submissions, Date.now());
    return kept;
  })().finally(() => submissionsInflight.delete(cik));
  submissionsInflight.set(cik, request);
  return request;
}

const PAGE_NAME = /^CIK\d{10}-submissions-\d{3,}\.json$/;

/**
 * The older pages that may hold filings on or after `since`, newest first:
 * a page whose last filing day is before it is left out. Pure.
 */
export function olderPagesFor(files: readonly SubmissionsPageRef[] | undefined, since: string): string[] {
  return (files ?? [])
    .filter((f) => typeof f.name === "string" && PAGE_NAME.test(f.name) && (!f.filingTo || f.filingTo >= since))
    .sort((a, b) => (b.filingTo ?? "9999").localeCompare(a.filingTo ?? "9999"))
    .map((f) => f.name!);
}

/**
 * The index's filings followed by those of the older pages `need` asks for,
 * newest first, read a few at a time (so up to PAGES_PARALLEL - 1 past the
 * one that satisfies `need.enough`). A page that cannot be read ends the
 * read (what follows would leave a gap); what came before is still answered.
 */
async function withOlderPages(cik: string, index: KeptIndex, need: HistoryNeed): Promise<FilingRef[]> {
  if (need.enough?.(index.filings)) return index.filings;
  const names = olderPagesFor(index.files, need.since).slice(0, PAGES_MAX);
  if (names.length === 0) return index.filings;
  const out = [...index.filings];
  const seen = new Set(out.map((f) => f.accession));
  // One page first (an annual report is most often in it), then two, then PAGES_PARALLEL at a time.
  for (let i = 0, size = 1; i < names.length; i += size, size = Math.min(size * 2, PAGES_PARALLEL)) {
    const read = await Promise.all(
      names.slice(i, i + size).map((name) =>
        submissionsPage(cik, name).catch((err) => {
          console.warn(`[edgar] ${name} not read:`, err instanceof Error ? err.message : String(err));
          return null;
        }),
      ),
    );
    const gap = read.indexOf(null);
    for (const page of gap === -1 ? read : read.slice(0, gap)) {
      for (const f of page!) {
        if (seen.has(f.accession)) continue;
        seen.add(f.accession);
        out.push(f);
      }
    }
    if (gap !== -1 || need.enough?.(out)) break;
  }
  return out;
}

/** One older page of the index, its filings newest first, BULK_FORMS left out. */
async function submissionsPage(cik: string, name: string): Promise<FilingRef[]> {
  const cached = pages.get(name);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.filings;
  const inflight = pagesInflight.get(name);
  if (inflight) return inflight;
  const request = (async () => {
    const res = await secFetch(`https://data.sec.gov/submissions/${name}`);
    if (!res.ok) throw new Error(`SEC filings page request failed (${res.status})`);
    const fetchedAt = Date.now();
    // Each page is a file of its own, with its own clock for the stamps (research/edgar-time.ts).
    const filings = filingsFromSubmissions(cik, (await res.json()) as SubmissionsRecent, fetchedAt, 0);
    pages.delete(name);
    pages.set(name, { at: fetchedAt, ttl: inEdgarRebuildWindow(fetchedAt) ? SUBMISSIONS_TTL_MS : PAGE_TTL_MS, filings });
    pruneKept(pages, Date.now(), PAGE_TTL_MS, PAGE_KEEP_MAX);
    return filings;
  })().finally(() => pagesInflight.delete(name));
  pagesInflight.set(name, request);
  return request;
}

/** Two item 2.02 filings closer than this are one report (a preliminary release, a re-filed exhibit). */
const SAME_REPORT_DAYS = 20;

/** How many earnings reports (8-K item 2.02; two within SAME_REPORT_DAYS count once) `filings` hold. Pure. */
export function releaseCount(filings: readonly FilingRef[]): number {
  const days = filings
    .filter((f) => f.form === "8-K" && f.items.includes("2.02") && /^\d{4}-\d{2}-\d{2}$/.test(f.filedAt))
    .map((f) => Date.parse(`${f.filedAt}T12:00:00Z`))
    .sort((a, b) => b - a);
  let count = 0;
  let last: number | null = null;
  for (const d of days) {
    if (last !== null && (last - d) / 86_400_000 < SAME_REPORT_DAYS) continue;
    count++;
    last = d;
  }
  return count;
}

/** The day `days` before `nowMs` as "YYYY-MM-DD" (UTC: a need's bound, where a day either way does not matter). */
export function daysBefore(days: number, nowMs = Date.now()): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What the last submissions read this run kept for a company, however old,
 * or null when none was read (or the ticker list is not loaded). Never
 * fetches: it lets a background job notice a new filing from the reads the
 * other modules already make, without polling EDGAR itself.
 */
export function cachedFilingHistory(ticker: string): FilingRef[] | null {
  const map = tickers?.map;
  if (!map) return null;
  const t = ticker.toUpperCase();
  const cik = map.get(t) ?? map.get(t.replace(".", "-")) ?? map.get(t.replace("-", "."));
  return cik ? (submissions.get(cik)?.filings ?? null) : null;
}

/** The submissions index's `filings.recent` columns (an older page carries the same at its top level). */
export type SubmissionsRecent = {
  form?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  items?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
};

/**
 * The filings of a submissions file (the index's `filings.recent`, or an
 * older page) read at `fetchedAtMs`, newest first, each with its true
 * acceptance instant (`acceptedAtUtc`): SEC's stamp of an older entry is
 * shifted by New York's offset in a file rebuilt since 2026-10-03
 * (research/edgar-time.ts), so the clock is read from this file's own
 * entries, all of them. The newest `keepAll` entries are kept whatever their
 * form, the rest unless BULK_FORMS (an older page passes 0).
 * Pure.
 */
export function filingsFromSubmissions(cik: string, r: SubmissionsRecent | undefined, fetchedAtMs: number, keepAll = HISTORY_COUNT): FilingRef[] {
  const filings: FilingRef[] = [];
  const count = r?.form?.length ?? 0;
  // Some files write older entries as the true instant, most shifted: the file's own entries say which.
  const convention = edgarIndexConvention(r, fetchedAtMs);
  for (let i = 0; i < count; i++) {
    const form = r!.form![i];
    const accession = r!.accessionNumber?.[i];
    if (!form || !accession) continue;
    if (i >= keepAll && BULK_FORMS.test(form.trim())) continue;
    const primary = r!.primaryDocument?.[i] || null;
    const filedAt = r!.filingDate?.[i] ?? "";
    const acceptedAt = edgarAcceptanceIso(r!.acceptanceDateTime?.[i], { filingDate: filedAt, fetchedAtMs, convention });
    filings.push({
      cik,
      form,
      accession,
      filedAt,
      acceptedAt,
      ...(acceptedAt ? { acceptedAtUtc: true } : {}),
      items: (r!.items?.[i] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      primaryDocument: primary,
      url: primary ? `${archiveBase(cik, accession)}/${primary}` : `${archiveBase(cik, accession)}/`,
    });
  }
  return filings;
}

type IndexItem = { name?: string; type?: string; size?: string | number };

async function fetchText(url: string): Promise<string> {
  const res = await secFetch(url, "text/html,application/xhtml+xml,text/plain");
  if (!res.ok) throw new Error(`SEC document request failed (${res.status})`);
  const body = await res.text();
  return body.slice(0, TEXT_MAX_CHARS * 4);
}

/**
 * A filing's readable text. For an 8-K the press release (EX-99.x) carries the
 * numbers, so it is read first and the cover document after it.
 */
export async function filingText(filing: FilingRef): Promise<FilingText> {
  const base = archiveBase(filing.cik, filing.accession);
  let exhibit: string | null = null;
  if (filing.form.startsWith("8-K") || filing.form.startsWith("6-K")) {
    try {
      const res = await secFetch(`${base}/index.json`);
      if (res.ok) {
        const index = (await res.json()) as { directory?: { item?: IndexItem[] } };
        const items = index.directory?.item ?? [];
        const ex = items.find((it) => typeof it.name === "string" && /ex-?99|ex99|dex99/i.test(it.name) && /\.(htm|html|txt)$/i.test(it.name));
        if (ex?.name) exhibit = ex.name;
      }
    } catch {
      exhibit = null;
    }
    if (!exhibit) {
      // A press release named for the quarter ("q2fy27pr.htm") is found by its type on the index page.
      try {
        const res = await secFetch(`${base}/${filing.accession}-index.htm`, "text/html");
        if (res.ok) exhibit = exhibitFromIndex(await res.text());
      } catch {
        exhibit = null;
      }
    }
  }
  const parts: string[] = [];
  let url = filing.url;
  if (exhibit) {
    url = `${base}/${exhibit}`;
    parts.push(htmlToText(await fetchText(url)));
  }
  if (filing.primaryDocument && (!exhibit || parts.join("").length < 4000)) {
    try {
      // An XSL-rendered path ("xslF345X05/doc.xml") is the raw document without the prefix.
      const doc = filing.primaryDocument.replace(/^.*\//, "");
      parts.push(htmlToText(await fetchText(`${base}/${doc}`)));
    } catch (err) {
      if (parts.length === 0) throw err;
    }
  }
  return {
    title: `${filing.form} filed ${filing.filedAt}`,
    url,
    text: parts.join("\n\n").slice(0, TEXT_MAX_CHARS),
  };
}

/** A Form 4's ownership XML, read through the same spaced queue; null when it cannot be read. */
export async function form4Xml(filing: FilingRef): Promise<string | null> {
  if (!filing.primaryDocument) return null;
  const doc = filing.primaryDocument.replace(/^.*\//, "");
  try {
    return await fetchText(`${archiveBase(filing.cik, filing.accession)}/${doc}`);
  } catch {
    return null;
  }
}

/**
 * One file of a filing's folder, raw, through the same spaced queue: the
 * primary document when `name` is null (an XSL-rendered path read without
 * its prefix), or a named file such as `<accession>-index-headers.html`.
 * Null when it cannot be read.
 */
export async function filingFile(filing: FilingRef, name: string | null): Promise<string | null> {
  const doc = name ?? filing.primaryDocument?.replace(/^.*\//, "") ?? null;
  if (!doc) return null;
  try {
    return await fetchText(`${archiveBase(filing.cik, filing.accession)}/${doc}`);
  } catch {
    return null;
  }
}

/** A whole primary document is at most this long (a 10-K with inline XBRL runs to ten or fifteen megabytes). */
const DOCUMENT_MAX_CHARS = 40_000_000;

/**
 * A filing's primary document in full, through the same spaced queue: for
 * readers that need all of a 10-K (Filing changes reads Item 1A and Item 9A).
 * Throws when it cannot be read.
 */
export async function filingDocument(filing: FilingRef): Promise<string> {
  const doc = filing.primaryDocument?.replace(/^.*\//, "") ?? null;
  if (!doc) throw new Error("filing has no primary document");
  const res = await secFetch(`${archiveBase(filing.cik, filing.accession)}/${doc}`, "text/html,application/xhtml+xml,text/plain");
  if (!res.ok) throw new Error(`SEC document request failed (${res.status})`);
  return (await res.text()).slice(0, DOCUMENT_MAX_CHARS);
}

export async function insiderTxn(filing: FilingRef): Promise<InsiderTxn | null> {
  if (!filing.primaryDocument) return null;
  const doc = filing.primaryDocument.replace(/^.*\//, "");
  try {
    return parseForm4(await fetchText(`${archiveBase(filing.cik, filing.accession)}/${doc}`));
  } catch {
    return null;
  }
}
