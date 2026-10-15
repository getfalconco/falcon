/**
 * Earnings: what the two providers say, read into one shape, and the rule for
 * putting the two together for one company.
 *
 * Two sources, each with a different part of the picture:
 *
 *   Finnhub `/calendar/earnings` (market-wide, one read for every company in a
 *   date range): the date, the hour (before the open, after the close, during
 *   the session, or blank), the fiscal quarter, the consensus EPS and revenue,
 *   and, once the company has reported, the actual EPS and revenue. It does
 *   not say whether the company has announced the date, and it carries no
 *   foreign filers (TSM, ASML and the like are not in it).
 *
 *   Yahoo quote summary (one read per company):
 *     calendarEvents   the next date or the provider's window for it, whether
 *                      that is the company's date, and the consensus
 *     earningsTrend    the consensus's quarter, its currency and how many
 *                      estimates it is the mean of
 *     earnings         the last four quarters: actual and consensus EPS, the
 *                      instant each release came out, and reported revenue
 *     earningsHistory  the last quarters' EPS surprise
 *
 * Two things the Yahoo read has to be read carefully for:
 *
 *   - On the day a company reports, Yahoo keeps the report's date but moves
 *     the consensus to the NEXT quarter. A row whose release is on record is
 *     therefore built from the quarter on record, never from calendarEvents.
 *   - Revenue is in the company's reporting currency (TSM: Taiwan dollars),
 *     EPS in the listing's (TSM's ADR: US dollars). Both currencies are kept.
 *
 * Nothing is filled in that neither said.
 *
 * Pure: no fs, no network, no clock (the clock is a parameter).
 */

import type {
  EarningsConsensus,
  EarningsDateStatus,
  EarningsPhase,
  EarningsQuarter,
  EarningsSurprise,
  EarningsTime,
} from "../../shared/earnings-types";
import { nyYmdOf, releaseThresholdMs, timeOfRelease } from "../../shared/earnings-time";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A plain US listing: one to five letters and an optional class letter. Preferreds ("SEAL PR B") and when-issued lines drop out. */
const US_COMMON = /^[A-Z]{1,5}(?:[.-][A-Z])?$/;

const CURRENCY = /^[A-Z]{3}$/;

function isYmd(value: unknown): value is string {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const d = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
}

/** Yahoo numbers come as `{ raw, fmt }` or bare. */
function rawNum(value: unknown): number | null {
  if (typeof value === "number") return finite(value);
  if (value && typeof value === "object") return finite((value as { raw?: unknown }).raw);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function currency(value: unknown): string | null {
  return typeof value === "string" && CURRENCY.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;
}

/** "3Q2026" (the provider's label) as "Q3 2026"; null for anything else. */
export function fiscalLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^([1-4])Q(\d{4})$/.exec(value.trim());
  return m ? `Q${m[1]} ${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Finnhub: the market-wide calendar
// ---------------------------------------------------------------------------

export type MarketCalendarEntry = {
  ticker: string;
  date: string;
  time: EarningsTime;
  fiscalPeriod: string | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  /** Set once the company has reported. */
  epsActual?: number | null;
  revenueActual?: number | null;
};

/** Finnhub's `hour`: "bmo", "amc", "dmh", or blank when it does not know. */
export function finnhubTime(hour: unknown): EarningsTime {
  const h = typeof hour === "string" ? hour.trim().toLowerCase() : "";
  return h === "bmo" || h === "amc" || h === "dmh" ? h : "unknown";
}

/**
 * One answer of `/calendar/earnings`. `rawCount` is how many lines the
 * provider sent before any was dropped: the endpoint stops at a fixed number
 * of lines and keeps the latest dates, so a full answer means the range has
 * to be asked for in smaller pieces.
 */
export function parseFinnhubCalendar(json: unknown): { entries: MarketCalendarEntry[]; rawCount: number } {
  const list = record(json)?.earningsCalendar;
  if (!Array.isArray(list)) return { entries: [], rawCount: 0 };
  const entries: MarketCalendarEntry[] = [];
  for (const item of list) {
    const e = record(item);
    if (!e) continue;
    const ticker = typeof e.symbol === "string" ? e.symbol.trim().toUpperCase() : "";
    if (!US_COMMON.test(ticker) || !isYmd(e.date)) continue;
    const quarter = finite(e.quarter);
    const year = finite(e.year);
    const entry: MarketCalendarEntry = {
      ticker,
      date: e.date,
      time: finnhubTime(e.hour),
      fiscalPeriod: quarter !== null && year !== null && quarter >= 1 && quarter <= 4 ? `Q${quarter} ${year}` : null,
      epsEstimate: finite(e.epsEstimate),
      revenueEstimate: positive(e.revenueEstimate),
    };
    const epsActual = finite(e.epsActual);
    const revenueActual = positive(e.revenueActual);
    if (epsActual !== null) entry.epsActual = epsActual;
    if (revenueActual !== null) entry.revenueActual = revenueActual;
    entries.push(entry);
  }
  return { entries, rawCount: list.length };
}

function hasActuals(e: MarketCalendarEntry): boolean {
  return (e.epsActual ?? null) !== null || (e.revenueActual ?? null) !== null;
}

/** The same company listed twice for one day keeps the line that says more. */
export function dedupeMarketEntries(entries: readonly MarketCalendarEntry[]): MarketCalendarEntry[] {
  const score = (e: MarketCalendarEntry) =>
    (hasActuals(e) ? 4 : 0) +
    (e.time !== "unknown" ? 1 : 0) +
    (e.epsEstimate !== null ? 1 : 0) +
    (e.revenueEstimate !== null ? 1 : 0) +
    (e.fiscalPeriod ? 1 : 0);
  const byKey = new Map<string, MarketCalendarEntry>();
  for (const e of entries) {
    const key = `${e.ticker}|${e.date}`;
    const known = byKey.get(key);
    if (!known || score(e) > score(known)) byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
}

// ---------------------------------------------------------------------------
// Yahoo: one company
// ---------------------------------------------------------------------------

/** A past quarter, with the release's calendar date even when its instant is not on record. */
export type YahooQuarter = EarningsQuarter & { reportedYmd: string | null };

export type YahooEarningsRead = {
  /** The next date, or the two ends of the provider's window, sorted. Empty when it gives none. */
  dates: string[];
  /** The provider's own flag: false when the date is the company's. Null when not given. */
  estimated: boolean | null;
  /** The hour on the provider's date, read only from a company-announced single date. */
  time: EarningsTime;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  lastSurprise: EarningsSurprise | null;
  /** The currency the EPS figures are in (the listing's: US dollars for an ADR). */
  epsCurrency?: string | null;
  /** The currency the revenue figures are in (the company's reporting currency). */
  revenueCurrency?: string | null;
  /** How many estimates the consensus EPS is the mean of, and their low and high. */
  consensus?: EarningsConsensus | null;
  /** The end of the quarter the consensus is for. */
  consensusPeriodEnd?: string | null;
  /** "Q4 2026" style label of that quarter. */
  consensusFiscal?: string | null;
  /** The last quarters on record, oldest first. */
  quarters?: YahooQuarter[];
};

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The hour a Yahoo earnings date carries. The provider stamps an announced
 * report with its hour (08:30 New York for a release before the open, 16:00
 * or later after the close). Midnight, and anything inside the session, is
 * how it writes a day without an hour, so those say nothing. These stamps
 * are buckets, not the release's minute: TSM's 08:30 stamp came out at 02:08.
 */
export function yahooTime(epochSeconds: number | null, ymd: string): EarningsTime {
  if (epochSeconds === null) return "unknown";
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(epochSeconds * 1000)).map((p) => [p.type, p.value]));
  if (`${parts.year}-${parts.month}-${parts.day}` !== ymd) return "unknown";
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (!Number.isFinite(minutes) || minutes === 0) return "unknown";
  if (minutes < 9 * 60 + 30) return "bmo";
  if (minutes >= 16 * 60) return "amc";
  return "unknown";
}

/** The provider's calendar date: its own `fmt` when it is one, else the UTC date of the epoch (see market-data-service `calendarYmd`). */
function yahooYmd(value: unknown): string | null {
  const fmt = record(value)?.fmt;
  if (isYmd(fmt)) return fmt;
  const raw = rawNum(value);
  return raw === null ? null : new Date(raw * 1000).toISOString().slice(0, 10);
}

/**
 * A release instant from `reportedDate`. A stamp on midnight UTC is how the
 * provider writes a day without a time (TSM's April release reads 00:00 UTC,
 * which would be the evening before in New York), so it gives no instant.
 */
function releaseInstant(value: unknown): string | null {
  const raw = rawNum(value);
  if (raw === null || raw <= 0 || raw % 86_400 === 0) return null;
  return new Date(raw * 1000).toISOString();
}

/** Fewer than three estimates, or a spread from a loss to a profit: the mean says little. */
export function consensusThin(analysts: number | null, low: number | null, high: number | null): boolean {
  if (analysts !== null && analysts < 3) return true;
  return low !== null && high !== null && low < 0 && high > 0;
}

function readQuarters(modules: Record<string, unknown>): YahooQuarter[] {
  const earnings = record(modules.earnings);
  const chart = record(earnings?.earningsChart)?.quarterly;
  const financials = record(earnings?.financialsChart)?.quarterly;
  const revenueByLabel = new Map<string, number>();
  if (Array.isArray(financials)) {
    for (const f of financials.map(record)) {
      const label = typeof f?.date === "string" ? f.date : null;
      const revenue = rawNum(f?.revenue);
      if (label && revenue !== null && revenue > 0) revenueByLabel.set(label, revenue);
    }
  }
  const out: YahooQuarter[] = [];
  if (Array.isArray(chart)) {
    for (const q of chart.map(record)) {
      if (!q) continue;
      const label = typeof q.date === "string" ? q.date : null;
      out.push({
        periodEnd: yahooYmd(q.periodEndDate),
        fiscalQuarter: typeof q.fiscalQuarter === "string" ? q.fiscalQuarter : label,
        reportedAt: releaseInstant(q.reportedDate),
        reportedYmd: yahooYmd(q.reportedDate),
        epsActual: rawNum(q.actual),
        epsEstimate: rawNum(q.estimate),
        revenueActual: label ? (revenueByLabel.get(label) ?? null) : null,
      });
    }
  }
  return out.sort((a, b) => (a.periodEnd ?? "").localeCompare(b.periodEnd ?? ""));
}

/** The Yahoo modules read into one shape. Null when the provider has none of them. */
export function parseYahooEarnings(modules: Record<string, unknown> | null): YahooEarningsRead | null {
  if (!modules) return null;
  const calendar = record(record(modules.calendarEvents)?.earnings);
  const history = record(modules.earningsHistory)?.history;
  const quarters = readQuarters(modules);
  if (!calendar && !Array.isArray(history) && quarters.length === 0) return null;

  const stamps = (Array.isArray(calendar?.earningsDate) ? calendar!.earningsDate : [])
    .map((d) => ({ ymd: yahooYmd(d), raw: rawNum(d) }))
    .filter((d): d is { ymd: string; raw: number | null } => d.ymd !== null)
    .sort((a, b) => a.ymd.localeCompare(b.ymd));
  const dates = [...new Set(stamps.map((s) => s.ymd))];
  const flag = calendar?.isEarningsDateEstimate;
  const estimated = typeof flag === "boolean" ? flag : null;
  const single = dates.length === 1;

  let lastSurprise: EarningsSurprise | null = null;
  let historyCurrency: string | null = null;
  if (Array.isArray(history)) {
    const reported = history
      .map(record)
      .filter((h): h is Record<string, unknown> => h !== null && rawNum(h.epsActual) !== null)
      .map((h) => ({ h, end: yahooYmd(h.quarter) }))
      .sort((a, b) => (a.end ?? "").localeCompare(b.end ?? ""));
    const last = reported[reported.length - 1];
    if (last) {
      const pct = rawNum(last.h.surprisePercent);
      historyCurrency = currency(last.h.currency);
      lastSurprise = {
        quarterEnd: last.end,
        epsActual: rawNum(last.h.epsActual),
        epsEstimate: rawNum(last.h.epsEstimate),
        // The provider sends a fraction: 0.0545 is 5.45 percent.
        surprisePct: pct === null ? null : Math.round(pct * 10_000) / 100,
      };
    }
  }
  if (!lastSurprise) {
    const last = [...quarters].reverse().find((q) => q.epsActual !== null);
    if (last) {
      const est = last.epsEstimate;
      lastSurprise = {
        quarterEnd: last.periodEnd,
        epsActual: last.epsActual,
        epsEstimate: est,
        surprisePct: est !== null && est !== 0 && last.epsActual !== null ? Math.round(((last.epsActual - est) / Math.abs(est)) * 10_000) / 100 : null,
      };
    }
  }

  const trend = record(modules.earningsTrend)?.trend;
  const current = Array.isArray(trend) ? (trend.map(record).find((t) => t?.period === "0q") ?? null) : null;
  const epsBlock = record(current?.earningsEstimate);
  const revBlock = record(current?.revenueEstimate);
  const earningsModule = record(modules.earnings);
  const chart = record(earningsModule?.earningsChart);

  const low = rawNum(calendar?.earningsLow) ?? rawNum(epsBlock?.low);
  const high = rawNum(calendar?.earningsHigh) ?? rawNum(epsBlock?.high);
  const analysts = rawNum(epsBlock?.numberOfAnalysts);
  const epsEstimate = rawNum(calendar?.earningsAverage);
  const consensus: EarningsConsensus | null =
    epsEstimate === null && analysts === null ? null : { analysts, low, high, thin: consensusThin(analysts, low, high) };

  const revenue = rawNum(calendar?.revenueAverage);
  const periodEnd = typeof current?.endDate === "string" && isYmd(current.endDate) ? current.endDate : yahooYmd(chart?.currentPeriodEndDate);
  return {
    dates,
    estimated,
    time: single && estimated === false ? yahooTime(stamps[0]!.raw, dates[0]!) : "unknown",
    epsEstimate,
    revenueEstimate: revenue !== null && revenue > 0 ? revenue : null,
    lastSurprise,
    epsCurrency: currency(epsBlock?.earningsCurrency) ?? historyCurrency,
    revenueCurrency: currency(revBlock?.revenueCurrency) ?? currency(earningsModule?.financialCurrency),
    consensus,
    consensusPeriodEnd: periodEnd,
    consensusFiscal: fiscalLabel(chart?.currentFiscalQuarter),
    quarters,
  };
}

// ---------------------------------------------------------------------------
// One company's row
// ---------------------------------------------------------------------------

/** The consensus as it stood before a release, kept by the service so it survives Yahoo's rollover. */
export type ConsensusSnapshot = {
  periodEnd: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsCurrency: string | null;
  revenueCurrency: string | null;
  consensus: EarningsConsensus | null;
  /** When it was taken, epoch ms. */
  at: number;
};

/** The snapshot to keep from one read: the consensus for a quarter not yet reported. Null when there is nothing to keep. */
export function snapshotOf(read: YahooEarningsRead | null, nowMs: number): ConsensusSnapshot | null {
  if (!read?.consensusPeriodEnd) return null;
  if (read.epsEstimate === null && read.revenueEstimate === null) return null;
  // A quarter already on record is a quarter reported: its consensus is the next one's by now.
  if ((read.quarters ?? []).some((q) => q.periodEnd === read.consensusPeriodEnd && q.epsActual !== null)) return null;
  return {
    periodEnd: read.consensusPeriodEnd,
    epsEstimate: read.epsEstimate,
    revenueEstimate: read.revenueEstimate,
    epsCurrency: read.epsCurrency ?? null,
    revenueCurrency: read.revenueCurrency ?? null,
    consensus: read.consensus ?? null,
    at: nowMs,
  };
}

export type MergedEarnings = {
  date: string;
  windowEnd: string | null;
  time: EarningsTime;
  status: EarningsDateStatus;
  phase: EarningsPhase;
  releasedAt: string | null;
  fiscalPeriod: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  epsCurrency: string | null;
  consensus: EarningsConsensus | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueCurrency: string | null;
  source: "yahoo" | "finnhub";
  lastSurprise: EarningsSurprise | null;
};

export type MergeWindow = {
  /** Monday of this week: reports from here to `today` are listed when out. */
  from: string;
  today: string;
  to: string;
  nowMs: number;
  /** The kept consensus for a quarter, by its end date. */
  snapshot?: (periodEnd: string) => ConsensusSnapshot | null;
};

function phaseOf(date: string, time: EarningsTime, w: MergeWindow): EarningsPhase {
  if (date > w.today) return "upcoming";
  if (date < w.today) return "pending";
  return w.nowMs >= releaseThresholdMs(date, time) ? "pending" : "upcoming";
}

/** The Yahoo quarter released inside `from`..`today`, with its actual EPS on record. */
function reportedQuarter(yahoo: YahooEarningsRead | null, w: MergeWindow): { q: YahooQuarter; ymd: string } | null {
  const quarters = yahoo?.quarters ?? [];
  for (let i = quarters.length - 1; i >= 0; i--) {
    const q = quarters[i]!;
    if (q.epsActual === null) continue;
    const ymd = q.reportedAt ? nyYmdOf(Date.parse(q.reportedAt)) : q.reportedYmd;
    if (!ymd) continue;
    if (ymd >= w.from && ymd <= w.today) return { q, ymd };
    return null;
  }
  return null;
}

/**
 * One company's report inside `from`..`to`, from whatever the two providers
 * said of it; null when neither places one in the window.
 *
 *   - A release this week that a provider has on record is listed as
 *     reported, with the quarter's actual and its consensus as it stood
 *     before (never the next quarter's, which Yahoo shows from that day).
 *   - A date the company announced (Yahoo, not estimated) is the date. A
 *     different Finnhub day for the same company is set aside, not merged.
 *   - An estimate stays an estimate. Where Yahoo only has a window and
 *     Finnhub names a day inside it, that day is shown, still estimated.
 *   - Without a Yahoo date, the Finnhub line stands alone, and the row says
 *     it cannot tell whether the date is announced.
 *   - The hour and the consensus come from the source whose day is shown.
 *   - A date this week past its hour without figures is "pending".
 */
export function mergeEarnings(
  yahoo: YahooEarningsRead | null,
  market: readonly MarketCalendarEntry[],
  w: MergeWindow,
): MergedEarnings | null {
  const { from, today, to } = w;
  const inRange = (d: string) => d >= from && d <= to;
  const lines = [...market].filter((m) => inRange(m.date)).sort((a, b) => a.date.localeCompare(b.date));
  const sameDay = (d: string) => lines.find((m) => m.date === d) ?? null;
  const surprise = yahoo?.lastSurprise ?? null;
  const epsCurrency = yahoo?.epsCurrency ?? null;
  const revenueCurrency = yahoo?.revenueCurrency ?? null;

  // ---- out this week, on a provider's record --------------------------------
  const done = reportedQuarter(yahoo, w);
  if (done) {
    const { q, ymd } = done;
    const m = sameDay(ymd);
    const snap = q.periodEnd ? (w.snapshot?.(q.periodEnd) ?? null) : null;
    const releasedMs = q.reportedAt ? Date.parse(q.reportedAt) : null;
    // Revenue keeps one source per pair: our own record of Yahoo's consensus
    // against Yahoo's actual, else Finnhub's pair when it has both.
    let revenueEstimate = snap?.revenueEstimate ?? null;
    let revenueActual = q.revenueActual;
    let revCurrency = snap?.revenueCurrency ?? revenueCurrency;
    if (revenueEstimate === null && m && m.revenueEstimate !== null && (m.revenueActual ?? null) !== null) {
      revenueEstimate = m.revenueEstimate;
      revenueActual = m.revenueActual ?? null;
      revCurrency = revenueCurrency ?? "USD";
    }
    return {
      date: ymd,
      windowEnd: null,
      time: releasedMs !== null ? timeOfRelease(releasedMs) : m && m.time !== "unknown" ? m.time : "unknown",
      status: "confirmed",
      phase: "reported",
      releasedAt: q.reportedAt,
      fiscalPeriod: fiscalLabel(q.fiscalQuarter) ?? m?.fiscalPeriod ?? null,
      epsEstimate: q.epsEstimate ?? snap?.epsEstimate ?? null,
      epsActual: q.epsActual,
      epsCurrency: snap?.epsCurrency ?? epsCurrency,
      consensus: snap?.consensus ?? null,
      revenueEstimate,
      revenueActual,
      revenueCurrency: revCurrency,
      source: "yahoo",
      lastSurprise: surprise,
    };
  }
  const reportedLine = lines.find((m) => m.date <= today && hasActuals(m)) ?? null;
  if (reportedLine) {
    return {
      date: reportedLine.date,
      windowEnd: null,
      time: reportedLine.time,
      status: "confirmed",
      phase: "reported",
      releasedAt: null,
      fiscalPeriod: reportedLine.fiscalPeriod,
      epsEstimate: reportedLine.epsEstimate,
      epsActual: reportedLine.epsActual ?? null,
      epsCurrency,
      consensus: null,
      revenueEstimate: reportedLine.revenueEstimate,
      revenueActual: reportedLine.revenueActual ?? null,
      revenueCurrency,
      source: "finnhub",
      lastSurprise: surprise,
    };
  }

  // ---- not out yet, or out without figures -----------------------------------
  const base = (date: string, time: EarningsTime, status: EarningsDateStatus): Pick<MergedEarnings, "date" | "time" | "status" | "phase" | "releasedAt" | "epsActual" | "revenueActual" | "lastSurprise"> => ({
    date,
    time,
    status,
    phase: phaseOf(date, time, w),
    releasedAt: null,
    epsActual: null,
    revenueActual: null,
    lastSurprise: surprise,
  });
  const yahooFigures = (fiscal: string | null, m: MarketCalendarEntry | null) => ({
    fiscalPeriod: fiscal ?? yahoo?.consensusFiscal ?? null,
    epsEstimate: yahoo!.epsEstimate ?? m?.epsEstimate ?? null,
    epsCurrency,
    consensus: yahoo!.epsEstimate !== null ? (yahoo!.consensus ?? null) : null,
    revenueEstimate: yahoo!.revenueEstimate ?? m?.revenueEstimate ?? null,
    revenueCurrency,
    source: "yahoo" as const,
  });

  const dates = yahoo?.dates ?? [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  // A Yahoo date entirely behind the window is a report that has happened
  // and not yet rolled forward: it says nothing about the next one.
  if (first !== undefined && last !== undefined && last >= from) {
    const windowed = last !== first;
    const estimated = yahoo!.estimated !== false || windowed;

    if (!estimated) {
      if (!inRange(first)) return null;
      const m = sameDay(first);
      return {
        ...base(first, m && m.time !== "unknown" ? m.time : yahoo!.time, "confirmed"),
        windowEnd: null,
        ...yahooFigures(m?.fiscalPeriod ?? null, m),
      };
    }

    if (windowed) {
      const inside = lines.find((m) => m.date >= first && m.date <= last && m.date >= today) ?? null;
      if (inside) {
        return {
          ...base(inside.date, inside.time, "estimated"),
          windowEnd: null,
          ...yahooFigures(inside.fiscalPeriod, inside),
          epsEstimate: yahoo!.epsEstimate ?? inside.epsEstimate,
          revenueEstimate: yahoo!.revenueEstimate ?? inside.revenueEstimate,
        };
      }
      // A window already under way is listed from today, with its end.
      const start = first < today ? today : first;
      if (start > last || !inRange(start)) return null;
      return {
        ...base(start, "unknown", "estimated"),
        phase: "upcoming",
        windowEnd: last,
        ...yahooFigures(null, null),
      };
    }

    // An estimated single day already behind today was the provider's guess, not a report.
    if (first < today || !inRange(first)) {
      const m = lines.find((x) => x.date >= today) ?? null;
      if (!m) return null;
      return { ...base(m.date, m.time, "unknown"), windowEnd: null, fiscalPeriod: m.fiscalPeriod, epsEstimate: m.epsEstimate, epsCurrency, consensus: null, revenueEstimate: m.revenueEstimate, revenueCurrency, source: "finnhub" };
    }
    const m = sameDay(first);
    return {
      ...base(first, m?.time ?? "unknown", "estimated"),
      windowEnd: null,
      ...yahooFigures(m?.fiscalPeriod ?? null, m),
    };
  }

  // A market line alone: one already past without figures is pending only
  // when it is this week; the next one ahead is listed otherwise.
  const m = lines.find((x) => x.date >= today) ?? lines.find((x) => x.date >= from && !hasActuals(x)) ?? null;
  if (!m) return null;
  return {
    ...base(m.date, m.time, "unknown"),
    windowEnd: null,
    fiscalPeriod: m.fiscalPeriod,
    epsEstimate: m.epsEstimate,
    epsCurrency,
    consensus: null,
    revenueEstimate: m.revenueEstimate,
    revenueCurrency,
    source: "finnhub",
  };
}
