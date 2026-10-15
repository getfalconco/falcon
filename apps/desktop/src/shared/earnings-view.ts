/**
 * Earnings tab and card: how the rows main sends are grouped, filtered,
 * counted down to and printed.
 *
 * Everything here is worded through `say` (the renderer passes its `t`), with
 * the keys of the earnings message area, so the tab and the card read the
 * same in every language. Numbers are printed as the provider gave them,
 * rounded for reading and never filled in: a missing figure is null here and
 * the caller prints its "not available" mark.
 *
 * Pure: "today" is a parameter.
 */

import type { CalendarSector } from "./calendar-events";
import type { EarningsReaction, EarningsRow, EarningsTime } from "./earnings-types";
import { reasonRank } from "./earnings-foryou";

export type Say = (key: string, params?: Record<string, string | number>) => string;

const DAY_MS = 86_400_000;

function noonUtc(ymd: string): number {
  return Date.parse(`${ymd}T12:00:00.000Z`);
}

/** Whole calendar days from `today` to `date`. */
export function daysUntil(today: string, date: string): number {
  return Math.round((noonUtc(date) - noonUtc(today)) / DAY_MS);
}

/** `ymd` moved by `n` calendar days. */
export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(noonUtc(ymd));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's New York calendar date: the reports are dated in New York. */
export function nyToday(now: Date = new Date()): string {
  return NY_DATE.format(now);
}

function plural(lang: string, count: number): "one" | "other" {
  try {
    return new Intl.PluralRules(lang).select(count) === "one" ? "one" : "other";
  } catch {
    return count === 1 ? "one" : "other";
  }
}

/** "today", "tomorrow", "in 12 days". */
export function whenText(days: number, say: Say, lang: string): string {
  if (days <= 0) return say("earnings.when.today");
  if (days === 1) return say("earnings.when.tomorrow");
  return say(`earnings.when.inDays.${plural(lang, days)}`, { count: days });
}

/** "12 reports". */
export function countText(count: number, say: Say, lang: string): string {
  return say(`earnings.count.${plural(lang, count)}`, { count });
}

/**
 * The card's line: "NVDA reports in 12 days", "AAPL reports today, after the
 * close". A countdown to a scheduled date, never a word about what it brings.
 */
export function countdownLine(row: Pick<EarningsRow, "ticker" | "date" | "time">, today: string, say: Say, lang: string): string {
  const when = whenText(daysUntil(today, row.date), say, lang);
  if (row.time === "unknown") return say("earnings.card.reports", { ticker: row.ticker, when });
  return say("earnings.card.reportsAt", { ticker: row.ticker, when, time: say(`earnings.timePhrase.${row.time}`) });
}

function formatter(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(lang, { ...options, timeZone: "UTC" });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
}

/** "Thu, Oct 22" in the reader's language. */
export function dayDate(ymd: string, lang: string): string {
  return formatter(lang, { weekday: "short", month: "short", day: "numeric" }).format(new Date(noonUtc(ymd)));
}

/** "Oct 22" in the reader's language. */
export function shortDate(ymd: string, lang: string): string {
  return formatter(lang, { month: "short", day: "numeric" }).format(new Date(noonUtc(ymd)));
}

export type DayGroup = {
  date: string;
  daysUntil: number;
  /** "Today", "Tomorrow", or the day's date. */
  title: string;
  /** The date beside "Today" and "Tomorrow"; null when the title is already the date. */
  subtitle: string | null;
  rows: EarningsRow[];
};

/** Rows by day, in date order; the rows keep the order they came in. */
export function groupByDay(rows: readonly EarningsRow[], today: string, say: Say, lang: string): DayGroup[] {
  const groups = new Map<string, EarningsRow[]>();
  for (const row of rows) {
    const list = groups.get(row.date);
    if (list) list.push(row);
    else groups.set(row.date, [row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const days = daysUntil(today, date);
      const named = days === 0 ? say("earnings.day.today") : days === 1 ? say("earnings.day.tomorrow") : null;
      return { date, daysUntil: days, title: named ?? dayDate(date, lang), subtitle: named ? dayDate(date, lang) : null, rows: list };
    });
}

export type EarningsFilters = {
  query: string;
  /** Null for every sector; "Unclassified" also matches rows without one. */
  sector: CalendarSector | null;
  time: EarningsTime | null;
  /** The last date shown, included. */
  through: string | null;
};

export const NO_FILTERS: EarningsFilters = { query: "", sector: null, time: null, through: null };

export function filtersActive(f: EarningsFilters): boolean {
  return f.query.trim() !== "" || f.sector !== null || f.time !== null;
}

export function filterRows(rows: readonly EarningsRow[], f: EarningsFilters): EarningsRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.through !== null && r.date > f.through) return false;
    if (f.time !== null && r.time !== f.time) return false;
    if (f.sector !== null && (r.sector ?? "Unclassified") !== f.sector) return false;
    if (q && !r.ticker.toLowerCase().startsWith(q) && !(r.company ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
}

/** The sectors the rows fall in, in the calendar's order of sectors. */
export function sectorsIn(rows: readonly EarningsRow[], order: readonly CalendarSector[]): CalendarSector[] {
  const present = new Set(rows.map((r) => r.sector ?? "Unclassified"));
  return order.filter((s) => present.has(s));
}

function numberFormat(lang: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(lang, options);
  } catch {
    return new Intl.NumberFormat("en-US", options);
  }
}

/** EPS to the cent, in the company's reporting currency (not named: the providers do not say it). */
export function formatEps(value: number | null, lang: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return numberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** Revenue, compact: "16.8B". */
export function formatRevenue(value: number | null, lang: string): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return numberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** The surprise with its sign: "+5.4%", "-0.1%". */
export function formatSurprise(pct: number | null, lang: string): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return numberFormat(lang, { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(pct / 100);
}

/** The brief an earnings-watch agent starts from, in the reader's language. */
export function agentBrief(row: Pick<EarningsRow, "ticker" | "date">, say: Say, lang: string): string {
  return say("earnings.agentBrief", { ticker: row.ticker, date: shortDate(row.date, lang) });
}

/** The card's few rows: the next reports, soonest first, held before watched on the same day. */
export function nextReports(rows: readonly EarningsRow[], limit: number): EarningsRow[] {
  return [...rows]
    .sort((a, b) => a.date.localeCompare(b.date) || Number(b.held) - Number(a.held) || a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// v2: names, sections, the header line, moves and figures
// ---------------------------------------------------------------------------

/** Words a listing directory tacks onto a company name that a table does not need. */
const NAME_TAIL =
  /(?:[,\s]+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|l\.p|n\.v|nv|s\.a|sa|se|ag|holdings?|group|class [a-c]|common stock|ordinary shares?|american depositary shares?|ads|adr|sponsored)\.?)+$/i;

/**
 * A company name short enough for a table: "Taiwan Semiconductor
 * Manufacturing Company Ltd." reads "Taiwan Semiconductor Manufacturing",
 * "NVIDIA Corporation" reads "NVIDIA". Never shorter than one word.
 */
export function shortCompanyName(name: string | null): string | null {
  if (!name) return null;
  let s = name.replace(/\s+-\s+.*$/, "").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(NAME_TAIL, "")
      .replace(/(?:[,\s]+(?:&|and))+$/i, "")
      .replace(/[,\s]+$/, "")
      .trim();
    if (!next || next === s) break;
    s = next;
  }
  return s || name.trim();
}

export type EarningsSectionKey = "reported" | "today" | "upcoming";

export type EarningsSection = {
  key: EarningsSectionKey;
  title: string;
  /** Reported this week: newest first. Today: by hour. Upcoming: by day. */
  rows: EarningsRow[];
  /** Upcoming only: the rows by day. */
  days: DayGroup[];
};

/** Out (with or without figures) this week: the rows a "Reported this week" section lists. */
export function isOut(row: Pick<EarningsRow, "phase">): boolean {
  return row.phase === "reported" || row.phase === "pending";
}

const TIME_RANK: Record<EarningsTime, number> = { bmo: 0, dmh: 1, amc: 2, unknown: 3 };

/** Rows in three sections, in this order: reported this week, today, upcoming. Empty sections are left out. */
export function sectionRows(rows: readonly EarningsRow[], today: string, say: Say, lang: string): EarningsSection[] {
  const mine = (r: EarningsRow) => (r.reason ? reasonRank(r.reason) : r.held ? 0 : r.watchlist ? 1 : 2);
  const reported = rows
    .filter((r) => isOut(r))
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") ||
        mine(a) - mine(b) ||
        a.ticker.localeCompare(b.ticker),
    );
  const todayRows = rows
    .filter((r) => !isOut(r) && r.date <= today)
    .sort((a, b) => TIME_RANK[a.time] - TIME_RANK[b.time] || mine(a) - mine(b) || a.ticker.localeCompare(b.ticker));
  const upcoming = rows.filter((r) => !isOut(r) && r.date > today);
  const out: EarningsSection[] = [];
  if (reported.length) out.push({ key: "reported", title: say("earnings.section.reported"), rows: reported, days: [] });
  if (todayRows.length) out.push({ key: "today", title: say("earnings.section.today"), rows: todayRows, days: [] });
  if (upcoming.length) {
    out.push({ key: "upcoming", title: say("earnings.section.upcoming"), rows: upcoming, days: groupByDay(upcoming, today, say, lang) });
  }
  return out;
}

/** "today", "yesterday", or "on Tuesday", for a day this week. */
export function pastDayText(date: string, today: string, say: Say, lang: string): string {
  const back = daysUntil(date, today);
  if (back <= 0) return say("earnings.when.today");
  if (back === 1) return say("earnings.when.yesterday");
  return say("earnings.when.onDay", { day: formatter(lang, { weekday: "long" }).format(new Date(noonUtc(date))) });
}

/**
 * The line over the table, from the rows and nothing else: how many of the
 * reader's names report in the next two weeks, and the report out this week
 * that reads through to the most of them. Null when there is nothing to say.
 */
export function headerLine(rows: readonly EarningsRow[], today: string, say: Say, lang: string, horizonDays = 14): string | null {
  const mine = (r: EarningsRow) => r.held || r.watchlist;
  const last = addDaysYmd(today, horizonDays - 1);
  const ahead = new Set(rows.filter((r) => mine(r) && !isOut(r) && r.date >= today && r.date <= last).map((r) => r.ticker)).size;
  const parts: string[] = [];
  if (ahead > 0) parts.push(say("earnings.header.ahead." + plural(lang, ahead), { count: ahead }));
  else if (rows.some(mine)) parts.push(say("earnings.header.noneAhead"));

  const out = rows.filter((r) => isOut(r) && (r.readsThrough.length > 0 || mine(r)));
  out.sort(
    (a, b) =>
      b.readsThrough.length - a.readsThrough.length ||
      Number(mine(b)) - Number(mine(a)) ||
      b.date.localeCompare(a.date) ||
      a.ticker.localeCompare(b.ticker),
  );
  const top = out[0];
  if (top) {
    const when = pastDayText(top.date, today, say, lang);
    const n = top.readsThrough.length;
    const verb = top.phase === "reported" ? "reported" : "due";
    parts.push(
      n > 0
        ? say("earnings.header." + verb + "Links." + plural(lang, n), { ticker: top.ticker, when, count: n })
        : say("earnings.header." + verb, { ticker: top.ticker, when }),
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/** A move as a signed percent: "+2.9%", "-0.4%". `move` is a fraction. */
export function formatMove(move: number | null, lang: string): string | null {
  if (move === null || !Number.isFinite(move)) return null;
  return numberFormat(lang, { style: "percent", signDisplay: "exceptZero", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(move);
}

/** A typical size of move, either way: "±4.1%". `move` is a fraction. */
export function formatUsualMove(move: number | null, lang: string): string | null {
  if (move === null || !Number.isFinite(move)) return null;
  return "±" + numberFormat(lang, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(move));
}

/** Revenue with its currency when it is not the dollar: "1.7T TWD"; "16.8B" for dollars. */
export function formatRevenueIn(value: number | null, currency: string | null, lang: string): string | null {
  const v = formatRevenue(value, lang);
  if (v === null) return null;
  return currency && currency !== "USD" ? v + " " + currency : v;
}

/** Dollars, compact: "$52.5B". */
export function formatUsd(value: number | null, lang: string): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return numberFormat(lang, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** EPS with its currency when it is not the dollar. */
export function formatEpsIn(value: number | null, currency: string | null, lang: string): string | null {
  const v = formatEps(value, lang);
  if (v === null) return null;
  return currency && currency !== "USD" ? v + " " + currency : v;
}

/**
 * The consensus EPS as it should be read: the mean, or, when the mean says
 * little (fewer than three estimates, or a spread from a loss to a profit),
 * the low and high it is the mean of.
 */
export function consensusText(row: Pick<EarningsRow, "epsEstimate" | "consensus">, say: Say, lang: string): { text: string | null; thin: boolean } {
  const c = row.consensus;
  if (c?.thin && c.low !== null && c.high !== null && c.low !== c.high) {
    return { text: say("earnings.cell.range", { low: formatEps(c.low, lang)!, high: formatEps(c.high, lang)! }), thin: true };
  }
  return { text: formatEps(row.epsEstimate, lang), thin: false };
}

const NY_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "16:20 ET" for a release on record; null otherwise. */
export function releaseTimeText(releasedAt: string | null, say: Say): string | null {
  if (!releasedAt) return null;
  const ms = Date.parse(releasedAt);
  if (!Number.isFinite(ms)) return null;
  return say("earnings.time.at", { time: NY_TIME.format(new Date(ms)) });
}

/** The card's line for a report out: "TSM reported today". */
export function reportedLine(row: Pick<EarningsRow, "ticker" | "date">, today: string, say: Say, lang: string): string {
  return say("earnings.card.reported", { ticker: row.ticker, when: pastDayText(row.date, today, say, lang) });
}

/**
 * The card's rows: the reader's own names first (a report out today, then
 * the next ones, soonest first), then, while there is room, the rest of the
 * "For you" list in its order of reasons.
 */
export function cardRows(rows: readonly EarningsRow[], today: string, limit: number): EarningsRow[] {
  const own = (r: EarningsRow) => r.held || r.watchlist;
  const pick = (list: readonly EarningsRow[]) => {
    const outToday = list.filter((r) => r.phase === "reported" && r.date === today);
    const next = list.filter((r) => !isOut(r) && r.date >= today);
    return [...outToday, ...nextReports(next, limit)];
  };
  const others = pick(rows.filter((r) => !own(r))).sort(
    (a, b) => reasonRank(a.reason) - reasonRank(b.reason) || a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker),
  );
  return [...pick(rows.filter(own)), ...others].slice(0, limit);
}

/**
 * The move a reported row is judged by: the close-to-close move of the
 * session that first traded it, from the closes once that session is over,
 * from the live quote while it is today (or, for a release after today's
 * close, the move since the close). `live` is the quote's move as a fraction.
 */
export function dayMoveOf(
  reactionDay: string,
  today: string,
  reaction: Pick<EarningsReaction, "moves"> | null,
  live: number | null,
): { move: number | null; live: boolean } {
  if (reactionDay < today) {
    const m = reaction?.moves.find((x) => x.reactionDay === reactionDay);
    return { move: m ? m.move : null, live: false };
  }
  return { move: live, live: live !== null };
}

/** "Fiscal Q3 2026", from either label the providers use ("Q3 2026" or "3Q2026"). */
export function fiscalText(label: string, say: Say): string {
  const m = /^([1-4])Q(\d{4})$/.exec(label.trim());
  return say("earnings.fiscal", { period: m ? "Q" + m[1] + " " + m[2] : label });
}
