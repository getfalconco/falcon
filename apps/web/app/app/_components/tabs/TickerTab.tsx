"use client";

import { useEffect, useMemo, useState } from "react";
import { analystsFor, analystsLabel } from "@falcon/ripple";
import { cardsForTicker, companyNameFor, connectionsFor, netDirection, sectorFor } from "@/lib/workspace/feed";
import { buildGraph, withSeedConnections } from "@/lib/workspace/graph";
import { useGraphNeighborhood } from "@/lib/workspace/graph-api";
import { fetchNames } from "@/lib/workspace/focus";
import { useWorkspace } from "../context";
import { GraphView } from "../GraphView";
import {
  ConfidenceMark,
  DirectionMark,
  EmptyState,
  EvidenceQuote,
  KindLabel,
  MONO,
  NetRing,
  Panel,
  PricedInTag,
  RecordText,
  SectionTitle,
  SERIF,
  TickerButton,
  feedEmpty,
  timeAgo,
} from "../parts";

/** Company name: the focus list, then the feed, then the SEC list. */
export function useCompanyName(ticker: string): string | null {
  const { feed, focus } = useWorkspace();
  const known = focus.find((f) => f.ticker === ticker)?.name || companyNameFor(feed, ticker);
  const [fetched, setFetched] = useState<string | null>(null);
  useEffect(() => {
    if (known) return;
    let live = true;
    void fetchNames([ticker]).then((names) => {
      if (live) setFetched(names[ticker] ?? null);
    });
    return () => {
      live = false;
    };
  }, [known, ticker]);
  return known || fetched;
}

export function FocusToggle({ ticker, name }: { ticker: string; name: string | null }) {
  const { focusSet, addFocus, removeFocus } = useWorkspace();
  const on = focusSet.has(ticker);
  return (
    <button
      type="button"
      onClick={() => (on ? removeFocus(ticker) : addFocus({ ticker, name: name ?? "" }))}
      className="inline-flex h-8 items-center rounded-lg border border-black/10 px-3 text-[12.5px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:border-black/40"
    >
      {on ? "On focus list" : "Add to focus list"}
    </button>
  );
}

export function TickerTab({ ticker }: { ticker: string }) {
  const { feed, feedStatus, openTicker, openSighting } = useWorkspace();
  const name = useCompanyName(ticker);
  const sector = sectorFor(feed, ticker);
  const analysts = analystsFor(feed?.cards ?? [], ticker);
  const { hitting, at } = useMemo(() => cardsForTicker(feed, ticker), [feed, ticker]);
  const extra = useGraphNeighborhood([ticker], 1);
  const connections = useMemo(() => withSeedConnections(connectionsFor(feed, ticker), extra, ticker), [extra, feed, ticker]);
  const net = netDirection(hitting.map((h) => h.hit));
  const graph = useMemo(() => buildGraph(feed, extra, [ticker], { maxDepth: 1, maxNodes: 13 }), [extra, feed, ticker]);

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-7 py-6">
      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-[#767676]" style={{ fontFamily: MONO }}>
              {ticker}
            </span>
            {sector ? <span className="text-[12px] text-[#9a9a9a]">{sector}</span> : null}
            {analysts !== null ? <span className="text-[12px] text-[#9a9a9a]">{analystsLabel(analysts)}</span> : null}
          </div>
          <h1 className="mt-1 truncate text-[28px] leading-[36px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            {name ?? ticker}
          </h1>
        </div>
        <FocusToggle ticker={ticker} name={name} />
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-5">
        <Panel className="flex items-center gap-6 px-6 py-5">
          <NetRing value={net} size={120} />
          <dl className="flex min-w-0 flex-1 flex-col">
            {(
              [
                ["Events hitting it", hitting.length],
                ["Its own events", at.length],
                ["Filing links", connections.length],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 border-b border-black/[0.05] py-2 last:border-0">
                <dt className="text-[12.5px] text-[#767676]">{label}</dt>
                <dd className="text-[15px] tabular-nums text-[#1d1b1b]">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel className="h-[220px] px-2 py-1">
          {graph.edges.length ? (
            <GraphView graph={graph} onOpen={(t) => t !== ticker && openTicker(t)} interactive={false} ring={90} highlight={ticker} ariaLabel={`${ticker} connections`} />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-[#9a9a9a]">No connections yet</div>
          )}
        </Panel>
      </div>

      <section>
        <SectionTitle count={hitting.length}>Events hitting {ticker}</SectionTitle>
        <div className="mt-2 flex flex-col gap-3">
          {hitting.length ? (
            hitting.map(({ card, hit }) => (
              <Panel key={card.id} className="px-5 py-4">
                <div className="flex items-center gap-2">
                  <TickerButton ticker={card.event.ticker} />
                  <KindLabel kind={card.event.kind} />
                  <span className="ml-auto text-[12px] text-[#9a9a9a]">{timeAgo(card.event.occurredAt)}</span>
                </div>
                <h3 className="mt-2">
                  <button
                    type="button"
                    onClick={() => openSighting(card.id)}
                    className="text-left text-[14px] leading-[20px] text-[#1d1b1b] underline decoration-transparent underline-offset-2 outline-none transition-colors hover:decoration-black/30 focus-visible:decoration-black/50"
                  >
                    {card.event.headline}
                  </button>
                </h3>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-black/[0.06] pt-3">
                  <DirectionMark direction={hit.direction} />
                  <ConfidenceMark confidence={hit.confidence} />
                  <RecordText hit={hit} className="text-[12px]" />
                  {hit.pricedIn ? <PricedInTag since={hit.sinceEvent} /> : null}
                  <span className="text-[12px] text-[#9a9a9a]">{hit.window}</span>
                  {hit.degree === 2 && hit.via ? (
                    <span className="flex items-center gap-1.5 text-[12px] text-[#9a9a9a]">
                      through <TickerButton ticker={hit.via} />
                    </span>
                  ) : null}
                </div>
                <p className="mt-2.5 text-[13px] leading-[20px] text-[#4b4b48]">{hit.mechanism}</p>
              </Panel>
            ))
          ) : (
            <EmptyState title={feedEmpty(feedStatus, `Nothing is hitting ${ticker} right now`)} />
          )}
        </div>
      </section>

      {at.length ? (
        <section>
          <SectionTitle count={at.length}>Events at {ticker}</SectionTitle>
          <ul className="mt-2 overflow-hidden rounded-lg border border-black/[0.08] bg-white">
            {at.map((card) => (
              <li key={card.id} className="border-b border-black/[0.05] last:border-0">
                <button
                  type="button"
                  onClick={() => openSighting(card.id)}
                  className="grid w-full grid-cols-[90px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-black/[0.02] focus-visible:bg-black/[0.03]"
                >
                  <KindLabel kind={card.event.kind} />
                  <span className="truncate text-[13px] text-[#1d1b1b]">{card.event.headline}</span>
                  <span className="text-[12px] text-[#9a9a9a]">{timeAgo(card.event.occurredAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="pb-6">
        <SectionTitle count={connections.length}>Connections</SectionTitle>
        <div className="mt-2 flex flex-col gap-3">
          {connections.length ? (
            connections.map((c) => (
              <Panel key={c.ticker} className="px-5 py-4">
                <div className="flex items-center gap-3">
                  <TickerButton ticker={c.ticker} />
                  <span className="truncate text-[13px] text-[#1d1b1b]">{c.companyName}</span>
                  <span className="ml-auto text-[12px] text-[#767676]">{c.phrase}</span>
                </div>
                {c.evidence.length ? (
                  <div className="mt-3 flex flex-col gap-3">
                    {c.evidence.slice(0, 3).map((e) => (
                      <EvidenceQuote key={e.quote} evidence={e} />
                    ))}
                  </div>
                ) : null}
              </Panel>
            ))
          ) : (
            <EmptyState title={feedEmpty(feedStatus, "No filing links yet")} />
          )}
        </div>
      </section>
    </div>
  );
}
