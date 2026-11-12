/**
 * SEC EDGAR reads: ticker to CIK, a company's recent filings with their true
 * acceptance instants, a filing's documents, and a document's text.
 */

import { edgarAcceptanceIso, edgarIndexConvention } from "./edgar-time.ts";
import { FOREVER_MS, HOUR_MS, secGet } from "./http.ts";
import { htmlToText } from "./text.ts";

export type Recent = {
  accessionNumber?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  form?: string[];
  items?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
};

export type Submissions = {
  cik: string;
  name: string;
  tickers?: string[];
  filings: { recent: Recent };
};

export type Filing = {
  cik: string;
  companyName: string;
  form: string;
  accession: string;
  filedAt: string;
  /** True acceptance instant (ISO), or null when the stamp does not parse. */
  acceptedAt: string | null;
  items: string[];
  primaryDocument: string;
  primaryDocDescription: string;
  /** The primary document on EDGAR. */
  url: string;
  /** The filing's index page on EDGAR. */
  indexUrl: string;
};

let tickerMap: Map<string, string> | null = null;

/** CIK (10 digits) for a ticker, from SEC's company_tickers.json. */
export async function cikForTicker(ticker: string): Promise<string | null> {
  if (!tickerMap) {
    const json = JSON.parse(await secGet("https://www.sec.gov/files/company_tickers.json", { maxAgeMs: 24 * HOUR_MS })) as Record<
      string,
      { cik_str: number; ticker: string }
    >;
    tickerMap = new Map();
    for (const row of Object.values(json)) tickerMap.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, "0"));
  }
  return tickerMap.get(ticker.toUpperCase().replace(".", "-")) ?? null;
}

export function archiveBase(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accession.replace(/-/g, "")}`;
}

/**
 * Filings in a submissions index read at `fetchedAtMs`, newest first, each
 * with its true acceptance instant. EDGAR writes older entries shifted by New
 * York's offset in a file rebuilt since 2026-10-03 and the current day's
 * entries as true UTC; `edgarIndexConvention` reads which from the file
 * itself. Pure.
 */
export function filingsFromSubmissions(sub: Submissions, fetchedAtMs: number): Filing[] {
  const r = sub.filings.recent;
  const n = r.form?.length ?? 0;
  const convention = edgarIndexConvention(r, fetchedAtMs);
  const cik = String(sub.cik).padStart(10, "0");
  const out: Filing[] = [];
  for (let i = 0; i < n; i++) {
    const accession = r.accessionNumber?.[i];
    const filedAt = r.filingDate?.[i];
    const form = r.form?.[i];
    if (!accession || !filedAt || !form) continue;
    const primaryDocument = r.primaryDocument?.[i] ?? "";
    const base = archiveBase(cik, accession);
    out.push({
      cik,
      companyName: sub.name,
      form,
      accession,
      filedAt,
      acceptedAt: edgarAcceptanceIso(r.acceptanceDateTime?.[i], { filingDate: filedAt, fetchedAtMs, convention }),
      items: (r.items?.[i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      primaryDocument,
      primaryDocDescription: r.primaryDocDescription?.[i] ?? "",
      url: `${base}/${primaryDocument}`,
      indexUrl: `${base}/${accession}-index.htm`,
    });
  }
  return out;
}

export async function submissions(cik: string): Promise<{ sub: Submissions; fetchedAtMs: number }> {
  const url = `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`;
  // Short cache: the index changes the moment a company files.
  const body = await secGet(url, { maxAgeMs: HOUR_MS / 2 });
  return { sub: JSON.parse(body) as Submissions, fetchedAtMs: Date.now() };
}

export async function recentFilings(cik: string): Promise<Filing[]> {
  const { sub, fetchedAtMs } = await submissions(cik);
  return filingsFromSubmissions(sub, fetchedAtMs);
}

export type FilingDocument = { type: string; description: string; url: string };

/** The documents table of a filing's -index.htm page. Pure. */
export function parseFilingIndex(html: string): FilingDocument[] {
  const out: FilingDocument[] = [];
  const table = /<table[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1] ?? "";
  for (const row of table.split(/<tr[^>]*>/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? "");
    if (cells.length < 4) continue;
    const href = /href="([^"]+)"/i.exec(cells[2] ?? "")?.[1];
    if (!href) continue;
    const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    out.push({
      description: strip(cells[1] ?? ""),
      type: strip(cells[3] ?? ""),
      url: new URL(href.replace(/^\/ix\?doc=/, ""), "https://www.sec.gov").toString(),
    });
  }
  return out;
}

export async function filingDocuments(filing: Pick<Filing, "indexUrl">): Promise<FilingDocument[]> {
  return parseFilingIndex(await secGet(filing.indexUrl, { maxAgeMs: FOREVER_MS }));
}

/** A document's plain text (archived documents never change, so cached for good). */
export async function documentText(url: string): Promise<string> {
  return htmlToText(await secGet(url, { maxAgeMs: FOREVER_MS }));
}
