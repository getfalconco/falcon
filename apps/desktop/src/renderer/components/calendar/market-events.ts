/**
 * Calendar tab: the market's own events across a run of dates.
 *
 * Each New York trading day is put together exactly as the dashboard's
 * calendar card puts together a day stepped to with its arrows: through
 * `calendarForDay` when the handover report is there (its own session passes
 * through as the report has it, every other day is built from the curated
 * macro calendar, the expiry and rebalance rules and the held names'
 * earnings), and through the engine's `calendarToday` over the same pieces
 * when it is not. Each row then goes through `calendarView`, so its labels,
 * source line and clock line are the card's own.
 *
 * On top of that come the provider's corporate dates for held and followed
 * names (`calendar:corporate`), which reach weeks further than the report's
 * ten sessions. Where the two speak about the same earnings, the report wins:
 * it prefers the date the company announced (with the hour) over the
 * provider's projection.
 *
 * Pure: the clock is a parameter.
 */

import type { BriefingReport } from "../../../shared/briefing-types";
import { calendarForDay } from "../../../shared/calendar-days";
import {
  EARNINGS_HORIZON_SESSIONS,
  REBALANCE_HORIZON_SESSIONS,
  addTradingDays,
  calendarToday,
  coverageStatus,
  expiryEventsBetween,
  loadMacroCalendar,
  rebalanceEventsBetween,
  sessionWindowFor,
  type CalendarReport,
} from "../../../shared/calendar-types";
import type { TFunction } from "@/lib/i18n";
import { ENGLISH, type BriefingText } from "../../../shared/briefing-text";
import { calendarView, degradedNotes } from "../../../shared/calendar-view";
import { CATEGORY_COLOR, MARKET_WIDE, type CalendarCorporateEvent } from "../../../shared/calendar-events";
import { addDays, daysFrom, weekday } from "./calendar-dates";
import { corporateToCal, itemViewToCal, type CalEvent, type CalendarWords, type SectorLookup } from "./calendar-model";

export type MarketEventsInput = {
  /** First and last New York date to build, both included. */
  from: string;
  to: string;
  briefing: BriefingReport | null;
  /** The provider's corporate dates; null when they could not be asked for (old main, nothing followed). */
  corporate: CalendarCorporateEvent[] | null;
  sectorOf: SectorLookup;
  now: Date;
  /** The reader's IANA zone for the clock line; the runtime's own when left out. */
  zone?: string;
  /** The reader's language for the rows and notes the views word; English when left out. */
  text?: BriefingText;
  /** The same language for the Calendar tab's own lines (the holiday row); English when left out. */
  t?: TFunction;
};

export type MarketEventsResult = {
  events: CalEvent[];
  /** Quiet lines for the footer: a section of the report that failed, or how far a source reaches. */
  notes: string[];
};

/** Days built per input, kept while the inputs stand: a month view asks for 42 of them on every render. */
const dayCache = new WeakMap<object, Map<string, CalendarReport | "closed">>();
const NO_BRIEFING = {};

function dayReport(ymd: string, briefing: BriefingReport | null, now: Date): CalendarReport | "closed" {
  const cacheKey = briefing ?? NO_BRIEFING;
  let days = dayCache.get(cacheKey);
  if (!days) {
    days = new Map();
    dayCache.set(cacheKey, days);
  }
  const hit = days.get(ymd);
  if (hit) return hit;

  let built: CalendarReport | "closed";
  if (briefing) {
    const day = calendarForDay(briefing, ymd, now);
    built = day.closed ? "closed" : day.report;
  } else {
    const window = sessionWindowFor(ymd, now);
    if (!window) {
      built = "closed";
    } else {
      const cal = loadMacroCalendar();
      built = {
        schema_version: 1,
        generated_at: now.toISOString(),
        demo: false,
        window,
        items: calendarToday(
          window,
          cal,
          expiryEventsBetween(ymd, ymd),
          rebalanceEventsBetween(ymd, addTradingDays(ymd, REBALANCE_HORIZON_SESSIONS), cal.index_events),
          [],
          [],
        ),
        coverage: coverageStatus(ymd, cal),
        degraded: [],
      };
    }
  }
  days.set(ymd, built);
  return built;
}

/** A weekday the exchange does not open: the one market-hours row such a day gets. */
function holidayEvent(ymd: string, text: BriefingText, t: TFunction | undefined): CalEvent {
  return {
    id: `m:session:closed:${ymd}`,
    origin: "market",
    type: "session",
    category: MARKET_WIDE,
    color: CATEGORY_COLOR[MARKET_WIDE],
    title: t ? t("calendar.holiday.title") : "US markets closed",
    detail: t ? t("calendar.holiday.detail") : "A NYSE market holiday: no regular session today.",
    importance: 2,
    kindLabel: text.t("briefing.kind.session"),
    allDay: true,
    startDate: ymd,
    endDate: ymd,
    startMs: null,
    endMs: null,
    timeEt: null,
    timeLine: text.t("briefing.rail.allDay"),
    tickers: [],
    sourceLabel: t ? t("calendar.holiday.source") : "Set by the NYSE holiday schedule.",
    estimated: false,
    notes: "",
    user: null,
  };
}

/** Briefing corporate events, used only when the provider's own list could not be asked for. */
function briefingCorporateFallback(briefing: BriefingReport, sectorOf: SectorLookup, words: CalendarWords | undefined): CalEvent[] {
  const out: CalEvent[] = [];
  for (const e of Array.isArray(briefing.corporate_events) ? briefing.corporate_events : []) {
    if ((e.kind !== "dividend" && e.kind !== "split") || !e.ticker) continue;
    out.push(
      corporateToCal(
        {
          id: e.id,
          kind: e.kind === "dividend" ? "ex_dividend" : "split",
          ticker: e.ticker,
          date: e.date,
          title: e.title,
          detail: e.detail,
          estimated: e.certainty === "estimated",
        },
        sectorOf,
        words,
      ),
    );
  }
  return out;
}

export function buildMarketEvents(input: MarketEventsInput): MarketEventsResult {
  const { briefing, sectorOf, now } = input;
  const text = input.text ?? ENGLISH;
  // The provider's rows are worded here, from main's codes, in the same language as the rest.
  const words: CalendarWords | undefined = input.t ? { t: input.t, locale: text.locale } : undefined;
  const events: CalEvent[] = [];
  const notes = new Set<string>();
  const ids = new Set<string>();
  const push = (e: CalEvent) => {
    if (ids.has(e.id)) return;
    ids.add(e.id);
    events.push(e);
  };

  for (const ymd of daysFrom(input.from, input.to)) {
    let report: CalendarReport | "closed";
    try {
      report = dayReport(ymd, briefing, now);
    } catch (error) {
      console.error("[calendar] day build failed:", ymd, error);
      continue;
    }
    if (report === "closed") {
      const dow = weekday(ymd);
      if (dow !== 0 && dow !== 6) push(holidayEvent(ymd, text, input.t));
      continue;
    }
    const view = calendarView(report, now, input.zone ? { zone: input.zone, text } : { text });
    const atById = new Map(report.items.map((i) => [i.id, i.at]));
    for (const item of [...view.allDay, ...view.timed]) push(itemViewToCal(item, ymd, atById.get(item.id) ?? null, sectorOf));
    const degraded = degradedNotes(report, text);
    for (const note of [degraded.macro_calendar, degraded.earnings]) if (note) notes.add(note);
  }

  // The provider's dates. Ids are shared with the report's rows
  // ("earn:TICKER:date"), so the same earnings on the same day is kept once,
  // as the report has it. For a held name inside the report's earnings reach
  // the report has already decided (and preferred the company's own date),
  // so the provider's earnings row is left out there.
  const held = new Set((briefing?.held_coverage ?? []).map((h) => h.ticker));
  const session = briefing?.window.target_session_ymd ?? null;
  const reachEnd = session ? addTradingDays(session, EARNINGS_HORIZON_SESSIONS) : null;
  const corporate = input.corporate ?? (briefing ? null : []);
  if (corporate) {
    for (const e of corporate) {
      if (e.date < input.from || e.date > input.to) continue;
      if (e.kind === "earnings" && session && reachEnd && held.has(e.ticker) && e.date >= session && e.date <= reachEnd) continue;
      push(corporateToCal(e, sectorOf, words));
    }
  } else if (briefing) {
    for (const e of briefingCorporateFallback(briefing, sectorOf, words)) if (e.startDate >= input.from && e.startDate <= input.to) push(e);
  }

  return { events, notes: [...notes] };
}

/** The New York dates whose rows can land on any of `days` in the viewing zone: one either side covers every offset. */
export function nyRangeFor(days: readonly string[]): { from: string; to: string } {
  return { from: addDays(days[0], -1), to: addDays(days[days.length - 1], 1) };
}
