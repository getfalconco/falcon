import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarRows, ROW_GRID, nowMarkerLabel, sessionStanding, type SessionStanding } from "@/components/briefing/CalendarRail";
import { HEAD_CLASS, QUIET_NOTE_CLASS } from "@/components/briefing/briefing-styles";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { useBriefing } from "@/hooks/useBriefing";
import { briefingEnabled } from "@/lib/dashboard-config";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { viewNow } from "../../../shared/briefing-view";
import { calendarForDay } from "../../../shared/calendar-days";
import { calendarView, degradedNotes, mastheadDate, type CalendarView } from "../../../shared/calendar-view";

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
  /** "THU SEP 25": the session the rail lists, for the head when that is not today. */
  sessionDate: string;
  earlyClose: boolean;
  /** Quiet lines: a section of the report that failed. */
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
function buildCardView(report: BriefingReport, now: Date): CardView | null {
  try {
    const day = calendarForDay(report, report.window.target_session_ymd, now);
    // The report's own session always trades; a closed answer is a report
    // this build cannot read, and is shown as one.
    if (day.closed) return null;
    const calendar = calendarView(day.report, now);
    const degraded = degradedNotes(day.report);
    const notes = [degraded.macro_calendar, degraded.earnings].filter((n): n is string => typeof n === "string");
    return {
      calendar,
      standing: sessionStanding(calendar, now, day.report.window.target_close_at),
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

/**
 * The calendar on the dashboard: what is scheduled for the session the clock
 * is on, on the rail, with the "now" line where the day stands. The rows are
 * the handover report's own, read through `calendarForDay`, and every row can
 * be hovered for what else is known about it.
 *
 * The session is today until the close and the next one after it, through
 * the weekend. The head says so: the date appears beside the offset only
 * when the rail is not listing today.
 */
function CalendarCardInner({ onDuplicate, onRemove }: Props) {
  const { status, report } = useBriefing();
  const minute = useMinute();
  // `minute` is the only reason this recomputes between reports: the view
  // takes the clock as an argument, and this is the one place the card reads it.
  const now = useMemo(() => (report ? viewNow(report, new Date()) : new Date()), [report, minute]);

  const view = useMemo(() => (report ? buildCardView(report, now) : null), [report, now]);

  // Once per session, the list is scrolled so the "now" line sits mid-card: a
  // reader who looks at 14:00 wants what is next, not the 08:30 print at the
  // top. Once, so the list never moves under a reader who has scrolled it; and
  // by hand, not with scrollIntoView, which would also scroll the page. The
  // mark is forgotten whenever the list is not drawn (a report dropped by the
  // store while a fresh one is fetched), because the list's box goes with it
  // and comes back at the top: there is no reader position to protect then.
  const listRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const placedFor = useRef<string | null>(null);
  const targetYmd = report?.window.target_session_ymd ?? null;
  const ready = view !== null;
  useEffect(() => {
    if (!ready) {
      placedFor.current = null;
      return;
    }
    if (targetYmd === null || placedFor.current === targetYmd) return;
    const list = listRef.current;
    const marker = markerRef.current;
    if (!list || !marker) return;
    placedFor.current = targetYmd;
    list.scrollTop = Math.max(0, marker.offsetTop - list.clientHeight / 2);
  }, [ready, targetYmd]);

  const unsupported = report === null && status === "unsupported";
  const failed = (report === null && status === "error") || (report !== null && view === null);

  const standing: SessionStanding = view ? view.standing : "on";

  let body: ReactNode;
  if (view) {
    const nothing = view.calendar.allDay.length === 0 && view.calendar.timed.length === 0;
    body = (
      <div ref={listRef} className="scrollbar-meridian relative -mx-2 min-h-0 flex-1 overflow-y-auto px-2">
        {view.earlyClose ? (
          <p className="pb-3 text-[12px] leading-[1.45] text-[#D97706]">Early close: this session ends at 13:00 ET.</p>
        ) : null}

        <CalendarRows view={view.calendar} markerLabel={nowMarkerLabel(standing, now)} markerRef={markerRef} />

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
            {/* The offset of the listed session's day, not of this instant: a
                session across the November change is on UTC−5 while the clock
                is still on UTC−4, and every time on its rows is that day's New
                York time. Noon there is clear of the 02:00 change either way. */}
            {!view || !report
              ? nyUtcOffset(now)
              : standing === "on"
                ? nyUtcOffset(new Date(`${report.window.target_session_ymd}T16:00:00Z`))
                : `${view.sessionDate} · ${nyUtcOffset(new Date(`${report.window.target_session_ymd}T16:00:00Z`))}`}
          </span>
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
