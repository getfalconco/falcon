"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion, type MotionProps } from "framer-motion";
import { Check, Loader2, Lock, X } from "lucide-react";
import { BUTTON_TEXT_STYLE, PRIMARY_BUTTON_TEXT_COLOR } from "../components/GetStartedButton";
import { MAX_STOCKS, type PickedStock } from "@/lib/onboarding";

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
/* Stock picker                                                        */
/* ------------------------------------------------------------------ */

export function StockPicker({
  value,
  onChange,
  onDone,
}: {
  value: PickedStock[];
  onChange: (stocks: PickedStock[]) => void;
  /** Enter on an empty search box: move on. */
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedStock[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const full = value.length >= MAX_STOCKS;

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tickers?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const body = (await res.json()) as { results?: PickedStock[] };
        setResults(body.results ?? []);
        setFailed(!res.ok);
        setActive(0);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 140);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const add = useCallback(
    (stock: PickedStock) => {
      if (!full && !value.some((s) => s.ticker === stock.ticker)) onChange([...value, stock]);
      setQuery("");
      setResults([]);
      inputRef.current?.focus();
    },
    [full, onChange, value],
  );

  function remove(ticker: string) {
    onChange(value.filter((s) => s.ticker !== ticker));
    inputRef.current?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (query.trim() && results[active]) add(results[active]);
      else if (!query.trim()) onDone();
    } else if (event.key === "Escape") {
      setQuery("");
    } else if (event.key === "Backspace" && !query && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  const open = query.trim().length > 0;

  return (
    <div>
      <div className="relative">
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={full}
          placeholder={full ? "That's the most you can add for now" : "Search a ticker or company"}
          aria-label="Search stocks"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-black/10 bg-transparent px-4 py-3 pr-10 text-sm text-[#1d1b1b] outline-none transition placeholder:text-[#9a9a9a] focus:border-black/30"
        />
        {loading ? (
          <Loader2 className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[#9a9a9a]" aria-hidden />
        ) : null}

        {open ? (
          <ul
            id={listId}
            role="listbox"
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-[min(300px,40dvh)] overflow-y-auto rounded-lg border border-black/10 bg-[#fdfdfd] p-1 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.3)]"
          >
            {results.length === 0 && !loading ? (
              <li className="px-3 py-3 text-sm text-[#767676]">
                {failed ? "Search is unavailable right now. Try again in a moment." : "No matching stocks."}
              </li>
            ) : null}
            {results.map((stock, index) => {
              const added = value.some((s) => s.ticker === stock.ticker);
              return (
                <li
                  key={stock.ticker}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => add(stock)}
                  className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm ${
                    index === active ? "bg-[#efefec]" : ""
                  }`}
                >
                  <span className="w-16 shrink-0 text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                    {stock.ticker}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[#4b4b48]">{stock.name}</span>
                  {added ? <Check className="h-4 w-4 text-[#1d1b1b]" aria-label="Added" /> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {value.length > 0 ? (
        <ul aria-label="Your stocks" className="mt-4 flex flex-wrap gap-2">
          {value.map((stock) => (
            <li
              key={stock.ticker}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-black/[0.12] py-1.5 pl-3 pr-1 text-[13px]"
              style={{ fontFamily: GEIST }}
            >
              <span className="text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                {stock.ticker}
              </span>
              <span className="max-w-[150px] truncate text-[#767676] sm:max-w-[190px]">{stock.name}</span>
              <button
                type="button"
                onClick={() => remove(stock.ticker)}
                aria-label={`Remove ${stock.ticker}`}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[#8a8a8a] outline-none transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] focus-visible:bg-black/[0.05]"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-[#8a8a8a]" style={{ fontFamily: GEIST }}>
          Add at least one to continue.
        </p>
      )}
    </div>
  );
}

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
