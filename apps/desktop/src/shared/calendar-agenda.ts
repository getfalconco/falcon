/**
 * The reader's own agenda: the dated events of the names they hold and
 * follow, for the Calendar tab's "Your positions" column and its event
 * detail countdown.
 *
 * The market calendar (CPI, FOMC, housing starts) is the same for every
 * reader. What sets one reader's weeks apart is "NVDA reports in 12 days" and
 * "XOM goes ex-dividend tomorrow", so those are listed held names first, then
 * the watchlist.
 *
 * The dates are the ones the app already reads: the provider's corporate
 * calendar (`calendar:corporate`, the Calendar tab's own pipeline and cache)
 * and the handover report's earnings for held names, which know the hour
 * (before the open or after the close) and are preferred where both speak.
 * Nothing here guesses a date; a projected one says it is estimated.
 *
 * Pure: "today" is a parameter, every string goes through `BriefingText`.
 */

import { ENGLISH, formatterFor, ymdNoonUtc, type BriefingKey, type BriefingText } from "./briefing-text";
import type { CalendarCorporateEvent, CorporateEventKind } from "./calendar-events";
import { EARNINGS_HORIZON_SESSIONS, addTradingDays, type HeldEarnings } from "./calendar-types";

/** How far ahead the agenda looks for the reader's own dates. A quarter apart, earnings need about half of one to show for most names. */
export const AGENDA_HORIZON_DAYS = 45;

const TIER_RANK: Record<"held" | "watchlist", number> = { held: 0, watchlist: 1 };

// ---------------------------------------------------------------------------
// The reader's own rows
// ---------------------------------------------------------------------------

export type AgendaRow = {
  id: string;
  tier: "held" | "watchlist";
  kind: CorporateEventKind;
  ticker: string;
  /** NY calendar date. */
  date: string;
  /** Calendar days from today, 0 for today. */
  daysUntil: number;
  /** "NVDA reports in 12 days", "XOM goes ex-dividend tomorrow". */
  text: string;
  /** "Before the open." style second line, or null. */
  detail: string | null;
  /** "Oct 22", or "today". */
  dateLabel: string;
  estimated: boolean;
};

export type AgendaInput = {
  /** Today's NY calendar date. */
  today: string;
  held: readonly string[];
  watchlist: readonly string[];
  /** The provider's corporate dates for held and followed names; empty while they are read or when they could not be. */
  corporate: readonly CalendarCorporateEvent[];
  /** The handover report's next earnings for held names, which carry the hour. */
  earnings?: readonly HeldEarnings[];
  /**
   * The report's session, when there is a report. Through its earnings reach
   * the report has already decided a held name's earnings (and preferred the
   * company's own date), so the provider's earnings row for a held name there
   * is left out, exactly as the Calendar tab's grid leaves it out.
   */
  reportSession?: string | null;
  horizonDays?: number;
  text?: BriefingText;
};

export type Agenda = {
  /** Held names first, then the watchlist; each by date. */
  rows: AgendaRow[];
  /** One honest line about what the list is, when it is not simply the reader's positions. */
  note: string | null;
};

const KIND_ORDER: Record<CorporateEventKind, number> = { earnings: 0, ex_dividend: 1, dividend_payment: 2, split: 3 };

const DAY_MS = 86_400_000;

/** Whole calendar days from `from` to `to`, both NY dates; null when either will not parse. */
export function daysBetween(from: string, to: string): number | null {
  const a = ymdNoonUtc(from);
  const b = ymdNoonUtc(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function pluralKey(locale: string, count: number, one: BriefingKey, other: BriefingKey): BriefingKey {
  try {
    return new Intl.PluralRules(locale).select(count) === "one" ? one : other;
  } catch {
    return count === 1 ? one : other;
  }
}

/** "today", "tomorrow", "in 12 days", in the reader's language. */
export function whenWords(daysUntil: number, text: BriefingText = ENGLISH): string {
  if (daysUntil <= 0) return text.t("briefing.agenda.today");
  if (daysUntil === 1) return text.t("briefing.agenda.tomorrow");
  return text.t(pluralKey(text.locale, daysUntil, "briefing.agenda.inDays.one", "briefing.agenda.inDays.other"), { count: daysUntil });
}

/** "Oct 22" in the reader's language; "today" for today. */
export function agendaDateLabel(ymd: string, daysUntil: number, text: BriefingText = ENGLISH): string {
  if (daysUntil === 0) return text.t("briefing.agenda.today");
  const at = ymdNoonUtc(ymd);
  if (!at) return ymd;
  return formatterFor(text.locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(at);
}

const SPLIT_TITLE = /(\d+(?:\.\d+)?)-for-(\d+(?:\.\d+)?) (reverse split|split)$/;

function splitRatio(e: CalendarCorporateEvent): { num: number; den: number; reverse: boolean } | null {
  const params = e.words?.title?.params;
  if (params && typeof params.num === "number" && typeof params.den === "number") {
    return { num: params.num, den: params.den, reverse: params.num < params.den };
  }
  const m = SPLIT_TITLE.exec(e.title ?? "");
  return m ? { num: Number(m[1]), den: Number(m[2]), reverse: m[3] !== "split" } : null;
}

/**
 * The one sentence a dated event gets: a countdown to a scheduled date, worded
 * as a fact about the calendar, never as what the date will bring.
 */
export function countdownSentence(
  kind: CorporateEventKind,
  ticker: string,
  daysUntil: number,
  text: BriefingText = ENGLISH,
  options: { beforeOpen?: boolean; ratio?: { num: number; den: number; reverse: boolean } | null } = {},
): string | null {
  const when = whenWords(daysUntil, text);
  switch (kind) {
    case "earnings":
      return text.t(options.beforeOpen ? "briefing.agenda.reportsBeforeOpen" : "briefing.agenda.reports", { ticker, when });
    case "ex_dividend":
      return text.t("briefing.agenda.exDividend", { ticker, when });
    case "dividend_payment":
      return text.t("briefing.agenda.payment", { ticker, when });
    case "split": {
      const ratio = options.ratio;
      if (!ratio) return null;
      return text.t(ratio.reverse ? "briefing.agenda.reverseSplit" : "briefing.agenda.split", { ticker, when, num: ratio.num, den: ratio.den });
    }
    default:
      return null;
  }
}

function upper(list: readonly string[]): Set<string> {
  return new Set(list.map((t) => t.trim().toUpperCase()).filter(Boolean));
}

/**
 * The reader's own dated events, from today through the horizon. A held name
 * the report has an earnings date for takes the report's (it knows the hour,
 * and prefers the company's own date); the provider's earnings row for that
 * name is then left out, so the same report is not listed twice, and so is
 * one inside the report's earnings reach, where the report has decided.
 */
export function personalAgenda(input: AgendaInput): Agenda {
  const text = input.text ?? ENGLISH;
  const horizon = input.horizonDays ?? AGENDA_HORIZON_DAYS;
  const held = upper(input.held);
  const watch = upper(input.watchlist);
  const tierOf = (ticker: string): AgendaRow["tier"] | null => (held.has(ticker) ? "held" : watch.has(ticker) ? "watchlist" : null);

  const rows: AgendaRow[] = [];
  const seen = new Set<string>();
  const inReach = (date: string): number | null => {
    const days = daysBetween(input.today, date);
    return days !== null && days >= 0 && days <= horizon ? days : null;
  };

  const reachEnd = input.reportSession ? addTradingDays(input.reportSession, EARNINGS_HORIZON_SESSIONS) : null;
  const decidedByReport = (ticker: string, date: string) =>
    reachEnd !== null && held.has(ticker) && date >= input.reportSession! && date <= reachEnd;

  const reported = new Set<string>();
  for (const e of Array.isArray(input.earnings) ? input.earnings : []) {
    const ticker = e?.ticker?.trim().toUpperCase();
    if (!ticker) continue;
    const tier = tierOf(ticker);
    if (!tier) continue;
    reported.add(ticker);
    const days = inReach(e.due_ymd);
    if (days === null) continue;
    const id = `earn:${ticker}:${e.due_ymd}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const beforeOpen = e.timing === "bmo";
    rows.push({
      id,
      tier,
      kind: "earnings",
      ticker,
      date: e.due_ymd,
      daysUntil: days,
      text: countdownSentence("earnings", ticker, days, text, { beforeOpen })!,
      detail: !e.confirmed ? text.t("briefing.agenda.estimated") : beforeOpen ? null : text.t("briefing.row.afterClose"),
      dateLabel: agendaDateLabel(e.due_ymd, days, text),
      estimated: !e.confirmed,
    });
  }

  for (const e of Array.isArray(input.corporate) ? input.corporate : []) {
    const ticker = e?.ticker?.trim().toUpperCase();
    if (!ticker || !e.date) continue;
    const tier = tierOf(ticker);
    if (!tier) continue;
    if (e.kind === "earnings" && (reported.has(ticker) || decidedByReport(ticker, e.date))) continue;
    const days = inReach(e.date);
    if (days === null) continue;
    const id = `${e.kind}:${ticker}:${e.date}`;
    if (seen.has(id) || seen.has(e.id)) continue;
    const sentence = countdownSentence(e.kind, ticker, days, text, { ratio: e.kind === "split" ? splitRatio(e) : null });
    if (!sentence) continue;
    seen.add(id);
    seen.add(e.id);
    rows.push({
      id,
      tier,
      kind: e.kind,
      ticker,
      date: e.date,
      daysUntil: days,
      text: sentence,
      detail: e.estimated ? text.t("briefing.agenda.estimated") : null,
      dateLabel: agendaDateLabel(e.date, days, text),
      estimated: e.estimated,
    });
  }

  rows.sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.ticker.localeCompare(b.ticker),
  );

  let note: string | null = null;
  if (held.size === 0 && watch.size === 0) note = text.t("briefing.agenda.marketOnly");
  else if (held.size === 0) note = text.t("briefing.agenda.noPositions");
  else if (!rows.some((r) => r.tier === "held")) note = text.t("briefing.agenda.nothingAhead", { count: horizon });
  return { rows, note };
}
