/**
 * EDGAR's record of a company's earnings releases: each 8-K with item 2.02
 * (results of operations) in the submissions index, with its acceptance
 * stamp. Yahoo keeps four quarters; these reach back to eight and further
 * for a US filer. A foreign filer (6-K) has none, and its figures rest on
 * Yahoo's quarters alone.
 *
 * One request per company, spaced like the agents' reader (SEC asks for no
 * more than ten a second; this sends at most four), and the caller keeps
 * the answer for the New York day.
 */

import { edgarAcceptanceIso, edgarIndexConvention } from "@meridian/research/edgar-time";
import { resolveCik } from "../agents/edgar";

const SEC_UA = process.env.SEC_EDGAR_USER_AGENT?.trim() || "Meridian Falcon Research research@getfalcon.co";
const TIMEOUT_MS = 15_000;
const MIN_GAP_MS = 250;

/** `acceptedAt` is the true instant when `acceptedAtUtc` is set (see @meridian/research/edgar-time). */
export type ReleaseFiling = { filedAt: string; acceptedAt: string | null; acceptedAtUtc?: boolean; url: string | null };

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function secFetch(url: string): Promise<Response> {
  const run = async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { headers: { "User-Agent": SEC_UA, Accept: "application/json" }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

type Recent = {
  form?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  items?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
};

/**
 * The item 2.02 filings in a submissions index read at `fetchedAtMs`, oldest
 * first, each with its true acceptance instant: SEC's stamp of an older entry
 * is shifted by New York's offset in a file rebuilt since 2026-10-03. Pure.
 */
export function releasesFromSubmissions(cik: string, recent: Recent | undefined, fetchedAtMs: number): ReleaseFiling[] {
  const out: ReleaseFiling[] = [];
  const n = recent?.form?.length ?? 0;
  // Some files write older entries as the true instant, most shifted: the file's own entries say which.
  const convention = edgarIndexConvention(recent, fetchedAtMs);
  for (let i = 0; i < n; i++) {
    if (recent!.form![i] !== "8-K") continue;
    const items = (recent!.items?.[i] ?? "").split(",").map((s) => s.trim());
    if (!items.includes("2.02")) continue;
    const filedAt = recent!.filingDate?.[i] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filedAt)) continue;
    const accession = recent!.accessionNumber?.[i];
    const doc = recent!.primaryDocument?.[i];
    const url = accession
      ? `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${accession.replace(/-/g, "")}/${doc ?? ""}`
      : null;
    const acceptedAt = edgarAcceptanceIso(recent!.acceptanceDateTime?.[i], { filingDate: filedAt, fetchedAtMs, convention });
    out.push({ filedAt, acceptedAt, ...(acceptedAt ? { acceptedAtUtc: true } : {}), url });
  }
  return out.sort((a, b) => a.filedAt.localeCompare(b.filedAt));
}

/** The company's item 2.02 filings; empty when EDGAR lists no such ticker. */
export async function fetchReleaseFilings(ticker: string): Promise<ReleaseFiling[]> {
  const cik = await resolveCik(ticker);
  if (!cik) return [];
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!res.ok) throw new Error(`SEC filings request failed (${res.status})`);
  const data = (await res.json()) as { filings?: { recent?: Recent } };
  return releasesFromSubmissions(cik, data.filings?.recent, Date.now());
}
