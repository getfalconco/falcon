"use client";

import { useEffect, useRef, useState } from "react";
import {
  MISSING,
  STRIP_KEYS,
  pollMs,
  sessionLabel,
  stripItem,
  stripSession,
  type MarketStripData,
  type StripKey,
  type StripSession,
  type Tone,
} from "@/lib/workspace/market-strip";

/**
 * The Dashboard's market strip under the setup card: SPY, QQQ, VIX and the
 * 10Y in one thin row, the session and New York time on the right (rules,
 * formats and colours: lib/workspace/market-strip.ts; data: GET /api/market).
 * Polls every 15 s while anything trades and every 5 min when closed; pauses
 * while the tab is hidden and refreshes when it comes back.
 */

const TONE: Record<Tone, string> = { up: "text-up", down: "text-down", flat: "text-quiet" };
const FLASH_MS = 900;

/** The clock, re-read at every minute boundary; null before mount. */
function useMinuteClock(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      timer = setTimeout(tick, 60_000 - (t % 60_000) + 50);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** GET /api/market on a schedule set by the session; the last good answer is kept through errors. */
function useMarketData(): MarketStripData | null {
  const [data, setData] = useState<MarketStripData | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;

    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const session: StripSession = stripSession(Date.now());
      timer = setTimeout(load, pollMs(session));
    };
    const load = async () => {
      clearTimeout(timer);
      inFlight?.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      try {
        const res = await fetch("/api/market", { signal: ctrl.signal });
        const body = (await res.json()) as MarketStripData;
        if (live && res.ok) setData(body);
      } catch {
        // Keep what is shown; the next poll tries again.
      } finally {
        if (inFlight === ctrl) inFlight = null;
        if (live) schedule();
      }
    };
    const onVisible = () => {
      if (document.hidden) {
        clearTimeout(timer);
        inFlight?.abort();
      } else void load();
    };
    const onFocus = () => {
      if (!document.hidden && !inFlight) void load();
    };

    void load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return data;
}

/** Keys whose shown value changed in the last answer, held for a moment for the tint. */
function useChanged(values: Record<StripKey, string> | null): Set<StripKey> {
  const prev = useRef<Record<StripKey, string> | null>(null);
  const [changed, setChanged] = useState<Set<StripKey>>(new Set());
  const sig = values ? STRIP_KEYS.map((k) => values[k]).join("|") : "";
  useEffect(() => {
    if (!values) return;
    const before = prev.current;
    prev.current = values;
    if (!before) return;
    const next = new Set(STRIP_KEYS.filter((k) => before[k] !== values[k] && before[k] !== MISSING && values[k] !== MISSING));
    setChanged(next);
    if (!next.size) return;
    const timer = setTimeout(() => setChanged(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` is the content of `values`.
  }, [sig]);
  return changed;
}

export function MarketStrip() {
  const now = useMinuteClock();
  const data = useMarketData();
  const session = now === null ? null : stripSession(now);
  const items = data && session ? STRIP_KEYS.map((k) => stripItem(k, data.quotes[k], session)) : null;
  const changed = useChanged(items ? (Object.fromEntries(items.map((i) => [i.key, `${i.value} ${i.change}`])) as Record<StripKey, string>) : null);

  return (
    <div className="pl-1.5">
      <section
        aria-label="Market"
        className="flex w-full items-center gap-3 rounded-2xl border border-line/[0.08] bg-raised px-5 py-3 text-fs-13 leading-fs-20 tabular-nums shadow-[0_1px_2px_rgba(0,0,0,0.05),0_8px_24px_-6px_rgba(0,0,0,0.10)]"
      >
        {/* Narrow panes: the items scroll sideways inside the card, fading out at the right edge. */}
        <ul className="flex min-w-0 flex-1 items-center gap-x-6 overflow-x-auto whitespace-nowrap pr-6 [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {STRIP_KEYS.map((key, i) => {
            const item = items?.[i];
            const flash = changed.has(key);
            return (
              <li key={key} className="flex shrink-0 items-baseline gap-1.5" title={item?.title}>
                <span className="text-quiet">{item?.label ?? (key === "TNX" ? "10Y" : key)}</span>
                {item ? (
                  <span
                    className={`-mx-1 flex items-baseline gap-1.5 rounded px-1 transition-colors motion-reduce:transition-none ${
                      flash ? "bg-line/[0.08] duration-150 motion-reduce:bg-transparent" : "bg-transparent duration-700"
                    }`}
                  >
                    <span className="font-medium text-fore">{item.value}</span>
                    <span className={TONE[item.tone]}>{item.change}</span>
                  </span>
                ) : (
                  // Before the first answer: the space is held, nothing flashes.
                  <span className="invisible" aria-hidden>
                    000.00 +0.0%
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <span className="shrink-0 whitespace-nowrap text-quiet" title={data?.stale ? "Showing the last prices Falcon could read" : "New York time"}>
          {now !== null ? (
            sessionLabel(now, session ?? undefined)
          ) : (
            <span className="invisible" aria-hidden>
              Pre-market · 0:00 ET
            </span>
          )}
        </span>
      </section>
    </div>
  );
}
