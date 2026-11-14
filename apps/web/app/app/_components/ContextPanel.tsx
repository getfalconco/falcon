"use client";

import { useMemo } from "react";
import { cardExplain } from "@falcon/ripple";
import type { Tab } from "@/lib/workspace/layout";
import { RELATIONS, cardsForTicker, connectionsFor, exposureByTicker, sectorFor } from "@/lib/workspace/feed";
import { withSeedConnections } from "@/lib/workspace/graph";
import { useGraphNeighborhood } from "@/lib/workspace/graph-api";
import { useWorkspace } from "./context";
import { RelationLegend } from "./GraphView";
import { DirectionWord, StrengthBadge } from "./explain";
import { ExternalAnchor, MONO, NetMark, NetValue, SectionTitle, TickerButton, formatDateTime, timeAgo } from "./parts";
import { useToday } from "./tabs/DashboardTab";
import { findCard } from "./tabs/SightingTab";
import { StrategyContext } from "./strategy/StrategyContext";

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="flex flex-col">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 border-b border-line/[0.05] py-2 last:border-0">
          <dt className="text-fs-12 text-quiet">{label}</dt>
          <dd className="min-w-0 truncate text-right text-fs-12.5 text-fore">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DashboardContext() {
  const { feed, focus, loadedAt } = useWorkspace();
  const summary = useToday();
  const exposure = useMemo(() => exposureByTicker(feed, focus).filter((e) => e.events > 0).slice(0, 6), [feed, focus]);
  return (
    <>
      <section>
        <SectionTitle>Today</SectionTitle>
        <Facts
          rows={[
            ["Net direction", <NetValue key="n" value={summary.metric.value} />],
            ["Hitting your portfolio", summary.portfolio.length],
            ["Opportunities", summary.opportunities.length],
            ["Events in feed", feed?.cards.length ?? 0],
            ["Updated", loadedAt ? timeAgo(new Date(loadedAt).toISOString()) : "Loading"],
          ]}
        />
      </section>
      <section>
        <SectionTitle>Most exposed</SectionTitle>
        {exposure.length ? (
          <ul className="flex flex-col gap-1.5 pt-1">
            {exposure.map((e) => (
              <li key={e.ticker} className="flex items-center gap-2.5">
                <span className="flex w-[56px] shrink-0">
                  <TickerButton ticker={e.ticker} />
                </span>
                <span className="min-w-0 flex-1 truncate text-fs-12 text-quiet">{e.events === 1 ? "1 event" : `${e.events} events`}</span>
                {e.net === null ? null : <NetMark value={e.net} showLabel />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pt-1 text-fs-12 text-faint">Nothing on your list is hit</p>
        )}
      </section>
    </>
  );
}

function GraphContext() {
  return (
    <>
      <section>
        <SectionTitle>Links</SectionTitle>
        <div className="pt-1">
          <RelationLegend relations={RELATIONS} />
        </div>
      </section>
      <section>
        <SectionTitle>Nodes</SectionTitle>
        <ul className="flex flex-col gap-2 pt-1 text-fs-12 text-fore-4">
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-fore" aria-hidden />
            Your focus list
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full border-[1.5px] border-line/35 bg-surface" aria-hidden />
            Connected company
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full border-[1.5px] border-up bg-surface" aria-hidden />
            Hit today, up
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full border-[1.5px] border-down bg-surface" aria-hidden />
            Hit today, down
          </li>
        </ul>
      </section>
    </>
  );
}

function TickerContext({ ticker }: { ticker: string }) {
  const { feed, focusSet } = useWorkspace();
  const { hitting } = useMemo(() => cardsForTicker(feed, ticker), [feed, ticker]);
  const extra = useGraphNeighborhood([ticker], 1);
  const connections = useMemo(() => withSeedConnections(connectionsFor(feed, ticker), extra, ticker), [extra, feed, ticker]);
  return (
    <>
      <section>
        <SectionTitle>{ticker}</SectionTitle>
        <Facts
          rows={[
            ["Focus list", focusSet.has(ticker) ? "On your list" : "Not on your list"],
            ["Sector", sectorFor(feed, ticker) ?? "Unknown"],
            ["Events hitting it", hitting.length],
            ["Filing links", connections.length],
          ]}
        />
      </section>
      {connections.length ? (
        <section>
          <SectionTitle count={connections.length}>Linked companies</SectionTitle>
          <ul className="flex flex-col gap-1.5 pt-1">
            {connections.slice(0, 12).map((c) => (
              <li key={c.ticker} className="flex items-center gap-2.5">
                <span className="flex w-[56px] shrink-0">
                  <TickerButton ticker={c.ticker} />
                </span>
                <span className="min-w-0 truncate text-fs-12 text-quiet">{c.phrase}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function SightingContext({ cardId }: { cardId: string }) {
  const { feed } = useWorkspace();
  const card = findCard(feed?.cards, cardId);
  if (!card) return <p className="text-fs-12 text-faint">No details</p>;
  const ex = cardExplain(card);
  return (
    <>
      <section>
        <SectionTitle>Event</SectionTitle>
        <Facts
          rows={[
            ["Company", <TickerButton key="t" ticker={card.event.ticker} />],
            ["Type", ex.kicker],
            ["Evidence", <StrengthBadge key="s" strength={ex.strength} />],
            ["Sector", card.sector],
            ["Published", formatDateTime(card.event.occurredAt)],
            ["Companies affected", card.hits.length],
          ]}
        />
      </section>
      <section>
        <SectionTitle>Signal per company</SectionTitle>
        <ul className="flex flex-col gap-1.5 pt-1">
          {card.hits.map((h) => (
            <li key={h.ticker} className="flex items-center gap-2.5">
              <TickerButton ticker={h.ticker} />
              <span className="flex-1" />
              <DirectionWord direction={h.direction} />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <SectionTitle>Source</SectionTitle>
        <p className="pt-1 text-fs-12 leading-fs-18">
          <span className="block text-quiet" style={{ fontFamily: MONO }}>
            {card.event.source.publisher}
          </span>
          <ExternalAnchor href={card.event.source.url}>{card.event.source.title || "Source"}</ExternalAnchor>
        </p>
      </section>
    </>
  );
}

/** Right panel inside the white card: details for whatever tab is active. */
export function ContextPanel({ tab }: { tab: Tab | null }) {
  let body: React.ReactNode = <p className="text-fs-12 text-faint">No details</p>;
  if (tab?.kind === "dashboard") body = <DashboardContext />;
  else if (tab?.kind === "graph") body = <GraphContext />;
  else if (tab?.kind === "ticker") body = <TickerContext ticker={tab.ticker} />;
  else if (tab?.kind === "sighting") body = <SightingContext cardId={tab.cardId} />;
  else if (tab?.kind === "strategy") body = <StrategyContext strategyId={tab.strategyId} />;
  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l border-line/[0.08]" aria-label="Details">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">{body}</div>
    </aside>
  );
}
