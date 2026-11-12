"use client";

import { useMemo } from "react";
import type { RippleCard, RippleHistory } from "@falcon/ripple";
import { relationPhrase } from "@/lib/workspace/feed";
import { buildGraph } from "@/lib/workspace/graph";
import { useWorkspace } from "../context";
import { GraphView } from "../GraphView";
import {
  ConfidenceMark,
  DirectionMark,
  EmptyState,
  EvidenceQuote,
  ExternalAnchor,
  KindLabel,
  MONO,
  Panel,
  SectionTitle,
  SERIF,
  TickerButton,
  feedEmpty,
  formatDateTime,
} from "../parts";

export function findCard(cards: readonly RippleCard[] | undefined, cardId: string): RippleCard | null {
  return cards?.find((c) => c.id === cardId) ?? null;
}

/**
 * "Moved the implied way 7 of 9 times, avg +2.1% vs market, 5 trading days".
 * Null when the engine had too few similar past events (or no implied way) to measure.
 */
function HistoryLine({ history }: { history: RippleHistory | null }) {
  if (!history) return <span className="text-[12px] text-[#9a9a9a]">No measured past reactions</span>;
  const v = Math.round(history.avgMovePct * 10) / 10;
  const avg = `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(1)}%`;
  const times = Math.round(history.hitRate * history.sample);
  const days = history.windowDays === 1 ? "1 trading day" : `${history.windowDays} trading days`;
  const span = history.from && history.to ? `, ${history.from.slice(0, 4)} to ${history.to.slice(0, 4)}` : "";
  return (
    <span className="text-[12px] text-[#4b4b48]" title={`Past events like this one${span}, each measured against ${history.benchmark ?? "the market"}`}>
      Moved the implied way {times} of {history.sample} times, avg {avg} vs market, {days}
    </span>
  );
}

export function SightingTab({ cardId }: { cardId: string }) {
  const { feed, feedStatus, focusSet, openTicker } = useWorkspace();
  const card = findCard(feed?.cards, cardId);
  const graph = useMemo(() => {
    if (!card) return null;
    // Only this event's links: the event company and everyone it reaches.
    const one = { generatedAt: card.generatedAt, cards: [card] };
    return buildGraph(one, null, [card.event.ticker], { maxDepth: 2 });
  }, [card]);

  if (!card) {
    return (
      <div className="mx-auto w-full max-w-[560px] px-7 py-16">
        <EmptyState title={feedEmpty(feedStatus, "This sighting is no longer in the feed")} />
      </div>
    );
  }

  const { event } = card;
  const hits = [...card.hits].sort((a, b) => a.degree - b.degree || Number(focusSet.has(b.ticker)) - Number(focusSet.has(a.ticker)));

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-7 py-6">
      <header>
        <div className="flex items-center gap-3">
          <TickerButton ticker={event.ticker} />
          <KindLabel kind={event.kind} />
          <span className="text-[12px] text-[#9a9a9a]">{formatDateTime(event.occurredAt)}</span>
          <span className="text-[12px] text-[#9a9a9a]">{card.sector}</span>
        </div>
        <h1 className="mt-3 max-w-[860px] text-[26px] leading-[35px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          {event.headline}
        </h1>
        <p className="mt-3 max-w-[760px] text-[14px] leading-[22px] text-[#4b4b48]">{event.summary}</p>
        {event.source.url ? (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-[#9a9a9a]">
            <span style={{ fontFamily: MONO }}>{event.source.publisher}</span>
            <ExternalAnchor href={event.source.url}>{event.source.title || "Source"}</ExternalAnchor>
          </p>
        ) : null}
      </header>

      {/* Side by side on wide screens; links on top otherwise. */}
      <div className="grid grid-cols-1 items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="2xl:order-1">
          <SectionTitle count={hits.length}>Companies hit</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {hits.length ? (
              hits.map((hit) => {
                const from = hit.degree === 2 && hit.via ? hit.via : event.ticker;
                return (
                  <Panel key={hit.ticker} className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <TickerButton ticker={hit.ticker} />
                      <span className="min-w-0 truncate text-[13px] text-[#1d1b1b]">{hit.companyName}</span>
                      <span className="ml-auto shrink-0 whitespace-nowrap pl-2 text-[12px] text-[#767676]">{relationPhrase(hit.relation, from)}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-black/[0.06] pt-3">
                      <DirectionMark direction={hit.direction} />
                      <ConfidenceMark confidence={hit.confidence} />
                      <span className="text-[12px] text-[#9a9a9a]">{hit.window}</span>
                      {hit.degree === 2 ? <span className="text-[12px] text-[#9a9a9a]">2nd degree</span> : null}
                      {focusSet.has(hit.ticker) ? <span className="text-[12px] text-[#767676]">On your list</span> : null}
                      <span className="ml-auto">
                        <HistoryLine history={hit.history} />
                      </span>
                    </div>
                    <p className="mt-2.5 text-[13px] leading-[20px] text-[#4b4b48]">{hit.mechanism}</p>
                    {hit.evidence.length ? (
                      <div className="mt-3 flex flex-col gap-3">
                        {hit.evidence.map((e) => (
                          <EvidenceQuote key={e.quote} evidence={e} />
                        ))}
                      </div>
                    ) : null}
                  </Panel>
                );
              })
            ) : (
              <EmptyState title="No companies linked yet" />
            )}
          </div>
        </section>
        <aside className="order-first 2xl:sticky 2xl:top-4 2xl:order-2">
          <SectionTitle>Links</SectionTitle>
          <Panel className="mt-2 h-[260px] px-2 py-1 2xl:h-[340px]">
            {graph && graph.edges.length ? (
              <GraphView graph={graph} onOpen={openTicker} interactive={false} ring={105} highlight={event.ticker} ariaLabel="Links of this event" />
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-[#9a9a9a]">No links</div>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
