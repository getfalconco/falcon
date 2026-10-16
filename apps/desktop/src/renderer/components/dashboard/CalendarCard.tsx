import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarRows, NowMarker, ROW_GRID, nowMarkerLabel, sessionStanding, type RowExtra, type SessionStanding } from "@/components/briefing/CalendarRail";
import { QUIET_NOTE_CLASS } from "@/components/briefing/briefing-styles";
import { useEconomicCalendar } from "@/components/calendar/use-calendar-data";
import { addDays, todayIn } from "@/components/calendar/calendar-dates";
import { useI18n } from "@/lib/i18n";
import { useRegion } from "@/lib/region";
import { useTimeZone } from "@/lib/time-zone";
import { useBriefingText } from "@/components/briefing/use-briefing-text";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { useBriefing } from "@/hooks/useBriefing";
import { briefingEnabled } from "@/lib/dashboard-config";
import { cn } from "@/lib/utils";
import type { BriefingText } from "../../../shared/briefing-text";
import type { BriefingReport } from "../../../shared/briefing-types";
import { viewNow } from "../../../shared/briefing-view";
import { calendarForDay, openingDay, stepDay } from "../../../shared/calendar-days";
import { MACRO_CALENDAR } from "../../../shared/calendar-types";
import { calendarView, closedDayNote, dayLabel, degradedNotes, earningsReachNote, mastheadDate, type CalendarView } from "../../../shared/calendar-view";
import { CURATED_SPEECH_CODES, curatedCode, curatedFigures, economicCountries, type EconomicEvent } from "../../../shared/economic-calendar";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
  /** View Calendar: opens the home screen's Calendar tab. */
  onOpenCalendar?: () => void;
};

const SKELETON_BAR = "animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none";

/** The head's small line, in the app's sans like the rest of the calendar. */
const META_CLASS = "font-sans text-[10.5px] font-medium tracking-[0.02em] text-[#9CA3AF]";

/**
 * "16 October", "16 Ekim", "10月16日": the day the rail lists, in the
 * reader's language. No zone and no offset: every time on the rail is
 * already in the reader's own zone.
 */
function headDate(ymd: string, locale: string): string {
  const at = new Date(`${ymd}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", timeZone: "UTC" }).format(at);
  }
}

type CardView = {
  calendar: CalendarView;
  standing: SessionStanding;
  /** The report's own session, rather than a day stepped to with the arrows. */
  isSession: boolean;
  /** "THU SEP 25": the session the rail lists, for the head when that is not today. */
  sessionDate: string;
  earlyClose: boolean;
  /**
   * Set on a day the market does not open: "US markets are closed for the
   * weekend.", or the holiday by name. Such a day has no session, so its rail
   * never carries a session mark (before the open, session ended); while the
   * clock is on it, it carries the "now" line like any today.
   */
  closedNote: string | null;
  /** Quiet lines: a section of the report that failed, or how far held names' earnings are known. */
  notes: string[];
  /** Set when the curated calendar does not reach this session: an empty rail then means "unknown", not "quiet". */
  warning: string | null;
  /** The economic calendar's figures for the curated releases, and which rows are speeches. */
  extras: Map<string, RowExtra>;
};

/** Each curated row's figures (from the economic calendar) and whether it is someone speaking. */
function rowExtras(items: ReadonlyArray<{ id: string; at: string | null }>, economic: readonly EconomicEvent[]): Map<string, RowExtra> {
  const figures = curatedFigures(items, economic);
  const out = new Map<string, RowExtra>();
  for (const item of items) {
    const startMs = item.at ? Date.parse(item.at) : Number.NaN;
    const code = curatedCode(item.id);
    const speech = Boolean(code && CURATED_SPEECH_CODES.has(code));
    const f = figures.get(item.id);
    if (speech || f) out.set(item.id, { figures: speech ? null : (f ?? null), speech, startMs: Number.isFinite(startMs) ? startMs : null });
  }
  return out;
}

/**
 * A report can come out of the on-disk cache written by another build. The
 * view guards its lists, but this card sits in the dashboard's own tree with
 * no boundary above it, so one field of the wrong shape would unmount the
 * whole page. A report the view cannot read is shown as one that failed.
 */
function buildCardView(report: BriefingReport, ymd: string, now: Date, text: BriefingText, zone: string, economic: readonly EconomicEvent[]): CardView | null {
  try {
    const day = calendarForDay(report, ymd, now);
    const calendar = calendarView(day.report, now, { text, zone, clockZone: zone });
    const extras = rowExtras(Array.isArray(day.report.items) ? day.report.items : [], economic);
    if (day.closed) {
      return {
        calendar,
        standing: sessionStanding(calendar, now, day.report.window.target_close_at),
        isSession: false,
        sessionDate: dayLabel(day.ymd, text),
        earlyClose: false,
        closedNote: closedDayNote(day.reason, day.holiday, text),
        notes: [],
        warning: calendar.footnote.tone === "warn" ? calendar.footnote.text : null,
        extras,
      };
    }
    const degraded = degradedNotes(day.report, text);
    const notes = [degraded.macro_calendar, degraded.earnings].filter((n): n is string => typeof n === "string");
    if (day.earningsKnownThrough) notes.push(earningsReachNote(day.earningsKnownThrough, text));
    return {
      calendar,
      standing: sessionStanding(calendar, now, day.report.window.target_close_at),
      isSession: day.isSession,
      sessionDate: mastheadDate(day.report, text),
      earlyClose: day.report.window.early_close === true,
      closedNote: null,
      notes,
      warning: calendar.footnote.tone === "warn" ? calendar.footnote.text : null,
      extras,
    };
  } catch (error) {
    console.error("[calendar] card view failed:", error);
    return null;
  }
}

/**
 * The minute the wall clock is on. The card prints "NOW 10:10" and dims the
 * rows behind it, both to the minute, so it re-reads the clock as each minute
 * turns rather than on a period of its own: a timer that fires every thirty
 * seconds would leave the printed minute up to half a minute behind the one on
 * the reader's own clock. A window that was hidden gets its timers slowed, so
 * coming back into view re-reads the clock at once.
 */
function useMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => setMinute(Math.floor(Date.now() / 60_000));
    const arm = () => {
      timer = setTimeout(() => {
        read();
        arm();
      }, 60_000 - (Date.now() % 60_000) + 20);
    };
    const onVisible = () => {
      if (!document.hidden) read();
    };
    arm();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return minute;
}

function Skeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {["w-[78%]", "w-[62%]", "w-[70%]", "w-[56%]", "w-[74%]"].map((width) => (
        <div key={width} className={ROW_GRID}>
          <div className={cn(SKELETON_BAR, "h-3 w-8")} />
          <div />
          <div className="space-y-1.5">
            <div className={cn(SKELETON_BAR, "h-3", width)} />
            <div className={cn(SKELETON_BAR, "h-2.5 w-[40%]")} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A small solid triangle, the arrow the head steps days with. */
function Triangle({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden>
      <path
        d={direction === "left" ? "M7.25 1.5 L2.5 5 L7.25 8.5 Z" : "M2.75 1.5 L7.5 5 L2.75 8.5 Z"}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STEP_BUTTON =
  "app-no-drag flex h-5 w-5 items-center justify-center rounded-md text-[#4b5563] transition-colors hover:bg-[#1d1b1b]/[0.06] hover:text-[#1d1b1b] disabled:pointer-events-none disabled:opacity-30";

/**
 * The calendar on the dashboard: what is scheduled for a session, on the
 * rail, with the "now" line where the day stands, and every row can be
 * hovered for what else is known about it. On a trading day it opens on the
 * session the clock is on (today until the close, the next one after it),
 * whose rows are the handover report's own; on a day the market does not open
 * (a Saturday, a Sunday, a holiday) it opens on that day, today, with a line
 * saying the market is closed (`openingDay`). The two triangles beside the
 * dots step one calendar day back or on, weekends and holidays included, and
 * those days are built from the same curated calendar and rules through
 * `calendarForDay`.
 *
 * The head names the day whenever the rail is not listing today.
 */
const NO_ECONOMIC: readonly EconomicEvent[] = [];

function CalendarCardInner({ onDuplicate, onRemove, onOpenCalendar }: Props) {
  const { status, report } = useBriefing();
  const text = useBriefingText();
  const t = text.t;
  const minute = useMinute();
  // `minute` is the only reason this recomputes between reports: the view
  // takes the clock as an argument, and this is the one place the card reads it.
  const now = useMemo(() => (report ? viewNow(report, new Date()) : new Date()), [report, minute]);

  // The day on the rail: the opening day (the session, or today when the
  // market is closed today) until an arrow picks another. Stepping back onto
  // it goes back to following it, so the card rolls with the report again at
  // the close, and with the calendar at midnight on a weekend.
  const openYmd = report ? openingDay(report, now) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const shownYmd = picked ?? openYmd;
  // Bounded by the curated file itself, which every day but the session is
  // built from; a report's own coverage line can be a demo's.
  const coverage = MACRO_CALENDAR.coverage;
  const back = shownYmd ? stepDay(shownYmd, -1, coverage) : null;
  const on = shownYmd ? stepDay(shownYmd, 1, coverage) : null;
  const step = (ymd: string | null) => {
    if (ymd) setPicked(ymd === openYmd ? null : ymd);
  };

  // The reader's zone (Settings, General) for every time on the rail, and the
  // economic calendar for the curated releases' figures.
  const zone = useTimeZone();
  const region = useRegion();
  const { locale, t: say } = useI18n();
  const countries = useMemo(() => economicCountries(region), [region]);
  const around = shownYmd ?? todayIn(zone, now);
  const economic = useEconomicCalendar(addDays(around, -1), addDays(around, 1), countries, Math.floor(minute / 10));
  const economicEvents = economic.status === "ready" ? economic.events : NO_ECONOMIC;

  const view = useMemo(
    () => (report && shownYmd ? buildCardView(report, shownYmd, now, text, zone, economicEvents) : null),
    [report, shownYmd, now, text, zone, economicEvents],
  );

  // Once per day shown, the list is scrolled so the "now" line sits mid-card:
  // a reader who looks at 14:00 wants what is next, not the 08:30 print at the
  // top; a day without the line starts at the top. Once, so the list never
  // moves under a reader who has scrolled it; and by hand, not with
  // scrollIntoView, which would also scroll the page. The mark is forgotten
  // whenever the list is not drawn (a report dropped by the store while a
  // fresh one is fetched), because the list's box goes with it and comes back
  // at the top: there is no reader position to protect then.
  const listRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const placedFor = useRef<string | null>(null);
  const ready = view !== null;
  useEffect(() => {
    if (!ready) {
      placedFor.current = null;
      return;
    }
    if (shownYmd === null || placedFor.current === shownYmd) return;
    const list = listRef.current;
    if (!list) return;
    placedFor.current = shownYmd;
    const marker = markerRef.current;
    list.scrollTop = marker ? Math.max(0, marker.offsetTop - list.clientHeight / 2) : 0;
  }, [ready, shownYmd]);

  const unsupported = report === null && status === "unsupported";
  const failed = (report === null && status === "error") || (report !== null && view === null);

  const standing: SessionStanding = view ? view.standing : "on";

  let body: ReactNode;
  if (view) {
    const nothing = view.calendar.allDay.length === 0 && view.calendar.timed.length === 0;
    // The session carries its line wherever the clock stands against it; a
    // day stepped to carries one only while the clock is on it.
    const markerLabel = view.isSession || standing === "on" ? nowMarkerLabel(standing, now, text, zone) : null;
    body = (
      <div ref={listRef} className="scrollbar-meridian relative -mx-2 min-h-0 flex-1 overflow-y-auto px-2">
        {view.earlyClose ? (
          <p className="pb-3 text-[12px] leading-[1.45] text-[#D97706]">{t("briefing.card.earlyClose")}</p>
        ) : null}
        {view.closedNote ? <p className="pb-3 text-[12px] leading-[1.45] text-[#6b7280]">{view.closedNote}</p> : null}

        <CalendarRows view={view.calendar} markerLabel={markerLabel} markerRef={markerRef} extras={view.extras} nowMs={now.getTime()} />
        {/* A closed today with no timed row still gets its "now" line, under
            whatever all-day rows it has: the rail draws the line only among
            timed rows, and without it a Sunday would not read as today. */}
        {view.closedNote && markerLabel !== null && view.calendar.timed.length === 0 ? (
          <NowMarker label={markerLabel} markerRef={markerRef} />
        ) : null}

        {nothing && !view.closedNote && !view.warning && view.notes.length === 0 ? (
          <p className={QUIET_NOTE_CLASS}>{t("briefing.card.nothing")}</p>
        ) : null}
      </div>
    );
  } else if (unsupported) {
    body = <p className="text-[13px] leading-[1.5] text-[#6b7280]">{t("briefing.card.restart")}</p>;
  } else if (failed) {
    body = (
      <>
        <p className="text-[13px] leading-[1.5] text-[#6b7280]">{t("briefing.card.failed")}</p>
        <p className={cn(QUIET_NOTE_CLASS, "mt-1")}>{t("briefing.card.failedNote")}</p>
      </>
    );
  } else {
    body = <Skeleton />;
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("briefing.card.label")}
        meta={
          <span className={cn(META_CLASS, "select-none truncate")}>
            {/* The day the rail lists, and "(Today)" while it is today where the reader is. */}
            {(() => {
              const ymd = shownYmd ?? todayIn(zone, now);
              const date = headDate(ymd, locale);
              return ymd === todayIn(zone, now) ? say("calendar.heading.today", { date }) : date;
            })()}
          </span>
        }
        actions={
          report ? (
            <div className="flex items-center gap-0.5">
              <button type="button" aria-label={t("briefing.card.previousDay")} disabled={!back} onClick={() => step(back)} className={STEP_BUTTON}>
                <Triangle direction="left" />
              </button>
              <button type="button" aria-label={t("briefing.card.nextDay")} disabled={!on} onClick={() => step(on)} className={STEP_BUTTON}>
                <Triangle direction="right" />
              </button>
            </div>
          ) : null
        }
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        // The door to the calendar view: the round arrow in the masthead.
        // Live, outside the dashboard-CTA switch, as the full-width button it
        // replaced was. It opens the Calendar tab beside the greeting;
        // HomePage hands the switch down.
        onOpen={onOpenCalendar}
        openLabel={t("briefing.card.viewCalendar")}
      />

      <div className="flex min-h-0 flex-1 flex-col pt-4">
        {body}

        {view && (view.warning || view.notes.length > 0) ? (
          <div className="mt-3 shrink-0 space-y-1 border-t-[0.5px] border-black/[0.06] pt-2">
            {view.notes.map((note) => (
              <p key={note} className="text-[11px] leading-[1.45] text-[#9CA3AF]">
                {note}
              </p>
            ))}
            {view.warning ? <p className="text-[11px] leading-[1.45] text-[#D97706]">{view.warning}</p> : null}
          </div>
        ) : null}

      </div>
    </div>
  );
}

/**
 * The calendar draws the handover report, so it goes with the handover's
 * switch: with the feature off nothing is mounted at all, or a held store
 * would go on asking the providers on behalf of a surface the switch was
 * meant to remove.
 */
export default function CalendarCard(props: Props) {
  if (!briefingEnabled()) return null;
  return <CalendarCardInner {...props} />;
}
