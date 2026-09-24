/**
 * Handover briefing: reading, correcting and checking the curated macro calendar.
 *
 * The data lives in `data/macro-calendar.ts`, compiled by hand from official
 * schedules. This module is the only way the rest of the engine touches it:
 * lookups by day, the coverage statement the report prints, the run-time
 * overlay that corrects a rescheduled release without a build, and the
 * validator that keeps a hand-edited file honest.
 *
 * Pure: no clock, no fs, no network. The caller supplies the day it asks about.
 */

import { calendarDaysBetween, weekdayOf } from "../tracker/calendar.js";
import { MACRO_CALENDAR } from "./data/macro-calendar.js";
import type {
  CalendarCoverage,
  IndexEvent,
  MacroCalendarFile,
  MacroCalendarOverlay,
  MacroEvent,
  SessionOverride,
} from "./types.js";

export const MACRO_CALENDAR_SCHEMA_VERSION = 1;

/**
 * One release of one series per day is the identity: a correction to the 10-14
 * CPI row must replace it, and a CPI moved to another day is a different id
 * (remove the old one, supply the new one).
 */
export function macroEventId(e: MacroEvent): string {
  return `${e.date}:${e.code}`;
}

/**
 * An untimed row sorts after the timed ones on its day. The agencies that give
 * no clock time (University of Michigan) release mid-morning, so putting null
 * first would list them above the 08:30 prints they follow.
 */
const UNTIMED_SORT_KEY = "99:99";

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvents(a: MacroEvent, b: MacroEvent): number {
  return (
    compareText(a.date, b.date) ||
    compareText(a.time_et ?? UNTIMED_SORT_KEY, b.time_et ?? UNTIMED_SORT_KEY) ||
    compareText(a.code, b.code)
  );
}

function compareIndexEvents(a: IndexEvent, b: IndexEvent): number {
  return compareText(a.date, b.date) || compareText(a.family, b.family);
}

/**
 * Applies run-time corrections over a calendar and returns a new one; neither
 * argument is touched, and no row object is shared with the input, so a caller
 * that edits the result cannot corrupt the shipped constant for the next call.
 *
 * Removals are applied to the base first, and overlay rows are laid on top.
 * The other order would let a stale `remove_event_ids` entry silently delete
 * the corrected row an operator supplied for the same id (a release moved away
 * and then moved back), and a missing CPI is the worst outcome this file has.
 *
 * Index events and session overrides have no id in the contract, so they are
 * keyed by what makes two rows the same fact: (date, family) and date. An
 * overlay row with the same key replaces the base row instead of printing the
 * rebalance twice or leaving two verdicts on one session.
 *
 * Coverage is deliberately not widened: an overlay corrects rows inside the
 * window the shipped file vouches for, it does not vouch for new months.
 */
export function mergeCalendarOverlay(
  file: MacroCalendarFile,
  overlay: MacroCalendarOverlay | null | undefined,
): MacroCalendarFile {
  const removed = new Set(overlay?.remove_event_ids ?? []);
  const events = new Map<string, MacroEvent>();
  for (const e of file.events) {
    const id = macroEventId(e);
    if (!removed.has(id)) events.set(id, { ...e });
  }
  for (const e of overlay?.events ?? []) events.set(macroEventId(e), { ...e });

  const indexEvents = new Map<string, IndexEvent>();
  for (const e of [...file.index_events, ...(overlay?.index_events ?? [])]) {
    indexEvents.set(`${e.date}:${e.family}`, { ...e });
  }

  const overrides = new Map<string, SessionOverride>();
  for (const o of [...file.session_overrides, ...(overlay?.session_overrides ?? [])]) {
    overrides.set(o.date, { ...o });
  }

  return {
    schema_version: file.schema_version,
    compiled_at: file.compiled_at,
    coverage: { ...file.coverage },
    per_source_until: { ...file.per_source_until },
    sources: file.sources.map((s) => ({ ...s })),
    events: [...events.values()].sort(compareEvents),
    index_events: [...indexEvents.values()].sort(compareIndexEvents),
    session_overrides: [...overrides.values()].sort((a, b) => compareText(a.date, b.date)),
  };
}

/** The shipped calendar with the overlay applied; always a fresh copy. */
export function loadMacroCalendar(overlay?: MacroCalendarOverlay | null): MacroCalendarFile {
  return mergeCalendarOverlay(MACRO_CALENDAR, overlay);
}

export function macroEventsOn(ymd: string, cal: MacroCalendarFile = MACRO_CALENDAR): MacroEvent[] {
  return cal.events.filter((e) => e.date === ymd);
}

/** Both ends inclusive. "YYYY-MM-DD" strings order the same way the dates do. */
export function macroEventsBetween(
  fromYmd: string,
  toYmd: string,
  cal: MacroCalendarFile = MACRO_CALENDAR,
): MacroEvent[] {
  return cal.events.filter((e) => e.date >= fromYmd && e.date <= toYmd);
}

/**
 * What the report says about how far the calendar can be trusted. A target
 * before `from` is uncovered too: the file holds no rows for it, so an empty
 * day there means "not compiled", not "nothing scheduled". `days_left` goes
 * negative past the end so the caller can say how stale the file is.
 */
export function coverageStatus(targetYmd: string, cal: MacroCalendarFile = MACRO_CALENDAR): CalendarCoverage {
  const { from, until } = cal.coverage;
  return {
    from,
    until,
    compiled_at: cal.compiled_at,
    covers_target: targetYmd >= from && targetYmd <= until,
    days_left: calendarDaysBetween(targetYmd, until),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Only publishers of the schedules themselves. A date copied from a news site
 * or an aggregator is second-hand, and second-hand dates are how a rescheduled
 * release stays wrong in the file. Matched as a host suffix so agency
 * subdomains pass (data.sca.isr.umich.edu) and look-alikes do not
 * (bls.gov.example.com, notbls.gov).
 */
const OFFICIAL_HOSTS: readonly string[] = [
  "federalreserve.gov",
  "bls.gov",
  "bea.gov",
  "census.gov",
  "ismworld.org",
  "dol.gov",
  "umich.edu",
  "msci.com",
  "lseg.com",
  "ftserussell.com",
  "nyse.com",
];

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DASHES = /[\u2013\u2014]/;

/**
 * The house copy rules for user-facing text: the briefing describes a
 * schedule, it never advises or foretells. Each entry is the word with its
 * inflections spelled out, because a stem match would reject "additional",
 * "shortage" and "stopgap" and would still miss "sold" and "bought".
 * "may" is matched case-blind on purpose: the month name in a title is
 * indistinguishable from the modal verb, so a period goes in `period`, which
 * is exempt from this list (and only from this list).
 */
const BANNED_WORDS: readonly string[] = [
  "buy|buys|buying|bought",
  "sell|sells|selling|sold",
  "enter|enters|entering|entered",
  "exit|exits|exiting|exited",
  "long|longs|longer|longest|longed|longing",
  "short|shorts|shorter|shortest|shorted|shorting",
  "add|adds|adding|added",
  "trim|trims|trimming|trimmed",
  "target|targets|targeting|targeted",
  "stop|stops|stopping|stopped",
  "(?:take|takes|taking|took|taken)[\\s-]+profits?",
  "signal|signals|signaling|signalling|signaled|signalled",
  "prediction|predictions",
  "recommend|recommends|recommending|recommended|recommendation|recommendations",
  "reduce|reduces|reducing|reduced",
  "consider|considers|considering|considered",
  "should",
  "will",
  "expect|expects|expecting|expected",
  "forecast|forecasts|forecasting|forecasted",
  "predict|predicts|predicting|predicted",
  "likely|likelier|likeliest",
  "may",
];

const BANNED = new RegExp(`\\b(?:${BANNED_WORDS.join("|")})\\b`, "i");

function copyProblems(label: string, text: string, checkWords: boolean): string[] {
  const problems: string[] = [];
  if (DASHES.test(text)) problems.push(`${label}: contains an em or en dash`);
  if (checkWords) {
    const hit = BANNED.exec(text);
    if (hit) problems.push(`${label}: contains the banned word "${hit[0]}"`);
  }
  return problems;
}

/**
 * A real calendar date, not just the right shape: "2026-02-30" passes the
 * regex and JavaScript rolls it forward to March, so round-trip it.
 */
function isRealYmd(ymd: string): boolean {
  if (!YMD.test(ymd)) return false;
  const d = new Date(`${ymd}T12:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

function isWeekday(ymd: string): boolean {
  const wd = weekdayOf(ymd);
  return wd >= 1 && wd <= 5;
}

function hostIsOfficial(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Human-readable problems with a calendar file; empty means valid. Run by the
 * test suite against the shipped file, so a refresh that breaks the ordering,
 * leaves a weekend date from a typo, or forgets to pull `coverage.until` back
 * to the shortest importance-3 schedule fails before it ships.
 */
export function validateMacroCalendar(file: MacroCalendarFile): string[] {
  const problems: string[] = [];
  const { from, until } = file.coverage;

  if (file.schema_version !== MACRO_CALENDAR_SCHEMA_VERSION) {
    problems.push(`schema_version: want ${MACRO_CALENDAR_SCHEMA_VERSION}, got ${file.schema_version}`);
  }
  if (!isRealYmd(file.compiled_at)) problems.push(`compiled_at: "${file.compiled_at}" is not a calendar date`);
  if (!isRealYmd(from)) problems.push(`coverage.from: "${from}" is not a calendar date`);
  if (!isRealYmd(until)) problems.push(`coverage.until: "${until}" is not a calendar date`);
  if (isRealYmd(from) && isRealYmd(until) && from > until) problems.push("coverage: from is after until");

  // Sources
  const sourceIds = new Set<string>();
  for (const s of file.sources) {
    if (sourceIds.has(s.id)) problems.push(`sources: duplicate id "${s.id}"`);
    sourceIds.add(s.id);
    if (!hostIsOfficial(s.url)) problems.push(`sources.${s.id}: url host is not an official publisher (${s.url})`);
    if (!isRealYmd(s.retrieved_at)) problems.push(`sources.${s.id}: retrieved_at "${s.retrieved_at}" is not a calendar date`);
    if (!(s.id in file.per_source_until)) problems.push(`per_source_until: no entry for source "${s.id}"`);
    problems.push(...copyProblems(`sources.${s.id}.name`, s.name, true));
  }
  for (const [id, ymd] of Object.entries(file.per_source_until)) {
    if (!sourceIds.has(id)) problems.push(`per_source_until: "${id}" is not a source id`);
    if (!isRealYmd(ymd)) problems.push(`per_source_until.${id}: "${ymd}" is not a calendar date`);
  }

  // A dated row: shared by events and index events.
  const dateProblems = (label: string, ymd: string, source: string, bounded: boolean): string[] => {
    const out: string[] = [];
    if (!isRealYmd(ymd)) return [`${label}: "${ymd}" is not a calendar date`];
    if (!isWeekday(ymd)) out.push(`${label}: falls on a weekend`);
    if (bounded && (ymd < from || ymd > until)) out.push(`${label}: outside coverage ${from}..${until}`);
    if (!sourceIds.has(source)) {
      out.push(`${label}: unknown source "${source}"`);
    } else {
      const horizon = file.per_source_until[source];
      // A row past its own publisher's horizon was not read off that schedule.
      if (horizon !== undefined && ymd > horizon) out.push(`${label}: after per_source_until.${source} (${horizon})`);
    }
    return out;
  };

  // Events
  const seen = new Set<string>();
  file.events.forEach((e, i) => {
    const id = macroEventId(e);
    const label = `events[${i}] ${id}`;
    if (seen.has(id)) problems.push(`${label}: duplicate id`);
    seen.add(id);
    problems.push(...dateProblems(label, e.date, e.source, true));
    if (e.time_et !== null && !HHMM.test(e.time_et)) problems.push(`${label}: time_et "${e.time_et}" is not HH:MM`);
    if (i > 0 && compareEvents(file.events[i - 1]!, e) > 0) {
      problems.push(`${label}: out of order (sort by date, time_et with untimed last, code)`);
    }
    problems.push(...copyProblems(`${label} title`, e.title, true));
    if (e.period !== undefined) problems.push(...copyProblems(`${label} period`, e.period, false));
  });

  // Index events. One row per family and date, the key the overlay merge
  // uses: two rows under one key would reach the report as two events with
  // the same id, and the second would silently overwrite the first there.
  const seenIndex = new Set<string>();
  file.index_events.forEach((e, i) => {
    const label = `index_events[${i}] ${e.date}:${e.family}`;
    if (seenIndex.has(`${e.date}:${e.family}`)) problems.push(`${label}: duplicate family and date`);
    seenIndex.add(`${e.date}:${e.family}`);
    problems.push(...dateProblems(label, e.date, e.source, true));
    if (i > 0 && compareIndexEvents(file.index_events[i - 1]!, e) > 0) problems.push(`${label}: out of order`);
    problems.push(...copyProblems(`${label} title`, e.title, true));
  });

  // Session overrides are not held to the coverage window: the session
  // calendar they correct is algorithmic and has no end date, so an ad-hoc
  // close announced for a day past the curated months is still a valid row.
  file.session_overrides.forEach((o, i) => {
    const label = `session_overrides[${i}] ${o.date}`;
    problems.push(...dateProblems(label, o.date, o.source, false));
    if (i > 0 && file.session_overrides[i - 1]!.date >= o.date) problems.push(`${label}: out of order or duplicate date`);
    problems.push(...copyProblems(`${label} note`, o.note, true));
  });

  // coverage.until is the shortest schedule among the sources that carry an
  // importance-3 row: past it, an empty day could be hiding a CPI.
  const critical = new Set(file.events.filter((e) => e.importance === 3).map((e) => e.source));
  const horizons = [...critical]
    .map((id) => file.per_source_until[id])
    .filter((ymd): ymd is string => ymd !== undefined)
    .sort();
  const want = horizons[0];
  if (want === undefined) {
    problems.push("coverage.until: no importance-3 source to derive it from");
  } else if (want !== until) {
    problems.push(`coverage.until: want ${want} (shortest importance-3 schedule), got ${until}`);
  }

  return problems;
}
