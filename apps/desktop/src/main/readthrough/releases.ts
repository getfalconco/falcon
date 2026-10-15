/**
 * EDGAR's record of a company's earnings releases: each 8-K with item 2.02
 * (results of operations) in the submissions index, with its acceptance
 * stamp. Yahoo keeps four quarters; these reach back to eight and further
 * for a US filer. A foreign filer (6-K) has none, and its figures rest on
 * Yahoo's quarters alone.
 *
 * One request per company, through the agents reader's submissions cache
 * and the process-wide SEC queue, and the caller keeps the answer for the
 * New York day.
 */

import { edgarAcceptanceIso, edgarIndexConvention } from "@meridian/research/edgar-time";
import { filingHistory } from "../agents/edgar";

/** `acceptedAt` is the true instant when `acceptedAtUtc` is set (see @meridian/research/edgar-time). */
export type ReleaseFiling = { filedAt: string; acceptedAt: string | null; acceptedAtUtc?: boolean; url: string | null };

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

/**
 * The company's item 2.02 filings, oldest first; empty when EDGAR lists no
 * such ticker. Read from the agents reader's submissions index
 * (agents/edgar.ts `filingHistory`): the same request, the same four-minute
 * cache and the process-wide SEC queue as every other EDGAR reader, the same
 * acceptance instants as `releasesFromSubmissions`.
 */
export async function fetchReleaseFilings(ticker: string): Promise<ReleaseFiling[]> {
  const filings = await filingHistory(ticker);
  const out: ReleaseFiling[] = [];
  for (const f of filings) {
    if (f.form !== "8-K" || !f.items.includes("2.02") || !/^\d{4}-\d{2}-\d{2}$/.test(f.filedAt)) continue;
    out.push({ filedAt: f.filedAt, acceptedAt: f.acceptedAt, ...(f.acceptedAtUtc ? { acceptedAtUtc: true } : {}), url: f.url });
  }
  return out.sort((a, b) => a.filedAt.localeCompare(b.filedAt));
}
