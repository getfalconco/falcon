import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarRows, ROW_GRID, nowMarkerLabel, sessionStanding, type SessionStanding } from "@/components/briefing/CalendarRail";
import { HEAD_CLASS, QUIET_NOTE_CLASS } from "@/components/briefing/briefing-styles";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { useBriefing } from "@/hooks/useBriefing";
import { briefingEnabled } from "@/lib/dashboard-config";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { viewNow } from "../../../shared/briefing-view";
import { calendarForDay, stepSession } from "../../../shared/calendar-days";
import { MACRO_CALENDAR } from "../../../shared/calendar-types";
import { calendarView, degradedNotes, earningsReachNote, mastheadDate, type CalendarView } from "../../../shared/calendar-view";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
};

const SKELETON_BAR = "animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none";

/**
 * The meta names New York's offset from UTC as it stands right now — "UTC−4"
 * through the summer, "UTC−5" in winter — so a reader anywhere can place the
 * times without knowing what "ET" means today. Read from the clock, never
 * hard-coded: the switch happens twice a year and nobody would remember to
 * edit a string on those two nights.
 */
function nyUtcOffset(now: Date): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = part ? /([+-])(\d{1,2})(?::(\d{2}))?/.exec(part) : null;
    if (!m) return "UTC−4";
    const sign = m[1] === "-" ? "−" : "+";
    return `UTC${sign}${Number(m[2])}${m[3] && m[3] !== "00" ? `:${m[3]}` : ""}`;
  } catch {
    return "UTC−4";
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
  /** Quiet lines: a section of the report that failed, or how far held names' earnings are known. */
  notes: string[];
  /** Set when the curated calendar does not reach this session: an empty rail then means "unknown", not "quiet". */
  warning: string | null;
};

/**
 * A report can come out of the on-disk cache written by another build. The
 * view guards its lists, but this card sits in the dashboard's own tree with
 * no boundary above it, so one field of the wrong shape would unmount the
 * whole page. A report the view cannot read is shown as one that failed.
 */
function buildCardView(report: BriefingReport, ymd: string, now: Date): CardView | null {
  try {
    const day = calendarForDay(report, ymd, now);
    // Only trading days are ever asked for (the arrows step over the rest);
    // a closed answer is a report this build cannot read, and is shown as one.
    if (day.closed) return null;
    const calendar = calendarView(day.report, now);
    const degraded = degradedNotes(day.report);
    const notes = [degraded.macro_calendar, degraded.earnings].filter((n): n is string => typeof n === "string");
    if (day.earningsKnownThrough) notes.push(earningsReachNote(day.earningsKnownThrough));
    return {
      calendar,
      standing: sessionStanding(calendar, now, day.report.window.target_close_at),
      isSession: day.isSession,
      sessionDate: mastheadDate(day.report),
      earlyClose: day.report.window.early_close === true,
      notes,
      warning: calendar.footnote.tone === "warn" ? calendar.footnote.text : null,
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
 * hovered for what else is known about it. It opens on the session the clock
 * is on (today until the close, the next one after it and through the
 * weekend), whose rows are the handover report's own; the two triangles
 * beside the dots step a trading day back or on, and those days are built
 * from the same curated calendar and rules through `calendarForDay`.
 *
 * The head names the day whenever the rail is not listing today.
 */
function CalendarCardInner({ onDuplicate, onRemove }: Props) {
  const { status, report } = useBriefing();
  const minute = useMinute();
  // `minute` is the only reason this recomputes between reports: the view
  // takes the clock as an argument, and this is the one place the card reads it.
  const now = useMemo(() => (report ? viewNow(report, new Date()) : new Date()), [report, minute]);

  // The day on the rail: the session until an arrow picks another. Stepping
  // back onto the session goes back to following it, so the card rolls with
  // the report again at the close.
  const sessionYmd = report?.window.target_session_ymd ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const shownYmd = picked ?? sessionYmd;
  // Bounded by the curated file itself, which every day but the session is
  // built from; a report's own coverage line can be a demo's.
  const coverage = MACRO_CALENDAR.coverage;
  const back = shownYmd ? stepSession(shownYmd, -1, coverage) : null;
  const on = shownYmd ? stepSession(shownYmd, 1, coverage) : null;
  const step = (ymd: string | null) => {
    if (ymd) setPicked(ymd === sessionYmd ? null : ymd);
  };

  const view = useMemo(
    () => (report && shownYmd ? buildCardView(report, shownYmd, now) : null),
    [report, shownYmd, now],
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
    const markerLabel = view.isSession || standing === "on" ? nowMarkerLabel(standing, now) : null;
    body = (
      <div ref={listRef} className="scrollbar-meridian relative -mx-2 min-h-0 flex-1 overflow-y-auto px-2">
        {view.earlyClose ? (
          <p className="pb-3 text-[12px] leading-[1.45] text-[#D97706]">Early close: this session ends at 13:00 ET.</p>
        ) : null}

        <CalendarRows view={view.calendar} markerLabel={markerLabel} markerRef={markerRef} />

        {nothing && !view.warning && view.notes.length === 0 ? (
          <p className={QUIET_NOTE_CLASS}>Nothing scheduled for this session.</p>
        ) : null}
      </div>
    );
  } else if (unsupported) {
    body = <p className="text-[13px] leading-[1.5] text-[#6b7280]">Restart Falcon to enable the calendar.</p>;
  } else if (failed) {
    body = (
      <>
        <p className="text-[13px] leading-[1.5] text-[#6b7280]">The calendar could not be put together right now.</p>
        <p className={cn(QUIET_NOTE_CLASS, "mt-1")}>It is asked for again on its own. The rest of the dashboard is unaffected.</p>
      </>
    );
  } else {
    body = <Skeleton />;
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label="CALENDAR"
        meta={
          <span className={cn(HEAD_CLASS, "select-none truncate")}>
            {/* The offset of the listed day, not of this instant: a day across
                the November change is on UTC−5 while the clock is still on
                UTC−4, and every time on its rows is that day's New York time.
                Noon there is clear of the 02:00 change either way. */}
            {!view || !shownYmd
              ? nyUtcOffset(now)
              : standing === "on"
                ? nyUtcOffset(new Date(`${shownYmd}T16:00:00Z`))
                : `${view.sessionDate} · ${nyUtcOffset(new Date(`${shownYmd}T16:00:00Z`))}`}
          </span>
        }
        actions={
          report ? (
            <div className="flex items-center gap-0.5">
              <button type="button" aria-label="Previous day" disabled={!back} onClick={() => step(back)} className={STEP_BUTTON}>
                <Triangle direction="left" />
              </button>
              <button type="button" aria-label="Next day" disabled={!on} onClick={() => step(on)} className={STEP_BUTTON}>
                <Triangle direction="right" />
              </button>
            </div>
          ) : null
        }
        onDuplicate={onDuplicate}
        onRemove={onRemove}
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

        {/* The door to the calendar view. Drawn live — the reader asked for
            it not to sit recessed — and outside the dashboard-CTA switch,
            which would dim it again. Nothing to open yet; the click is wired
            the day the view exists. */}
        <div className="mt-auto pt-4">
          <button type="button" className="glass-cta app-no-drag w-full py-2 text-[12.5px] font-medium">
            View Calendar
          </button>
        </div>
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
