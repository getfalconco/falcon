"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, Loader2, Lock, Plus, Search, X, type LucideIcon } from "lucide-react";
import { MAX_STOCKS, type PickedStock } from "@/lib/onboarding";

/* ------------------------------------------------------------------ */
/* Single choice cards                                                 */
/* ------------------------------------------------------------------ */

export type ChoiceOption = { id: string; label: string; icon?: LucideIcon };

export function ChoiceCards({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly ChoiceOption[];
  value: string | undefined;
  onChange: (id: string) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const withIcons = options.some((o) => o.icon);
  const cols = options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";

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
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={`grid w-full max-w-[600px] grid-cols-1 gap-2.5 sm:gap-3 ${cols}`}
    >
      {options.map((option, index) => {
        const Icon = option.icon;
        const selected = value === option.id;
        const focusable = value ? selected : index === 0;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={focusable ? 0 : -1}
            onClick={() => onChange(option.id)}
            className={`relative flex items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left outline-none transition-[background-color,border-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-[#1a7f95]/40 sm:px-5 ${
              withIcons ? "sm:min-h-[104px] sm:flex-col sm:items-start sm:justify-between sm:gap-4 sm:py-5" : "sm:min-h-[64px] sm:py-4"
            } ${
              selected
                ? "border-[#1a7f95] bg-white shadow-[0_10px_30px_rgba(15,84,104,0.12)]"
                : "border-black/[0.08] bg-white/60 backdrop-blur-sm hover:border-black/15 hover:bg-white/85"
            }`}
          >
            {Icon ? (
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ${
                  selected ? "bg-[#1a7f95] text-white" : "bg-[#e4f7fa] text-[#0f5468]"
                }`}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </span>
            ) : null}
            <span className="flex-1 pr-6 text-[15px] font-medium leading-snug text-[#1d1b1b]">{option.label}</span>
            <span
              className={`absolute right-4 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border transition-colors duration-200 ${
                withIcons ? "sm:top-4 sm:translate-y-0" : ""
              } ${selected ? "border-[#1a7f95] bg-[#1a7f95] text-white" : "border-black/15 bg-white text-transparent"}`}
              aria-hidden
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Multi select chips                                                  */
/* ------------------------------------------------------------------ */

export function Chips({
  options,
  value,
  onToggle,
  label,
}: {
  options: readonly { id: string; label: string }[];
  value: readonly string[];
  onToggle: (id: string) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex w-full max-w-[600px] flex-wrap justify-center gap-2 sm:gap-2.5">
      {options.map((option) => {
        const on = value.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(option.id)}
            className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-[14px] font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[#1a7f95]/40 sm:h-11 sm:px-5 ${
              on
                ? "border-[#1a7f95] bg-[#1a7f95] text-white shadow-[0_6px_18px_rgba(15,84,104,0.18)]"
                : "border-black/[0.08] bg-white/70 text-[#1d1b1b] backdrop-blur-sm hover:border-black/15 hover:bg-white"
            }`}
          >
            {on ? <Check className="h-3.5 w-3.5" strokeWidth={2.75} aria-hidden /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

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
      if (full || value.some((s) => s.ticker === stock.ticker)) {
        setQuery("");
        return;
      }
      onChange([...value, stock]);
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
    <div className="flex w-full max-w-[520px] flex-col gap-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-[#8a8f91]" aria-hidden />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={full}
          placeholder={full ? "That's the most you can add for now" : "Search a ticker or company, e.g. AAPL"}
          aria-label="Search stocks"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-12 w-full rounded-2xl border border-black/[0.08] bg-white/85 pl-11 pr-11 text-[15px] text-[#1d1b1b] shadow-[0_8px_24px_rgba(15,84,104,0.08)] outline-none backdrop-blur-sm transition placeholder:text-[#9a9a9a] focus:border-[#1a7f95]/60"
        />
        {loading ? (
          <Loader2 className="absolute right-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 animate-spin text-[#8a8f91]" aria-hidden />
        ) : null}

        {open ? (
          <ul
            id={listId}
            role="listbox"
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-[min(300px,40dvh)] overflow-y-auto rounded-2xl border border-black/[0.08] bg-white p-1.5 shadow-[0_18px_40px_rgba(15,84,104,0.14)]"
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
                  className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 ${index === active ? "bg-[#e4f7fa]" : ""}`}
                >
                  <span className="w-16 shrink-0 text-[14px] font-semibold text-[#0f5468]">{stock.ticker}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-[#1d1b1b]">{stock.name}</span>
                  {added ? (
                    <Check className="h-4 w-4 text-[#1a7f95]" aria-label="Added" />
                  ) : (
                    <Plus className="h-4 w-4 text-[#8a8f91]" aria-hidden />
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {value.length > 0 ? (
        <ul aria-label="Your stocks" className="flex flex-wrap gap-2">
          {value.map((stock) => (
            <li
              key={stock.ticker}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#1a7f95]/25 bg-white/85 py-1.5 pl-3.5 pr-1.5 text-[13px] shadow-[0_4px_12px_rgba(15,84,104,0.06)]"
            >
              <span className="font-semibold text-[#0f5468]">{stock.ticker}</span>
              <span className="max-w-[160px] truncate text-[#5f6a6d] sm:max-w-[200px]">{stock.name}</span>
              <button
                type="button"
                onClick={() => remove(stock.ticker)}
                aria-label={`Remove ${stock.ticker}`}
                className="flex h-6 w-6 items-center justify-center rounded-full text-[#5f6a6d] outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-[#1a7f95]/40"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-center text-[13px] text-[#767676]">Add at least one to continue.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Press and hold to commit                                            */
/* ------------------------------------------------------------------ */

const HOLD_MS = 1500;

/**
 * Press and hold (pointer, Space or Enter) for HOLD_MS to commit. The ring
 * fills with a CSS transition, so letting go early runs it back smoothly; the
 * button sinks slightly while held and pops once on commit.
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

  const R = 66;
  const C = 2 * Math.PI * R;
  const filled = committed || holding;
  const fillTransition = committed
    ? "none"
    : holding
      ? `stroke-dashoffset ${HOLD_MS}ms linear`
      : "stroke-dashoffset 350ms ease-out";

  return (
    <div className="flex flex-col items-center gap-5">
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
        className={`relative flex h-[152px] w-[152px] touch-none select-none items-center justify-center rounded-full outline-none transition-transform duration-300 ease-out focus-visible:ring-4 focus-visible:ring-[#1a7f95]/25 ${
          committed ? "welcome-pop" : ""
        }`}
        style={{ transform: holding ? "scale(0.95)" : undefined, transitionDuration: holding ? `${HOLD_MS}ms` : undefined }}
      >
        <svg viewBox="0 0 152 152" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="76" cy="76" r={R} fill="none" stroke="#0f5468" strokeOpacity="0.1" strokeWidth="6" />
          <circle
            cx="76"
            cy="76"
            r={R}
            fill="none"
            stroke="#1a7f95"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={filled ? 0 : C}
            style={{ transition: fillTransition }}
          />
        </svg>
        <span
          className={`relative flex h-[118px] w-[118px] flex-col items-center justify-center overflow-hidden rounded-full text-[13px] font-medium transition-colors duration-300 ${
            committed
              ? "bg-[#1a7f95] text-white shadow-[0_14px_34px_rgba(26,127,149,0.35)]"
              : "bg-[#1c1917] text-[#f2f2f2] shadow-[0_12px_30px_rgba(28,25,23,0.25)]"
          }`}
        >
          <span
            className="absolute inset-0 rounded-full bg-[#63d2e2]/40"
            style={{
              transform: `scale(${filled && !committed ? 1 : 0})`,
              transition: holding ? `transform ${HOLD_MS}ms linear` : "transform 350ms ease-out",
            }}
            aria-hidden
          />
          {committed ? (
            <span className="relative flex flex-col items-center">
              <Check className="mb-1 h-6 w-6" strokeWidth={2.5} aria-hidden />
              Committed
            </span>
          ) : (
            <span className="relative">Hold</span>
          )}
        </span>
      </button>
      <p className="text-[13px] text-[#767676]" aria-live="polite">
        {committed ? "See you tomorrow morning." : "Press and hold for a moment."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export function MappingAnimation({ tickers, durationMs }: { tickers: string[]; durationMs: number }) {
  const shown = tickers.slice(0, 8);
  const extra = tickers.length - shown.length;
  const n = Math.max(shown.length, 1);
  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-8">
      <div className="relative" style={{ width: "min(72vw, 36dvh, 320px)", height: "min(72vw, 36dvh, 320px)" }} aria-hidden>
        <svg viewBox="0 0 320 320" className="absolute inset-0 h-full w-full overflow-visible">
          <circle cx="160" cy="160" r="128" fill="none" stroke="#0f5468" strokeOpacity="0.12" strokeDasharray="1 7" strokeLinecap="round" strokeWidth="1.5" />
          {shown.map((t, i) => {
            const a = (i / n) * Math.PI * 2 - Math.PI / 2;
            const x = 160 + Math.cos(a) * 128;
            const y = 160 + Math.sin(a) * 128;
            const next = (i + 1) % n;
            const b = (next / n) * Math.PI * 2 - Math.PI / 2;
            return (
              <g key={t}>
                <line
                  className="welcome-map-line"
                  style={{ animationDelay: `${0.2 + i * 0.22}s` }}
                  pathLength={1}
                  x1="160"
                  y1="160"
                  x2={x}
                  y2={y}
                  stroke="#1a7f95"
                  strokeOpacity="0.45"
                  strokeWidth="1.5"
                />
                {n > 2 ? (
                  <line
                    className="welcome-map-line"
                    style={{ animationDelay: `${0.6 + i * 0.22}s` }}
                    pathLength={1}
                    x1={x}
                    y1={y}
                    x2={160 + Math.cos(b) * 128}
                    y2={160 + Math.sin(b) * 128}
                    stroke="#34a8bd"
                    strokeOpacity="0.3"
                    strokeWidth="1"
                  />
                ) : null}
              </g>
            );
          })}
          <circle cx="160" cy="160" r="34" fill="#ffffff" stroke="#9fe6f0" strokeWidth="1.5" />
          <circle className="welcome-tip-halo" style={{ animationDelay: "0s" }} cx="160" cy="160" r="10" fill="#1a7f95" />
          <circle cx="160" cy="160" r="10" fill="#0f5468" />
        </svg>
        {shown.map((t, i) => {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          return (
            <span
              key={t}
              className="welcome-map-node absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#0f5468]/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-[#0f5468] shadow-[0_6px_18px_rgba(15,84,104,0.12)] sm:text-xs"
              style={{
                left: `${50 + Math.cos(a) * 40}%`,
                top: `${50 + Math.sin(a) * 40}%`,
                animationDelay: `${0.15 + i * 0.22}s`,
              }}
            >
              {t}
            </span>
          );
        })}
      </div>
      <div className="w-full max-w-[280px]">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0f5468]/10">
          <div
            className="welcome-progress-fill h-full rounded-full bg-[#1a7f95]"
            style={{ "--welcome-load-ms": `${durationMs}ms` } as React.CSSProperties}
          />
        </div>
        {extra > 0 ? (
          <p className="mt-3 text-center text-[12px] text-[#767676]">and {extra} more</p>
        ) : null}
      </div>
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
    <div className="flex w-full max-w-[460px] flex-col items-center gap-6 sm:gap-8">
      <div className="flex w-full flex-col items-center">
        <div className="flex items-baseline gap-1.5">
          <span className="font-serif text-[5.5rem] leading-none [font-variant-numeric:lining-nums] text-[#0f5468] sm:text-[7rem]">{score}</span>
          <span className="text-[15px] text-[#767676]">/ 100</span>
        </div>
        <div className="mt-4 h-1.5 w-full max-w-[300px] overflow-hidden rounded-full bg-[#0f5468]/10" aria-hidden>
          <div className="welcome-progress-fill h-full rounded-full bg-gradient-to-r from-[#63d2e2] to-[#0f5468]" style={{ width: `${score}%`, "--welcome-load-ms": "1200ms" } as React.CSSProperties} />
        </div>
        <p className="mt-3 max-w-[340px] text-center text-[13px] leading-relaxed text-[#767676] [text-wrap:balance]">
          From your answers: how often you miss moves, your research time, what frustrates you and how many stocks you follow.
        </p>
      </div>

      <div className="w-full rounded-3xl border border-white/80 bg-white/75 p-5 shadow-[0_24px_60px_rgba(15,84,104,0.12)] backdrop-blur-md">
        {filings.state === "loading" ? (
          <p className="flex items-center justify-center gap-2 py-3 text-[14px] text-[#5f6a6d]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Checking today&apos;s filings on your stocks
          </p>
        ) : filings.state === "error" ? (
          <p className="py-2 text-center text-[14px] leading-relaxed text-[#5f6a6d]">
            We couldn&apos;t reach SEC filings just now. Falcon keeps watching your stocks.
          </p>
        ) : filings.count === 0 ? (
          <p className="py-2 text-center text-[14px] leading-relaxed text-[#5f6a6d]">
            No new filings on your stocks today. Falcon keeps watching.
          </p>
        ) : (
          <>
            <p className="text-center text-[15px] font-medium text-[#1d1b1b]">
              {filings.count} {filings.count === 1 ? "event" : "events"} hit your portfolio today
            </p>
            <p className="mt-1 text-center text-[12px] text-[#8a8f91]">SEC filings on your stocks in the last 24 hours</p>
            <div className="relative mt-4">
              <ul className="pointer-events-none select-none space-y-2 blur-[5px]" aria-hidden>
                {filings.items.slice(0, 3).map((item, i) => (
                  <li key={`${item.ticker}-${item.filedAt}-${i}`} className="flex items-center gap-3 rounded-xl bg-[#f3fafb] px-3 py-2.5 text-[13px]">
                    <span className="w-14 shrink-0 font-semibold text-[#0f5468]">{item.ticker}</span>
                    <span className="min-w-0 flex-1 truncate text-[#1d1b1b]">
                      {item.form} · {item.label}
                    </span>
                    <span className="shrink-0 text-[#8a8f91]">{timeAgo(item.filedAt)}</span>
                  </li>
                ))}
              </ul>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="inline-flex items-center gap-2 rounded-full border border-black/[0.06] bg-white/95 px-3.5 py-2 text-[12px] font-medium text-[#1d1b1b] shadow-[0_8px_22px_rgba(15,84,104,0.12)]">
                  <Lock className="h-3.5 w-3.5 text-[#1a7f95]" aria-hidden />
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
