/**
 * Yahoo Finance earnings: EPS actual vs the consensus for the last quarters,
 * read from the quote summary (`earnings` module). Yahoo needs a cookie and a
 * "crumb" for this endpoint; both come from its own pages. When Yahoo is not
 * reachable the engine still runs on EDGAR alone (no surprise figure).
 *
 * Reading notes (from the old desktop app, still true):
 *   - On the day a company reports, the consensus in `calendarEvents` already
 *     moves to the next quarter; the reported quarter is read from
 *     `earningsChart.quarterly`, never from calendarEvents.
 *   - EPS is in the listing's currency (an ADR: US dollars).
 */

import { BROWSER_USER_AGENT, HOUR_MS } from "./http.ts";

export type EarningsQuarterRead = {
  /** Yahoo's label, e.g. "3Q2026" (calendar quarter for most US filers). */
  fiscalQuarter: string;
  periodEnd: string | null;
  /** The day the release came out (New York calendar date as Yahoo writes it). */
  reportedDate: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  /** (actual - estimate) / |estimate| * 100, rounded to one decimal; null without both. */
  surprisePct: number | null;
};

function raw(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const r = (v as { raw?: unknown }).raw;
    if (typeof r === "number" && Number.isFinite(r)) return r;
  }
  return null;
}

function fmtDate(v: unknown): string | null {
  if (v && typeof v === "object") {
    const fmt = (v as { fmt?: unknown }).fmt;
    if (typeof fmt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fmt)) return fmt;
    const r = raw(v);
    if (r !== null) return new Date(r * 1000).toISOString().slice(0, 10);
  }
  return null;
}

export function surprisePct(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null || estimate === 0) return null;
  return Math.round(((actual - estimate) / Math.abs(estimate)) * 1000) / 10;
}

/** The quarters in a quoteSummary answer, oldest first. Pure. */
export function parseEarnings(json: unknown): EarningsQuarterRead[] {
  const result = (json as { quoteSummary?: { result?: unknown[] } })?.quoteSummary?.result?.[0] as
    | { earnings?: { earningsChart?: { quarterly?: unknown[] } } }
    | undefined;
  const rows = result?.earnings?.earningsChart?.quarterly;
  if (!Array.isArray(rows)) return [];
  const out: EarningsQuarterRead[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const epsActual = raw(r.actual);
    const epsEstimate = raw(r.estimate);
    out.push({
      fiscalQuarter: typeof r.fiscalQuarter === "string" ? r.fiscalQuarter : typeof r.date === "string" ? r.date : "",
      periodEnd: fmtDate(r.periodEndDate),
      reportedDate: fmtDate(r.reportedDate),
      epsActual,
      epsEstimate,
      surprisePct: surprisePct(epsActual, epsEstimate),
    });
  }
  return out;
}

let session: { cookie: string; crumb: string; at: number } | null = null;

async function yahooSession(): Promise<{ cookie: string; crumb: string }> {
  if (session && Date.now() - session.at < HOUR_MS) return session;
  const first = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": BROWSER_USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = first.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie },
    signal: AbortSignal.timeout(15_000),
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumbRes.ok || !crumb || crumb.includes("<")) throw new Error("Yahoo crumb unavailable");
  session = { cookie, crumb, at: Date.now() };
  return session;
}

const cache = new Map<string, EarningsQuarterRead[]>();

/** The last quarters Yahoo has for a ticker; empty when Yahoo is unreachable or has none. */
export async function yahooEarnings(ticker: string): Promise<EarningsQuarterRead[]> {
  const key = ticker.toUpperCase();
  if (cache.has(key)) return cache.get(key)!;
  let out: EarningsQuarterRead[] = [];
  try {
    const { cookie, crumb } = await yahooSession();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(key)}?modules=earnings&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) out = parseEarnings(await res.json());
  } catch {
    out = [];
  }
  cache.set(key, out);
  return out;
}

export function yahooQuoteUrl(ticker: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/analysis`;
}

/** The quarter reported on (or within a day after) `ymd`, if Yahoo has it. */
export function quarterReportedOn(quarters: EarningsQuarterRead[], ymd: string): EarningsQuarterRead | null {
  const day = Date.parse(`${ymd}T12:00:00Z`);
  let best: EarningsQuarterRead | null = null;
  for (const q of quarters) {
    if (!q.reportedDate) continue;
    const d = Date.parse(`${q.reportedDate}T12:00:00Z`);
    // An after-close release is often filed the next morning, or dated the day after by Yahoo.
    if (Math.abs(d - day) <= 1.5 * 86_400_000) best = q;
  }
  return best;
}
