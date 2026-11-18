/**
 * `earnings(ticker)`: the last reported quarters (EPS estimate, actual,
 * surprise, release date and time of day) and the next earnings date when
 * Yahoo has one.
 *
 * Sources, as the backtester's YahooEarningsSource reads them: Yahoo's
 * earnings calendar archive (estimate, actual and release time; it currently
 * stops in mid 2025) merged with the quote summary's last four quarters
 * (`earnings` module; the release instant gives the time of day). A quarter
 * between the two can be missing. The next date and consensus come from the
 * `calendarEvents` module. EPS is Yahoo's (usually adjusted, non-GAAP) figure.
 */

import { mergeEarnings, parseEarningsCalendar, surprisePct, type EarningsEvent } from "@falcon/backtest/data";
import { yahooEarningsCalendar, yahooSummary } from "./yahoo";
import { ToolError, num, nyParts, round, type DeskToolContext } from "./util";

export const MAX_QUARTERS = 8;

type Timing = EarningsEvent["time"];

function timing(minutes: number): Timing {
  if (minutes === 0) return "unknown";
  if (minutes < 9 * 60 + 30) return "before_open";
  if (minutes >= 16 * 60) return "after_close";
  return "during";
}

type Quarter = EarningsEvent & { fiscalQuarter?: string; periodEnd?: string };

/** The quote summary's reported quarters, with the time of day when the release instant has one. Pure. */
export function quartersFromSummary(summary: Record<string, unknown> | null): Quarter[] {
  const rows = (summary?.earnings as { earningsChart?: { quarterly?: unknown[] } } | undefined)?.earningsChart?.quarterly;
  if (!Array.isArray(rows)) return [];
  const out: Quarter[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const actual = num(r.actual);
    if (actual === null) continue;
    const estimate = num(r.estimate);
    const instant = num(r.reportedDate);
    const fmt = (r.reportedDate as { fmt?: unknown } | undefined)?.fmt;
    let date: string | null = null;
    let time: Timing = "unknown";
    if (instant !== null) {
      const ny = nyParts(instant * 1000);
      // A bare date comes as midnight UTC (evening the day before in New York).
      if (instant % 86_400 === 0) date = new Date(instant * 1000).toISOString().slice(0, 10);
      else {
        date = ny.date;
        time = timing(ny.minutes);
      }
    } else if (typeof fmt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fmt)) date = fmt;
    if (!date) continue;
    const periodEnd = (r.periodEndDate as { fmt?: unknown } | undefined)?.fmt;
    out.push({
      date,
      time,
      epsActual: actual,
      epsEstimate: estimate,
      surprisePct: surprisePct(actual, estimate),
      ...(typeof r.fiscalQuarter === "string" ? { fiscalQuarter: r.fiscalQuarter } : {}),
      ...(typeof periodEnd === "string" ? { periodEnd } : {}),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The next earnings date from `calendarEvents`, when it is today or later. Pure. */
export function nextEarnings(summary: Record<string, unknown> | null, today: string) {
  const e = (summary?.calendarEvents as { earnings?: Record<string, unknown> } | undefined)?.earnings;
  if (!e) return null;
  const dates = Array.isArray(e.earningsDate) ? e.earningsDate.map(num).filter((x): x is number => x !== null) : [];
  const upcoming = dates.filter((s) => nyParts(s * 1000).date >= today || new Date(s * 1000).toISOString().slice(0, 10) >= today);
  if (!upcoming.length) return null;
  const first = upcoming[0]!;
  const dateOf = (s: number) => (s % 86_400 === 0 ? new Date(s * 1000).toISOString().slice(0, 10) : nyParts(s * 1000).date);
  const t = first % 86_400 === 0 ? "unknown" : timing(nyParts(first * 1000).minutes);
  return {
    date: dateOf(first),
    ...(upcoming.length > 1 ? { windowEnd: dateOf(upcoming[upcoming.length - 1]!) } : {}),
    time: t,
    estimated: e.isEarningsDateEstimate === true,
    epsEstimate: { average: round(num(e.earningsAverage), 3), low: round(num(e.earningsLow), 3), high: round(num(e.earningsHigh), 3) },
    revenueEstimate: { average: num(e.revenueAverage), low: num(e.revenueLow), high: num(e.revenueHigh) },
  };
}

export async function earningsTool(symbol: string, ctx: DeskToolContext, signal: AbortSignal) {
  const [summary, calendar] = await Promise.all([
    yahooSummary(symbol, "earnings,calendarEvents", signal).catch((err) => (signal.aborted ? Promise.reject(err) : null)),
    yahooEarningsCalendar(symbol, signal).catch((err) => (signal.aborted ? Promise.reject(err) : null)),
  ]);
  if (!summary && !calendar) throw new ToolError(`Yahoo has no earnings record for ${symbol} right now.`);
  const recent = quartersFromSummary(summary);
  const archive = calendar ? parseEarningsCalendar(calendar) : [];
  const merged = mergeEarnings(archive, recent) as Quarter[];
  const quarters = merged.slice(-MAX_QUARTERS).reverse();
  const today = nyParts((ctx.now?.() ?? Date.now())).date;
  const notes = [
    "surprisePct = (actual - estimate) / |estimate| x 100, Yahoo consensus; EPS as Yahoo reports it (usually adjusted, non-GAAP).",
    "time: before_open / after_close / during New York session; unknown when the source has no time.",
  ];
  for (let i = 0; i + 1 < quarters.length; i++) {
    const gap = (Date.parse(quarters[i]!.date) - Date.parse(quarters[i + 1]!.date)) / 86_400_000;
    if (gap > 130) {
      notes.push(`A quarter between ${quarters[i + 1]!.date} and ${quarters[i]!.date} is missing from Yahoo's record.`);
      break;
    }
  }
  return {
    ticker: symbol,
    quarters: quarters.map((q) => ({
      date: q.date,
      time: q.time,
      ...(q.fiscalQuarter ? { fiscalQuarter: q.fiscalQuarter } : {}),
      ...(q.periodEnd ? { periodEnd: q.periodEnd } : {}),
      epsEstimate: round(q.epsEstimate, 3),
      epsActual: round(q.epsActual, 3),
      surprisePct: round(q.surprisePct, 1),
    })),
    next: nextEarnings(summary, today),
    notes,
    source: "Yahoo Finance (earnings calendar archive + quote summary)",
  };
}
