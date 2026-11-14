/**
 * Who a CIK is: its listed ticker and exchange (SEC company_tickers_exchange,
 * cached a day), its SIC and recent forms (submissions JSON), trailing annual
 * revenue and shares outstanding (XBRL companyconcept), and a loose name
 * match from a counterparty name to a listed filer.
 */

import { HOUR_MS, HttpError, secGet } from "../http.ts";
import { secPoolGet } from "./sec-pool.ts";
import { pad10 } from "./edgar.ts";

export type Listing = { cik: string; name: string; ticker: string; exchange: string | null };

/** Exchanges that count as US-listed (OTC and unknown do not). */
export const LISTED_EXCHANGES = new Set(["Nasdaq", "NYSE", "CBOE", "TXSE"]);

export type Listings = {
  /** Primary listing per CIK: the first row SEC gives for it (SEC orders a company's main class first). */
  byCik: Map<string, Listing>;
  byTicker: Map<string, Listing>;
  /** Normalized name -> CIK, listed companies only. */
  byName: Map<string, string>;
};

/** Rows of company_tickers_exchange.json: { fields: [...], data: [[cik, name, ticker, exchange], ...] }. Pure. */
export function parseListings(json: unknown): Listings {
  const body = json as { fields?: string[]; data?: unknown[][] };
  const f = body.fields ?? ["cik", "name", "ticker", "exchange"];
  const i = (k: string) => f.indexOf(k);
  const byCik = new Map<string, Listing>();
  const byTicker = new Map<string, Listing>();
  const byName = new Map<string, string>();
  for (const row of body.data ?? []) {
    const l: Listing = {
      cik: pad10(String(row[i("cik")])),
      name: String(row[i("name")] ?? ""),
      ticker: String(row[i("ticker")] ?? "").toUpperCase(),
      exchange: (row[i("exchange")] as string | null) ?? null,
    };
    if (!l.ticker) continue;
    byTicker.set(l.ticker, l);
    const known = byCik.get(l.cik);
    // Prefer a listed row over an OTC one for the same CIK.
    if (!known || (!isListed(known) && isListed(l))) byCik.set(l.cik, l);
    if (isListed(l)) {
      const n = normalizeCompanyName(l.name);
      if (n && !byName.has(n)) byName.set(n, l.cik);
    }
  }
  return { byCik, byTicker, byName };
}

export function isListed(l: Listing | null | undefined): boolean {
  return !!l && l.exchange !== null && LISTED_EXCHANGES.has(l.exchange);
}

let listings: Promise<Listings> | null = null;

export function loadListings(): Promise<Listings> {
  listings ??= secGet("https://www.sec.gov/files/company_tickers_exchange.json", { maxAgeMs: 24 * HOUR_MS, staleOk: true }).then((b) => parseListings(JSON.parse(b)));
  return listings;
}

/** Legal suffixes and punctuation folded away, for matching a counterparty name. Pure. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\/[a-z]{2}\/?$/i, "") // "ACME CORP /DE/"
    .replace(/[.,'’"()]/g, " ")
    .replace(/\b(the|incorporated|inc|corporation|corp|company|co|limited|ltd|llc|l\s?l\s?c|plc|lp|l\s?p|holdings?|group|n\s?v|s\s?a|ag|se|sa|nv|technologies|technology)\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The listed filer a counterparty name refers to, by its normalized name. */
export function matchListed(name: string, l: Listings): Listing | null {
  const n = normalizeCompanyName(name);
  if (n.length < 3) return null;
  // "BioNTech US Inc." -> "biontech us" -> "biontech": a subsidiary named after its listed parent.
  const tokens = n.split(" ");
  for (let k = tokens.length; k >= 1; k--) {
    const key = tokens.slice(0, k).join(" ");
    if (k < tokens.length && key.length < 5) break;
    const cik = l.byName.get(key);
    if (cik) return l.byCik.get(cik) ?? null;
  }
  return null;
}

/** What the submissions JSON says about a filer: SIC and its recent filings (form, date). */
export type FilerMeta = { cik: string; name: string; sic: string | null; tickers: string[]; exchanges: string[]; recent: Array<{ form: string; filingDate: string; accession: string }> };

const metaCache = new Map<string, Promise<FilerMeta | null>>();

export function parseFilerMeta(json: unknown): FilerMeta {
  const s = json as { cik?: string; name?: string; sic?: string; tickers?: string[]; exchanges?: string[]; filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[] } } };
  const r = s.filings?.recent ?? {};
  const recent = (r.form ?? []).map((form, i) => ({ form, filingDate: r.filingDate?.[i] ?? "", accession: r.accessionNumber?.[i] ?? "" }));
  return { cik: pad10(s.cik ?? "0"), name: s.name ?? "", sic: s.sic || null, tickers: s.tickers ?? [], exchanges: s.exchanges ?? [], recent };
}

/** A filer's submissions summary (cached 6 hours); null when SEC has none. */
export function filerMeta(cik: string): Promise<FilerMeta | null> {
  const key = pad10(cik);
  if (!metaCache.has(key)) {
    metaCache.set(
      key,
      secPoolGet(`https://data.sec.gov/submissions/CIK${key}.json`, 6 * HOUR_MS)
        .then((b) => parseFilerMeta(JSON.parse(b)))
        .catch((err) => {
          if (err instanceof HttpError && err.status === 404) return null;
          throw err;
        }),
    );
  }
  return metaCache.get(key)!;
}

type ConceptFact = { start?: string; end: string; val: number; fy?: number; fp?: string; form?: string; filed: string };

async function concept(cik: string, taxonomy: string, tag: string): Promise<ConceptFact[]> {
  try {
    const body = await secPoolGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${pad10(cik)}/${taxonomy}/${tag}.json`, 7 * 24 * HOUR_MS);
    const units = (JSON.parse(body) as { units?: Record<string, ConceptFact[]> }).units ?? {};
    return units.USD ?? units.shares ?? Object.values(units)[0] ?? [];
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return [];
    throw err;
  }
}

export type AnnualRevenue = { value: number; fiscalYearEnd: string; tag: string; filed: string; form: string };

/**
 * The latest fiscal year's revenue as first filed: annual facts (about a
 * year long) from a 10-K / 20-F, latest period end, earliest filing of that
 * period. Pure.
 */
export function latestAnnual(facts: ConceptFact[], tag: string): AnnualRevenue | null {
  const annual = facts.filter((f) => {
    if (!f.start || !/^(10-K|20-F|40-F)/.test(f.form ?? "")) return false;
    const days = (Date.parse(f.end) - Date.parse(f.start)) / 86_400_000;
    return days > 340 && days < 380;
  });
  if (annual.length === 0) return null;
  const end = annual.map((f) => f.end).sort().at(-1)!;
  const first = annual.filter((f) => f.end === end).sort((a, b) => a.filed.localeCompare(b.filed))[0]!;
  return { value: first.val, fiscalYearEnd: end, tag, filed: first.filed, form: first.form ?? "" };
}

/** Trailing annual revenue from `Revenues` or `RevenueFromContractWithCustomerExcludingAssessedTax`, whichever is later. */
export async function annualRevenue(cik: string): Promise<AnnualRevenue | null> {
  const tags = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"];
  const reads = await Promise.all(tags.map(async (t) => latestAnnual(await concept(cik, "us-gaap", t), t)));
  const ok = reads.filter((r): r is AnnualRevenue => r !== null && r.value > 0);
  return ok.sort((a, b) => b.fiscalYearEnd.localeCompare(a.fiscalYearEnd))[0] ?? null;
}

/** Latest `dei:EntityCommonStockSharesOutstanding` (cover page), or null. */
export async function sharesOutstanding(cik: string): Promise<{ shares: number; asOf: string } | null> {
  const facts = await concept(cik, "dei", "EntityCommonStockSharesOutstanding");
  if (facts.length === 0) return null;
  const latest = [...facts].sort((a, b) => a.end.localeCompare(b.end) || a.filed.localeCompare(b.filed)).at(-1)!;
  // Several share classes on one date are separate facts; add them up.
  const sameDay = facts.filter((f) => f.end === latest.end && f.filed === latest.filed);
  const total = sameDay.reduce((s, f) => s + f.val, 0);
  return total > 0 ? { shares: total, asOf: latest.end } : null;
}
