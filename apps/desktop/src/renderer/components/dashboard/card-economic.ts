import type { CalendarItemView, CalendarView, TimedCalendarItemView } from "../../../shared/calendar-view";
import { nyYmd, zonedClock } from "../../../shared/calendar-view";
import {
  CURATED_SPEECH_CODES,
  curatedCode,
  figuresOf,
  matchCurated,
  type EconomicEvent,
  type EconomicFigures,
} from "../../../shared/economic-calendar";
import type { MessageKey } from "@/lib/i18n";
import type { CalendarScope } from "@/lib/calendar-scope";
import { curatedRowImportant, liveRowImportant } from "../calendar/calendar-model";

/**
 * The dashboard card's day with the economic calendar laid over it, and the
 * shared "Important / All" choice applied, the way the Calendar tab does it:
 *
 *  - a curated US release takes its headline's figures, and the headline is
 *    not listed again; the rest of its slot (core CPI beside CPI) is listed
 *    under "All" only;
 *  - every other release, decision and speech of that New York day is
 *    listed at its time in the reader's zone;
 *  - "Important" keeps the curated schedule's weightier rows, the session's
 *    exceptions and the held names' earnings, the high-impact rows of the US
 *    and the major European economies, and the region's from medium up.
 *
 * Pure: the clock, the zone and the words come in.
 */

/** What a row carries beyond the session calendar's own view. */
export type RowExtra = {
  figures?: EconomicFigures | null;
  speech?: boolean;
  startMs: number | null;
  /** The flag beside the row; the US for the curated schedule. */
  country?: string | null;
};

type Words = (key: MessageKey, params?: Record<string, string | number>) => string;

const IMPORTANCE_KEY: Record<1 | 2 | 3, MessageKey> = {
  3: "briefing.importance.high",
  2: "briefing.importance.medium",
  1: "briefing.importance.low",
};

const SOURCE_KEY: Record<EconomicEvent["source"], MessageKey> = {
  tradingview: "calendar.econ.source.tradingview",
  forexfactory: "calendar.econ.source.forexfactory",
};

export type CardDayInput = {
  view: CalendarView;
  /** The session calendar's own items for the day (ids and instants). */
  items: ReadonlyArray<{ id: string; at: string | null }>;
  economic: readonly EconomicEvent[];
  /** The New York date the card lists. */
  ymd: string;
  now: Date;
  zone: string;
  region: string | null;
  scope: CalendarScope;
  t: Words;
};

export function cardDay(input: CardDayInput): { view: CalendarView; extras: Map<string, RowExtra> } {
  const { view, items, economic, ymd, now, zone, region, scope, t } = input;
  const nowMs = now.getTime();
  const atOf = new Map(items.map((i) => [i.id, i.at ? Date.parse(i.at) : Number.NaN]));
  const extras = new Map<string, RowExtra>();
  const headlines = new Set<string>();
  const slot = new Set<string>();

  for (const item of items) {
    const code = curatedCode(item.id);
    const ms = atOf.get(item.id) ?? Number.NaN;
    if (!code) continue;
    const speech = CURATED_SPEECH_CODES.has(code);
    const match = Number.isFinite(ms) ? matchCurated(code, ms, economic) : { headline: null, family: new Set<string>() };
    for (const id of match.family) slot.add(id);
    if (match.headline) headlines.add(match.headline.id);
    extras.set(item.id, { figures: speech ? null : match.headline ? figuresOf(match.headline) : null, speech, startMs: Number.isFinite(ms) ? ms : null, country: "US" });
  }

  const liveTimed: Array<{ row: TimedCalendarItemView; ms: number }> = [];
  const liveAllDay: CalendarItemView[] = [];
  for (const e of economic) {
    if (headlines.has(e.id)) continue;
    const ms = Date.parse(e.at);
    const day = e.allDay ? e.at.slice(0, 10) : nyYmd(e.at);
    if (day !== ymd || !Number.isFinite(ms)) continue;
    const sharesSlot = slot.has(e.id);
    if (scope === "important" && !liveRowImportant(e.country, e.importance, sharesSlot, region)) continue;
    const clock = e.allDay ? null : zonedClock(e.at, zone);
    const row: CalendarItemView = {
      id: `e:${e.id}`,
      kind: "data",
      kindLabel: t(e.speech ? "calendar.econ.kind.speech" : "calendar.econ.kind.release"),
      title: e.title,
      detail: null,
      importance: e.importance,
      tickers: [],
      timeLabel: clock,
      past: e.allDay ? false : ms <= nowMs,
      timeLine: clock ?? t("briefing.rail.allDay"),
      sourceLabel: t(SOURCE_KEY[e.source]),
      importanceLabel: t(IMPORTANCE_KEY[e.importance]),
    };
    extras.set(row.id, { figures: e.speech ? null : figuresOf(e), speech: e.speech, startMs: e.allDay ? null : ms, country: e.country });
    if (clock) liveTimed.push({ row: row as TimedCalendarItemView, ms });
    else liveAllDay.push(row);
  }

  const keepCurated = (item: CalendarItemView) =>
    scope === "all" || item.kind === "earnings" || curatedRowImportant(item.importance, item.kind === "session");

  const timed = [
    ...view.timed.filter(keepCurated).map((row, i) => ({ row, ms: atOf.get(row.id) ?? Number.NaN, i })),
    ...liveTimed.map((x, i) => ({ ...x, i: 1000 + i })),
  ]
    .sort((a, b) => {
      const am = Number.isFinite(a.ms) ? a.ms : Number.POSITIVE_INFINITY;
      const bm = Number.isFinite(b.ms) ? b.ms : Number.POSITIVE_INFINITY;
      // In one slot the curated release comes first, then the rest of its slot.
      return am - bm || Number(a.i >= 1000) - Number(b.i >= 1000) || b.row.importance - a.row.importance || a.i - b.i;
    })
    .map((x) => x.row);
  const firstAhead = timed.findIndex((r) => !r.past);

  return {
    view: {
      ...view,
      allDay: [...view.allDay.filter(keepCurated), ...liveAllDay],
      timed,
      nowIndex: firstAhead === -1 ? timed.length : firstAhead,
    },
    extras,
  };
}
