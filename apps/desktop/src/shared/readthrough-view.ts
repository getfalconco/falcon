/**
 * Read-through radar: the plain sentences and figures the card and the
 * Earnings tab's section print for a row. Every figure is the row's own
 * (main/readthrough/event-study.ts); nothing is estimated here.
 *
 * Pure: the wording comes in through `say` (the i18n table), dates and
 * numbers through Intl.
 */

import { dayDate, daysUntil, formatEps, formatMove, shortDate, type Say } from "./earnings-view";
import { READTHROUGH_MIN_EVENTS, type ReadthroughRow } from "./readthrough-types";

function numberFormat(lang: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(lang, options);
  } catch {
    return new Intl.NumberFormat("en-US", options);
  }
}

/** A size of move, no sign: "2.1%". `x` is a fraction. */
export function formatSize(x: number | null, lang: string): string | null {
  if (x === null || !Number.isFinite(x)) return null;
  return numberFormat(lang, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(x));
}

/** A ratio to one decimal: "1.6". */
export function formatRatio(x: number | null, lang: string): string | null {
  if (x === null || !Number.isFinite(x)) return null;
  return numberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x);
}

/** "today", "tomorrow", "yesterday", or the day's date. */
export function whenText(date: string, today: string, say: Say, lang: string): string {
  const d = daysUntil(today, date);
  if (d === 0) return say("readthrough.when.today");
  if (d === 1) return say("readthrough.when.tomorrow");
  if (d === -1) return say("readthrough.when.yesterday");
  return dayDate(date, lang);
}

/** The report line: "TSM reports Thu, Oct 16, after the close" or "TSM reported Tue, Oct 14 · EPS 2.92 vs 2.61". */
export function headLine(row: Pick<ReadthroughRow, "counterparty" | "kind" | "date" | "time" | "report">, today: string, say: Say, lang: string): string {
  if (!row.date) return say("readthrough.line.noDate", { counterparty: row.counterparty });
  const when = whenText(row.date, today, say, lang);
  if (row.kind === "recent") {
    const actual = formatEps(row.report?.epsActual ?? null, lang);
    const estimate = formatEps(row.report?.epsEstimate ?? null, lang);
    if (actual && estimate) return say("readthrough.line.recentEps", { counterparty: row.counterparty, when, actual, estimate });
    return say("readthrough.line.recent", { counterparty: row.counterparty, when });
  }
  if (row.time === "unknown") return say("readthrough.line.upcoming", { counterparty: row.counterparty, when });
  return say("readthrough.line.upcomingAt", { counterparty: row.counterparty, when, time: say(`readthrough.time.${row.time}`) });
}

/**
 * The measured line: "NVDA moved with it 6 of the last 8 times · average
 * 2.1% on the day, market included" (the close to close move, which the
 * Earnings section sets beside the move beyond the market), or the count of
 * reports when there are too few.
 */
export function statsLine(row: Pick<ReadthroughRow, "holding" | "counterparty" | "sample" | "stats">, say: Say, lang: string): string {
  const s = row.stats;
  if (!s) {
    if (row.sample === 0) return say("readthrough.stats.none", { holding: row.holding });
    return say("readthrough.stats.few", { holding: row.holding, count: row.sample, min: READTHROUGH_MIN_EVENTS });
  }
  return say("readthrough.stats.line", { holding: row.holding, with: s.withIt, count: s.events, avg: formatSize(s.avgAbsMove, lang) ?? "" });
}

/** For a report out this week: "NVDA +1.2% since" (and "+0.8% on the day" once that session closed). */
export function sinceLine(row: Pick<ReadthroughRow, "holding" | "report">, say: Say, lang: string): string | null {
  const r = row.report;
  if (!r) return null;
  const since = formatMove(r.holdingSince, lang);
  const onDay = formatMove(r.holdingOnDay, lang);
  if (since && onDay) return say("readthrough.since.both", { holding: row.holding, onDay, since });
  if (since) return say("readthrough.since.only", { holding: row.holding, since });
  return null;
}

/** "Supplier to NVDA", "Customer of NVDA", "Competitor of NVDA". */
export function relationText(row: Pick<ReadthroughRow, "relation" | "holding">, say: Say): string {
  return say(`readthrough.relation.${row.relation}`, { holding: row.holding });
}

/** "10-K filed Feb 26, 2026 by NVDA", for the link's tooltip. */
export function sourceHint(row: Pick<ReadthroughRow, "form" | "filingDate" | "namedBy">, say: Say, lang: string): string {
  const form = row.form ?? say("readthrough.source.filing");
  if (row.filingDate && /^\d{4}-\d{2}-\d{2}$/.test(row.filingDate)) {
    return say("readthrough.source.hint", { form, date: shortDate(row.filingDate, lang), filer: row.namedBy });
  }
  return say("readthrough.source.hintNoDate", { form, filer: row.namedBy });
}

/** The rows the card lists: the top of the ranking, one per linked company so one report does not fill the card. */
export function cardRows(rows: readonly ReadthroughRow[], limit: number): ReadthroughRow[] {
  const seen = new Set<string>();
  const out: ReadthroughRow[] = [];
  for (const r of rows) {
    if (r.kind === "later" || seen.has(r.counterparty)) continue;
    seen.add(r.counterparty);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Only safe addresses are opened: the filing on SEC.gov. */
export function safeSourceUrl(url: string | null): string | null {
  return url && /^https:\/\/(www\.)?sec\.gov\//i.test(url) ? url : null;
}

// ---------------------------------------------------------------------------
// The Stock tab's Read-through section: one name's filing links, measured
// ---------------------------------------------------------------------------

/**
 * The Stock tab's order: measured rows by sensitivity (how many usual days'
 * worth the open stock moves beyond the market on the linked company's report
 * day), then measured rows without a usual day to compare, then the rows
 * with too few reports, the larger count first.
 */
export function focusRows(rows: readonly ReadthroughRow[]): ReadthroughRow[] {
  const rank = (r: ReadthroughRow): [number, number] => {
    if (r.stats && r.stats.sensitivity !== null && Number.isFinite(r.stats.sensitivity)) return [0, -r.stats.sensitivity];
    if (r.stats) return [1, -r.stats.avgAbsAbnormal];
    return [2, -r.sample];
  };
  return [...rows].sort((a, b) => {
    const [ga, va] = rank(a);
    const [gb, vb] = rank(b);
    if (ga !== gb) return ga - gb;
    if (va !== vb) return va - vb;
    return a.counterparty.localeCompare(b.counterparty);
  });
}

/**
 * The measured sentence, with the sample size always in it: "Moves with TSM
 * reports 6 of the last 8 times · 2.4% beyond the market on the day vs 1.1% on
 * a normal day". The day and the normal day are both the move beyond the
 * market, the figures the sensitivity is taken over, and the sentence says so
 * because the Earnings tab's own line prints the close to close move. Below
 * the minimum, only the count of reports.
 */
export function focusLine(row: Pick<ReadthroughRow, "counterparty" | "sample" | "stats">, say: Say, lang: string): string {
  const s = row.stats;
  if (!s) {
    if (row.sample <= 0) return say("readthrough.focus.none");
    if (row.sample === 1) return say("readthrough.focus.fewOne");
    return say("readthrough.focus.few", { count: row.sample });
  }
  const day = formatSize(s.avgAbsAbnormal, lang) ?? "";
  const usual = formatSize(s.normalAbsAbnormal, lang);
  const base = { counterparty: row.counterparty, with: s.withIt, count: s.events, day };
  return usual ? say("readthrough.focus.line", { ...base, usual }) : say("readthrough.focus.lineDay", base);
}

/** "Reports tomorrow", "Reported Tue, Oct 14": only for a report inside the window (next four weeks, last week). */
export function focusWhen(row: Pick<ReadthroughRow, "kind" | "date">, today: string, say: Say, lang: string): string | null {
  if (!row.date || row.kind === "later") return null;
  const when = whenText(row.date, today, say, lang);
  return say(row.kind === "recent" ? "readthrough.focus.reported" : "readthrough.focus.reports", { when });
}
