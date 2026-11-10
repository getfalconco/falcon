"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion, type MotionProps } from "framer-motion";
import { Check, Loader2, Lock } from "lucide-react";
import { BUTTON_TEXT_STYLE, PRIMARY_BUTTON_TEXT_COLOR } from "../components/GetStartedButton";

/**
 * The welcome flow's building blocks, in the site's own questionnaire style
 * (same as ApplicationFlow): Libre Baskerville headlines, Geist body, Geist
 * Mono labels, thin black borders that darken when chosen.
 */

export const GEIST = "var(--font-geist-sans), sans-serif";
export const MONO = "var(--font-geist-mono), monospace";
export const SERIF = "var(--font-libre-baskerville), Georgia, serif";

const OPTION_BASE = "rounded-xl border text-left transition-colors outline-none focus-visible:border-black/50";
const OPTION_ON = "border-black/70 bg-black/[0.035] text-[#1d1b1b]";
const OPTION_OFF = "border-black/[0.12] text-[#4b4b48] hover:border-black/30";
/** The chosen option's beat of confirmation before the step moves on. */
const OPTION_CONFIRM = "border-black bg-black/[0.07] text-[#1d1b1b]";

export function MonoLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-[11px] uppercase tracking-[0.2em] text-[#1d1b1b]/35 ${className}`} style={{ fontFamily: MONO }}>
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Single choice rows                                                  */
/* ------------------------------------------------------------------ */

export function ChoiceRows({
  options,
  value,
  onChange,
  label,
  confirming = false,
  optionMotion,
}: {
  options: readonly { id: string; label: string }[];
  value: string | undefined;
  onChange: (id: string) => void;
  label: string;
  /** The step is moving on: the chosen option settles darker. */
  confirming?: boolean;
  /** Each option's entrance (the step staggers them in). */
  optionMotion?: (index: number) => MotionProps;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = options.findIndex((o) => o.id === value);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current === -1 ? 0 : (current + delta + options.length) % options.length;
    onChange(options[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={handleKeyDown} className="space-y-2.5">
      {options.map((option, index) => {
        const selected = value === option.id;
        const focusable = value ? selected : index === 0;
        return (
          <motion.button
            key={option.id}
            {...optionMotion?.(index)}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={focusable ? 0 : -1}
            onClick={() => onChange(option.id)}
            className={`flex w-full items-center justify-between gap-4 px-5 py-3.5 text-[15px] ${OPTION_BASE} ${
              selected ? (confirming ? OPTION_CONFIRM : OPTION_ON) : OPTION_OFF
            }`}
            style={{ fontFamily: GEIST }}
          >
            {option.label}
            {selected ? <Check className="h-4 w-4 shrink-0 text-[#1d1b1b]" strokeWidth={2} aria-hidden /> : null}
          </motion.button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chips (multi select, or single select with `single`)                */
/* ------------------------------------------------------------------ */

export function Chips({
  options,
  value,
  onToggle,
  label,
  confirming = false,
}: {
  options: readonly { id: string; label: string }[];
  value: readonly string[];
  onToggle: (id: string) => void;
  label: string;
  /** The step is moving on: the chosen chips settle darker. */
  confirming?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const on = value.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(option.id)}
            className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-[14px] ${OPTION_BASE} ${
              on ? (confirming ? OPTION_CONFIRM : OPTION_ON) : OPTION_OFF
            }`}
            style={{ fontFamily: GEIST }}
          >
            {on ? <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The site's underlined free-text field (ApplicationFlow's "Other"). */
export const UNDERLINE_INPUT =
  "w-full border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60";

/* ------------------------------------------------------------------ */
/* Press and hold to commit                                            */
/* ------------------------------------------------------------------ */

const HOLD_MS = 1500;

/**
 * The site's primary button, held (pointer, Space or Enter) for HOLD_MS to
 * commit. A lighter fill sweeps across while held and runs back if released
 * early; the button sinks slightly under the press.
 */
export function HoldToCommit({ committed, onCommit }: { committed: boolean; onCommit: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const begin = useCallback(() => {
    if (committed || timer.current !== null) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(24);
      onCommit();
    }, HOLD_MS);
  }, [committed, onCommit]);

  const release = useCallback(() => {
    if (committed) return;
    clear();
    setHolding(false);
  }, [clear, committed]);

  const filled = committed || holding;

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        aria-label={committed ? "Committed" : "Press and hold to commit"}
        aria-pressed={committed}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          begin();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            if (!e.repeat) begin();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") release();
        }}
        onBlur={release}
        onContextMenu={(e) => e.preventDefault()}
        className="relative h-[45px] w-[260px] touch-none select-none overflow-hidden rounded-lg bg-[#1c1917] outline-none transition-transform duration-200 ease-out focus-visible:ring-2 focus-visible:ring-black/20"
        style={{
          ...BUTTON_TEXT_STYLE,
          color: PRIMARY_BUTTON_TEXT_COLOR,
          transform: holding ? "scale(0.98)" : undefined,
        }}
      >
        <span
          className="absolute inset-y-0 left-0 bg-white/[0.16]"
          style={{
            width: filled ? "100%" : "0%",
            transition: committed ? "none" : holding ? `width ${HOLD_MS}ms linear` : "width 300ms ease-out",
          }}
          aria-hidden
        />
        <span className="relative inline-flex items-center gap-2">
          {committed ? <Check className="h-4 w-4" strokeWidth={2} aria-hidden /> : null}
          {committed ? "Committed" : "Press and hold"}
        </span>
      </button>
      <p className="text-[12px] text-[#8a8a8a]" style={{ fontFamily: GEIST }} aria-live="polite">
        {committed ? "See you tomorrow morning." : "Hold for a moment to commit."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** Each ticker ticks over to done in turn across `durationMs`. */
export function MappingList({ tickers, durationMs }: { tickers: string[]; durationMs: number }) {
  const shown = tickers.slice(0, 6);
  const extra = tickers.length - shown.length;
  const count = shown.length;
  const [done, setDone] = useState(0);

  useEffect(() => {
    const step = durationMs / (count + 1);
    const timers = Array.from({ length: count }, (_, i) => setTimeout(() => setDone(i + 1), step * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [durationMs, count]);

  return (
    <div>
      <ul className="divide-y divide-black/[0.06] border-y border-black/[0.06]">
        {shown.map((t, i) => (
          <li key={t} className="flex items-center justify-between py-3 text-[14px]" style={{ fontFamily: GEIST }}>
            <span className="text-[13px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
              {t}
            </span>
            {i < done ? (
              <span className="inline-flex items-center gap-1.5 text-[#1d1b1b]">
                <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                Mapped
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[#9a9a9a]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Mapping
              </span>
            )}
          </li>
        ))}
      </ul>
      {extra > 0 ? (
        <p className="mt-3 text-[12px] text-[#8a8a8a]" style={{ fontFamily: GEIST }}>
          and {extra} more
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export type FilingsResult =
  | { state: "loading" }
  /** No portfolio connected: nothing to look up. */
  | { state: "none" }
  | { state: "error" }
  | { state: "ok"; count: number; items: { ticker: string; form: string; label: string; filedAt: string }[] };

function timeAgo(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function ResultView({ score, filings }: { score: number; filings: FilingsResult }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[64px] leading-none text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          {score}
        </span>
        <span className="text-[14px] text-[#8a8a8a]" style={{ fontFamily: GEIST }}>
          / 100
        </span>
      </div>
      <div className="mt-5 h-px w-full bg-black/10" aria-hidden>
        <div className="h-px bg-[#1d1b1b]" style={{ width: `${score}%` }} />
      </div>
      <p className="mt-3 text-[13px] leading-[20px] text-[#8a8a8a]" style={{ fontFamily: GEIST }}>
        From your answers: how often you miss moves, your research time, what frustrates you and how many stocks you
        follow.
      </p>

      <div className="mt-8 rounded-2xl border border-black/[0.07] bg-[#fdfdfd] p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.18)]">
        <MonoLabel>Today on your stocks</MonoLabel>
        {filings.state === "loading" ? (
          <p className="mt-3 flex items-center gap-2 text-[14px] text-[#767676]" style={{ fontFamily: GEIST }}>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Checking today&apos;s filings
          </p>
        ) : filings.state === "none" ? (
          <p className="mt-3 text-[15px] leading-[24px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            Connect a portfolio to see what hits your stocks.
          </p>
        ) : filings.state === "error" ? (
          <p className="mt-3 text-[15px] leading-[24px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            We couldn&apos;t reach SEC filings just now. Falcon keeps watching your stocks.
          </p>
        ) : filings.count === 0 ? (
          <p className="mt-3 text-[15px] leading-[24px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            No new filings on your stocks today. Falcon keeps watching.
          </p>
        ) : (
          <>
            <p className="mt-3 text-[18px] leading-[26px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
              {filings.count} {filings.count === 1 ? "event" : "events"} hit your portfolio today
            </p>
            <p className="mt-1 text-[12px] text-[#8a8a8a]" style={{ fontFamily: GEIST }}>
              SEC filings on your stocks in the last 24 hours
            </p>
            <div className="relative mt-4">
              <ul className="pointer-events-none select-none divide-y divide-black/[0.06] blur-[5px]" aria-hidden>
                {filings.items.slice(0, 3).map((item, i) => (
                  <li
                    key={`${item.ticker}-${item.filedAt}-${i}`}
                    className="flex items-center gap-3 py-2.5 text-[13px]"
                    style={{ fontFamily: GEIST }}
                  >
                    <span className="w-14 shrink-0 text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                      {item.ticker}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[#4b4b48]">
                      {item.form} · {item.label}
                    </span>
                    <span className="shrink-0 text-[#8a8a8a]">{timeAgo(item.filedAt)}</span>
                  </li>
                ))}
              </ul>
              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  className="inline-flex items-center gap-2 rounded-lg border border-black/10 bg-[#fdfdfd] px-3 py-1.5 text-[12px] text-[#1d1b1b]"
                  style={{ fontFamily: GEIST }}
                >
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                  Details unlock in Falcon
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
