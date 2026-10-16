/**
 * Calendar tab: one event shape for everything the grid draws, and the
 * filters over it.
 *
 * Market rows (the session calendar's items, the provider's corporate dates)
 * and the reader's own events arrive in three shapes; the views only ever see
 * `CalEvent`. All-day events are a run of calendar dates; timed events are a
 * pair of instants, placed on the grid in whichever zone the reader views.
 *
 * Pure.
 */

import {
  CATEGORY_COLOR,
  CALENDAR_SECTORS,
  MARKET_WIDE,
  type CalendarCategory,
  type CalendarColor,
  type CalendarCorporateEvent,
  type CalendarEventType,
  type CorporateDetailCode,
  type CorporateEventWords,
  type CorporatePart,
  type CorporateTitleCode,
  type CalendarSector,
  type UserCalendarEvent,
} from "../../../shared/calendar-events";
import type { CalendarItemView } from "../../../shared/calendar-view";
import {
  CURATED_SPEECH_CODES,
  IMPORTANT_COUNTRIES,
  curatedCode,
  figuresOf,
  type EconomicEvent,
  type EconomicFigures,
  type EconomicSource,
} from "../../../shared/economic-calendar";
import type { MessageKey, TFunction } from "@/lib/i18n";
import { addDays, shortDay, zonedParts, MINUTES_PER_DAY } from "./calendar-dates";

export type CalEvent = {
  id: string;
  origin: "market" | "user";
  type: CalendarEventType;
  /** The sector (or the market-wide bucket) a market event is filed under; null for the reader's own events without one. */
  category: CalendarCategory | null;
  color: CalendarColor;
  title: string;
  detail: string | null;
  importance: 1 | 2 | 3;
  /** "Earnings", "FOMC", "Dividend"... the small label under a title. */
  kindLabel: string;
  allDay: boolean;
  /** All-day: the first and last date, both included. Timed: unused (empty). */
  startDate: string;
  endDate: string;
  /** Timed: epoch ms. */
  startMs: number | null;
  endMs: number | null;
  /** Market timed events: "08:30" New York time, as scheduled. */
  timeEt: string | null;
  /** The detail card's clock line ("08:30 ET · 15:30 your time"), when the session calendar wrote one. */
  timeLine: string | null;
  tickers: string[];
  sourceLabel: string | null;
  estimated: boolean;
  notes: string;
  user: UserCalendarEvent | null;
  /** The provider's kind for a company date (earnings, ex-dividend, payment, split), for the detail card's countdown. */
  corporateKind?: CalendarCorporateEvent["kind"];
  /** Whether the event is about a name the reader holds or follows (`withHoldings`). */
  holding?: Holding | null;
  /** Drawn emphasised: a held name's date while "Highlight your positions" is on. */
  emphasis?: boolean;
  /** The country a release or a decision is for (ISO alpha-2, "EU"): the round flag beside the row. */
  country?: string | null;
  /** Forecast, previous and, once out, actual (the economic calendar). */
  figures?: EconomicFigures | null;
  /** Someone speaking: no figures, and "Completed" once its time has passed. */
  speech?: boolean;
  /** Read from the economic calendar rather than the curated schedule. */
  live?: EconomicSource;
  /** A live row printed in the same slot as a curated release (core CPI beside CPI): the curated row's id. */
  slotOf?: string;
};

export type Holding = "held" | "watchlist";

/** How long a scheduled release is drawn for: it is an instant, but a block needs room for its title. */
export const RELEASE_BLOCK_MINUTES = 30;

export type SectorLookup = (ticker: string) => CalendarSector | null;

function categoryOfTickers(tickers: readonly string[], sectorOf: SectorLookup): CalendarSector {
  for (const t of tickers) {
    const s = sectorOf(t);
    if (s) return s;
  }
  return "Unclassified";
}

const TYPE_OF_KIND: Record<CalendarItemView["kind"], CalendarEventType> = {
  fomc: "fed",
  data: "macro",
  opex: "derivatives",
  rebalance: "derivatives",
  session: "session",
  earnings: "earnings",
};

/** One of the session calendar's rows on its New York date. */
export function itemViewToCal(view: CalendarItemView, ymd: string, at: string | null, sectorOf: SectorLookup): CalEvent {
  const type = TYPE_OF_KIND[view.kind] ?? "macro";
  const code = curatedCode(view.id);
  const category: CalendarCategory = type === "earnings" ? categoryOfTickers(view.tickers, sectorOf) : MARKET_WIDE;
  const startMs = view.timeLabel && at ? Date.parse(at) : Number.NaN;
  const timed = Number.isFinite(startMs);
  return {
    id: `m:${view.id}`,
    origin: "market",
    type,
    category,
    color: CATEGORY_COLOR[category],
    title: view.title,
    detail: view.detail,
    importance: view.importance,
    kindLabel: view.kindLabel,
    allDay: !timed,
    startDate: ymd,
    endDate: ymd,
    startMs: timed ? startMs : null,
    endMs: timed ? startMs + RELEASE_BLOCK_MINUTES * 60_000 : null,
    timeEt: view.timeLabel,
    timeLine: view.timeLine,
    tickers: [...view.tickers],
    sourceLabel: view.sourceLabel,
    estimated: false,
    notes: "",
    user: null,
    // The curated schedule, the expiries, the index reviews and the session are all the US market's own.
    country: view.kind === "earnings" ? null : "US",
    ...(code && CURATED_SPEECH_CODES.has(code) ? { speech: true } : {}),
    ...(view.kind === "earnings" ? { corporateKind: "earnings" as const } : {}),
  };
}

/** A US rate decision is a Fed decision; every other live row is a release. */
const FED_DECISION = /^(Fed Interest Rate Decision|FOMC\b)/i;

const SOURCE_KEY: Record<EconomicSource, MessageKey> = {
  tradingview: "calendar.econ.source.tradingview",
  forexfactory: "calendar.econ.source.forexfactory",
};

const SOURCE_ENGLISH: Record<EconomicSource, string> = {
  tradingview: "From TradingView's economic calendar.",
  forexfactory: "From the Forex Factory calendar.",
};

/** One row of the economic calendar. Timed at its instant (a half hour block); a row with no hour is all-day on its UTC date. */
export function economicToCal(e: EconomicEvent, t?: TFunction): CalEvent {
  const startMs = Date.parse(e.at);
  const timed = !e.allDay && Number.isFinite(startMs);
  const ymd = e.at.slice(0, 10);
  const type: CalendarEventType = e.country === "US" && FED_DECISION.test(e.title) ? "fed" : "macro";
  return {
    id: `e:${e.id}`,
    origin: "market",
    type,
    category: MARKET_WIDE,
    color: CATEGORY_COLOR[MARKET_WIDE],
    title: e.title,
    detail: null,
    importance: e.importance,
    kindLabel: t ? t(e.speech ? "calendar.econ.kind.speech" : "calendar.econ.kind.release") : e.speech ? "Speech" : "Release",
    allDay: !timed,
    startDate: timed ? "" : ymd,
    endDate: timed ? "" : ymd,
    startMs: timed ? startMs : null,
    endMs: timed ? startMs + RELEASE_BLOCK_MINUTES * 60_000 : null,
    timeEt: null,
    timeLine: null,
    tickers: [],
    sourceLabel: t ? t(SOURCE_KEY[e.source]) : SOURCE_ENGLISH[e.source],
    estimated: false,
    notes: "",
    user: null,
    country: e.country,
    figures: e.speech ? null : figuresOf(e),
    speech: e.speech,
    live: e.source,
  };
}

/** Whether a speech's time is behind the clock: it then reads "Completed". */
export function speechDone(event: CalEvent, nowMs: number): boolean {
  return Boolean(event.speech) && event.startMs !== null && event.startMs <= nowMs;
}

/**
 * The reader's language for the rows the views word themselves: `t`, and the
 * locale `Intl` formats their dates and amounts in. Left out, a row reads in
 * English, as main wrote it.
 */
export type CalendarWords = { t: TFunction; locale: string };

const CORPORATE_LABEL: Record<CalendarCorporateEvent["kind"], string> = {
  earnings: "Earnings",
  ex_dividend: "Dividend",
  dividend_payment: "Dividend",
  split: "Split",
};

const CORPORATE_LABEL_KEY: Record<CalendarCorporateEvent["kind"], MessageKey> = {
  earnings: "briefing.kind.earnings",
  ex_dividend: "calendar.kind.dividend",
  dividend_payment: "calendar.kind.dividend",
  split: "calendar.kind.split",
};

/** "$0.26", "0,26 $", "0.26ドル"...: fund distributions run to four decimals, so up to four are kept. */
function usdIn(locale: string, amount: number): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
  } catch {
    return `$${amount}`;
  }
}

/** One code's values, formatted for the reader: dates as short dates, amounts as dollars. */
function wordParams(params: Readonly<Record<string, string | number>> | undefined, locale: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (name === "amount" && typeof value === "number") out[name] = usdIn(locale, value);
    else if ((name === "from" || name === "to") && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) out[name] = shortDay(value, locale);
    else out[name] = value;
  }
  return out;
}

/**
 * A corporate row's title and detail in the reader's language, from the codes
 * main sent. Null when there are none or one is not a key this build has
 * (an older or newer main): the row then keeps main's English whole rather
 * than coming out half in one language and half in another.
 */
export function wordCorporate(words: CorporateEventWords | undefined, w: CalendarWords): { title: string; detail: string | null } | null {
  if (!words?.title?.code || !Array.isArray(words.detail)) return null;
  const titleKey = (words.title.code === "earnings" ? "briefing.row.earnings" : `calendar.corporate.title.${words.title.code}`) as MessageKey;
  const keys = [titleKey, ...words.detail.map((d) => `calendar.corporate.detail.${d?.code}` as MessageKey)];
  if (keys.some((k) => w.t(k) === k)) return null;
  const title = w.t(titleKey, wordParams(words.title.params, w.locale));
  const detail = words.detail.map((d) => w.t(`calendar.corporate.detail.${d.code}` as MessageKey, wordParams(d.params, w.locale))).join(" ");
  return { title, detail: detail || null };
}

/** The English titles main and the briefing write, read back as codes for a row that came without `words`. */
const TITLE_SHAPES: ReadonlyArray<[RegExp, (m: RegExpExecArray) => CorporatePart<CorporateTitleCode>]> = [
  [/^(\S+) earnings report$/, (m) => ({ code: "earnings", params: { ticker: m[1]! } })],
  [/^(\S+) ex-dividend date$/, (m) => ({ code: "exDividend", params: { ticker: m[1]! } })],
  [/^(\S+) dividend payment$/, (m) => ({ code: "dividendPayment", params: { ticker: m[1]! } })],
  [
    /^(\S+) (\d+(?:\.\d+)?)-for-(\d+(?:\.\d+)?) (reverse split|split)$/,
    (m) => ({ code: m[4] === "split" ? "split" : "reverseSplit", params: { ticker: m[1]!, num: Number(m[2]), den: Number(m[3]) } }),
  ],
];

/** Whole English details that carry no values, by their code. */
const DETAIL_SENTENCES: Readonly<Record<string, CorporateDetailCode>> = {
  "Date from the data provider. The hour is not given.": "earningsDated",
  "Date estimated by the data provider; the company has not confirmed it.": "earningsEstimated",
  "Shares held before this date carry the payment.": "heldBefore",
  "The payment date the provider lists for the current dividend.": "payment",
  "Price history from before this date is on the old share count.": "splitHistory",
  "A distribution went ex-dividend, read from the price history.": "distributionWentEx",
};

/**
 * A row without codes (an older main's answer, the briefing's own corporate
 * rows): its title read back from the known English shapes, and its detail
 * worded only when it is one whole known sentence, else kept as written.
 * Null when the title is not a known shape.
 */
function wordEnglish(e: CalendarCorporateEvent, w: CalendarWords): { title: string; detail: string | null } | null {
  for (const [shape, part] of TITLE_SHAPES) {
    const m = shape.exec(e.title);
    if (!m) continue;
    const code = e.detail ? DETAIL_SENTENCES[e.detail] : undefined;
    const worded = wordCorporate({ title: part(m), detail: code ? [{ code }] : [] }, w);
    if (!worded) return null;
    return { title: worded.title, detail: code ? worded.detail : e.detail };
  }
  return null;
}

/** Whether a corporate row was read from the price history rather than the provider's calendar. */
function readFromHistory(e: CalendarCorporateEvent): boolean {
  if (e.kind === "split") return true;
  if (e.kind !== "ex_dividend") return false;
  if (e.words) return e.words.detail.some((d) => d.code === "wentEx" || d.code === "distributionWentEx");
  return /price history/.test(e.detail ?? "");
}

/** One of the provider's corporate dates. */
export function corporateToCal(e: CalendarCorporateEvent, sectorOf: SectorLookup, w?: CalendarWords): CalEvent {
  const category = categoryOfTickers([e.ticker], sectorOf);
  const fromHistory = readFromHistory(e);
  const worded = w ? (e.words ? wordCorporate(e.words, w) : wordEnglish(e, w)) : null;
  const sourceKey: MessageKey = fromHistory ? "calendar.source.priceHistory" : e.estimated ? "calendar.source.estimated" : "calendar.source.provider";
  return {
    id: `m:${e.id}`,
    origin: "market",
    type: e.kind === "earnings" ? "earnings" : "corporate",
    category,
    color: CATEGORY_COLOR[category],
    title: worded?.title ?? e.title,
    detail: worded ? worded.detail : e.detail,
    importance: e.kind === "earnings" ? 3 : e.kind === "dividend_payment" ? 1 : 2,
    kindLabel: w ? w.t(CORPORATE_LABEL_KEY[e.kind]) : CORPORATE_LABEL[e.kind],
    allDay: true,
    startDate: e.date,
    endDate: e.date,
    startMs: null,
    endMs: null,
    timeEt: null,
    timeLine: w ? w.t("calendar.detail.allDay") : "All day",
    tickers: [e.ticker],
    sourceLabel: w
      ? w.t(sourceKey)
      : fromHistory
        ? "Read from the provider's price history."
        : e.estimated
          ? "Date estimated by the data provider."
          : "Date from the data provider.",
    estimated: e.estimated,
    notes: "",
    user: null,
    corporateKind: e.kind,
  };
}

/** One of the reader's own events. A ticker without a chosen sector borrows its company's, when known. */
export function userEventToCal(e: UserCalendarEvent, sectorOf: SectorLookup, t?: TFunction): CalEvent {
  const sector = e.sector ?? (e.ticker ? sectorOf(e.ticker) : null);
  const startMs = e.start_at ? Date.parse(e.start_at) : null;
  const endMs = e.end_at ? Date.parse(e.end_at) : null;
  return {
    id: `u:${e.id}`,
    origin: "user",
    type: "mine",
    category: sector,
    color: e.color,
    title: e.title,
    detail: null,
    importance: 2,
    kindLabel: t ? t("calendar.kind.mine") : "My event",
    allDay: e.all_day,
    startDate: e.all_day ? (e.date ?? "") : "",
    endDate: e.all_day ? (e.end_date ?? e.date ?? "") : "",
    startMs: e.all_day ? null : startMs,
    endMs: e.all_day ? null : endMs,
    timeEt: null,
    timeLine: null,
    tickers: e.ticker ? [e.ticker] : [],
    sourceLabel: null,
    estimated: false,
    notes: e.notes,
    user: e,
  };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** A timed event's piece on one day, in minutes from that day's midnight in the viewing zone. */
export type DaySegment = { event: CalEvent; ymd: string; start: number; end: number; continuesBefore: boolean; continuesAfter: boolean };

/**
 * The pieces a timed event leaves on each of `days`. An event that crosses
 * midnight in the viewing zone is cut there and drawn on both days, marked so
 * the block can square off the cut edge.
 */
export function timedSegments(event: CalEvent, days: readonly string[], zone: string | undefined): DaySegment[] {
  if (event.allDay || event.startMs === null || event.endMs === null) return [];
  const start = zonedParts(event.startMs, zone);
  const end = zonedParts(Math.max(event.endMs, event.startMs + 1), zone);
  const out: DaySegment[] = [];
  for (const ymd of days) {
    if (ymd < start.ymd || ymd > end.ymd) continue;
    // An event that ends exactly at midnight leaves nothing on the next day.
    if (ymd === end.ymd && end.minutes === 0 && ymd !== start.ymd) continue;
    const s = ymd === start.ymd ? start.minutes : 0;
    const e = ymd === end.ymd ? (end.minutes === 0 && ymd !== start.ymd ? MINUTES_PER_DAY : end.minutes) : MINUTES_PER_DAY;
    out.push({ event, ymd, start: s, end: Math.max(e, s), continuesBefore: ymd !== start.ymd, continuesAfter: ymd !== end.ymd && !(addDays(ymd, 1) === end.ymd && end.minutes === 0) });
  }
  return out;
}

/** Whether an event touches a calendar date in the viewing zone. */
export function eventOnDay(event: CalEvent, ymd: string, zone: string | undefined): boolean {
  if (event.allDay) return event.startDate <= ymd && event.endDate >= ymd;
  return timedSegments(event, [ymd], zone).length > 0;
}

const HOLDING_RANK = { held: 0, watchlist: 1, none: 2 } as const;

function holdingRank(e: CalEvent): number {
  return HOLDING_RANK[e.holding ?? "none"];
}

/**
 * Sorts a day's list the way a month cell and the detail list read: all-day
 * first, the reader's positions before the watchlist before the rest, heavier
 * first; then by time.
 */
export function compareEvents(a: CalEvent, b: CalEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.allDay) {
    return a.startDate.localeCompare(b.startDate) || holdingRank(a) - holdingRank(b) || b.importance - a.importance || a.title.localeCompare(b.title);
  }
  return (a.startMs ?? 0) - (b.startMs ?? 0) || b.importance - a.importance || a.title.localeCompare(b.title);
}

/**
 * Marks each market event with the reader's tie to it: a held name, a
 * watchlist name, or neither (the market's own rows, the reader's own
 * events). With `highlight` on, held names' dates are drawn emphasised.
 */
export function withHoldings(events: readonly CalEvent[], held: ReadonlySet<string>, watchlist: ReadonlySet<string>, highlight: boolean): CalEvent[] {
  return events.map((e) => {
    if (e.origin !== "market" || e.tickers.length === 0) return e;
    const tickers = e.tickers.map((t) => t.toUpperCase());
    const holding: Holding | null = tickers.some((t) => held.has(t)) ? "held" : tickers.some((t) => watchlist.has(t)) ? "watchlist" : null;
    if (holding === null) return e;
    return { ...e, holding, emphasis: highlight && holding === "held" };
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** "Important" or "All", the choice under the small month. */
export type CalendarScope = "important" | "all";

/**
 * Whether an event belongs to "Important": the reader's own events; the
 * dates of names they hold or follow; the curated US schedule's weightier
 * rows and the session's exceptions; the economic calendar's high-impact
 * rows for the US and the major European economies; and the reader's
 * region's rows of medium impact and up. A live row printed in the slot of a
 * curated release is that release over again, and is left to "All".
 */
export function isImportant(e: CalEvent, region: string | null): boolean {
  if (e.origin === "user") return true;
  if (e.live) {
    if (e.slotOf) return false;
    if (region && e.country === region && e.importance >= 2) return true;
    return e.importance === 3 && Boolean(e.country && IMPORTANT_COUNTRIES.has(e.country));
  }
  if (e.type === "earnings" || e.type === "corporate") return Boolean(e.holding);
  return e.importance >= 2 || e.type === "session";
}

export function scopeEvents(events: readonly CalEvent[], scope: CalendarScope, region: string | null): CalEvent[] {
  return scope === "all" ? [...events] : events.filter((e) => isImportant(e, region));
}

export type CalendarFilters = {
  hiddenTypes: CalendarEventType[];
  hiddenCategories: CalendarCategory[];
  /** Company events of watchlist names only; market-wide rows and the reader's own events are unaffected. */
  watchlistOnly: boolean;
};

export const DEFAULT_FILTERS: CalendarFilters = { hiddenTypes: [], hiddenCategories: [], watchlistOnly: false };

export function filterEvents(events: readonly CalEvent[], filters: CalendarFilters, watchlist: ReadonlySet<string>): CalEvent[] {
  const types = new Set(filters.hiddenTypes);
  const categories = new Set(filters.hiddenCategories);
  return events.filter((e) => {
    if (types.has(e.type)) return false;
    if (e.category !== null && categories.has(e.category)) return false;
    if (filters.watchlistOnly && e.origin === "market" && e.category !== MARKET_WIDE && e.tickers.length > 0) {
      return e.tickers.some((t) => watchlist.has(t));
    }
    return true;
  });
}

/** The categories the filter lists: market-wide first, then every sector the events carry or the reader has hidden. */
export function categoriesToList(events: readonly CalEvent[], hidden: readonly CalendarCategory[]): CalendarCategory[] {
  const present = new Set<CalendarCategory>(hidden);
  for (const e of events) if (e.category) present.add(e.category);
  const order: CalendarCategory[] = [MARKET_WIDE, ...CALENDAR_SECTORS];
  return order.filter((c) => present.has(c));
}

/** Reads stored filters back, keeping only values this build knows. */
export function readFilters(raw: unknown, knownTypes: readonly string[], knownCategories: readonly string[]): CalendarFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_FILTERS };
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown, known: readonly string[]) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && known.includes(x)))] : [];
  return {
    hiddenTypes: strings(r.hiddenTypes, knownTypes) as CalendarEventType[],
    hiddenCategories: strings(r.hiddenCategories, knownCategories) as CalendarCategory[],
    watchlistOnly: r.watchlistOnly === true,
  };
}
