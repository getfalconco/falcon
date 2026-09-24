import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactionChip from "@/components/briefing/ReactionChip";
import { HEAD_CLASS, MONO_CLASS, QUIET_NOTE_CLASS, TONE_TEXT } from "@/components/briefing/briefing-styles";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { useBriefing } from "@/hooks/useBriefing";
import { openBriefing } from "@/lib/briefing-open";
import { readShownThisLaunch } from "@/lib/briefing-seen";
import { briefingEnabled } from "@/lib/dashboard-config";
import { cn } from "@/lib/utils";
import type { BriefingReport, StoryScope } from "../../../shared/briefing-types";
import { calendarView, cardSummary, mastheadDate, viewNow, type CardSummary, type PhaseChip } from "../../../shared/briefing-view";

type Props = {
  /** The dashboard's privacy switch. Market moves stay; a dollar figure quoted in a sentence does not. */
  masked?: boolean;
  onDuplicate?: () => void;
  onRemove?: () => void;
};

/** The phase line counts minutes, so twice a minute keeps it honest without a per-second render. */
const CLOCK_TICK_MS = 30_000;

/** How often the launch mark is read again while the dot is lit; see `useUnopened`. */
const SHOWN_RECHECK_MS = 1_500;

/** The calendar rail's "now" accent in the panel: the one colour that means "this is where you are". */
const UNOPENED_ACCENT = "#189E9A";

/** The panel masthead's phase colours, so the card and the panel never call one phase two things. */
const PHASE_DOT: Record<PhaseChip["tone"], string> = { pre: "#D97706", open: "#16A34A", closed: "#9CA3AF" };

/**
 * The dot beside a story row says what kind of story it is: grey for the
 * tape as a whole, ink for a held name, and the pre-market amber for a
 * release that has printed. Never green or red: those mean direction, and the
 * move beside the row already carries it.
 */
const SCOPE_DOT: Record<StoryScope, string> = { market: "#9CA3AF", name: "#1d1b1b", release: "#D97706" };

const SKELETON_BAR = "animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none";

type CardView = {
  summary: CardSummary;
  date: string;
  /** Set when the curated calendar does not reach this session: no next item then means "unknown", not "quiet". */
  calendarWarning: string | null;
};

/**
 * A report can come out of the on-disk cache written by another build. The
 * view guards its lists, but this card sits in the dashboard's own tree with
 * no boundary above it, so one field of the wrong shape would unmount the
 * whole page. A report the view cannot read is shown as one that failed.
 */
function buildCardView(report: BriefingReport, now: Date, masked: boolean): CardView | null {
  try {
    const footnote = calendarView(report, now).footnote;
    return {
      summary: cardSummary(report, now, masked),
      date: mastheadDate(report),
      calendarWarning: footnote.tone === "warn" ? footnote.text : null,
    };
  } catch (error) {
    console.error("[briefing] card view failed:", error);
    return null;
  }
}

function shownYmd(): string | null {
  try {
    return readShownThisLaunch(window.sessionStorage)?.ymd ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the report on screen has yet to be opened this launch, in any
 * phase: the host records every opening (by itself, from this card, from the
 * shortcut) under the report's target session, and the dot is lit until the
 * mark for that session is there.
 *
 * The host writes the mark without telling anyone, and a storage event never
 * fires in the window that made the change. So while the dot is lit, and only
 * then, the key is read again on a short timer. Once the mark is there the
 * timer stops: it can only fall behind again when the target session changes,
 * and that arrives as a new report.
 */
function useUnopened(report: BriefingReport | null): boolean {
  const targetYmd = report?.window.target_session_ymd ?? null;
  const [shown, setShown] = useState<string | null>(shownYmd);
  const lit = targetYmd !== null && shown !== targetYmd;

  useEffect(() => {
    if (!lit) return;
    setShown(shownYmd());
    const timer = setInterval(() => setShown(shownYmd()), SHOWN_RECHECK_MS);
    return () => clearInterval(timer);
  }, [lit, targetYmd]);

  return lit;
}

function Skeleton() {
  return (
    <div className="flex flex-col" aria-hidden>
      <div className={cn(SKELETON_BAR, "h-3 w-[46%]")} />
      <div className="mt-4 space-y-2.5">
        {["w-[94%]", "w-[86%]", "w-[58%]"].map((width) => (
          <div key={width} className={cn(SKELETON_BAR, "h-[18px]", width)} />
        ))}
      </div>
      <div className="mt-3 flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(SKELETON_BAR, "h-[18px] w-[84px] rounded-md")} />
        ))}
      </div>
      <div className="mt-6 space-y-3">
        {["w-[72%]", "w-[64%]"].map((width) => (
          <div key={width} className={cn(SKELETON_BAR, "h-3", width)} />
        ))}
      </div>
    </div>
  );
}

function Summary({ view }: { view: CardView }) {
  const { phase, headline, sub, meaning, reactions, more, nextItem } = view.summary;
  return (
    <>
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: PHASE_DOT[phase.tone] }} aria-hidden />
        <span className="shrink-0 font-medium text-[#4b5563]">{phase.label}</span>
        <span className="truncate text-[#9CA3AF]">{phase.detail}</span>
      </div>

      {/* The lead story: what happened, the figures it moved, and what that
          means for this book. The reaction sentence itself stays in the panel;
          here the chips carry the figures. It is printed only when there are
          no chips, which is the older report that leads with a conclusion and
          its evidence line instead of a story. */}
      <p className="mt-3 line-clamp-3 text-[17px] font-medium leading-[1.3] text-[#1d1b1b]">{headline}</p>
      {reactions.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {reactions.map((reaction, i) => (
            <ReactionChip key={`${reaction.label}-${i}`} reaction={reaction} />
          ))}
        </div>
      ) : sub ? (
        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-[1.45] text-[#6b7280]">{sub}</p>
      ) : null}
      {meaning ? (
        <div className="mt-3">
          <div className={cn(HEAD_CLASS, "select-none")}>FOR YOUR BOOK</div>
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.45] text-[#4b5563]">{meaning}</p>
        </div>
      ) : null}

      {more.length > 0 ? (
        <>
          <div className="mt-4 border-t-[0.5px] border-black/[0.06]" aria-hidden />
          <ul className="mt-3 space-y-2.5">
            {more.map((row) => (
              <li key={row.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2">
                <span className="mt-[7px] h-[5px] w-[5px] rounded-full" style={{ backgroundColor: SCOPE_DOT[row.scope] }} aria-hidden />
                <span className="line-clamp-2 text-[13px] leading-[1.4] text-[#1d1b1b]">{row.what}</span>
                {row.primaryMove ? <span className={cn(MONO_CLASS, "pt-px text-[11.5px]", TONE_TEXT[row.tone])}>{row.primaryMove}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className={cn(QUIET_NOTE_CLASS, "mt-4 truncate")}>
        {nextItem ? `Next · ${nextItem}` : (view.calendarWarning ?? "Nothing further on this session's calendar.")}
      </p>
    </>
  );
}

function BriefingCardInner({ masked = false, onDuplicate, onRemove }: Props) {
  const { status, report } = useBriefing();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // `tick` is the only reason this recomputes between reports: the view takes
  // the clock as an argument, and this is the one place the card reads it.
  const now = useMemo(() => (report ? viewNow(report, new Date()) : new Date()), [report, tick]);

  const view = useMemo(() => (report ? buildCardView(report, now, masked) : null), [report, now, masked]);
  const unopened = useUnopened(report);

  const unsupported = report === null && status === "unsupported";
  const failed = (report === null && status === "error") || (report !== null && view === null);

  let body: ReactNode;
  if (view) {
    body = <Summary view={view} />;
  } else if (unsupported) {
    body = <p className="text-[13px] leading-[1.5] text-[#6b7280]">Restart Falcon to enable the handover.</p>;
  } else if (failed) {
    body = (
      <>
        <p className="text-[13px] leading-[1.5] text-[#6b7280]">The handover could not be put together right now.</p>
        <p className={cn(QUIET_NOTE_CLASS, "mt-1")}>Open it to try again. The rest of the dashboard is unaffected.</p>
      </>
    );
  } else {
    body = <Skeleton />;
  }

  return (
    <div className="flex h-full min-h-[460px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label="HANDOVER"
        meta={view ? <span className={cn(MONO_CLASS, "select-none text-[11px] tracking-[0.04em] text-[#6b7280]")}>{view.date}</span> : null}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
      />

      <div className="flex min-h-0 flex-1 flex-col pt-4">
        {body}

        {/* A plain button, not a DashboardCta: those are switched off as a set
            while the detail views are shut, and this opens no detail view. It
            opens the panel the card is a summary of, so it stays live. Without
            the main-process handlers the panel has one sentence to show, the
            one already on this card, so the door is shut then. */}
        <div className="mt-auto pt-4">
          {/* data-no-lift, not just app-no-drag: on the free canvas a press held
              past LiftableCard's threshold picks the whole card up, and the drag
              it starts cancels the click. A deliberate press on the card's only
              door to the panel would then do nothing at all. */}
          <button
            type="button"
            data-no-lift
            onClick={() => openBriefing("card")}
            disabled={unsupported}
            aria-label={unopened ? "Open handover, not opened yet this launch" : undefined}
            className="glass-cta app-no-drag w-full py-2 text-[12.5px] font-medium disabled:pointer-events-none disabled:border-white/10 disabled:bg-[#1d1b1b]/40 disabled:text-white/75 disabled:shadow-none"
          >
            {/* The dot hangs off the label instead of sitting beside it, so the
                label does not shift sideways when the dot goes out. */}
            <span className="relative">
              Open handover
              {unopened ? (
                <span
                  className="absolute -right-3.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
                  style={{ backgroundColor: UNOPENED_ACCENT }}
                  aria-hidden
                />
              ) : null}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The handover briefing on the dashboard, as a story card: which phase the
 * session is in, the lead story (what happened, the figures it moved, what it
 * means for this book), the two stories after it, the next thing on the
 * calendar, and the door to the full panel. Everything printed comes from
 * `cardSummary`, the same view the panel reads, so the two cannot disagree.
 *
 * Mounting it holds the shared store, which is what keeps the report fresh
 * while the card is on screen. With the feature off nothing is mounted at all:
 * a held store would go on asking the providers on behalf of a panel that no
 * longer exists, behind a button nothing listens to.
 */
export default function BriefingCard(props: Props) {
  if (!briefingEnabled()) return null;
  return <BriefingCardInner {...props} />;
}
