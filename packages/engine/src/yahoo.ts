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

import fs from "node:fs";
import path from "node:path";
import { BROWSER_USER_AGENT, ENGINE_ROOT, fetchResponse, HOUR_MS } from "./http.ts";

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
/** Set once Yahoo's session fails for this run, so every later ticker skips it at once. */
let sessionFailure: string | null = null;
const failures: string[] = [];

async function yahooSession(): Promise<{ cookie: string; crumb: string }> {
  if (session && Date.now() - session.at < HOUR_MS) return session;
  if (sessionFailure) throw new Error(sessionFailure);
  try {
    // fc.yahoo.com answers with an error status and the cookie; only network errors are retried.
    const first = await fetchResponse("https://fc.yahoo.com", { headers: { "User-Agent": BROWSER_USER_AGENT }, redirect: "manual" }, false);
    const setCookie = first.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const crumbRes = await fetchResponse("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumbRes.ok || !crumb || crumb.includes("<")) throw new Error(`Yahoo crumb unavailable (HTTP ${crumbRes.status})`);
    session = { cookie, crumb, at: Date.now() };
    return session;
  } catch (err) {
    sessionFailure = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

const cache = new Map<string, EarningsQuarterRead[]>();

/** What went wrong with Yahoo during this run (empty when it all worked), for the run summary. */
export function yahooProblems(): string[] {
  return sessionFailure ? [`session: ${sessionFailure}`, ...failures] : [...failures];
}

/** The last quarters Yahoo has for a ticker; empty when Yahoo is unreachable or has none. */
export async function yahooEarnings(ticker: string): Promise<EarningsQuarterRead[]> {
  const key = ticker.toUpperCase();
  if (cache.has(key)) return cache.get(key)!;
  let out: EarningsQuarterRead[] = [];
  try {
    const { cookie, crumb } = await yahooSession();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(key)}?modules=earnings&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetchResponse(url, { headers: { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie } });
    if (res.ok) out = parseEarnings(await res.json());
    // A 404 is a ticker Yahoo has no figures for, not a failure.
    else if (res.status !== 404) failures.push(`${key}: HTTP ${res.status}`);
  } catch (err) {
    if (!sessionFailure) failures.push(`${key}: ${err instanceof Error ? err.message : err}`);
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

/** Analyst coverage and size of a listing (src/rank.ts, low-coverage hits). */
export type CoverageRead = { analysts: number | null; marketCapUsd: number | null };

/**
 * Coverage from a quoteSummary answer with the `financialData` and `price`
 * modules: Yahoo's number of analysts with an opinion, and the market value
 * (in US dollars only; a listing quoted in another currency gets null).
 * Null when the answer has neither. Pure.
 */
export function parseCoverage(json: unknown): CoverageRead | null {
  const result = (json as { quoteSummary?: { result?: unknown[] } })?.quoteSummary?.result?.[0] as
    | { financialData?: { numberOfAnalystOpinions?: unknown }; price?: { marketCap?: unknown; currency?: unknown } }
    | undefined;
  if (!result) return null;
  const analysts = raw(result.financialData?.numberOfAnalystOpinions);
  const currency = result.price?.currency;
  const cap = currency === undefined || currency === "USD" ? raw(result.price?.marketCap) : null;
  if (analysts === null && cap === null) return null;
  return { analysts: analysts === null ? null : Math.round(analysts), marketCapUsd: cap };
}

/**
 * Coverage source (approved 2026-11-12): Yahoo quoteSummary
 * `financialData.numberOfAnalystOpinions`, through the same cookie and crumb
 * session as the EPS reads. Terms: Yahoo's terms forbid automated and
 * commercial use, so this is a stand-in until the first paying user; then a
 * licensed source (Finnhub or FMP paid) takes its place behind this function.
 *
 * Analyst counts change slowly: each read is kept on disk for
 * COVERAGE_TTL_MS (packages/engine/.cache/coverage), requests are spaced
 * COVERAGE_SPACING_MS apart, and when Yahoo cannot be read a cached copy up
 * to COVERAGE_STALE_MS old is used instead.
 */
export const COVERAGE_TTL_MS = 3 * 24 * HOUR_MS;
export const COVERAGE_STALE_MS = 30 * 24 * HOUR_MS;
export const COVERAGE_SPACING_MS = 400;
export const COVERAGE_CACHE_DIR = path.join(ENGINE_ROOT, ".cache", "coverage");

type CoverageFile = { at: number; value: CoverageRead | null };

function coverageFile(dir: string, ticker: string): string {
  return path.join(dir, `${ticker.replace(/[^A-Z0-9.-]/g, "_")}.json`);
}

/** A cached read and its age in ms, or null. */
export function readCoverageCache(dir: string, ticker: string, nowMs = Date.now()): { value: CoverageRead | null; ageMs: number } | null {
  try {
    const body = JSON.parse(fs.readFileSync(coverageFile(dir, ticker), "utf8")) as CoverageFile;
    if (typeof body?.at !== "number" || !("value" in body)) return null;
    return { value: body.value, ageMs: nowMs - body.at };
  } catch {
    return null;
  }
}

export function writeCoverageCache(dir: string, ticker: string, value: CoverageRead | null, nowMs = Date.now()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(coverageFile(dir, ticker), JSON.stringify({ at: nowMs, value } satisfies CoverageFile));
  } catch {
    // A cache that cannot be written only costs a refetch.
  }
}

const coverageCache = new Map<string, CoverageRead | null>();
let lastCoverageAt = 0;

/**
 * A ticker's analyst coverage; null when Yahoo has no figures, or cannot be
 * read and nothing is cached. Never throws.
 */
export async function yahooCoverage(ticker: string, dir: string = COVERAGE_CACHE_DIR): Promise<CoverageRead | null> {
  const key = ticker.toUpperCase();
  if (coverageCache.has(key)) return coverageCache.get(key)!;
  const cached = readCoverageCache(dir, key);
  if (cached && cached.ageMs >= 0 && cached.ageMs < COVERAGE_TTL_MS) {
    coverageCache.set(key, cached.value);
    return cached.value;
  }
  let out: CoverageRead | null = null;
  let read = false;
  try {
    const { cookie, crumb } = await yahooSession();
    const wait = lastCoverageAt + COVERAGE_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCoverageAt = Date.now();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(key)}?modules=financialData,price&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetchResponse(url, { headers: { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie } });
    if (res.ok) {
      out = parseCoverage(await res.json());
      read = true;
    } else if (res.status === 404) read = true;
    else failures.push(`${key} coverage: HTTP ${res.status}`);
  } catch (err) {
    if (!sessionFailure) failures.push(`${key} coverage: ${err instanceof Error ? err.message : err}`);
  }
  if (read) writeCoverageCache(dir, key, out);
  else if (cached && cached.ageMs < COVERAGE_STALE_MS) out = cached.value;
  coverageCache.set(key, out);
  return out;
}
