"use client";

import { useMemo } from "react";
import { cardPricedIn, shortCompany, type RippleCard, type RippleHit } from "@falcon/ripple";
import { buildGraph } from "@/lib/workspace/graph";
import { useWorkspace } from "../context";
import { GraphView } from "../GraphView";
import { OptionsRow } from "../OptionsBlock";
import { CardKicker, DirectionWord, ExplainSections, HowToReadButton, SightingSources, StrengthBadge, hitLinkText, isSelfOnly, useExplain } from "../explain";
import { EmptyState, EvidenceQuote, Panel, PricedInTag, SectionTitle, SERIF, TickerButton, feedEmpty, formatDateTime, signedPct, sinceEventText } from "../parts";
import { AskFalconButton } from "../lab/AskFalconButton";

export function findCard(cards: readonly RippleCard[] | undefined, cardId: string): RippleCard | null {
  return cards?.find((c) => c.id === cardId) ?? null;
}

/** One company the event reaches: who it is, which way, how it is linked, why, and for how long. */
function AffectedRow({ hit, card, mine }: { hit: RippleHit; card: RippleCard; mine: boolean }) {
  const link = hitLinkText(hit, card);
  const quotes = hit.evidence.length;
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <TickerButton ticker={hit.ticker} />
        <span className="min-w-0 truncate text-fs-13.5 text-fore">{shortCompany(hit.companyName)}</span>
        <DirectionWord direction={hit.direction} />
        {mine ? <span className="text-fs-12 text-quiet">In your portfolio</span> : null}
        {hit.pricedIn ? <PricedInTag since={hit.sinceEvent} /> : null}
      </div>
      {link ? <p className="mt-1.5 text-fs-12.5 text-quiet">{link.charAt(0).toUpperCase() + link.slice(1)}</p> : null}
      <p className="mt-2 text-fs-13.5 leading-fs-21 text-fore-4">{hit.mechanism}</p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-fs-12.5 text-quiet">
        <span>Time frame: {hit.window}</span>
        {hit.sinceEvent ? (
          <span title={hit.sinceEvent.pricedInAtPct !== null ? `Half its usual move is ${signedPct(hit.sinceEvent.pricedInAtPct)}` : undefined}>
            {sinceEventText(hit.sinceEvent)}
          </span>
        ) : null}
      </p>
      <OptionsRow options={hit.options} className="mt-2.5" />
      {quotes ? (
        <details className="group mt-2.5 [&_summary::-webkit-details-marker]:hidden">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-fs-12.5 text-fore-4 underline decoration-line/20 underline-offset-2 outline-none hover:text-fore focus-visible:ring-2 focus-visible:ring-line/20">
            <span className="group-open:hidden">{quotes === 1 ? "Show the filing quote" : `Show the filing quotes (${quotes})`}</span>
            <span className="hidden group-open:inline">{quotes === 1 ? "Hide the filing quote" : "Hide the filing quotes"}</span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {hit.evidence.map((e) => (
              <EvidenceQuote key={e.quote} evidence={e} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function SightingTab({ cardId }: { cardId: string }) {
  const { feed, feedStatus } = useWorkspace();
  const card = findCard(feed?.cards, cardId);
  if (!card) {
    return (
      <div className="mx-auto w-full max-w-[560px] px-7 py-16">
        <EmptyState title={feedEmpty(feedStatus, "This sighting is no longer in the feed")} />
      </div>
    );
  }
  return <SightingDetail card={card} />;
}

function SightingDetail({ card }: { card: RippleCard }) {
  const { portfolioSet, openTicker } = useWorkspace();
  const ex = useExplain(card);
  const { event } = card;
  const hits = [...card.hits].sort((a, b) => a.degree - b.degree || Number(portfolioSet.has(b.ticker)) - Number(portfolioSet.has(a.ticker)));
  const graph = useMemo(() => {
    if (isSelfOnly(card)) return null;
    // Only this event's links: the event company and everyone it reaches.
    const one = { generatedAt: card.generatedAt, cards: [card] };
    return buildGraph(one, null, [card.event.ticker], { maxDepth: 2 });
  }, [card]);

  return (
    <div className="mx-auto flex w-full max-w-[var(--f-w-sighting)] flex-col gap-7 px-7 py-6">
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <CardKicker card={card} ex={ex} />
          <span className="text-fs-12 text-faint">{formatDateTime(event.occurredAt)}</span>
          <span className="ml-auto flex items-center gap-2">
            <AskFalconButton prompt={`Explain this sighting: "${ex.title}" (${event.ticker}). What is the evidence, and what would weaken it?`} />
            <HowToReadButton />
          </span>
        </div>
        <h1 className="mt-3 max-w-[820px] text-fs-26 leading-fs-35 text-fore" style={{ fontFamily: SERIF }}>
          {ex.title}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StrengthBadge strength={ex.strength} />
          {cardPricedIn(card) ? <PricedInTag since={card.hits.find((h) => h.pricedIn)?.sinceEvent} /> : null}
        </div>
        <p className="mt-1.5 max-w-[680px] text-fs-13 leading-fs-20 text-quiet">{ex.strength.detail}</p>
      </header>

      <Panel className="px-6 py-5">
        <ExplainSections ex={ex} columns={2} />
      </Panel>

      {card.options && !card.hits.some((h) => h.ticker === event.ticker && h.options) ? (
        <section>
          <SectionTitle>Options on {event.ticker}</SectionTitle>
          <OptionsRow options={card.options} className="mt-2" label={false} />
        </section>
      ) : null}

      <section>
        <SectionTitle count={hits.length}>Companies affected</SectionTitle>
        {hits.length ? (
          <Panel className="mt-2 divide-y divide-line/[0.06]">
            {hits.map((hit) => (
              <AffectedRow key={hit.ticker} hit={hit} card={card} mine={portfolioSet.has(hit.ticker)} />
            ))}
          </Panel>
        ) : (
          <div className="mt-2">
            <EmptyState title="No companies linked yet" />
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Sources</SectionTitle>
        <Panel className="mt-2 px-5 py-4">
          <SightingSources card={card} ex={ex} />
        </Panel>
      </section>

      {graph && graph.edges.length ? (
        <section className="pb-4">
          <SectionTitle>How the companies are linked</SectionTitle>
          <Panel className="mt-2 h-[300px] px-2 py-1">
            <GraphView graph={graph} onOpen={openTicker} interactive={false} ring={105} highlight={event.ticker} ariaLabel="Links of this event" />
          </Panel>
        </section>
      ) : null}
    </div>
  );
}
