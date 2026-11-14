/**
 * Rates and dividends for option pricing. Both are approximations, good
 * enough for implied volatilities at the precision the research needs.
 *
 * Risk-free rate: FRED DTB3, the 3-month T-bill secondary market rate. It is
 * quoted on a bank discount basis; we convert it to a continuously
 * compounded rate (price P = 1 - d * 91/360, r = -ln P / (91/365)) and use
 * that one rate for every expiry (a flat curve). Between 1 week and 1 year
 * the bill curve rarely spans more than ~50 bp, which moves a 30-day ATM IV
 * by well under 0.1 vol point. The value used for a day is the latest
 * observation on or before it (FRED leaves holidays empty).
 *
 * Dividends: a continuous yield from the trailing 12 months of cash
 * dividends (Yahoo chart `events=div`, split adjusted), divided by Yahoo's
 * split-adjusted close on the same day, q = ln(1 + D_12m / S). It assumes
 * the last year's dividends continue and are paid continuously; it ignores
 * discrete ex-dates, which matter for American calls just before an
 * ex-date. Yahoo is acceptable for internal research only.
 *
 * Parsers are pure; the fetchers cache through http.ts `plainGet`.
 */

import { HOUR_MS, plainGet } from "../http.ts";

export const DTB3_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3";

export type RatePoint = { date: string; pct: number };

/** FRED CSV (observation_date,DTB3; empty or "." on holidays). Pure. */
export function parseFredCsv(text: string): RatePoint[] {
  const out: RatePoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2}),\s*(-?[0-9.]+)\s*$/.exec(line.trim());
    if (m && Number.isFinite(Number(m[2]))) out.push({ date: m[1]!, pct: Number(m[2]) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Bank discount yield (percent) of a 91-day bill to a continuously compounded annual rate. Pure. */
export function discountToContinuous(pct: number, days = 91): number {
  const price = 1 - ((pct / 100) * days) / 360;
  return -Math.log(price) / (days / 365);
}

/** Continuous risk-free rate on `date`: latest DTB3 on or before it. Null when none within 10 days. Pure. */
export function rateOn(points: readonly RatePoint[], date: string): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const p = points[found]!;
  if (Date.parse(date) - Date.parse(p.date) > 10 * 86_400_000) return null;
  return discountToContinuous(p.pct);
}

export async function fetchDtb3(get: (url: string) => Promise<string> = (u) => plainGet(u, { maxAgeMs: 12 * HOUR_MS, staleOk: true })): Promise<RatePoint[]> {
  const points = parseFredCsv(await get(DTB3_URL));
  if (points.length < 100) throw new Error("FRED DTB3: unexpected answer");
  return points;
}

// ---------------------------------------------------------------------------
// Dividends

export type DividendHistory = {
  /** Cash dividends by ex-date (split adjusted). */
  dividends: Array<{ date: string; amount: number }>;
  /** Split-adjusted daily closes. */
  closes: Map<string, number>;
};

/** Yahoo chart JSON (interval=1d, events=div) to dividends and closes. Dates are New York dates. Pure. */
export function parseYahooDividends(json: unknown): DividendHistory {
  const res = (json as { chart?: { result?: Array<Record<string, unknown>> } })?.chart?.result?.[0];
  const out: DividendHistory = { dividends: [], closes: new Map() };
  if (!res) return out;
  const nyDate = (sec: number) => new Date(sec * 1000 - 5 * HOUR_MS).toISOString().slice(0, 10);
  const divs = ((res.events as Record<string, unknown> | undefined)?.dividends ?? {}) as Record<string, { amount?: number; date?: number }>;
  for (const d of Object.values(divs)) {
    if (typeof d.amount === "number" && typeof d.date === "number" && d.amount > 0) out.dividends.push({ date: nyDate(d.date), amount: d.amount });
  }
  out.dividends.sort((a, b) => (a.date < b.date ? -1 : 1));
  const ts = (res.timestamp as number[] | undefined) ?? [];
  const closes = ((res.indicators as { quote?: Array<{ close?: Array<number | null> }> } | undefined)?.quote?.[0]?.close ?? []) as Array<number | null>;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number" && c > 0) out.closes.set(nyDate(ts[i]!), c);
  }
  return out;
}

/**
 * Continuous dividend yield on `date`: ln(1 + D / S) with D the dividends of
 * ex-date in (date - 365 days, date] and S the split-adjusted close on the
 * latest day on or before `date`. `spot` overrides S (it must be on the same
 * split basis). 0 when the stock paid nothing; null when no close is known.
 */
export function dividendYieldOn(h: DividendHistory, date: string, spot?: number): number | null {
  const from = new Date(Date.parse(`${date}T12:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  let d = 0;
  for (const x of h.dividends) if (x.date > from && x.date <= date) d += x.amount;
  let s = spot;
  if (s === undefined) {
    let best: string | null = null;
    for (const k of h.closes.keys()) if (k <= date && (best === null || k > best)) best = k;
    if (best === null || Date.parse(date) - Date.parse(best) > 10 * 86_400_000) return null;
    s = h.closes.get(best)!;
  }
  if (!(s > 0)) return null;
  return Math.log(1 + d / s);
}

export async function fetchDividends(ticker: string, get: (url: string) => Promise<string> = (u) => plainGet(u, { maxAgeMs: 24 * HOUR_MS, staleOk: true })): Promise<DividendHistory> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d&events=div`;
  return parseYahooDividends(JSON.parse(await get(url)));
}
