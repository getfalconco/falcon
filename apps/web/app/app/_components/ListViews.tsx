"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Plus, RotateCw, X } from "lucide-react";
import { NOTHING_CLEARED, cardPricedIn, type RippleCard } from "@falcon/ripple";
import { eventKicker, eventTypeCounts, exposureByTicker, mixByType, sortByTime, touchesFocus } from "@/lib/workspace/feed";
import { searchTickers, type TickerResult } from "@/lib/workspace/focus";
import { MAX_STOCKS, TICKER_PATTERN } from "@/lib/onboarding";
import { useWorkspace } from "./context";
import { FeedNotice } from "./FeedNotice";
import { MONO, NetMark, timeAgo } from "./parts";
import { StrengthBadge, useExplain } from "./explain";
import { CardBody, CardHeader, TextButton } from "./shell/ui";

/**
 * The focus list and the Sightings list, which used to live in the left
 * sidebar; on desktop they now open in the white card from the sidebar nav.
 */

const ROW = "flex w-full items-center gap-3 rounded-lg px-3 text-left outline-none transition-colors hover:bg-line/[0.04] focus-visible:bg-line/[0.05]";

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
    <div className="relative mb-2">
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
        className="h-9 w-full rounded-lg border border-line/15 bg-surface px-3 text-fs-13 text-fore outline-none placeholder:text-faint focus:border-line/35"
      />
      {results.length ? (
        <ul role="listbox" className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 rounded-xl border border-line/10 bg-surface p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]">
          {results.map((r, i) => (
            <li key={r.ticker} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left ${i === active ? "bg-line/[0.05]" : "hover:bg-line/[0.05]"}`}
              >
                <span className="w-14 shrink-0 text-fs-12.5 text-fore" style={{ fontFamily: MONO }}>
                  {r.ticker}
                </span>
                <span className="truncate text-fs-12.5 text-quiet">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FocusListView({ headerExtra }: { headerExtra?: React.ReactNode }) {
  const { feed, focus, openTicker, removeFocus } = useWorkspace();
  // An empty list opens straight into the ticker search.
  const [adding, setAdding] = useState(() => focus.length === 0);
  const exposure = useMemo(() => new Map(exposureByTicker(feed, focus).map((e) => [e.ticker, e])), [feed, focus]);
  const full = focus.length >= MAX_STOCKS;

  return (
    <>
      <CardHeader
        title="Focus list"
        actions={
          <>
            <TextButton icon={Plus} onClick={() => setAdding(true)} disabled={full} title={full ? `Up to ${MAX_STOCKS} tickers` : undefined}>
              Add ticker
            </TextButton>
            {headerExtra}
          </>
        }
      />
      <CardBody>
        <div className="mx-auto w-full max-w-[720px] px-7 py-6">
          <p className="mb-4 text-fs-13 text-quiet">
            {focus.length} of {MAX_STOCKS} tickers. Sightings that reach these are marked across the workspace.
          </p>
          {adding ? <AddTicker onDone={() => setAdding(false)} /> : null}
          {focus.length ? (
            <ul className="flex flex-col">
              {focus.map((f) => {
                const e = exposure.get(f.ticker);
                return (
                  <li key={f.ticker} className="group relative">
                    <button type="button" onClick={() => openTicker(f.ticker)} className={`${ROW} h-11 pr-11`}>
                      <span className="w-[64px] shrink-0 text-fs-13 text-fore" style={{ fontFamily: MONO }}>
                        {f.ticker}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-fs-13 text-quiet">{f.name || e?.companyName || ""}</span>
                      {e && e.events ? <span className="shrink-0 text-fs-12 text-faint">{e.events === 1 ? "1 event" : `${e.events} events`}</span> : null}
                      {e && e.net !== null ? <NetMark value={e.net} showLabel /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFocus(f.ticker)}
                      aria-label={`Remove ${f.ticker} from focus list`}
                      className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-faint opacity-0 outline-none transition-opacity hover:bg-line/[0.07] hover:text-fore focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X width={13} height={13} strokeWidth={2} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : adding ? null : (
            <button type="button" onClick={() => setAdding(true)} className={`${ROW} h-10 text-fs-13 text-quiet`}>
              Add a ticker
            </button>
          )}
        </div>
      </CardBody>
    </>
  );
}

function SightingRow({ card, mine, onOpen }: { card: RippleCard; mine: boolean; onOpen: () => void }) {
  const ex = useExplain(card);
  return (
    <li>
      <button type="button" onClick={onOpen} className={`${ROW} items-start py-2.5`} title={mine ? "Touches your focus list" : undefined}>
        <span className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${mine ? "bg-fore" : "bg-line/15"}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex min-h-[20px] items-center gap-2.5 text-fs-11 text-fore/50">
            <span className="flex min-w-0 items-center gap-1.5" style={{ fontFamily: MONO }}>
              <span className="min-w-0 truncate uppercase tracking-[0.04em]">{ex.kicker}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 whitespace-nowrap text-fs-11.5 text-fore">{card.event.ticker}</span>
            </span>
            <StrengthBadge strength={ex.strength} className="ml-auto" />
            <span className="shrink-0 text-fs-11.5 text-faint" style={{ fontFamily: MONO }}>
              {timeAgo(card.event.occurredAt)}
            </span>
          </span>
          <span className="mt-0.5 line-clamp-2 text-fs-13.5 leading-fs-19 text-fore">{ex.title}</span>
          {cardPricedIn(card) ? <span className="mt-0.5 block text-fs-12 text-quiet">May be priced in</span> : null}
        </span>
      </button>
    </li>
  );
}

function FilterChip({ on, onClick, count, children }: { on: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-fs-12 outline-none transition-colors focus-visible:border-line/50 ${
        on ? "border-line/25 bg-surface text-fore" : "border-line/[0.08] bg-transparent text-faint hover:text-fore-4"
      }`}
    >
      {children}
      <span className={on ? "text-quiet" : "text-faint-3"}>{count}</span>
    </button>
  );
}

export function SightingsListView({ onGuide, headerExtra }: { onGuide: () => void; headerExtra?: React.ReactNode }) {
  const { feed, feedStatus, focusSet, openSighting, refreshFeed } = useWorkspace();
  const all = useMemo(() => feed?.cards ?? [], [feed]);
  const types = useMemo(() => eventTypeCounts(all), [all]);
  const [picked, setPicked] = useState<string | null>(null);
  // A type that left the feed on refresh falls back to All.
  const type = picked && types.some((t) => t.type === picked) ? picked : null;
  // Newest first with every strength level together (each row says its level); All keeps any one type to half of any 10 rows.
  const cards = useMemo(() => (type ? sortByTime(all.filter((c) => eventKicker(c) === type)) : mixByType(all)), [all, type]);

  return (
    <>
      <CardHeader
        title="Sightings"
        actions={
          <>
            <TextButton icon={BookOpen} onClick={onGuide}>
              How to read
            </TextButton>
            <TextButton icon={RotateCw} onClick={refreshFeed}>
              Refresh
            </TextButton>
            {headerExtra}
          </>
        }
      />
      <CardBody>
        <div className="mx-auto w-full max-w-[760px] px-7 py-6">
          <FeedNotice />
          {all.length ? (
            <>
              {types.length > 1 ? (
                <div role="group" aria-label="Event type" className="mb-3 flex flex-wrap gap-1.5 px-3">
                  <FilterChip on={type === null} onClick={() => setPicked(null)} count={all.length}>
                    All
                  </FilterChip>
                  {types.map((t) => (
                    <FilterChip key={t.type} on={type === t.type} onClick={() => setPicked(type === t.type ? null : t.type)} count={t.count}>
                      {t.type}
                    </FilterChip>
                  ))}
                </div>
              ) : null}
              <ul className="flex flex-col">
                {cards.map((card) => (
                  <SightingRow key={card.id} card={card} mine={touchesFocus(card, focusSet)} onOpen={() => openSighting(card.id)} />
                ))}
              </ul>
            </>
          ) : (
            <p className="px-3 py-2 text-fs-13 text-faint">
              {feedStatus === "loading" ? "Loading" : feedStatus === "ready" ? NOTHING_CLEARED : "Sightings are not available"}
            </p>
          )}
        </div>
      </CardBody>
    </>
  );
}
