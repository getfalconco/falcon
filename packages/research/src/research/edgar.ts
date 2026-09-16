import { getConfig } from "../config.js";
import type { EdgarResearch } from "../types.js";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

type TickerEntry = { cik_str: number; ticker: string; title: string };

async function secFetch(url: string): Promise<Response> {
  const config = getConfig();
  return fetch(url, {
    headers: {
      "User-Agent": config.secUserAgent,
      Accept: "application/json",
    },
  });
}

export async function resolveCik(symbol: string): Promise<{ cik: string; name: string } | null> {
  const res = await secFetch(TICKERS_URL);
  if (!res.ok) return null;

  const data = (await res.json()) as Record<string, TickerEntry>;
  const upper = symbol.trim().toUpperCase();
  const entry = Object.values(data).find((e) => e.ticker.toUpperCase() === upper);
  if (!entry) return null;

  return { cik: String(entry.cik_str).padStart(10, "0"), name: entry.title };
}

export async function fetchEdgarResearch(symbol: string): Promise<EdgarResearch | null> {
  const resolved = await resolveCik(symbol);
  if (!resolved) return null;

  const submissionsUrl = `https://data.sec.gov/submissions/CIK${resolved.cik}.json`;
  const res = await secFetch(submissionsUrl);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    filings?: {
      recent?: {
        form?: string[];
        filingDate?: string[];
        accessionNumber?: string[];
        primaryDocument?: string[];
      };
    };
  };

  const recent = data.filings?.recent;
  if (!recent?.form) return null;

  const filings: EdgarResearch["filings"] = [];
  const targetTypes = new Set(["10-K", "10-Q", "8-K"]);

  for (let i = 0; i < recent.form.length && filings.length < 5; i++) {
    const form = recent.form[i];
    if (!form || !targetTypes.has(form)) continue;

    const accession = recent.accessionNumber?.[i]?.replace(/-/g, "");
    const doc = recent.primaryDocument?.[i];
    const filedAt = recent.filingDate?.[i] ?? "";

    filings.push({
      type: form,
      filedAt,
      excerpt: `${form} filed ${filedAt} for ${resolved.name}`,
      url: accession && doc
        ? `https://www.sec.gov/Archives/edgar/data/${resolved.cik.replace(/^0+/, "")}/${accession}/${doc}`
        : undefined,
    });
  }

  return {
    symbol: symbol.toUpperCase(),
    cik: resolved.cik,
    filings,
  };
}
