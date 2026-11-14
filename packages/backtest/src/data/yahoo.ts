/**
 * Yahoo Finance, the free source until the first paying user (vault: then a
 * licensed source, Massive, behind the same interfaces).
 *
 * Prices: the v8 chart API, daily bars. Yahoo's open/high/low/close are split
 * adjusted only; `adjclose` is also dividend adjusted. Each bar is scaled by
 * adjclose / close so all four prices share the dividend-adjusted basis.
 *
 * Earnings: Yahoo's earnings calendar archive (the `visualization` endpoint
 * behind finance.yahoo.com/calendar/earnings) has EPS estimate, actual and
 * release time back to about 2000, but currently stops in mid 2025. The quote
 * summary's `earnings` module adds the last four quarters. A quarter between
 * the two can be missing. Both need Yahoo's cookie and "crumb".
 *
 * Survivorship: Yahoo only serves symbols that trade today; delisted names
 * return nothing. Every result carries that caveat.
 */

import type { Bar, EarningsEvent, EarningsSource, PriceSource } from "./types";
import { JsonCache } from "./cache";
import { BROWSER_USER_AGENT, PoliteFetcher, yahooFetcher } from "./http";

const HOUR = 3_600_000;
export const PRICE_TTL_MS = 12 * HOUR;
export const EARNINGS_TTL_MS = 24 * HOUR;

const toEpoch = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);

function localDate(epochSec: number, gmtOffsetSec: number): string {
  return new Date((epochSec + gmtOffsetSec) * 1000).toISOString().slice(0, 10);
}

type ChartJson = {
  chart?: {
    result?: Array<{
      meta?: {
        gmtoffset?: number;
        currentTradingPeriod?: { regular?: { start?: number; end?: number } };
      };
      timestamp?: number[];
      events?: { splits?: Record<string, { date?: number; numerator?: number; denominator?: number }> };
      indicators?: {
        quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
    }> | null;
    error?: unknown;
  };
};

const good = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Adjusted daily bars from a chart answer, oldest first. With `raw`, each
 * bar also carries the close as printed (rawClose) and dollar volume. Drops rows with a
 * missing or non-positive price, keeps the last row of a repeated date, and
 * drops today's bar while the session is still open (its "close" is not final).
 * Pure.
 */
export function parseChart(json: unknown, nowSec = Math.floor(Date.now() / 1000), opts: { raw?: boolean } = {}): Bar[] {
  const r = (json as ChartJson)?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!r || !Array.isArray(ts) || !q) return [];
  const adj = r.indicators?.adjclose?.[0]?.adjclose;
  const off = r.meta?.gmtoffset ?? -5 * 3600;
  // Yahoo's OHLC are split-adjusted. The price that printed on a day is the
  // split-adjusted one times every split ratio that happened after it.
  const splits = Object.values(r.events?.splits ?? {})
    .filter((x) => good(x.date) && good(x.numerator) && good(x.denominator))
    .map((x) => ({ date: localDate(x.date!, off), ratio: x.numerator! / x.denominator! }));
  const byDate = new Map<string, Bar>();
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (!good(o) || !good(h) || !good(l) || !good(c)) continue;
    const a = adj?.[i];
    const f = good(a) ? a / c : 1;
    const date = localDate(ts[i]!, off);
    let later = 1;
    for (const sp of splits) if (sp.date > date) later *= sp.ratio;
    const vol = q.volume?.[i] ?? 0;
    const extra = opts.raw ? { rawClose: c * later, dollarVolume: c * vol } : {};
    byDate.set(date, {
      date,
      open: o * f,
      // Yahoo occasionally prints an open outside the day's range; keep the bar self-consistent.
      high: Math.max(h, o, c) * f,
      low: Math.min(l, o, c) * f,
      close: c * f,
      volume: vol,
      ...extra,
    });
  }
  const bars = Array.from(byDate.values()).sort((x, y) => (x.date < y.date ? -1 : 1));
  const regular = r.meta?.currentTradingPeriod?.regular;
  if (bars.length && regular?.start && regular.end && nowSec < regular.end + 15 * 60) {
    if (bars[bars.length - 1]!.date === localDate(regular.start, off)) bars.pop();
  }
  return bars;
}

type CompactBars = { d: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; r?: number[]; dv?: number[] };

const round = (x: number) => Math.round(x * 1e6) / 1e6;

function pack(bars: Bar[]): CompactBars {
  return {
    d: bars.map((b) => b.date),
    o: bars.map((b) => round(b.open)),
    h: bars.map((b) => round(b.high)),
    l: bars.map((b) => round(b.low)),
    c: bars.map((b) => round(b.close)),
    v: bars.map((b) => b.volume),
    r: bars.map((b) => round(b.rawClose ?? b.close)),
    dv: bars.map((b) => Math.round(b.dollarVolume ?? b.close * b.volume)),
  };
}

function unpack(p: CompactBars): Bar[] {
  return p.d.map((date, i) => {
    const bar: Bar = { date, open: p.o[i]!, high: p.h[i]!, low: p.l[i]!, close: p.c[i]!, volume: p.v[i]! };
    if (p.r) bar.rawClose = p.r[i]!;
    if (p.dv) bar.dollarVolume = p.dv[i]!;
    return bar;
  });
}

/**
 * The whole requested span is re-fetched when the cache is stale, never
 * patched: adjusted history shifts every time a dividend is paid.
 */
export class YahooPriceSource implements PriceSource {
  readonly name = "Yahoo Finance (adjusted daily bars)";

  constructor(
    private cache: JsonCache,
    private http: PoliteFetcher = yahooFetcher,
  ) {}

  async dailyBars(ticker: string, from: string, to: string, signal?: AbortSignal): Promise<Bar[]> {
    const key = `bars-v2-${ticker}`;
    type Cached = { requestedFrom: string; bars: CompactBars };
    let hit = await this.cache.get<Cached>(key, PRICE_TTL_MS);
    if (!hit || hit.requestedFrom > from) {
      const url =
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
        `?period1=${toEpoch(from)}&period2=${Math.floor(Date.now() / 1000) + 86_400}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
      const res = await this.http.fetch(url, { headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" } }, signal);
      if (res.status === 404) {
        hit = { requestedFrom: from, bars: pack([]) };
      } else if (!res.ok) {
        throw new Error(`Yahoo chart ${ticker}: HTTP ${res.status}`);
      } else {
        hit = { requestedFrom: from, bars: pack(parseChart(await res.json(), undefined, { raw: true })) };
      }
      await this.cache.set(key, hit);
    }
    return unpack(hit.bars).filter((b) => b.date >= from && b.date <= to);
  }
}

// ---------------------------------------------------------------------------
// Earnings

export function surprisePct(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null || estimate === 0) return null;
  return Math.round(((actual - estimate) / Math.abs(estimate)) * 10_000) / 100;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function timeOfDay(localMinutes: number): EarningsEvent["time"] {
  if (localMinutes === 0) return "unknown"; // midnight means Yahoo has no time
  if (localMinutes < 9 * 60 + 30) return "before_open";
  if (localMinutes >= 16 * 60) return "after_close";
  return "during";
}

/** Reported quarters from a `visualization` (earnings calendar) answer, oldest first. Pure. */
export function parseEarningsCalendar(json: unknown): EarningsEvent[] {
  const doc = (json as { finance?: { result?: Array<{ documents?: Array<{ columns?: { id: string }[]; rows?: unknown[][] }> }> } })
    ?.finance?.result?.[0]?.documents?.[0];
  if (!doc?.columns || !Array.isArray(doc.rows)) return [];
  const col = new Map(doc.columns.map((c, i) => [c.id, i]));
  const get = (row: unknown[], id: string) => {
    const i = col.get(id);
    return i === undefined ? undefined : row[i];
  };
  const out: EarningsEvent[] = [];
  for (const row of doc.rows) {
    if (!Array.isArray(row)) continue;
    const start = get(row, "startdatetime");
    if (typeof start !== "string") continue;
    const eventName = get(row, "eventname");
    if (typeof eventName === "string" && eventName.trim()) continue; // shareholder meetings and the like
    const epsActual = num(get(row, "epsactual"));
    const epsEstimate = num(get(row, "epsestimate"));
    if (epsActual === null) continue; // not reported yet
    const offMs = num(get(row, "gmtOffsetMilliSeconds")) ?? -5 * HOUR;
    const local = new Date(Date.parse(start) + offMs);
    if (Number.isNaN(local.getTime())) continue;
    const given = num(get(row, "epssurprisepct"));
    out.push({
      date: local.toISOString().slice(0, 10),
      time: timeOfDay(local.getUTCHours() * 60 + local.getUTCMinutes()),
      epsActual,
      epsEstimate,
      surprisePct: surprisePct(epsActual, epsEstimate) ?? given,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The last four quarters from a quote summary (`earnings` module), oldest first. Pure. */
export function parseQuoteSummaryEarnings(json: unknown): EarningsEvent[] {
  const rows = (json as { quoteSummary?: { result?: Array<{ earnings?: { earningsChart?: { quarterly?: unknown[] } } }> } })
    ?.quoteSummary?.result?.[0]?.earnings?.earningsChart?.quarterly;
  if (!Array.isArray(rows)) return [];
  const raw = (v: unknown) => num(v) ?? (v && typeof v === "object" ? num((v as { raw?: unknown }).raw) : null);
  const out: EarningsEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const rd = r.reportedDate;
    let date: string | null = null;
    if (rd && typeof rd === "object" && typeof (rd as { fmt?: unknown }).fmt === "string") date = (rd as { fmt: string }).fmt;
    else if (raw(rd) !== null) date = new Date(raw(rd)! * 1000).toISOString().slice(0, 10);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const epsActual = raw(r.actual);
    const epsEstimate = raw(r.estimate);
    if (epsActual === null) continue;
    out.push({ date, time: "unknown", epsActual, epsEstimate, surprisePct: surprisePct(epsActual, epsEstimate) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Calendar rows win; a quote-summary row within 5 days of one is the same quarter. Pure. */
export function mergeEarnings(calendar: EarningsEvent[], recent: EarningsEvent[]): EarningsEvent[] {
  const out = [...calendar];
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  for (const r of recent) {
    if (!out.some((c) => Math.abs(day(c.date) - day(r.date)) <= 5)) out.push(r);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

type Session = { cookie: string; crumb: string; at: number };

export class YahooEarningsSource implements EarningsSource {
  readonly name = "Yahoo Finance (earnings calendar archive + quote summary)";
  private session: Session | null = null;

  constructor(
    private cache: JsonCache,
    private http: PoliteFetcher = yahooFetcher,
  ) {}

  private async getSession(signal?: AbortSignal): Promise<Session> {
    if (this.session && Date.now() - this.session.at < HOUR) return this.session;
    const first = await this.http.fetch("https://fc.yahoo.com", { headers: { "User-Agent": BROWSER_USER_AGENT }, redirect: "manual" }, signal);
    const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const res = await this.http.fetch(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      { headers: { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie } },
      signal,
    );
    const crumb = (await res.text()).trim();
    if (!res.ok || !crumb || crumb.includes("<") || crumb.length > 64) throw new Error("Yahoo session (crumb) unavailable");
    this.session = { cookie, crumb, at: Date.now() };
    return this.session;
  }

  private async fetchAll(ticker: string, signal?: AbortSignal): Promise<EarningsEvent[]> {
    const { cookie, crumb } = await this.getSession(signal);
    const headers = { "User-Agent": BROWSER_USER_AGENT, Cookie: cookie, "Content-Type": "application/json" };
    const body = {
      sortType: "DESC",
      entityIdType: "earnings",
      sortField: "startdatetime",
      includeFields: ["ticker", "eventname", "startdatetime", "startdatetimetype", "epsestimate", "epsactual", "epssurprisepct", "gmtOffsetMilliSeconds"],
      query: { operator: "and", operands: [{ operator: "eq", operands: ["ticker", ticker] }] },
      offset: 0,
      size: 250,
    };
    const [calRes, qsRes] = await Promise.all([
      this.http.fetch(
        `https://query1.finance.yahoo.com/v1/finance/visualization?crumb=${encodeURIComponent(crumb)}&lang=en-US&region=US`,
        { method: "POST", headers, body: JSON.stringify(body) },
        signal,
      ),
      this.http.fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=earnings&crumb=${encodeURIComponent(crumb)}`,
        { headers },
        signal,
      ),
    ]);
    if (!calRes.ok && !qsRes.ok) {
      if (calRes.status === 401 || calRes.status === 403) this.session = null;
      throw new Error(`Yahoo earnings ${ticker}: HTTP ${calRes.status}/${qsRes.status}`);
    }
    const calendar = calRes.ok ? parseEarningsCalendar(await calRes.json()) : [];
    const recent = qsRes.ok ? parseQuoteSummaryEarnings(await qsRes.json()) : [];
    return mergeEarnings(calendar, recent);
  }

  async earnings(ticker: string, from: string, to: string, signal?: AbortSignal): Promise<EarningsEvent[]> {
    const key = `earnings-v1-${ticker}`;
    let all = await this.cache.get<EarningsEvent[]>(key, EARNINGS_TTL_MS);
    if (!all) {
      all = await this.fetchAll(ticker, signal);
      await this.cache.set(key, all);
    }
    return all.filter((e) => e.date >= from && e.date <= to);
  }
}
