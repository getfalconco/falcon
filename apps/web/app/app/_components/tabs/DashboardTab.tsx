"use client";

import { useMemo } from "react";
import { isWeakSignal } from "@falcon/ripple";
import { buildTodaySummary, exposureByTicker, sortByTime } from "@/lib/workspace/feed";
import { buildGraph } from "@/lib/workspace/graph";
import { useWorkspace } from "../context";
import { GraphView } from "../GraphView";
import { EmptyState, MONO, NetMark, NetRing, Panel, RippleCardView, SectionTitle, SERIF, feedEmpty, timeAgo } from "../parts";
import { FeedNotice } from "../FeedNotice";

export function useToday() {
  const { feed, focus } = useWorkspace();
  return useMemo(() => buildTodaySummary(feed, focus.map((f) => f.ticker)), [feed, focus]);
}

function longDate(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** The ring, the why line and today's date: the top of Today. */
export function TodayHeader({ compact = false }: { compact?: boolean }) {
  const summary = useToday();
  const { feedStatus } = useWorkspace();
  const why =
    feedStatus === "ready" ? summary.why : feedStatus === "loading" ? "Loading today's sightings." : "Today's sightings are not in yet.";
  return (
    <div className={`flex items-center ${compact ? "flex-col gap-5 text-center" : "gap-7"}`}>
      <NetRing value={summary.metric.value} size={compact ? 168 : 148} label={summary.metric.label} />
      <div className="min-w-0">
        <p className="text-[12px] text-[#9a9a9a]">{longDate(summary.date)}</p>
        <h1 className="mt-1 text-[26px] leading-[34px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          Today
        </h1>
        <p className="mt-2 max-w-[440px] text-[14px] leading-[21px] text-[#4b4b48]">{why}</p>
      </div>
    </div>
  );
}

export function DashboardTab() {
  const { feed, feedStatus, focus, focusSet, openTab, openTicker } = useWorkspace();
  const summary = useToday();
  const exposure = useMemo(() => exposureByTicker(feed, focus), [feed, focus]);
  // Today never lists a weak signal; those sit under "Weak signals" in the sidebar.
  const listed = useMemo(() => sortByTime(feed?.cards ?? []).filter((c) => !isWeakSignal(c)), [feed]);
  const latest = listed.slice(0, 6);
  const seeds = useMemo(() => {
    const own = focus.map((f) => f.ticker);
    return own.length ? own : Array.from(new Set((feed?.cards ?? []).map((c) => c.event.ticker))).slice(0, 4);
  }, [feed, focus]);
  const mini = useMemo(() => buildGraph(feed, null, seeds, { maxDepth: 1, maxNodes: 28 }), [feed, seeds]);

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-7 py-6">
      <FeedNotice />

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-5">
        <Panel className="flex items-center px-6 py-6">
          <TodayHeader />
        </Panel>
        <Panel className="flex h-[280px] flex-col px-4 pb-2 pt-3">
          <SectionTitle
            action={
              <button
                type="button"
                onClick={() => openTab("graph")}
                className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-[#767676] outline-none transition-colors hover:bg-[#efefec] hover:text-[#1d1b1b] focus-visible:bg-[#efefec]"
              >
                Open graph
              </button>
            }
          >
            Connections
          </SectionTitle>
          <div className="min-h-0 flex-1">
            {mini.edges.length ? (
              <GraphView graph={mini} onOpen={openTicker} interactive={false} ring={110} ariaLabel="Focus list connections" />
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] text-[#9a9a9a]">No connections yet</div>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <section>
          <SectionTitle count={summary.portfolio.length}>Hitting your portfolio</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {summary.portfolio.length ? (
              summary.portfolio.slice(0, 3).map((card) => <RippleCardView key={card.id} card={card} highlight={focusSet} maxHits={3} />)
            ) : (
              <EmptyState title={feedEmpty(feedStatus, focus.length ? "Nothing is hitting your portfolio" : "Your focus list is empty")} />
            )}
          </div>
        </section>
        <section>
          <SectionTitle count={summary.opportunities.length}>Opportunities</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {summary.opportunities.length ? (
              summary.opportunities.slice(0, 2).map((card) => <RippleCardView key={card.id} card={card} maxHits={3} />)
            ) : (
              <EmptyState title={feedEmpty(feedStatus, "No opportunities right now")} />
            )}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-5 pb-4">
        <section>
          <SectionTitle count={focus.length}>Focus list</SectionTitle>
          <Panel className="mt-2 overflow-hidden">
            {exposure.length ? (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-black/[0.06] text-[11px] uppercase tracking-[0.12em] text-[#1d1b1b]/40">
                    <th className="w-[84px] px-4 py-2 font-normal">Ticker</th>
                    <th className="px-2 py-2 font-normal">Company</th>
                    <th className="px-2 py-2 text-right font-normal">Events</th>
                    <th className="px-4 py-2 text-right font-normal">Direction</th>
                  </tr>
                </thead>
                <tbody>
                  {exposure.map((row) => (
                    <tr
                      key={row.ticker}
                      onClick={() => openTicker(row.ticker)}
                      className="cursor-pointer border-b border-black/[0.05] last:border-0 hover:bg-black/[0.02]"
                    >
                      <td className="px-4 py-2.5 text-[12.5px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                        {row.ticker}
                      </td>
                      <td className="max-w-0 truncate px-2 py-2.5 text-[13px] text-[#4b4b48]">{row.companyName || row.ticker}</td>
                      <td className="px-2 py-2.5 text-right text-[13px] tabular-nums text-[#4b4b48]">{row.events || ""}</td>
                      <td className="px-4 py-2.5 text-right text-[13px]">{row.net === null ? null : <NetMark value={row.net} showLabel />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-4">
                <EmptyState title="Add tickers from the sidebar" />
              </div>
            )}
          </Panel>
        </section>
        <section>
          <SectionTitle count={listed.length}>Latest sightings</SectionTitle>
          <Panel className="mt-2 overflow-hidden">
            {latest.length ? (
              <ul>
                {latest.map((card) => (
                  <LatestRow key={card.id} cardId={card.id} />
                ))}
              </ul>
            ) : (
              <div className="p-4">
                <EmptyState title={feedEmpty(feedStatus, feed?.cards.length ? "Only weak signals today" : "No sightings yet")} />
              </div>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}

function LatestRow({ cardId }: { cardId: string }) {
  const { feed, openSighting, focusSet } = useWorkspace();
  const card = feed?.cards.find((c) => c.id === cardId);
  if (!card) return null;
  const mine = card.hits.filter((h) => focusSet.has(h.ticker)).length;
  return (
    <li className="border-b border-black/[0.05] last:border-0">
      <button
        type="button"
        onClick={() => openSighting(card.id)}
        className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03]"
      >
        <span className="text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
          {card.event.ticker}
        </span>
        <span className="min-w-0 truncate text-[13px] text-[#1d1b1b]">{card.event.headline}</span>
        <span className="flex items-center gap-3 whitespace-nowrap text-[12px] text-[#9a9a9a]">
          {mine ? <span className="text-[#4b4b48]">{mine} on your list</span> : null}
          <span>{card.hits.length === 1 ? "1 company" : `${card.hits.length} companies`}</span>
          <span className="w-14 text-right">{timeAgo(card.event.occurredAt)}</span>
        </span>
      </button>
    </li>
  );
}
