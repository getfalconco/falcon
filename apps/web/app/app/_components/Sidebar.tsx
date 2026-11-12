"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, LogOut, Plus, X } from "lucide-react";
import { cardPricedIn, splitWeakSignals, type RippleCard } from "@falcon/ripple";
import { exposureByTicker, sortByTime, touchesFocus } from "@/lib/workspace/feed";
import { searchTickers, type TickerResult } from "@/lib/workspace/focus";
import { MAX_STOCKS, TICKER_PATTERN } from "@/lib/onboarding";
import BrandMark from "../../components/BrandMark";
import { useWorkspace } from "./context";
import { MONO, NetMark, SectionTitle, timeAgo } from "./parts";

const ROW = "flex w-full items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-black/[0.04] focus-visible:bg-black/[0.05]";

function AddTicker({ onDone }: { onDone: () => void }) {
  const { addFocus, focusSet } = useWorkspace();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TickerResult[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchTickers(query, controller.signal).then((r) => {
        if (!controller.signal.aborted) {
          setResults(r.filter((x) => !focusSet.has(x.ticker)).slice(0, 6));
          setActive(0);
        }
      });
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [focusSet, q]);

  function pick(item: TickerResult) {
    addFocus(item);
    setQ("");
    setResults([]);
    inputRef.current?.focus();
  }

  return (
    <div className="relative px-2 pb-1">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value.slice(0, 40))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const chosen = results[active];
            if (chosen) pick(chosen);
            else {
              const typed = q.trim().toUpperCase();
              if (TICKER_PATTERN.test(typed) && !focusSet.has(typed)) pick({ ticker: typed, name: "" });
            }
          }
        }}
        onBlur={() => {
          // Leave room for a click on a result.
          setTimeout(() => {
            if (!inputRef.current?.matches(":focus")) onDone();
          }, 150);
        }}
        placeholder="Ticker or company"
        aria-label="Add a ticker"
        className="h-8 w-full rounded-md border border-black/15 bg-white px-2.5 text-[12.5px] text-[#1d1b1b] outline-none placeholder:text-[#9a9a9a] focus:border-black/35"
      />
      {results.length ? (
        <ul role="listbox" className="absolute left-2 right-2 top-[calc(100%-2px)] z-20 rounded-lg border border-black/10 bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
          {results.map((r, i) => (
            <li key={r.ticker} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left ${i === active ? "bg-[#efefec]" : "hover:bg-[#efefec]"}`}
              >
                <span className="w-12 shrink-0 text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                  {r.ticker}
                </span>
                <span className="truncate text-[12px] text-[#767676]">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SightingRow({ card, active, mine, onOpen }: { card: RippleCard; active: boolean; mine: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={`${ROW} items-start py-2 ${active ? "bg-black/[0.055]" : ""}`}>
        <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${mine ? "bg-[#1d1b1b]" : "bg-black/15"}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[11.5px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
              {card.event.ticker}
            </span>
            {cardPricedIn(card) ? (
              <span className="text-[10px] uppercase tracking-[0.08em] text-[#767676]" style={{ fontFamily: MONO }}>
                Priced in
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] text-[#9a9a9a]">{timeAgo(card.event.occurredAt)}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-[#4b4b48]">{card.event.headline}</span>
        </span>
      </button>
    </li>
  );
}

export function Sidebar({ email, onSignOut, activeTicker, activeCardId }: { email: string | null; onSignOut: (() => void) | null; activeTicker: string | null; activeCardId: string | null }) {
  const { feed, feedStatus, focus, focusSet, openTicker, openSighting, removeFocus } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const exposure = useMemo(() => new Map(exposureByTicker(feed, focus).map((e) => [e.ticker, e])), [feed, focus]);
  const cards = useMemo(() => sortByTime(feed?.cards ?? []), [feed]);
  // Weak signals (card confidence "low") go last, folded away.
  const split = useMemo(() => splitWeakSignals(cards), [cards]);

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-black/[0.08] bg-[#f6f6f3]" aria-label="Sidebar">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/[0.08] px-4">
        <BrandMark size={18} />
        <span className="text-[13px] text-[#1d1b1b]">Falcon</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <section className="px-2 pt-3">
          <div className="px-2">
            <SectionTitle
              count={focus.length}
              action={
                focus.length < MAX_STOCKS ? (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    aria-label="Add a ticker"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[#767676] outline-none transition-colors hover:bg-black/[0.06] hover:text-[#1d1b1b] focus-visible:bg-black/[0.06]"
                  >
                    <Plus width={14} height={14} strokeWidth={1.75} aria-hidden />
                  </button>
                ) : null
              }
            >
              Focus list
            </SectionTitle>
          </div>
          {adding ? <AddTicker onDone={() => setAdding(false)} /> : null}
          {focus.length ? (
            <ul className="mt-0.5">
              {focus.map((f) => {
                const e = exposure.get(f.ticker);
                const active = activeTicker === f.ticker;
                return (
                  <li key={f.ticker} className="group relative">
                    <button type="button" onClick={() => openTicker(f.ticker)} className={`${ROW} h-8 pr-7 ${active ? "bg-black/[0.055]" : ""}`}>
                      <span className="w-[46px] shrink-0 text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                        {f.ticker}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[#767676]">{f.name || e?.companyName || ""}</span>
                      {e && e.net !== null ? <NetMark value={e.net} className="group-hover:opacity-0" /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFocus(f.ticker)}
                      aria-label={`Remove ${f.ticker} from focus list`}
                      className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[#9a9a9a] opacity-0 outline-none transition-opacity hover:bg-black/[0.07] hover:text-[#1d1b1b] focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X width={12} height={12} strokeWidth={2} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : adding ? null : (
            <button type="button" onClick={() => setAdding(true)} className={`${ROW} mt-1 h-8 text-[12px] text-[#767676]`}>
              Add your first ticker
            </button>
          )}
        </section>

        <section className="mt-4 px-2 pb-3">
          <div className="px-2">
            <SectionTitle count={cards.length}>Sightings</SectionTitle>
          </div>
          {cards.length ? (
            <>
              {split.strong.length ? (
                <ul className="mt-0.5 flex flex-col">
                  {split.strong.map((card) => (
                    <SightingRow key={card.id} card={card} active={activeCardId === card.id} mine={touchesFocus(card, focusSet)} onOpen={() => openSighting(card.id)} />
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-2 text-[12px] text-[#9a9a9a]">Only weak signals today</p>
              )}
              {split.weak.length ? (
                <details className="group mt-2" open={split.weak.some((c) => c.id === activeCardId) || undefined}>
                  <summary
                    className={`${ROW} h-8 cursor-pointer list-none text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/45 [&::-webkit-details-marker]:hidden`}
                    style={{ fontFamily: MONO }}
                    title="Cards whose best link is low confidence"
                  >
                    <ChevronRight width={12} height={12} strokeWidth={2} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden />
                    Weak signals
                    <span className="text-[#1d1b1b]/30">{split.weak.length}</span>
                  </summary>
                  <ul className="mt-0.5 flex flex-col opacity-80">
                    {split.weak.map((card) => (
                      <SightingRow key={card.id} card={card} active={activeCardId === card.id} mine={touchesFocus(card, focusSet)} onOpen={() => openSighting(card.id)} />
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : (
            <p className="px-2 py-2 text-[12px] text-[#9a9a9a]">
              {feedStatus === "loading" ? "Loading" : feedStatus === "ready" ? "No sightings yet" : "Sightings are not available"}
            </p>
          )}
        </section>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 border-t border-black/[0.08] px-4">
        <span className="min-w-0 flex-1 truncate text-[12px] text-[#767676]">{email ?? "Preview"}</span>
        {onSignOut ? (
          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#767676] outline-none transition-colors hover:bg-black/[0.06] hover:text-[#1d1b1b] focus-visible:bg-black/[0.06]"
          >
            <LogOut width={14} height={14} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>
    </aside>
  );
}
