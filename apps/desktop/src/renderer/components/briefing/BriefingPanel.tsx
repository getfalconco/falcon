import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import SelectionGloss, { type GlossScope } from "@/components/dashboard/SelectionGloss";
import { useBriefing } from "@/hooks/useBriefing";
import { refreshBriefing } from "@/lib/briefing-store";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import { degradedNotes, phaseTitle, spokenImplicationIds, storiesView, viewNow } from "../../../shared/briefing-view";
import BookAndRisk from "./BookAndRisk";
import BriefingMasthead from "./BriefingMasthead";
import BriefingNarrative from "./BriefingNarrative";
import CorporateEvents from "./CorporateEvents";
import HeldOvernight from "./HeldOvernight";
import Implications from "./Implications";
import OvernightMarkets from "./OvernightMarkets";
import Stories from "./Stories";
import TodayCalendar from "./TodayCalendar";
import { PANEL_TWEEN, Rise } from "./briefing-motion";
import { HEAD_CLASS, QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The dashboard's privacy switch: the account's dollar figures are hidden, market prices are not. */
  masked: boolean;
};

/** The countdown in the phase chip counts minutes, so twice a minute keeps it honest without a per-second render. */
const CLOCK_TICK_MS = 30_000;

const FOCUSABLE = 'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** What the model is told a highlight in the panel is, when no section or row has said more. */
const PANEL_GLOSS_CONTEXT =
  "The pre-open handover briefing: what happened since the last US close, how markets and the held names reacted, and what it means for the reader's book.";

/**
 * What a highlight in the panel is about. The nearest block that names a
 * ticker (a story, a conclusion, a held row) says whose figure it is, and the
 * nearest that carries a context (the story's own sentence, a section's
 * description) says what kind of figure. Either alone is enough; with
 * neither, the panel's description stands.
 */
function glossScopeOf(range: Range): GlossScope | null {
  const node = range.startContainer;
  const el = node instanceof Element ? node : node.parentElement;
  const ticker = el?.closest<HTMLElement>("[data-gloss-ticker]")?.dataset.glossTicker;
  const context = el?.closest<HTMLElement>("[data-gloss-context]")?.dataset.glossContext;
  if (!ticker && !context) return null;
  return { ...(ticker ? { ticker } : {}), ...(context ? { context } : {}) };
}

function Centred({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">{children}</div>;
}

const SKELETON_BAR = "animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none";

/**
 * Everything under the frame. A component of its own so that the hook which
 * holds the store (and with it the polling) is mounted only while the panel is
 * actually up, not for as long as the host is.
 */
function BriefingContent({ titleId, masked, onClose }: { titleId: string; masked: boolean; onClose: () => void }) {
  const { status, report, refreshing, refresh } = useBriefing();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // `tick` is the only reason this recomputes between reports: the view takes
  // the clock as an argument, and this is the one place the panel reads it.
  const now = useMemo(() => (report ? viewNow(report, new Date()) : new Date()), [report, tick]);

  const notes = useMemo(() => (report ? degradedNotes(report) : {}), [report]);

  // The conclusions a story already carries in its "for your book" line, so
  // the list under the stories does not say them again.
  const spoken = useMemo(() => spokenImplicationIds(report ? storiesView(report, masked) : []), [report, masked]);

  // Leaving for a stock page closes the panel first: the page opens under the
  // panel otherwise, and the reader is left looking at a briefing over it.
  const openFromPanel = useCallback(
    (ticker: string) => {
      onClose();
      openStock(ticker);
    },
    [onClose],
  );

  const loading = report === null && (status === "loading" || status === "idle");

  let body: ReactNode;
  if (report === null && status === "unsupported") {
    body = (
      <Centred>
        <p className="text-[13px] text-[#6b7280]">Restart Falcon to enable the handover.</p>
      </Centred>
    );
  } else if (report === null && status === "error") {
    body = (
      <Centred>
        <p className="font-baskerville text-[17px] text-[#1d1b1b]">The handover could not be put together right now.</p>
        <p className={QUIET_NOTE_CLASS}>The rest of the dashboard is unaffected.</p>
        <button
          type="button"
          onClick={() => void refreshBriefing()}
          className="glass-cta app-no-drag mt-1 px-3.5 py-1.5 font-sans text-[12px] font-medium"
        >
          Try again
        </button>
      </Centred>
    );
  } else {
    body = (
      <div className="mt-5 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] grid-rows-[minmax(0,1fr)] gap-x-6 min-[1500px]:grid-cols-[minmax(0,1fr)_340px] max-[979px]:grid-cols-1 max-[979px]:grid-rows-none max-[979px]:overflow-y-auto">
        {/* Highlight a word anywhere in the main column and it explains itself,
            as the Positions card's copy does. The gloss host is the grid cell,
            not the scroller inside it: the popover is positioned against the
            host's box, so with the scroller as host it would be carried off
            with the rows, while here it stays over the column, clamps to its
            width and flips above a highlight near the bottom. */}
        <SelectionGloss
          context={PANEL_GLOSS_CONTEXT}
          resolve={glossScopeOf}
          className="relative flex min-h-0 min-w-0 flex-col"
          contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <div className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto pr-2 max-[979px]:overflow-visible">
            {report ? (
              <Rise index={0}>
                <h2 className="font-baskerville text-[26px] leading-[1.2] text-[#1d1b1b]">{phaseTitle(report, now)}</h2>
                <BriefingNarrative report={report} masked={masked} note={notes.narrative} className="mt-2.5" />
              </Rise>
            ) : (
              <div aria-hidden>
                <div className={cn(SKELETON_BAR, "h-7 w-[46%]")} />
                <div className={cn(SKELETON_BAR, "mt-3.5 h-3 w-[84%]")} />
                <div className={cn(SKELETON_BAR, "mt-2 h-3 w-[62%]")} />
              </div>
            )}
            {/* The stories first, then the conclusions that do not belong to
                one, then the figures both rest on. The first two carry their
                own margins: either can have nothing to show, and a wrapper
                with a margin would leave a gap where it is not. */}
            <Rise index={1}>
              <Stories report={report} masked={masked} loading={loading} onOpenStock={openFromPanel} className="mt-7" />
            </Rise>
            <Rise index={2}>
              <Implications report={report} masked={masked} loading={loading} exclude={spoken} onOpenStock={openFromPanel} className="mt-7" />
            </Rise>
            <Rise index={3} className="mt-9 flex items-center gap-3">
              <span className={cn(HEAD_CLASS, "shrink-0 select-none")}>THE FIGURES</span>
              <span className="h-px flex-1 bg-black/[0.06]" aria-hidden />
            </Rise>
            <Rise index={4} className="mt-5">
              <OvernightMarkets report={report} loading={loading} note={notes.markets} />
            </Rise>
            <Rise index={5} className="mt-7">
              <HeldOvernight
                report={report}
                masked={masked}
                loading={loading}
                notes={[notes.held_quotes, notes.chain_news, notes.quant]}
                onOpenStock={openFromPanel}
              />
            </Rise>
            <Rise index={6} className="mt-7">
              <BookAndRisk report={report} masked={masked} loading={loading} note={notes.risk} />
            </Rise>
            <Rise index={7} className="mt-7 pb-2">
              <CorporateEvents report={report} now={now} loading={loading} note={notes.corporate_actions} onOpenStock={openFromPanel} />
            </Rise>
          </div>
        </SelectionGloss>

        <Rise
          index={2}
          className="flex min-h-0 flex-col border-l-[0.5px] border-black/[0.06] pl-6 max-[979px]:mt-7 max-[979px]:border-l-0 max-[979px]:pl-0"
        >
          <TodayCalendar report={report} now={now} loading={loading} note={notes.macro_calendar} />
        </Rise>
      </div>
    );
  }

  return (
    <>
      <BriefingMasthead
        titleId={titleId}
        report={report}
        now={now}
        refreshing={refreshing}
        canRefresh={report !== null && !report.demo}
        onRefresh={refresh}
        onClose={onClose}
      />
      {body}
    </>
  );
}

/**
 * The handover briefing panel: the same glass frame as the stock peek and the
 * Insight panel (portal, blurred backdrop, spring, masthead as the drag strip),
 * a size up, because this one is read top to bottom and not glanced at.
 */
export default function BriefingPanel({ open, onClose, masked }: Props) {
  const reduced = useReducedMotion() === true;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes, Tab stays inside, and the dashboard never scrolls underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (stops.length === 0) {
        e.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      // Focus can sit outside the panel (a click on the backdrop drops it on
      // the body). The next Tab would then walk the dashboard behind a modal,
      // so it is brought back in, whichever way it was heading.
      if (!(active instanceof Node) || !panel.contains(active) || active === panel) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // Focus goes to the panel itself, not to its first button: a panel that
  // opens by itself and lands the focus on "Refresh" turns the reader's next
  // press of Space into a provider round. It goes back where it was on close,
  // so keyboard readers are not dropped at the top of the page.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="briefing" className="fixed inset-0 z-[80] flex items-center justify-center" initial={false} animate={{}} exit={{}}>
          {/* Backdrop: the dashboard blurs away behind the panel. */}
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="app-no-drag relative flex h-[min(860px,86vh)] w-[min(1240px,88vw)] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] outline-none ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 18 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 10 }}
            transition={reduced ? { duration: 0.2 } : PANEL_TWEEN}
          >
            <BriefingContent titleId={titleId} masked={masked} onClose={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
