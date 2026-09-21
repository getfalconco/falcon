import { useCallback, useEffect, useRef, useState } from "react";
import type { Gloss } from "../../../shared/gloss-types";
import { cn } from "@/lib/utils";

/**
 * Highlight a word in the copy and it explains itself. A spinner appears at
 * the top-right corner of the selection while the model reads it, then a
 * glass card opens underneath with the market sense of the term — or, for a
 * longer highlight, what the passage is actually saying. Turkish is a second
 * call made only when TR is pressed: carrying both languages in the first
 * answer doubled the output tokens, and output tokens are the spinner.
 */

type Anchor = {
  right: number;
  top: number;
  bottom: number;
  left: number;
  /** Measured at selection time, so the popover clamps to the real card. */
  hostWidth: number;
  /** ...and flips above the selection when there is no room under it. */
  hostHeight: number;
};

/** What a selection is about, read off the copy it was made in. */
export type GlossScope = { context?: string; ticker?: string };

type State =
  | { phase: "idle" }
  | { phase: "loading"; text: string; anchor: Anchor }
  | { phase: "ready"; text: string; anchor: Anchor; gloss: Gloss }
  | { phase: "error"; text: string; anchor: Anchor; error: string };

const MIN_CHARS = 2;
const MAX_CHARS = 400;
const POPOVER_W = 290;
/** About what a one-term answer stands at — enough to decide which way to open. */
const POPOVER_EST_H = 150;

function Spinner() {
  return (
    <span className="pointer-events-none absolute z-40 flex h-4 w-4 items-center justify-center rounded-full border border-white/70 bg-white/80 shadow-[0_2px_8px_rgba(0,0,0,0.10)] backdrop-blur-md">
      <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 animate-spin" aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="#1d1b1b" strokeOpacity={0.15} strokeWidth={2} />
        <path
          d="M8 2 a6 6 0 0 1 6 6"
          fill="none"
          stroke="#1d1b1b"
          strokeOpacity={0.7}
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export default function SelectionGloss({
  ticker,
  context,
  resolve,
  className,
  contentClassName,
  children,
}: {
  /** The company the copy is about, when there is one. */
  ticker?: string;
  /** The sentence the selection lives in — the model needs it to pick a sense. */
  context?: string;
  /**
   * For copy that is a table rather than a sentence: given the selection,
   * say what it is. A "1.98" means nothing on its own; the cell it sits in
   * knows it is a beta, and whose. What this returns overrides the props.
   */
  resolve?: (range: Range) => GlossScope | null;
  /** The host is the popover's frame; a caller whose copy scrolls sizes it. */
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);
  const [state, setState] = useState<State>({ phase: "idle" });
  /** Turkish arrives on demand, so the first answer stays short. */
  const [turkish, setTurkish] = useState<{
    showing: boolean;
    text: string | null;
    error: string | null;
  }>({ showing: false, text: null, error: null });

  const close = useCallback(() => {
    requestId.current += 1;
    setState({ phase: "idle" });
  }, []);

  const showTurkish = useCallback((gloss: Gloss) => {
    // Already fetched for this gloss — just show it again, no second call.
    let cached = false;
    setTurkish((prev) => {
      // Only a real answer counts as fetched — a failure has to be retryable,
      // or TR stays dead for the life of the popover.
      if (prev.text) {
        cached = true;
        return { ...prev, showing: true };
      }
      return { showing: true, text: null, error: null };
    });
    if (cached) return;

    const id = requestId.current;
    void (async () => {
      try {
        const res = await window.meridian?.translateGloss?.({
          term: gloss.term,
          english: gloss.english,
        });
        if (id !== requestId.current) return;
        setTurkish((prev) =>
          res?.ok
            ? { ...prev, text: res.turkish, error: null }
            : { ...prev, text: null, error: res?.error ?? "Çeviri alınamadı." },
        );
      } catch (err) {
        if (id !== requestId.current) return;
        setTurkish((prev) => ({
          ...prev,
          text: null,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
  }, []);

  const readSelection = useCallback(() => {
    const host = hostRef.current;
    const selection = window.getSelection();
    if (!host || !selection || selection.isCollapsed || selection.rangeCount === 0) return;

    // Only our own copy — a selection that starts here and ends somewhere else
    // is not a word the card can explain.
    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return;

    // The popover lives inside the host too. Highlighting a word in the answer
    // must not start another lookup on the answer.
    const pop = popRef.current;
    if (pop && (pop.contains(range.startContainer) || pop.contains(range.endContainer))) return;

    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (text.length < MIN_CHARS) return;

    const hostBox = host.getBoundingClientRect();
    const box = range.getBoundingClientRect();
    const anchor: Anchor = {
      right: box.right - hostBox.left,
      left: box.left - hostBox.left,
      top: box.top - hostBox.top,
      bottom: box.bottom - hostBox.top,
      hostWidth: hostBox.width,
      hostHeight: hostBox.height,
    };

    if (text.length > MAX_CHARS) {
      setState({ phase: "error", text, anchor, error: "Highlight a sentence or less." });
      return;
    }

    // Read the scope off the copy first — the props are the fallback.
    const scope = resolve?.(range) ?? null;
    const askContext = scope?.context ?? context;
    const askTicker = scope?.ticker ?? ticker;

    const id = ++requestId.current;
    setTurkish({ showing: false, text: null, error: null });
    setState({ phase: "loading", text, anchor });

    void (async () => {
      try {
        const res = await window.meridian?.explainSelection?.({
          selection: text,
          context: askContext,
          ticker: askTicker,
        });
        if (id !== requestId.current) return;
        if (res?.ok) setState({ phase: "ready", text, anchor, gloss: res.gloss });
        else setState({ phase: "error", text, anchor, error: res?.error ?? "Couldn't explain that." });
      } catch (err) {
        if (id !== requestId.current) return;
        setState({
          phase: "error",
          text,
          anchor,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, [context, ticker, resolve]);

  // Keyboard selection (shift+arrow, caret browsing) never produces a mouseup.
  const onKeyUp = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.shiftKey || event.key === "Shift") readSelection();
    },
    [readSelection],
  );

  // A drag that starts on the headline and releases past the card still
  // selects our words; React's onMouseUp only fires for releases inside.
  useEffect(() => {
    const onUp = () => readSelection();
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [readSelection]);

  // The card re-reads its run every minute. If the sentence under the popover
  // changes, the explanation is about words that are no longer there.
  useEffect(() => {
    close();
  }, [context, close]);

  // Dismiss on Escape, or on a click that isn't in the popover. Selection
  // changes are deliberately ignored: clicking the translate toggle collapses
  // the selection, and that must not close the thing being read.
  useEffect(() => {
    if (state.phase === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popRef.current && target && popRef.current.contains(target)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [state.phase, close]);

  const anchor = state.phase === "idle" ? null : state.anchor;
  // Under the selection by default; above it when the host has no room left
  // there — a card that clips its overflow would otherwise swallow the answer
  // to a highlight in its last rows.
  const flipUp = anchor != null && anchor.bottom + 10 + POPOVER_EST_H > anchor.hostHeight && anchor.top > POPOVER_EST_H;

  return (
    <div ref={hostRef} className={cn("relative", className)} onKeyUp={onKeyUp}>
      {/* data-selectable tells LiftableCard to keep its hands off: a drag that
          starts here is a text selection, not a card being picked up. */}
      <div data-selectable className={cn("app-no-drag cursor-text select-text", contentClassName)}>
        {children}
      </div>

      {anchor && state.phase === "loading" && (
        <span
          className="pointer-events-none absolute z-40"
          style={{ left: anchor.right - 2, top: anchor.top - 10 }}
        >
          <Spinner />
        </span>
      )}

      {anchor && (state.phase === "ready" || state.phase === "error") && (
        <div
          ref={popRef}
          data-selectable
          className="absolute z-50 w-[290px] rounded-2xl border border-white/70 bg-white/80 p-3.5 shadow-[0_12px_36px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.04] backdrop-blur-2xl backdrop-saturate-150"
          style={{
            ...(flipUp
              ? { bottom: anchor.hostHeight - anchor.top + 10 }
              : { top: anchor.bottom + 10 }),
            left: Math.max(0, Math.min(anchor.left - 20, anchor.hostWidth - POPOVER_W)),
          }}
        >
          {state.phase === "ready" ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="line-clamp-2 font-sans text-[13px] font-medium leading-snug text-[#1d1b1b]">
                  {state.gloss.term}
                </span>
                <span className="shrink-0 font-['Geist_Mono'] text-[9px] uppercase tracking-[0.08em] text-[#9CA3AF]">
                  {state.gloss.kind === "passage" ? "passage" : "term"}
                </span>
              </div>

              <p className="mt-2 font-sans text-[12px] leading-[1.5] text-[#373B42]">
                {turkish.showing
                  ? (turkish.text ?? turkish.error ?? "Çevriliyor…")
                  : state.gloss.english}
              </p>

              {state.gloss.kind === "term" && state.gloss.in_context && !turkish.showing && (
                <p className="mt-2 border-l border-black/[0.10] pl-2 font-sans text-[11.5px] leading-[1.45] text-[#6B7280]">
                  {state.gloss.in_context}
                </p>
              )}

              <div className="mt-3 flex items-center justify-between">
                <span className="font-['Geist_Mono'] text-[9px] uppercase tracking-[0.08em] text-[#9CA3AF]">
                  {state.gloss.kind === "term" && state.gloss.finance_specific ? "market sense" : ""}
                </span>
                <div className="flex items-center gap-0.5 rounded-lg bg-black/[0.04] p-0.5">
                  {[
                    { showing: false, label: "EN" },
                    { showing: true, label: "TR" },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() =>
                        option.showing
                          ? showTurkish(state.gloss)
                          : setTurkish((prev) => ({ ...prev, showing: false }))
                      }
                      className={`app-no-drag rounded-[6px] px-2 py-0.5 font-['Geist_Mono'] text-[9.5px] tracking-[0.06em] transition-colors ${
                        turkish.showing === option.showing
                          ? "bg-white text-[#1d1b1b] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                          : "text-[#6B7280] hover:text-[#1d1b1b]"
                      }`}
                    >
                      {option.label}
                      {option.showing && turkish.showing && !turkish.text && !turkish.error && (
                        <span className="ml-1 inline-block h-1 w-1 animate-pulse rounded-full bg-[#1d1b1b]" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <p className="font-sans text-[12px] leading-[1.5] text-[#6B7280]">{state.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
