import { edgarAcceptanceIso, edgarIndexConvention } from "@meridian/research/edgar-time";
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
const HISTORY_COUNT = 1000;

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

const submissions = new Map<string, { at: number; filings: FilingRef[] }>();
/**
 * A kept index (up to a thousand filings, about half a megabyte) is dropped
 * after a day, and no more than SUBMISSIONS_KEEP_MAX are kept: the
 * insiders card alone reads some sixty companies. A day still covers
 * `cachedFilingHistory`'s readers, which follow names read every few hours.
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
const submissionsInflight = new Map<string, Promise<FilingRef[]>>();

function archiveBase(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${accession.replace(/-/g, "")}`;
}

/** The newest filings (up to 60), any form, newest first. */
export async function recentFilings(ticker: string): Promise<FilingRef[]> {
  return (await filingHistory(ticker)).slice(0, RECENT_COUNT);
}

/**
 * Every filing the submissions index lists (up to its last thousand), any
 * form, newest first. Same request and cache as `recentFilings`: the Stock
 * tab reads two years of 8-K releases and the window's Form 4s from it.
 */
export async function filingHistory(ticker: string): Promise<FilingRef[]> {
  const cik = await resolveCik(ticker);
  if (!cik) return [];
  const cached = submissions.get(cik);
  if (cached && Date.now() - cached.at < SUBMISSIONS_TTL_MS) return cached.filings;
  const inflight = submissionsInflight.get(cik);
  if (inflight) return inflight;
  const request = (async () => {
    const res = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    if (!res.ok) throw new Error(`SEC filings request failed (${res.status})`);
    const data = (await res.json()) as { filings?: { recent?: SubmissionsRecent } };
    // The acceptance stamp's clock depends on this read of the file (research/edgar-time.ts).
    const filings = filingsFromSubmissions(cik, data.filings?.recent, Date.now());
    submissions.delete(cik);
    submissions.set(cik, { at: Date.now(), filings });
    pruneKept(submissions, Date.now());
    return filings;
  })().finally(() => submissionsInflight.delete(cik));
  submissionsInflight.set(cik, request);
  return request;
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

/** The submissions index's `filings.recent` columns. */
export type SubmissionsRecent = {
  form?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  items?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
};

/**
 * The filings of a submissions index read at `fetchedAtMs`, newest first, each
 * with its true acceptance instant (`acceptedAtUtc`): SEC's stamp of an older
 * entry is shifted by New York's offset in a file rebuilt since 2026-10-03
 * (research/edgar-time.ts).
 * Pure.
 */
export function filingsFromSubmissions(cik: string, r: SubmissionsRecent | undefined, fetchedAtMs: number): FilingRef[] {
  const filings: FilingRef[] = [];
  const count = Math.min(r?.form?.length ?? 0, HISTORY_COUNT);
  // Some files write older entries as the true instant, most shifted: the file's own entries say which.
  const convention = edgarIndexConvention(r, fetchedAtMs);
  for (let i = 0; i < count; i++) {
    const form = r!.form![i];
    const accession = r!.accessionNumber?.[i];
    if (!form || !accession) continue;
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
