/**
 * Calendar tab: the contracts shared by the renderer and the main process.
 *
 * Two kinds of event reach the Calendar tab. Market events are read-only and
 * come from what the app already knows: the curated macro calendar and the
 * date rules (built in the renderer through `calendar-types`), and the
 * provider's corporate calendar of held and followed names (built in main,
 * `calendar:corporate`). User events are the reader's own and are kept by the
 * main process as JSON under the data root. Both are described here, with the
 * validation main runs on every write, so the form in the renderer can run
 * the same rules before it asks.
 *
 * Pure: no fs, no DOM, no clock (whatever needs the time takes it).
 */

import { en as calendarEn } from "../renderer/lib/i18n/messages/areas/calendar";

// ---------------------------------------------------------------------------
// Sectors and categories
// ---------------------------------------------------------------------------

/** The sectors a company event can be filed under, GICS names, plus the two buckets that are not sectors. */
export const CALENDAR_SECTORS = [
  "Technology",
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Healthcare",
  "Industrials",
  "Materials",
  "Real Estate",
  "Utilities",
  "Funds & ETFs",
  "Unclassified",
] as const;

export type CalendarSector = (typeof CALENDAR_SECTORS)[number];

/**
 * Market-wide events (macro releases, the Fed, expiries, index reviews, the
 * session itself) belong to no company, so they are filed here instead of
 * under a sector.
 */
export const MARKET_WIDE = "Market-wide" as const;

/** What a sector filter lists: every sector, and the market-wide bucket. */
export type CalendarCategory = CalendarSector | typeof MARKET_WIDE;

export function isCalendarSector(value: unknown): value is CalendarSector {
  return typeof value === "string" && (CALENDAR_SECTORS as readonly string[]).includes(value);
}

/**
 * Provider sector names to the calendar's. Yahoo's asset profile uses its own
 * vocabulary ("Financial Services", "Consumer Cyclical"), Finnhub an industry
 * string ("Semiconductors", "Banking"); both come down to the GICS sector
 * here. Matched on lower-cased words, longest phrase first.
 */
const SECTOR_ALIASES: ReadonlyArray<readonly [needle: string, sector: CalendarSector]> = [
  ["communication services", "Communication Services"],
  ["consumer discretionary", "Consumer Discretionary"],
  ["consumer cyclical", "Consumer Discretionary"],
  ["consumer defensive", "Consumer Staples"],
  ["consumer staples", "Consumer Staples"],
  ["financial services", "Financials"],
  ["basic materials", "Materials"],
  ["real estate", "Real Estate"],
  ["health care", "Healthcare"],
  ["healthcare", "Healthcare"],
  ["pharmaceutical", "Healthcare"],
  ["biotechnology", "Healthcare"],
  ["life sciences", "Healthcare"],
  ["semiconductor", "Technology"],
  ["technology", "Technology"],
  ["software", "Technology"],
  ["telecommunication", "Communication Services"],
  ["media", "Communication Services"],
  ["financial", "Financials"],
  ["banking", "Financials"],
  ["insurance", "Financials"],
  ["energy", "Energy"],
  ["oil", "Energy"],
  ["utilities", "Utilities"],
  ["industrials", "Industrials"],
  ["aerospace", "Industrials"],
  ["machinery", "Industrials"],
  ["materials", "Materials"],
  ["chemicals", "Materials"],
  ["metals", "Materials"],
  ["retail", "Consumer Discretionary"],
  ["automobiles", "Consumer Discretionary"],
];

/** A provider's sector or industry as one of the calendar's sectors, or null when it names none. */
export function normalizeSector(raw: string | null | undefined): CalendarSector | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  if (isCalendarSector(text)) return text;
  const lower = text.toLowerCase();
  for (const [needle, sector] of SECTOR_ALIASES) {
    if (lower.includes(needle)) return sector;
  }
  return null;
}

/** The event types the filter lists, in the order it lists them. */
export const CALENDAR_EVENT_TYPES = ["earnings", "macro", "fed", "corporate", "derivatives", "session", "mine"] as const;

export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export const CALENDAR_EVENT_TYPE_LABEL: Record<CalendarEventType, string> = {
  earnings: "Earnings",
  macro: "Macro releases",
  fed: "Fed decisions",
  corporate: "Dividends & splits",
  derivatives: "Options & index",
  session: "Market hours",
  mine: "My events",
};

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Colour names only: the renderer owns the shades, per theme. */
export const CALENDAR_COLORS = [
  "blue",
  "sky",
  "teal",
  "violet",
  "indigo",
  "pink",
  "fuchsia",
  "orange",
  "amber",
  "yellow",
  "brown",
  "slate",
  "stone",
] as const;

export type CalendarColor = (typeof CALENDAR_COLORS)[number];

export function isCalendarColor(value: unknown): value is CalendarColor {
  return typeof value === "string" && (CALENDAR_COLORS as readonly string[]).includes(value);
}

/**
 * Each category's colour. Red and green are left out on purpose: elsewhere in
 * the app they mean up and down, and a green Financials block would read as a
 * gain before it read as a sector.
 */
export const CATEGORY_COLOR: Record<CalendarCategory, CalendarColor> = {
  Technology: "blue",
  "Communication Services": "sky",
  "Consumer Discretionary": "orange",
  "Consumer Staples": "yellow",
  Energy: "amber",
  Financials: "teal",
  Healthcare: "pink",
  Industrials: "brown",
  Materials: "stone",
  "Real Estate": "fuchsia",
  Utilities: "indigo",
  "Funds & ETFs": "slate",
  Unclassified: "stone",
  [MARKET_WIDE]: "violet",
};

// ---------------------------------------------------------------------------
// Corporate events from the provider (main → renderer)
// ---------------------------------------------------------------------------

export type CorporateEventKind = "earnings" | "ex_dividend" | "dividend_payment" | "split";

/** A corporate row's title as a code: `calendar.corporate.title.<code>` in the renderer. */
export type CorporateTitleCode = "earnings" | "exDividend" | "dividendPayment" | "split" | "reverseSplit";

/** One sentence of a corporate row's detail as a code: `calendar.corporate.detail.<code>` in the renderer. */
export type CorporateDetailCode =
  | "earningsWindow"
  | "earningsEstimated"
  | "earningsDated"
  | "indicatedRate"
  | "heldBefore"
  | "payment"
  | "perShare"
  | "wentEx"
  | "distributionWentEx"
  | "splitHistory";

/**
 * A code and its values. Dates are "YYYY-MM-DD" and amounts plain numbers in
 * US dollars, so the renderer formats both in the reader's locale.
 */
export type CorporatePart<C extends string> = { code: C; params?: Readonly<Record<string, string | number>> };

/** A corporate row's wording as codes: the title, and the detail sentence by sentence. */
export type CorporateEventWords = {
  title: CorporatePart<CorporateTitleCode>;
  detail: CorporatePart<CorporateDetailCode>[];
};

/** One dated corporate event of one name, as the provider's calendar or price history has it. */
export type CalendarCorporateEvent = {
  id: string;
  kind: CorporateEventKind;
  ticker: string;
  /** NY calendar date, YYYY-MM-DD. */
  date: string;
  /** The English wording, for logs and for a row without `words` (the briefing's own corporate rows). */
  title: string;
  detail: string | null;
  /** True when the provider marks the date as its own projection. */
  estimated: boolean;
  /** The same wording as codes, which the renderer words in the reader's language. */
  words?: CorporateEventWords;
};

export type CalendarCorporateRequest = { symbols: string[] };

export type CalendarCorporateResult =
  | {
      ok: true;
      events: CalendarCorporateEvent[];
      /** The provider's sector per symbol, already normalised; null when it gave none. */
      sectors: Record<string, CalendarSector | null>;
      /** Symbols whose calendar could not be read this time. */
      unavailable: string[];
      /** Symbols beyond the per-request cap, left out rather than queued. */
      skipped: string[];
    }
  | { ok: false; error: "invalid_request" | "unavailable" };

/** How many names one request may ask about: a watchlist is short, and each new name is two provider reads. */
export const CORPORATE_SYMBOL_CAP = 40;

const TICKER_SHAPE = /^[A-Z][A-Z0-9.\-^=]{0,11}$/;

/** "brk.b " → "BRK.B"; null for anything that is not a ticker. */
export function normalizeTicker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return TICKER_SHAPE.test(upper) ? upper : null;
}

/** The symbols of a corporate request, cleaned, de-duplicated and capped; null when the request is not one. */
export function parseCorporateRequest(raw: unknown): { symbols: string[]; skipped: string[] } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = (raw as { symbols?: unknown }).symbols;
  if (!Array.isArray(list) || list.length > 500) return null;
  const seen = new Set<string>();
  for (const item of list) {
    const ticker = normalizeTicker(item);
    if (ticker) seen.add(ticker);
  }
  const all = [...seen];
  return { symbols: all.slice(0, CORPORATE_SYMBOL_CAP), skipped: all.slice(CORPORATE_SYMBOL_CAP) };
}

// ---------------------------------------------------------------------------
// User events
// ---------------------------------------------------------------------------

/**
 * One of the reader's own events. An all-day event is a run of calendar dates
 * (`date` through `end_date`, both included) and means the same days wherever
 * the reader is. A timed event is a pair of instants, so it stays put when the
 * view switches between local time and New York time.
 */
export type UserCalendarEvent = {
  id: string;
  title: string;
  all_day: boolean;
  /** All-day only: the first and last date, YYYY-MM-DD. */
  date: string | null;
  end_date: string | null;
  /** Timed only: UTC ISO instants. */
  start_at: string | null;
  end_at: string | null;
  ticker: string | null;
  sector: CalendarSector | null;
  color: CalendarColor;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type UserCalendarEventInput = Omit<UserCalendarEvent, "id" | "created_at" | "updated_at">;

export const USER_EVENT_TITLE_MAX = 120;
export const USER_EVENT_NOTES_MAX = 2000;
/** An all-day run longer than a year is a typo, not a plan. */
export const USER_EVENT_MAX_SPAN_DAYS = 366;
/** A timed event is drawn inside the hour grid; past a day it belongs in the all-day lane. */
export const USER_EVENT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const USER_EVENTS_PER_USER_MAX = 5000;

/** Why an event was refused, as a code the renderer words in the reader's language (`calendar.validation.<code>`). */
export type UserEventErrorCode =
  | "unreadable"
  | "titleMissing"
  | "titleTooLong"
  | "dateMissing"
  | "endDateMissing"
  | "endsBeforeStart"
  | "spanTooLong"
  | "timesMissing"
  | "durationTooLong"
  | "tickerInvalid"
  | "sectorInvalid"
  | "notesUnreadable"
  | "notesTooLong";

/**
 * A refusal carries the code and its values for the renderer, and `error`,
 * the same sentence in English, for the main process's IPC answer and its log.
 */
export type UserEventValidation =
  | { ok: true; value: UserCalendarEventInput }
  | { ok: false; error: string; code: UserEventErrorCode; params?: Readonly<Record<string, number>> };

/** The English the codes stand for: the Calendar area's own source table, so the two cannot drift. */
function refuse(code: UserEventErrorCode, params?: Readonly<Record<string, number>>): Extract<UserEventValidation, { ok: false }> {
  let error: string = calendarEn[`calendar.validation.${code}`];
  for (const [name, value] of Object.entries(params ?? {})) error = error.split(`{${name}}`).join(String(value));
  return params ? { ok: false, error, code, params } : { ok: false, error, code };
}

/**
 * Why the store could not answer, as a code the renderer words in the
 * reader's language (`calendar.store.<code>`): reading or writing the file
 * failed, the calendar is full, the event is gone, or this main build has no
 * calendar bridge at all.
 */
export type UserEventStoreErrorCode = "readFailed" | "saveFailed" | "deleteFailed" | "full" | "missing" | "restart";

/** A failed list, write or delete: the English sentence, and the code (with its values) when there is one. */
export type UserEventFailure = {
  ok: false;
  error: string;
  code?: UserEventErrorCode | UserEventStoreErrorCode;
  params?: Readonly<Record<string, number>>;
};

const STORE_ERROR_CODES: ReadonlySet<string> = new Set<UserEventStoreErrorCode>(["readFailed", "saveFailed", "deleteFailed", "full", "missing", "restart"]);

export function isUserEventStoreErrorCode(code: unknown): code is UserEventStoreErrorCode {
  return typeof code === "string" && STORE_ERROR_CODES.has(code);
}

/** A store refusal with its English sentence from the Calendar area's source table. */
export function storeFailure(code: UserEventStoreErrorCode): UserEventFailure & { code: UserEventStoreErrorCode } {
  return { ok: false, error: calendarEn[`calendar.store.${code}`], code };
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date: 2026-02-30 is refused rather than rolled forward. */
export function isYmd(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = YMD.exec(value);
  if (!m) return false;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return at.getUTCFullYear() === Number(m[1]) && at.getUTCMonth() === Number(m[2]) - 1 && at.getUTCDate() === Number(m[3]);
}

/** Whole days from one date to another (negative when `b` is earlier). */
export function daysBetweenYmd(a: string, b: string): number {
  const pa = Date.parse(`${a}T12:00:00Z`);
  const pb = Date.parse(`${b}T12:00:00Z`);
  return Math.round((pb - pa) / 86_400_000);
}

function isoInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  // Only plausible years: a slip of the year field is caught here rather than drawn in 1970.
  const year = new Date(t).getUTCFullYear();
  if (year < 1990 || year > 2200) return null;
  return new Date(t).toISOString();
}

/** Control characters out, whitespace runs kept for notes but collapsed for a title. */
function cleanText(value: string, singleLine: boolean): string {
  const stripped = value.replace(singleLine ? /[\u0000-\u001f\u007f]/g : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, singleLine ? " " : "");
  return singleLine ? stripped.replace(/\s+/g, " ").trim() : stripped.replace(/\r\n?/g, "\n").trim();
}

/**
 * Checks a user event as it arrives over IPC. Every field is re-read rather
 * than trusted: the renderer is ours, but the file this ends up in is read
 * back on every launch, and one bad row must not cost the reader the rest.
 * A refusal is a code (worded by the renderer) and the English sentence for it.
 */
export function validateUserEventInput(raw: unknown): UserEventValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refuse("unreadable");
  const r = raw as Record<string, unknown>;

  if (typeof r.title !== "string") return refuse("titleMissing");
  const title = cleanText(r.title, true);
  if (!title) return refuse("titleMissing");
  if (title.length > USER_EVENT_TITLE_MAX) return refuse("titleTooLong", { max: USER_EVENT_TITLE_MAX });

  const allDay = r.all_day === true;
  let date: string | null = null;
  let endDate: string | null = null;
  let startAt: string | null = null;
  let endAt: string | null = null;

  if (allDay) {
    if (!isYmd(r.date)) return refuse("dateMissing");
    date = r.date;
    endDate = r.end_date === null || r.end_date === undefined || r.end_date === "" ? date : isYmd(r.end_date) ? r.end_date : null;
    if (endDate === null) return refuse("endDateMissing");
    const span = daysBetweenYmd(date, endDate);
    if (span < 0) return refuse("endsBeforeStart");
    if (span >= USER_EVENT_MAX_SPAN_DAYS) return refuse("spanTooLong");
  } else {
    startAt = isoInstant(r.start_at);
    endAt = isoInstant(r.end_at);
    if (!startAt || !endAt) return refuse("timesMissing");
    const duration = Date.parse(endAt) - Date.parse(startAt);
    if (duration <= 0) return refuse("endsBeforeStart");
    if (duration > USER_EVENT_MAX_DURATION_MS) return refuse("durationTooLong");
  }

  let ticker: string | null = null;
  if (r.ticker !== null && r.ticker !== undefined && r.ticker !== "") {
    ticker = normalizeTicker(r.ticker);
    if (!ticker) return refuse("tickerInvalid");
  }

  let sector: CalendarSector | null = null;
  if (r.sector !== null && r.sector !== undefined && r.sector !== "") {
    if (!isCalendarSector(r.sector)) return refuse("sectorInvalid");
    sector = r.sector;
  }

  const color: CalendarColor = isCalendarColor(r.color) ? r.color : "blue";

  let notes = "";
  if (r.notes !== null && r.notes !== undefined) {
    if (typeof r.notes !== "string") return refuse("notesUnreadable");
    notes = cleanText(r.notes, false);
    if (notes.length > USER_EVENT_NOTES_MAX) return refuse("notesTooLong", { max: USER_EVENT_NOTES_MAX });
  }

  return {
    ok: true,
    value: { title, all_day: allDay, date, end_date: endDate, start_at: startAt, end_at: endAt, ticker, sector, color, notes },
  };
}

/** A stored row read back from disk, or null when it is not one. Used on load, so one bad row drops alone. */
export function readStoredUserEvent(raw: unknown): UserCalendarEvent | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !USER_EVENT_ID.test(r.id)) return null;
  const checked = validateUserEventInput(r);
  if (!checked.ok) return null;
  const created = isoInstant(r.created_at) ?? new Date(0).toISOString();
  const updated = isoInstant(r.updated_at) ?? created;
  return { id: r.id, ...checked.value, created_at: created, updated_at: updated };
}

/** Ids main hands out: "ue_" and url-safe characters, never a path. */
export const USER_EVENT_ID = /^ue_[A-Za-z0-9_-]{6,40}$/;

export type UserEventsListResult = { ok: true; events: UserCalendarEvent[] } | UserEventFailure;
export type UserEventWriteResult = { ok: true; event: UserCalendarEvent } | UserEventFailure;
export type UserEventDeleteResult = { ok: true } | UserEventFailure;
