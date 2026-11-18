/**
 * SEC EDGAR reads for the Desk tools: ticker to CIK, a company's filing index
 * (submissions), XBRL company facts, EDGAR full-text search, and archived
 * documents as text.
 *
 * SEC asks automated clients for a descriptive User-Agent and at most 10
 * requests a second. Every request here carries Falcon's generic app address
 * (never a member's) and goes through one polite queue: 6 at a time, starts
 * at least 110 ms apart (about 9 a second at most per server instance), 6 s
 * per request, one retry on 429/5xx. Answers are cached in memory only
 * (no disk), so this runs the same inside a Netlify function.
 *
 * Ported from packages/engine/src/sec.ts and text.ts (the engine keeps a disk
 * cache and long retries for its batch runs; the Desk needs answers in
 * seconds).
 */

import { PoliteFetcher } from "@falcon/backtest/data";
import { TtlCache, cached } from "./util";

export const SEC_USER_AGENT = process.env.SEC_EDGAR_USER_AGENT?.trim() || "Falcon Website research@getfalcon.co";

export const secFetcher = new PoliteFetcher({ concurrency: 6, minGapMs: 110, timeoutMs: 6_000, retries: 1 });

const HOUR = 3_600_000;

export class SecError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function secText(url: string, signal?: AbortSignal, accept = "application/json"): Promise<string> {
  const res = await secFetcher.fetch(url, { headers: { "User-Agent": SEC_USER_AGENT, Accept: accept, "Accept-Encoding": "gzip, deflate" } }, signal);
  if (!res.ok) throw new SecError(res.status, `SEC HTTP ${res.status}`);
  return res.text();
}

async function secJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await secText(url, signal)) as T;
}

/* ------------------------------------------------------------------ tickers */

export type Company = { ticker: string; cik: string; name: string };

const tickerCache = new TtlCache<Promise<Map<string, Company>>>(24 * HOUR, 1);

/** SEC's company_tickers.json by ticker ("BRK-B" form). Cached 24 h. */
export function tickerMap(signal?: AbortSignal): Promise<Map<string, Company>> {
  return cached(tickerCache, "all", async () => {
    const raw = await secJson<Record<string, { cik_str: number; ticker: string; title: string }>>("https://www.sec.gov/files/company_tickers.json", signal);
    const map = new Map<string, Company>();
    for (const row of Object.values(raw)) {
      const ticker = String(row.ticker).toUpperCase().replace(/\./g, "-");
      if (!map.has(ticker)) map.set(ticker, { ticker, cik: String(row.cik_str).padStart(10, "0"), name: row.title });
    }
    return map;
  });
}

/** The SEC registrant for a ticker, or null when SEC does not list it (an ETF, a fund, a delisted name). */
export async function companyForTicker(ticker: string, signal?: AbortSignal): Promise<Company | null> {
  return (await tickerMap(signal)).get(ticker) ?? null;
}

/* ------------------------------------------------------------------ submissions */

export type Recent = {
  accessionNumber: string[];
  filingDate: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  form: string[];
  items?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
};

export type Submissions = {
  cik: string;
  name: string;
  tickers?: string[];
  fiscalYearEnd?: string;
  filings: { recent: Recent };
};

const subsCache = new TtlCache<Promise<Submissions>>(10 * 60_000, 300);

/** A filer's submissions index (the last 1,000 filings, newest first). Cached 10 min. */
export function submissions(cik: string, signal?: AbortSignal): Promise<Submissions> {
  const padded = cik.padStart(10, "0");
  return cached(subsCache, padded, () => secJson<Submissions>(`https://data.sec.gov/submissions/CIK${padded}.json`, signal));
}

export function archiveBase(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accession.replace(/-/g, "")}`;
}

/* ------------------------------------------------------------------ company facts */

export type XbrlFact = { start?: string; end: string; val: number; accn: string; fy?: number | null; fp?: string | null; form: string; filed: string; frame?: string };
export type CompanyFacts = {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { label?: string; units: Record<string, XbrlFact[]> }>>;
};

/** XBRL company facts (several MB for a large filer; callers keep only what they derive). Not cached here. */
export function companyFacts(cik: string, signal?: AbortSignal): Promise<CompanyFacts> {
  return secJson<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padStart(10, "0")}.json`, signal);
}

/* ------------------------------------------------------------------ full-text search */

export type FtsHit = {
  _id: string;
  _source: {
    ciks?: string[];
    display_names?: string[];
    form?: string;
    root_forms?: string[];
    file_date?: string;
    period_ending?: string | null;
    file_type?: string;
    file_description?: string | null;
    items?: string[];
    adsh?: string;
  };
};

const ftsCache = new TtlCache<Promise<{ total: number; hits: FtsHit[] }>>(30 * 60_000, 100);

/** EDGAR full-text search (efts.sec.gov, filings since 2001). Cached 30 min. */
export function fullTextSearch(params: { q: string; ciks?: string[]; forms?: string[]; startdt?: string; enddt?: string }, signal?: AbortSignal) {
  const qs = new URLSearchParams({ q: params.q });
  if (params.ciks?.length) qs.set("ciks", params.ciks.join(","));
  if (params.forms?.length) qs.set("forms", params.forms.join(","));
  if (params.startdt && params.enddt) {
    qs.set("dateRange", "custom");
    qs.set("startdt", params.startdt);
    qs.set("enddt", params.enddt);
  }
  const url = `https://efts.sec.gov/LATEST/search-index?${qs.toString()}`;
  return cached(ftsCache, url, async () => {
    const json = await secJson<{ hits?: { total?: { value?: number }; hits?: FtsHit[] } }>(url, signal);
    return { total: json.hits?.total?.value ?? 0, hits: json.hits?.hits ?? [] };
  });
}

/* ------------------------------------------------------------------ documents */

const docCache = new TtlCache<Promise<string>>(24 * HOUR, 20);

/** An archived document's text (HTML converted); archived documents never change. Cached 24 h (20 documents). */
export function documentText(url: string, signal?: AbortSignal): Promise<string> {
  return cached(docCache, url, async () => {
    const body = await secText(url, signal, "text/html,application/xhtml+xml,text/plain,*/*");
    return /<(html|body|div|p|table)\b/i.test(body.slice(0, 20_000)) ? htmlToText(body) : body;
  });
}

/** For tests. */
export function resetSec(): void {
  tickerCache.clear();
  subsCache.clear();
  ftsCache.clear();
  docCache.clear();
}

/* ------------------------------------------------------------------ text (engine text.ts) */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  reg: "®",
  trade: "™",
  copy: "©",
  bull: "•",
  middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n)) return m;
      if (n === 160) return " ";
      if (n === 8211 || n === 8212) return "-";
      return String.fromCodePoint(n);
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const BLOCK = /<\/?(p|div|br|tr|li|ul|ol|table|h[1-6]|section|article|header|footer|blockquote|center|hr)\b[^>]*>/gi;

/** Readable text from an HTML document: one paragraph per line, table cells joined with " | ". Pure. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ");
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/t[dh]>/gi, " | ");
  s = s.replace(BLOCK, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[   ]/g, " ");
  s = s.replace(/[‐-―]/g, "-");
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((line) => line.length > 0 && !/^(\|\s*)+$/.test(line))
    .join("\n");
}
