/**
 * Session calendar: the view model.
 *
 * Every string the calendar card prints is built here, and so is every Intl
 * call. The components stay dumb: they lay out what these functions return
 * and hold no formatting options, no date arithmetic and no copy of their
 * own. That is what lets one test file check the wording rules (no advice
 * verbs, no long dashes) against everything a reader can see.
 *
 * Pure. Nothing here reads a clock; whatever depends on the time takes `now`.
 * Lives in `shared/` and is compiled for the main process too, so no DOM types.
 */

import {
  MACRO_CALENDAR,
  type CalendarItem,
  type CalendarItemKind,
  type CalendarReport,
  type CalendarSectionKey,
  type SessionPhase,
  type SessionWindow,
} from "./calendar-types";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Month and weekday names are spelled out here instead of asked of Intl, for
 * two reasons. A session date is a calendar date, not an instant: handing
 * "2026-09-21" to a date formatter means picking a time of day and a zone for
 * it, and picking wrong prints the 20th to anyone west of UTC. And the text
 * then does not depend on which ICU build the runtime shipped with.
 */
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * A report can come out of the main process's cache written by an older
 * build, so a list this build expects may simply not be there. Reading it as
 * empty keeps one missing field from blanking the whole card.
 */
function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

type YmdParts = { y: number; m: number; d: number; dow: number; noonUtc: number };

/**
 * Reads a "YYYY-MM-DD" calendar date through UTC noon: far enough from both
 * ends of the day that no zone offset can push it onto a neighbouring date.
 * A date that does not exist (02-30) is rejected rather than rolled forward.
 */
function parseYmd(ymd: string): YmdParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return { y, m, d, dow: at.getUTCDay(), noonUtc: at.getTime() };
}

/** "Mon Sep 28". An unreadable date is shown as it came, which beats showing nothing. */
function weekdayDate(ymd: string): string {
  const p = parseYmd(ymd);
  return p ? `${WEEKDAY_ABBR[p.dow]} ${MONTH_ABBR[p.m - 1]} ${p.d}` : ymd;
}

/** "Oct 31, 2026". */
function fullDate(ymd: string): string {
  const p = parseYmd(ymd);
  return p ? `${MONTH_ABBR[p.m - 1]} ${p.d}, ${p.y}` : ymd;
}

const NY_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** The New York calendar date and wall-clock time of an instant. */
function nyClock(at: Date | string): { ymd: string; hm: string } | null {
  const date = typeof at === "string" ? new Date(at) : at;
  if (!Number.isFinite(date.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const part of NY_CLOCK.formatToParts(date)) parts[part.type] = part.value;
  // Some engines print midnight as hour 24 even under h23.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hm: `${hour}:${parts.minute}` };
}

/**
 * The New York calendar date of an instant, "YYYY-MM-DD", or null when the
 * instant cannot be read. Exported because "which day is the reader on?" is
 * asked outside this file too: the window opens at 20:00 ET the evening
 * before, so the phase alone does not say whether the session in the report
 * has actually happened yet. A second Intl call in a component is the thing
 * this module exists to prevent.
 */
export function nyYmd(at: Date | string): string | null {
  return nyClock(at)?.ymd ?? null;
}

/**
 * "07:16": the New York wall-clock time of an instant, for the one place the
 * card prints a bare time of its own (the "now" line on the rail).
 */
export function etClock(at: Date | string): string | null {
  return nyClock(at)?.hm ?? null;
}

// ---------------------------------------------------------------------------
// Phase and masthead
// ---------------------------------------------------------------------------

/**
 * The report in a demo was assembled for a made-up morning. Judged against the
 * real clock it would read "closed" and every calendar line would be in the
 * past, so a demo is always viewed from the moment it was generated.
 */
export function viewNow(report: CalendarReport, realNow: Date): Date {
  return report.demo ? new Date(report.generated_at) : realNow;
}

/**
 * The phase as of `now`, not as of when the report was built. A card drawn at
 * 09:20 is still on screen at 09:31; without this it would go on treating the
 * session as ahead until something refetched the report, and the refetch
 * would cost a provider round for the sake of one line.
 *
 * Before the target open the window's own bounds decide. If those cannot be
 * read, or the local clock sits before a window the engine already called
 * pre-open (a skewed clock), the window's word is kept.
 */
export function effectivePhase(window: SessionWindow, now: Date): SessionPhase {
  const t = now.getTime();
  const open = Date.parse(window.target_open_at);
  const close = Date.parse(window.target_close_at);
  if (!Number.isFinite(t) || !Number.isFinite(open) || !Number.isFinite(close)) return window.phase;
  if (t >= close) return "between_sessions";
  if (t >= open) return "in_session";
  const windowOpens = Date.parse(window.window_opens_at);
  if (Number.isFinite(windowOpens) && t >= windowOpens) return "pre_open";
  return window.phase === "pre_open" ? "pre_open" : "between_sessions";
}

/** "MON SEP 28". */
export function mastheadDate(report: CalendarReport): string {
  return dayLabel(report.window.target_session_ymd);
}

/** "MON SEP 28" for any calendar date: the head names the day the strip has picked, closed days included. */
export function dayLabel(ymd: string): string {
  return weekdayDate(ymd).toUpperCase();
}

// ---------------------------------------------------------------------------
// The session's rows
// ---------------------------------------------------------------------------

export type CalendarItemView = {
  id: string;
  kind: CalendarItemKind;
  kindLabel: string;
  title: string;
  detail: string | null;
  importance: 1 | 2 | 3;
  tickers: string[];
  /** "08:30" New York time; null for an all-day item. */
  timeLabel: string | null;
  past: boolean;
  /** The hover card's clock line: "08:30 ET · 15:30 your time", "08:30 ET", or "All day". */
  timeLine: string;
  /** Where the row's date comes from, as a sentence; null when the row carries no known source. */
  sourceLabel: string | null;
  importanceLabel: string;
};

export type TimedCalendarItemView = CalendarItemView & { timeLabel: string };

export type CalendarFootnote = { text: string; tone: "quiet" | "warn" };

export type CalendarView = {
  allDay: CalendarItemView[];
  timed: TimedCalendarItemView[];
  /** Where the "now" line goes among `timed`: the index of the first item still ahead. */
  nowIndex: number;
  /**
   * Whether `now` falls on the session this column lists. False from 20:00 ET
   * the evening before, when the window is already open for a day that has not
   * started: a wall-clock time on the marker would then print "21:30" above
   * "08:30" on a rail that is otherwise strictly in order.
   */
  nowOnTargetDay: boolean;
  footnote: CalendarFootnote;
};

export const CALENDAR_KIND_LABEL: Record<CalendarItemKind, string> = {
  fomc: "FOMC",
  data: "Data",
  opex: "Options",
  earnings: "Earnings",
  session: "Session",
  rebalance: "Index",
};

const IMPORTANCE_LABEL: Record<1 | 2 | 3, string> = {
  3: "High importance",
  2: "Medium importance",
  1: "Low importance",
};

/** The curated file names its publishers; a row carries the id, the hover card prints the name. */
const PUBLISHER = new Map(MACRO_CALENDAR.sources.map((source) => [source.id, source.name]));

/**
 * Rows the engine derives by rule carry "rule" as their source, which names no
 * publisher. What set the date differs by kind, so the kind picks the sentence.
 */
const RULE_SOURCE: Partial<Record<CalendarItemKind, string>> = {
  opex: "Set by the exchanges' standard options expiry schedule.",
  session: "Set by the NYSE holiday and early close schedule.",
  rebalance: "Set by the index provider's published rules.",
};

function sourceLabel(item: CalendarItem): string | null {
  if (item.kind === "earnings") {
    return item.source === "tracker" ? "Date announced by the company." : "Date from the data provider.";
  }
  // "curated" is a date the index provider announced (Russell, MSCI): no rule
  // gives those, so they are not called rule-derived.
  if (item.kind === "rebalance" && item.source === "curated") return "Date announced by the index provider.";
  if (item.source === "rule") return RULE_SOURCE[item.kind] ?? null;
  const publisher = PUBLISHER.get(item.source);
  return publisher ? `Source: ${publisher}.` : null;
}

/**
 * The reader's own clock for a release, beside New York's. A card read in
 * Istanbul says 08:30 ET and the reader has to do the arithmetic, across two
 * DST changes a year that do not fall on the same weekend; the hover card does
 * it once. Nothing is printed when the reader is on New York time already, and
 * a release that lands on another calendar day where the reader is says so.
 * `zone` is the reader's time zone, left to the runtime unless a test pins it.
 */
function localTime(at: string | null, zone: string | undefined): string | null {
  if (!at) return null;
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime())) return null;
  let parts: Record<string, string>;
  try {
    parts = {};
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    for (const part of format.formatToParts(instant)) parts[part.type] = part.value;
  } catch {
    return null;
  }
  const ny = nyClock(instant);
  if (!ny) return null;
  const hm = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  if (ymd === ny.ymd && hm === ny.hm) return null;
  const shift = ymd > ny.ymd ? " the next day" : ymd < ny.ymd ? " the day before" : "";
  return `${hm}${shift} your time`;
}

function timeLine(item: CalendarItem, zone: string | undefined): string {
  if (!item.time_et) return "All day";
  const local = localTime(item.at, zone);
  return local ? `${item.time_et} ET · ${local}` : `${item.time_et} ET`;
}

/**
 * Whether a timed item is behind `now`. The engine sends the instant alongside
 * the ET label so nothing here converts zones; if the instant is missing, the
 * label is compared with New York's own wall clock instead.
 */
function isPast(item: CalendarItem, now: Date, targetYmd: string): boolean {
  const t = now.getTime();
  if (!Number.isFinite(t)) return false;
  const at = item.at ? Date.parse(item.at) : Number.NaN;
  if (Number.isFinite(at)) return at <= t;
  const clock = nyClock(now);
  if (!clock || !item.time_et) return false;
  if (clock.ymd !== targetYmd) return clock.ymd > targetYmd;
  return item.time_et <= clock.hm;
}

function calendarItemView(item: CalendarItem, past: boolean, zone: string | undefined): CalendarItemView {
  return {
    id: item.id,
    kind: item.kind,
    kindLabel: CALENDAR_KIND_LABEL[item.kind] ?? "Event",
    title: item.title,
    detail: item.detail ?? null,
    importance: item.importance,
    tickers: [...list(item.tickers)],
    timeLabel: item.time_et ?? null,
    past,
    timeLine: timeLine(item, zone),
    sourceLabel: sourceLabel(item),
    importanceLabel: IMPORTANCE_LABEL[item.importance] ?? IMPORTANCE_LABEL[1],
  };
}

function calendarFootnote(report: CalendarReport): CalendarFootnote {
  const c = report.coverage;
  if (!c || !c.until) return { text: "Calendar coverage is unknown.", tone: "warn" };
  if (!c.covers_target) return { text: `Calendar data ends ${fullDate(c.until)}. This session is not covered.`, tone: "warn" };
  return { text: `Calendar covers until ${fullDate(c.until)}.`, tone: "quiet" };
}

export type CalendarViewOptions = {
  /** The reader's IANA time zone for the hover card's second clock; the runtime's own when left out. */
  zone?: string;
};

export function calendarView(report: CalendarReport, now: Date, options: CalendarViewOptions = {}): CalendarView {
  const zone = options.zone;
  const targetYmd = report.window.target_session_ymd;
  const items = list(report.items);

  // "HH:MM" sorts correctly as text, and every item is on the one New York day.
  const timedItems = items
    .filter((i) => typeof i.time_et === "string" && i.time_et !== "")
    .map((i, index) => ({ i, index }))
    .sort((a, b) => (a.i.time_et as string).localeCompare(b.i.time_et as string) || b.i.importance - a.i.importance || a.index - b.index);

  const timed = timedItems.map(({ i }) => calendarItemView(i, isPast(i, now, targetYmd), zone) as TimedCalendarItemView);
  const firstAhead = timed.findIndex((t) => !t.past);

  // An all-day item is behind us once the session it belongs to has closed.
  const closeAt = Date.parse(report.window.target_close_at);
  const dayOver = Number.isFinite(closeAt) && Number.isFinite(now.getTime()) && now.getTime() >= closeAt;
  const allDay = items
    .filter((i) => !i.time_et)
    .map((i, index) => ({ i, index }))
    .sort((a, b) => b.i.importance - a.i.importance || a.index - b.index)
    .map(({ i }) => calendarItemView(i, dayOver, zone));

  return {
    allDay,
    timed,
    nowIndex: firstAhead === -1 ? timed.length : firstAhead,
    nowOnTargetDay: nyYmd(now) === targetYmd,
    footnote: calendarFootnote(report),
  };
}

// ---------------------------------------------------------------------------
// Degraded sections
// ---------------------------------------------------------------------------

const DEGRADED_NOTE: Record<CalendarSectionKey, string> = {
  macro_calendar: "The macro calendar is unavailable right now.",
  earnings: "Earnings dates are unavailable right now.",
};

/** When only some symbols failed, the note names them and the rest of the section stands. */
const DEGRADED_NOTE_FOR_SYMBOLS: Partial<Record<CalendarSectionKey, string>> = {
  earnings: "Earnings dates are unavailable for",
};

function symbolList(symbols: readonly string[]): string {
  const unique = [...new Set(symbols)];
  const shown = unique.slice(0, 4).join(", ");
  const rest = unique.length - 4;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * One quiet line per section that failed. The engine's own `detail` is never
 * shown: it is written for a log, and keeping it out is also what guarantees
 * no provider text reaches the reader.
 */
export function degradedNotes(report: CalendarReport): Partial<Record<CalendarSectionKey, string>> {
  const symbolsBySection = new Map<CalendarSectionKey, string[] | null>();
  for (const d of list(report.degraded)) {
    if (!(d.section in DEGRADED_NOTE)) continue;
    const symbols = list(d.symbols);
    const known = symbolsBySection.get(d.section);
    // One entry without symbols means the whole section failed; that outranks
    // any per-symbol entry for the same section.
    if (symbols.length === 0 || known === null) symbolsBySection.set(d.section, null);
    else symbolsBySection.set(d.section, [...(known ?? []), ...symbols]);
  }
  const notes: Partial<Record<CalendarSectionKey, string>> = {};
  for (const [section, symbols] of symbolsBySection) {
    const lead = DEGRADED_NOTE_FOR_SYMBOLS[section];
    notes[section] = symbols && lead ? `${lead} ${symbolList(symbols)}.` : DEGRADED_NOTE[section];
  }
  return notes;
}
