import { CALENDAR_EVENT_TYPES, CALENDAR_SECTORS, MARKET_WIDE } from "../../../shared/calendar-events";
import { DEFAULT_FILTERS, readFilters, type CalendarFilters, type CalendarScope } from "./calendar-model";
import type { CalendarViewMode, WeekStart } from "./calendar-dates";

/**
 * Calendar tab: what the reader set up, kept in this browser.
 *
 * The view, the zone, the week layout and the filters are conveniences for
 * one reader on one machine, so they live in localStorage. Every read and
 * write is wrapped: storage can be missing or refuse (a private window, a
 * preview), and the calendar must draw the same with or without it.
 */

const KEY = "falcon.ui.calendar.v1";

export type ZoneMode = "local" | "et";

export type CalendarPrefs = {
  view: CalendarViewMode;
  zoneMode: ZoneMode;
  weekStart: WeekStart;
  showWeekends: boolean;
  filters: CalendarFilters;
  /** Held names' dates drawn emphasised and listed first. On unless the reader turns it off. */
  highlightPositions: boolean;
  /** "Important" (the default) or "All" of the economic calendar, the choice under the small month. */
  scope: CalendarScope;
};

export const DEFAULT_PREFS: CalendarPrefs = {
  view: "week",
  zoneMode: "local",
  weekStart: 1,
  showWeekends: true,
  filters: DEFAULT_FILTERS,
  highlightPositions: true,
  scope: "important",
};

const CATEGORIES: readonly string[] = [MARKET_WIDE, ...CALENDAR_SECTORS];

export function parsePrefs(raw: unknown): CalendarPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    view: r.view === "day" || r.view === "week" || r.view === "month" ? r.view : DEFAULT_PREFS.view,
    zoneMode: r.zoneMode === "et" ? "et" : "local",
    weekStart: r.weekStart === 0 ? 0 : 1,
    showWeekends: r.showWeekends !== false,
    filters: readFilters(r.filters, CALENDAR_EVENT_TYPES, CATEGORIES),
    highlightPositions: r.highlightPositions !== false,
    scope: r.scope === "all" ? "all" : "important",
  };
}

export function readPrefs(): CalendarPrefs {
  try {
    const text = localStorage.getItem(KEY);
    return text ? parsePrefs(JSON.parse(text)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(prefs: CalendarPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* the setting still holds for this session */
  }
}
