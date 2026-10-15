import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBriefingText } from "@/components/briefing/use-briefing-text";
import { useBriefing } from "@/hooks/useBriefing";
import { useHomeTabIsActive } from "@/lib/home-tab-activity";
import { briefingEnabled } from "@/lib/dashboard-config";
import { useI18n } from "@/lib/i18n";
import { paperScopeKey } from "@/lib/paper-account";
import { isTypingTarget } from "@/lib/shortcuts";
import { personalAgenda } from "../../../shared/calendar-agenda";
import { MACRO_CALENDAR, sessionWindowFor } from "../../../shared/calendar-types";
import { nyYmd } from "../../../shared/calendar-view";
import {
  type CalendarCategory,
  type CalendarEventType,
  type CalendarSector,
  type UserCalendarEventInput,
} from "../../../shared/calendar-events";
import { useTheme } from "./calendar-colors";
import {
  NY_ZONE,
  fullDay,
  isoWeek,
  longDay,
  localIsNewYork,
  monthGrid,
  rangeTitle,
  shortDay,
  stepAnchor,
  todayIn,
  visibleDays,
  zoneLabel,
  zonedParts,
  zonedWallToMs,
  type CalendarViewMode,
} from "./calendar-dates";
import { categoriesToList, eventOnDay, filterEvents, userEventToCal, withHoldings, type CalEvent, type CalendarFilters } from "./calendar-model";
import { readPrefs, writePrefs, type CalendarPrefs } from "./calendar-prefs";
import { failureMessage } from "./sector-labels";
import { CARD } from "./calendar-styles";
import CalendarHeader from "./CalendarHeader";
import CalendarPopover, { type AnchorRect } from "./CalendarPopover";
import CalendarSidebar from "./CalendarSidebar";
import EventDetails from "./EventDetails";
import EventEditor from "./EventEditor";
import { buildMarketEvents, nyRangeFor } from "./market-events";
import MonthView from "./MonthView";
import TimeGridView, { type CreateRequest, type MoveRequest } from "./TimeGridView";
import {
  createUserEvent,
  deleteUserEvent,
  updateUserEvent,
  useCorporateCalendar,
  useHeldTickers,
  useMinute,
  useUserEvents,
  useWatchlistTickers,
} from "./use-calendar-data";
import { EventBar } from "./EventBlocks";

/**
 * The Calendar tab, after Notion Calendar: week view by default with the
 * hour grid and the all-day lane, day and month views beside it, a small
 * month and the filters on the left.
 *
 * What it shows is what the app already knows. Market events: the curated
 * macro calendar and the Fed, options expiries, index reviews and the
 * session's own exceptions (the same rows as the dashboard's calendar card,
 * through the same builders), the handover report's earnings for held names,
 * and the provider's earnings, dividend and split dates for held and followed
 * names (`calendar:corporate`, cached in main). Each company event is filed
 * under its sector; market-wide rows have a bucket of their own. The
 * reader's own events are kept by the main process, per account. Nothing is
 * made up: a source that is not there is said so in the notes under the
 * filters.
 *
 * The reader's positions come first: the column on the left opens with their
 * upcoming dates counted down from today (the dashboard card's own list), a
 * held name's date sorts first in its day, and with "Highlight your
 * positions" on (the default) it is drawn emphasised on the grid.
 */

type Popover =
  | { kind: "details"; eventId: string; anchor: AnchorRect }
  | { kind: "editor"; source: { request: CreateRequest } | { event: NonNullable<CalEvent["user"]> }; anchor: AnchorRect }
  | { kind: "day"; ymd: string; anchor: AnchorRect };

type Note = { text: string; tone: "quiet" | "warn" };

/** The tab's box: the window under the greeting row, never shorter than a usable grid. */
const TAB_HEIGHT = "max(540px, calc(100vh - 150px))";

function inputOf(user: NonNullable<CalEvent["user"]>): UserCalendarEventInput {
  return {
    title: user.title,
    all_day: user.all_day,
    date: user.date,
    end_date: user.end_date,
    start_at: user.start_at,
    end_at: user.end_at,
    ticker: user.ticker,
    sector: user.sector,
    color: user.color,
    notes: user.notes,
  };
}

function CalendarTabInner({ briefingReport }: { briefingReport: ReturnType<typeof useBriefing>["report"] }) {
  const { t, locale } = useI18n();
  const text = useBriefingText();
  const theme = useTheme();
  const minute = useMinute();
  const nowMs = minute * 60_000;
  const now = useMemo(() => new Date(minute * 60_000), [minute]);

  // --- Preferences ---------------------------------------------------------
  const [prefs, setPrefs] = useState<CalendarPrefs>(readPrefs);
  const updatePrefs = useCallback((patch: Partial<CalendarPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);
  const nyLocal = useMemo(localIsNewYork, []);
  const zone = prefs.zoneMode === "et" || nyLocal ? NY_ZONE : undefined;
  // The zones in words: "NY time" and "Local time", never a raw offset.
  const zoneWords = useMemo(() => ({ ny: t("calendar.zone.nyShort"), local: t("calendar.zone.localShort") }), [t]);
  const zoneText = zoneLabel(zone, zoneWords);

  const today = todayIn(zone, now);
  const [anchor, setAnchor] = useState(today);
  const view = prefs.view;
  // Today stays in a week view even with weekends hidden, so a Sunday is still today.
  const days = useMemo(
    () => visibleDays(view, anchor, prefs.weekStart, prefs.showWeekends, today),
    [view, anchor, prefs.weekStart, prefs.showWeekends, today],
  );
  // The small month tints the days a week or a day view shows; the month view is the month itself.
  const visibleSet = useMemo(() => new Set(view === "month" ? [] : days), [days, view]);

  // --- Data ----------------------------------------------------------------
  const held = useHeldTickers();
  const watchlist = useWatchlistTickers();
  const watchSet = useMemo(() => new Set(watchlist), [watchlist]);
  const heldSet = useMemo(() => new Set(held), [held]);
  const symbols = useMemo(() => [...new Set([...held, ...watchlist])], [held, watchlist]);
  const corporate = useCorporateCalendar(symbols);
  const userEvents = useUserEvents(paperScopeKey("calendar"));

  const sectorOf = useCallback((ticker: string): CalendarSector | null => corporate.sectors[ticker.toUpperCase()] ?? null, [corporate.sectors]);

  // Built for the six weeks around the anchor, which holds every view's days
  // and the small month's: one build serves the grid and the dots.
  const gridDays = useMemo(() => monthGrid(anchor, prefs.weekStart), [anchor, prefs.weekStart]);
  // The hour, not the minute: rows only change which are past, and the views judge that themselves.
  const hour = Math.floor(minute / 60);
  const market = useMemo(() => {
    const range = nyRangeFor(gridDays);
    const corporateEvents = corporate.status === "ready" ? corporate.events : corporate.status === "loading" || corporate.status === "idle" ? [] : null;
    try {
      return buildMarketEvents({
        ...range,
        briefing: briefingReport ?? null,
        corporate: corporateEvents,
        sectorOf,
        now: new Date(hour * 3_600_000),
        text,
        t,
      });
    } catch (error) {
      console.error("[calendar] market events failed:", error);
      return { events: [], notes: [] };
    }
  }, [gridDays, briefingReport, corporate.status, corporate.events, sectorOf, hour, text, t]);

  // Every event marked with the reader's tie to it, so held names' dates sort
  // first in a day and are drawn emphasised while the highlight is on.
  const allEvents = useMemo(
    () =>
      withHoldings(
        [...market.events, ...userEvents.events.map((e) => userEventToCal(e, sectorOf, t))],
        heldSet,
        watchSet,
        prefs.highlightPositions,
      ),
    [market.events, userEvents.events, sectorOf, t, heldSet, watchSet, prefs.highlightPositions],
  );

  // The reader's own upcoming dates for the column on the left, counted from
  // New York's calendar day: the same list, in the same order, as the
  // dashboard's calendar card.
  const nyToday = nyYmd(now) ?? today;
  const agenda = useMemo(
    () =>
      personalAgenda({
        today: nyToday,
        held,
        watchlist,
        corporate: corporate.status === "ready" ? corporate.events : [],
        earnings: Array.isArray(briefingReport?.earnings_next) ? briefingReport.earnings_next : [],
        reportSession: briefingReport?.window.target_session_ymd ?? null,
        text,
      }),
    [nyToday, held, watchlist, corporate.status, corporate.events, briefingReport, text],
  );
  const shown = useMemo(() => filterEvents(allEvents, prefs.filters, watchSet), [allEvents, prefs.filters, watchSet]);

  // Counts over the days in view, before the filters, for the sidebar.
  const inView = useMemo(() => allEvents.filter((e) => days.some((d) => eventOnDay(e, d, zone))), [allEvents, days, zone]);
  const typeCounts = useMemo(() => {
    const out: Partial<Record<CalendarEventType, number>> = {};
    for (const e of inView) out[e.type] = (out[e.type] ?? 0) + 1;
    return out;
  }, [inView]);
  const categoryCounts = useMemo(() => {
    const out: Partial<Record<CalendarCategory, number>> = {};
    for (const e of inView) if (e.category) out[e.category] = (out[e.category] ?? 0) + 1;
    return out;
  }, [inView]);
  const categories = useMemo(() => categoriesToList(allEvents, prefs.filters.hiddenCategories), [allEvents, prefs.filters.hiddenCategories]);
  const marked = useMemo(() => new Set(gridDays.filter((d) => shown.some((e) => e.importance >= 2 && eventOnDay(e, d, zone)))), [gridDays, shown, zone]);

  // The US regular session per day shown, in the viewing zone, for the band on the grid.
  const sessions = useMemo(() => {
    const out: Record<string, { open: number; close: number } | null> = {};
    for (const ymd of days) {
      try {
        const w = sessionWindowFor(ymd, now);
        if (!w) {
          out[ymd] = null;
          continue;
        }
        const open = zonedParts(Date.parse(w.target_open_at), zone);
        const close = zonedParts(Date.parse(w.target_close_at), zone);
        // A session that lands across midnight where the reader is gets no band rather than a wrong one.
        out[ymd] = open.ymd === ymd && close.ymd === ymd ? { open: open.minutes, close: close.minutes } : null;
      } catch {
        out[ymd] = null;
      }
    }
    return out;
    // `now` only enters through the phase, which the band does not use.
  }, [days, zone]);

  // --- Notes under the filters ---------------------------------------------
  const notes = useMemo<Note[]>(() => {
    const out: Note[] = [];
    const cov = MACRO_CALENDAR.coverage;
    const first = days[0];
    const last = days[days.length - 1];
    if (last > cov.until) out.push({ text: t("calendar.note.beyond", { date: fullDay(cov.until, locale) }), tone: "warn" });
    else if (first < cov.from) out.push({ text: t("calendar.note.before", { date: fullDay(cov.from, locale) }), tone: "warn" });
    else out.push({ text: t("calendar.note.coverage", { from: shortDay(cov.from, locale), to: fullDay(cov.until, locale) }), tone: "quiet" });

    if (corporate.status === "unsupported") out.push({ text: t("calendar.note.corporateRestart"), tone: "quiet" });
    else if (corporate.status === "error") out.push({ text: t("calendar.note.corporateError"), tone: "warn" });
    else if (corporate.status === "loading") out.push({ text: t("calendar.note.corporateLoading"), tone: "quiet" });
    else if (symbols.length === 0) out.push({ text: t("calendar.note.corporateNone"), tone: "quiet" });
    else out.push({ text: t("calendar.note.corporateSome", { count: symbols.length - corporate.skipped.length }), tone: "quiet" });
    if (corporate.unavailable.length > 0) {
      const list = corporate.unavailable.slice(0, 4).join(", ") + (corporate.unavailable.length > 4 ? ` +${corporate.unavailable.length - 4}` : "");
      out.push({ text: t("calendar.note.unavailable", { symbols: list }), tone: "warn" });
    }
    if (corporate.skipped.length > 0) out.push({ text: t("calendar.note.skipped", { count: corporate.skipped.length }), tone: "quiet" });
    for (const n of market.notes) out.push({ text: n, tone: "warn" });
    if (userEvents.status === "unsupported") out.push({ text: t("calendar.note.userRestart"), tone: "quiet" });
    else if (userEvents.status === "error" && userEvents.error) out.push({ text: failureMessage(t, userEvents.error), tone: "warn" });
    if (view !== "month") out.push({ text: t("calendar.note.sessionBand"), tone: "quiet" });
    return out;
  }, [days, corporate.status, corporate.unavailable, corporate.skipped, symbols.length, market.notes, userEvents.status, userEvents.error, view, t, locale]);

  // --- Navigation ----------------------------------------------------------
  const [popover, setPopover] = useState<Popover | null>(null);
  const [draft, setDraft] = useState<CreateRequest | null>(null);
  const closePopover = useCallback(() => {
    setPopover(null);
    setDraft(null);
  }, []);

  const goToday = useCallback(() => setAnchor(todayIn(zone, new Date())), [zone]);
  const step = useCallback((direction: -1 | 1) => setAnchor((a) => stepAnchor(view, a, direction)), [view]);
  const setView = useCallback((v: CalendarViewMode) => updatePrefs({ view: v }), [updatePrefs]);
  const openDay = useCallback(
    (ymd: string) => {
      setAnchor(ymd);
      updatePrefs({ view: "day" });
    },
    [updatePrefs],
  );

  // Keys: T for today, the arrows to step, D / W / M for the views. Only with
  // no modifier held, never while typing, and not under another app dialog.
  // The home page keeps this tab mounted behind the others: its keys only act while it is in front.
  const isActive = useHomeTabIsActive();
  const keyState = useRef({ goToday, step, setView, popover });
  keyState.current = { goToday, step, setView, popover };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive()) return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const s = keyState.current;
      if (s.popover?.kind === "editor") return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let handled = true;
      if (key === "t") s.goToday();
      else if (key === "ArrowLeft") s.step(-1);
      else if (key === "ArrowRight") s.step(1);
      else if (key === "d") s.setView("day");
      else if (key === "w") s.setView("week");
      else if (key === "m") s.setView("month");
      else handled = false;
      if (handled) {
        e.preventDefault();
        if (s.popover) setPopover(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  // --- Actions -------------------------------------------------------------
  const selected = popover?.kind === "details" ? allEvents.find((e) => e.id === popover.eventId) ?? null : null;

  const onSelect = useCallback((event: CalEvent, rect: AnchorRect) => {
    setDraft(null);
    setPopover({ kind: "details", eventId: event.id, anchor: rect });
  }, []);

  const onCreate = useCallback((request: CreateRequest, rect: AnchorRect) => {
    setDraft(request);
    setPopover({ kind: "editor", source: { request }, anchor: rect });
  }, []);

  const onMove = useCallback(async (event: CalEvent, request: MoveRequest) => {
    if (!event.user) return;
    const base = inputOf(event.user);
    const next: UserCalendarEventInput = request.allDay
      ? { ...base, all_day: true, date: request.date, end_date: request.endDate, start_at: null, end_at: null }
      : { ...base, all_day: false, date: null, end_date: null, start_at: new Date(request.startMs).toISOString(), end_at: new Date(request.endMs).toISOString() };
    await updateUserEvent(event.user.id, next);
  }, []);

  /** "New event": the next whole hour when today is in view, else 09:00 on the day in view. */
  const newEventAt = (rect: DOMRect) => {
    const onToday = days.includes(today) && (view !== "day" || anchor === today);
    const ymd = onToday ? today : anchor;
    const startMin = onToday ? Math.min(23, Math.floor(zonedParts(Date.now(), zone).minutes / 60) + 1) * 60 : 9 * 60;
    const request: CreateRequest = { allDay: false, startMs: zonedWallToMs(ymd, startMin, zone), endMs: zonedWallToMs(ymd, startMin + 60, zone) };
    onCreate(request, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  };

  const listForDay = popover?.kind === "day" ? shown.filter((e) => eventOnDay(e, popover.ymd, zone)) : [];

  const viewProps = {
    today,
    zone,
    events: shown,
    nowMs,
    theme,
    selectedId: selected?.id ?? null,
    draft,
    onSelect,
    onCreate,
    onMove: (e: CalEvent, r: MoveRequest) => void onMove(e, r),
    onOpenDay: openDay,
  };

  return (
    <div className="app-no-drag mt-5 flex gap-4 px-8 pb-6" style={{ height: TAB_HEIGHT }}>
      <CalendarSidebar
        anchor={anchor}
        today={today}
        weekStart={prefs.weekStart}
        visible={visibleSet}
        marked={marked}
        theme={theme}
        filters={prefs.filters}
        categories={categories}
        typeCounts={typeCounts}
        categoryCounts={categoryCounts}
        hasWatchlist={watchlist.length > 0}
        agenda={agenda}
        holdsAny={held.length > 0}
        highlightPositions={prefs.highlightPositions}
        onHighlightPositions={(highlightPositions) => updatePrefs({ highlightPositions })}
        notes={notes}
        onPick={(ymd) => setAnchor(ymd)}
        onNewEvent={newEventAt}
        onFilters={(filters: CalendarFilters) => updatePrefs({ filters })}
      />

      <section className={`${CARD} flex min-w-0 flex-1 flex-col overflow-hidden`} aria-label={t("calendar.title")}>
        <CalendarHeader
          title={rangeTitle(view, anchor, prefs.weekStart, locale)}
          weekNumber={view === "week" ? isoWeek(days[0] ?? anchor) : null}
          view={view}
          zoneMode={prefs.zoneMode}
          localText={zoneWords.local}
          nyText={zoneWords.ny}
          showZoneSwitch={!nyLocal}
          weekStart={prefs.weekStart}
          showWeekends={prefs.showWeekends}
          onToday={goToday}
          onStep={step}
          onView={setView}
          onZone={(zoneMode) => updatePrefs({ zoneMode })}
          onWeekStart={(weekStart) => updatePrefs({ weekStart })}
          onWeekends={(showWeekends) => updatePrefs({ showWeekends })}
        />
        <div key={view} className="flex min-h-0 flex-1 flex-col">
          {view === "month" ? (
            <MonthView
              {...viewProps}
              days={days}
              anchor={anchor}
              onShowDay={(ymd, _list, rect) => setPopover({ kind: "day", ymd, anchor: rect })}
            />
          ) : (
            <TimeGridView {...viewProps} days={days} zoneText={zoneText} sessions={sessions} />
          )}
        </div>
      </section>

      {popover?.kind === "details" && selected ? (
        <CalendarPopover anchor={popover.anchor} onClose={closePopover} label={selected.title}>
          <EventDetails
            event={selected}
            zone={zone}
            zoneText={zoneText}
            today={nyToday}
            theme={theme}
            onClose={closePopover}
            onEdit={() => selected.user && setPopover({ kind: "editor", source: { event: selected.user }, anchor: popover.anchor })}
            onDelete={async () => {
              if (!selected.user) return null;
              const result = await deleteUserEvent(selected.user.id);
              if (!result.ok) return failureMessage(t, result);
              closePopover();
              return null;
            }}
          />
        </CalendarPopover>
      ) : null}

      {popover?.kind === "editor" ? (
        <CalendarPopover anchor={popover.anchor} width={340} onClose={closePopover} label={"event" in popover.source ? t("calendar.editor.editTitle") : t("calendar.editor.newTitle")}>
          <EventEditor
            source={popover.source}
            zone={zone}
            zoneText={zoneText}
            sectorOf={sectorOf}
            onDraft={(request) => ("request" in popover.source ? setDraft(request) : undefined)}
            onCancel={closePopover}
            onSave={async (input) => {
              const result = "event" in popover.source ? await updateUserEvent(popover.source.event.id, input) : await createUserEvent(input);
              if (!result.ok) return failureMessage(t, result);
              closePopover();
              return null;
            }}
          />
        </CalendarPopover>
      ) : null}

      {popover?.kind === "day" ? (
        <CalendarPopover anchor={popover.anchor} width={280} onClose={closePopover} label={t("calendar.dayList", { date: longDay(popover.ymd, locale) })}>
          <div className="p-3">
            <div className="mb-2 px-1 text-[13px] font-medium text-[#1d1b1b]">{longDay(popover.ymd, locale)}</div>
            <div className="scrollbar-meridian max-h-[320px] space-y-[2px] overflow-y-auto">
              {listForDay.length === 0 ? <p className="px-1 text-[12px] text-[#9CA3AF]">{t("calendar.empty.day")}</p> : null}
              {listForDay.map((e) => (
                <EventBar
                  key={e.id}
                  event={e}
                  theme={theme}
                  zoneMinutes={!e.allDay && e.startMs !== null ? zonedParts(e.startMs, zone).minutes : null}
                  className="w-full"
                  onClick={(ev) => onSelect(e, (ev.currentTarget as HTMLElement).getBoundingClientRect())}
                />
              ))}
            </div>
          </div>
        </CalendarPopover>
      ) : null}
    </div>
  );
}

/**
 * The tab mounts the handover report's store only while the feature is on,
 * the way the dashboard card does: with it off nothing should keep asking
 * the providers on its behalf. Without it the market rows still come from
 * the curated calendar and the corporate dates from `calendar:corporate`.
 */
function WithBriefing() {
  const { report } = useBriefing();
  return <CalendarTabInner briefingReport={report} />;
}

export default function CalendarTab() {
  if (briefingEnabled()) return <WithBriefing />;
  return <CalendarTabInner briefingReport={null} />;
}
