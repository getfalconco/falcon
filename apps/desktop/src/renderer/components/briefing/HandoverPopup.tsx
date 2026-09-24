import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import logoBlack from "@/assets/brand/logo-black.png";
import { useBriefing } from "@/hooks/useBriefing";
import { refreshBriefing } from "@/lib/briefing-store";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import { viewNow } from "../../../shared/briefing-view";
import {
  HANDOVER_INTRO,
  etDateLabel,
  etTimeLabel,
  handoverView,
  type HandoverItem,
  type HandoverSection,
} from "../../../shared/handover-view";
import { HEAD_CLASS, MONO_CLASS, QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The dashboard's privacy switch: dollar amounts in the prose are masked. */
  masked: boolean;
};

/** The footer clock counts minutes; twice a minute keeps it right without a per-second render. */
const CLOCK_TICK_MS = 30_000;

const FOCUSABLE = 'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const POPUP_SPRING = { type: "spring", stiffness: 260, damping: 28, mass: 0.9 } as const;

const SKELETON_BAR = "animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none";

const LINK_CLASS =
  "app-no-drag shrink-0 font-sans text-[11.5px] font-medium text-[#6b7280] underline-offset-2 transition-colors hover:text-[#1d1b1b] hover:underline focus-visible:text-[#1d1b1b] focus-visible:underline focus-visible:outline-none";

function openArticle(url: string) {
  if (/^https?:\/\//i.test(url)) void window.meridian?.openExternal(url);
}

/**
 * One line of the summary: who it is about, the sentence, and "See more",
 * which opens the reaction and what it means in place. The sentence is held to
 * one line until then, so the popup stays a glance.
 */
function HandoverLine({ item, onOpenStock }: { item: HandoverItem; onOpenStock: (ticker: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const hasMore = item.detail !== null || item.meaning !== null || item.url !== null;

  return (
    <li className="py-2">
      <div className="flex items-baseline gap-3">
        <p className={cn("min-w-0 flex-1 text-[13.5px] leading-[1.5] text-[#1d1b1b]", !expanded && "truncate")}>
          {item.subject !== null &&
            (item.ticker !== null ? (
              <button
                type="button"
                onClick={() => onOpenStock(item.ticker!)}
                className={cn(MONO_CLASS, "app-no-drag mr-2 text-[12px] font-medium text-[#1d1b1b] hover:underline focus-visible:underline focus-visible:outline-none")}
              >
                {item.subject}
              </button>
            ) : (
              <span className={cn(MONO_CLASS, "mr-2 text-[12px] font-medium text-[#4b5563]")}>{item.subject}</span>
            ))}
          <span>{item.summary}</span>
        </p>
        {hasMore && (
          <button type="button" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded((e) => !e)} className={LINK_CLASS}>
            {expanded ? "Show less" : "See more"}
          </button>
        )}
      </div>
      {expanded && (
        <div id={detailId} className="mt-1.5 space-y-1 border-l-2 border-black/[0.06] pl-3 text-[12.5px] leading-[1.55] text-[#4b5563]">
          {item.detail !== null && <p>{item.detail}</p>}
          {item.meaning !== null && <p className="text-[#1d1b1b]">{item.meaning}</p>}
          {item.url !== null && (
            <button type="button" onClick={() => openArticle(item.url!)} className={LINK_CLASS}>
              Read the source
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function Section({ section, onOpenStock }: { section: HandoverSection; onOpenStock: (ticker: string) => void }) {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className={cn(HEAD_CLASS, "select-none")}>{section.title}</h3>
      <ul className="mt-1 divide-y divide-black/[0.05]">
        {section.items.map((item) => (
          <HandoverLine key={item.id} item={item} onOpenStock={onOpenStock} />
        ))}
      </ul>
    </section>
  );
}

function Centred({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2.5 py-8 text-center">{children}</div>;
}

/**
 * Everything inside the frame. Its own component so the hook that holds the
 * store (and with it the polling) is mounted only while the popup is up.
 */
function HandoverContent({ titleId, masked, onClose }: { titleId: string; masked: boolean; onClose: () => void }) {
  const { status, report } = useBriefing();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // `tick` is the only reason this recomputes between reports: the view takes
  // the clock as an argument, and this is the one place the popup reads it.
  const now = useMemo(() => (report ? viewNow(report, new Date()) : new Date()), [report, tick]);
  const view = useMemo(() => (report ? handoverView(report, now, masked) : null), [report, now, masked]);

  // Leaving for a stock page closes the popup first, or the page opens under it.
  const openFromPopup = useCallback(
    (ticker: string) => {
      onClose();
      openStock(ticker);
    },
    [onClose],
  );

  let body: ReactNode;
  if (view === null && status === "unsupported") {
    body = (
      <Centred>
        <p className="text-[13px] text-[#6b7280]">Restart Falcon to enable the handover.</p>
      </Centred>
    );
  } else if (view === null && status === "error") {
    body = (
      <Centred>
        <p className="text-[14px] text-[#1d1b1b]">The handover could not be put together right now.</p>
        <button type="button" onClick={() => void refreshBriefing()} className="glass-cta app-no-drag mt-1 px-3.5 py-1.5 font-sans text-[12px] font-medium">
          Try again
        </button>
      </Centred>
    );
  } else if (view === null) {
    body = (
      <div aria-hidden className="space-y-3 py-2">
        <div className={cn(SKELETON_BAR, "h-3 w-[30%]")} />
        <div className={cn(SKELETON_BAR, "h-3.5 w-[88%]")} />
        <div className={cn(SKELETON_BAR, "h-3.5 w-[72%]")} />
        <div className={cn(SKELETON_BAR, "mt-5 h-3 w-[26%]")} />
        <div className={cn(SKELETON_BAR, "h-3.5 w-[80%]")} />
      </div>
    );
  } else if (view.empty) {
    body = (
      <Centred>
        <p className="text-[13.5px] text-[#4b5563]">A quiet night: nothing since the last close made the summary.</p>
      </Centred>
    );
  } else {
    body = (
      <div>
        {view.sections.map((section) => (
          <Section key={section.kind} section={section} onOpenStock={openFromPopup} />
        ))}
      </div>
    );
  }

  const partial = report !== null && report.degraded.length > 0;

  return (
    <>
      <header className="flex items-start gap-4">
        <h2 id={titleId} className="min-w-0 flex-1 font-baskerville text-[21px] leading-[1.25] text-[#1d1b1b]">
          {view?.intro ?? HANDOVER_INTRO}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="app-no-drag -mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#9CA3AF] transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] focus-visible:bg-black/[0.05] focus-visible:outline-none"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      {view?.lead && <p className="mt-2 text-[13px] leading-[1.55] text-[#4b5563]">{view.lead}</p>}

      <div className="scrollbar-meridian mt-5 min-h-0 flex-1 overflow-y-auto pr-1">{body}</div>

      {(partial || report?.demo) && (
        <p className={cn(QUIET_NOTE_CLASS, "mt-3")}>
          {report?.demo ? "Demo book: the figures are illustrative." : "Some sources could not be reached, so this summary is partial."}
        </p>
      )}

      {/* The design's bottom row: the time on the left, the mark in the middle, the date on the right. */}
      <footer className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center border-t border-black/[0.06] pt-3.5">
        <span className={cn(MONO_CLASS, "justify-self-start text-[12px] text-[#4b5563]")}>{view?.time ?? etTimeLabel(now)}</span>
        <img src={logoBlack} alt="Falcon" className="h-6 w-6 select-none opacity-30" draggable={false} />
        <span className={cn(MONO_CLASS, "justify-self-end text-[12px] text-[#4b5563]")}>{view?.date || etDateLabel(now)}</span>
      </footer>
    </>
  );
}

/**
 * The handover popup: what happened while the reader was away, as a short
 * summary by kind (news, earnings, the rest), with the time and the date along
 * the bottom. Modal: Esc and the backdrop close it, Tab stays inside, and the
 * dashboard does not scroll underneath.
 */
export default function HandoverPopup({ open, onClose, masked }: Props) {
  const reduced = useReducedMotion() === true;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

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
      // Focus can sit outside the popup (a click on the backdrop drops it on
      // the body); the next Tab is brought back in rather than walking the
      // dashboard behind a modal.
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

  // Focus goes to the popup itself, not its first button, so a popup that
  // opened by itself does not turn the reader's next Space into a click. It
  // goes back where it was on close.
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
        <motion.div key="handover" className="fixed inset-0 z-[80] flex items-center justify-center" initial={false} animate={{}} exit={{}}>
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            data-testid="handover-popup"
            className="app-no-drag relative flex max-h-[min(640px,86vh)] w-[min(560px,92vw)] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/70 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] outline-none ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 14 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={reduced ? { duration: 0.2 } : POPUP_SPRING}
          >
            <HandoverContent titleId={titleId} masked={masked} onClose={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
