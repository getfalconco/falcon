"use client";

import { useMemo, useState } from "react";
import { BookOpen } from "lucide-react";
import { NOTHING_CLEARED, cardOptions, cardPricedIn, type RippleCard } from "@falcon/ripple";
import { eventKicker, eventTypeCounts, mixByType, sortByTime, touchesPortfolio } from "@/lib/workspace/feed";
import { useWorkspace } from "./context";
import { FeedNotice } from "./FeedNotice";
import { OptionsChip } from "./OptionsBlock";
import { MONO, timeAgo } from "./parts";
import { StrengthBadge, useExplain } from "./explain";
import { CardBody, CardHeader, TextButton } from "./shell/ui";

/**
 * The Sightings list, which used to live in the left sidebar; on desktop it
 * now opens in the white card (See all on the Dashboard).
 */

const ROW = "flex w-full items-center gap-3 rounded-lg px-3 text-left outline-none transition-colors hover:bg-line/[0.04] focus-visible:bg-line/[0.05]";

function SightingRow({ card, mine, onOpen }: { card: RippleCard; mine: boolean; onOpen: () => void }) {
  const ex = useExplain(card);
  return (
    <li>
      <button type="button" onClick={onOpen} className={`${ROW} items-start py-2.5`} title={mine ? "Touches your portfolio" : undefined}>
        <span className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${mine ? "bg-fore" : "bg-line/15"}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex min-h-[20px] items-center gap-2.5 text-fs-11 text-fore/50">
            <span className="flex min-w-0 items-center gap-1.5" style={{ fontFamily: MONO }}>
              <span className="min-w-0 truncate uppercase tracking-[0.04em]">{ex.kicker}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 whitespace-nowrap text-fs-11.5 text-fore">{card.event.ticker}</span>
            </span>
            <OptionsChip options={cardOptions(card)} className="ml-auto" />
            <StrengthBadge strength={ex.strength} className={cardOptions(card) ? "" : "ml-auto"} />
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
  const { feed, feedStatus, portfolioSet, openSighting } = useWorkspace();
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
                  <SightingRow key={card.id} card={card} mine={touchesPortfolio(card, portfolioSet)} onOpen={() => openSighting(card.id)} />
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
