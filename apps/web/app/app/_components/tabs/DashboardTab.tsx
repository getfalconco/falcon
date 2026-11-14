"use client";

import { useMemo } from "react";
import { NOTHING_CLEARED, anyClearsBar, cardStrength, type RippleCard } from "@falcon/ripple";
import { buildTodaySummary, exposureByTicker, sortByTime, touchesFocus } from "@/lib/workspace/feed";
import { buildGraph } from "@/lib/workspace/graph";
import { useWorkspace } from "../context";
import { GraphView } from "../GraphView";
import { EmptyState, MONO, NetMark, NetRing, Panel, SectionTitle, SERIF, feedEmpty, timeAgo } from "../parts";
import { HowToReadButton, SightingCard, StrengthBadge, todaySentence, useExplain } from "../explain";
import { FeedNotice } from "../FeedNotice";

/** True when the feed is in and no card clears the publishing bar (only Watch-tier cards, or none). */
export function useNothingCleared(): boolean {
  const { feed, feedStatus } = useWorkspace();
  return feedStatus === "ready" && !anyClearsBar(feed?.cards ?? []);
}

export function useToday() {
  const { feed, focus } = useWorkspace();
  return useMemo(() => buildTodaySummary(feed, focus.map((f) => f.ticker)), [feed, focus]);
}

/** The empty "Hitting your portfolio" title; says so when only Watching cards touch the focus list. */
export function usePortfolioEmptyTitle(): string {
  const { feed, feedStatus, focus, focusSet } = useWorkspace();
  const nothingCleared = useNothingCleared();
  const watching = useMemo(
    () => (feed?.cards ?? []).filter((c) => touchesFocus(c, focusSet) && cardStrength(c).level === "watching").length,
    [feed, focusSet],
  );
  if (!focus.length) return feedEmpty(feedStatus, "Your focus list is empty");
  if (watching) {
    return feedEmpty(
      feedStatus,
      `Nothing backed by evidence touches your portfolio. ${watching === 1 ? "1 Sighting under Watching does" : `${watching} Sightings under Watching do`}.`,
    );
  }
  return feedEmpty(feedStatus, nothingCleared ? NOTHING_CLEARED : "Nothing is hitting your portfolio");
}

function longDate(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** The ring, today's one-sentence summary and the date: the top of Today. */
export function TodayHeader({ compact = false }: { compact?: boolean }) {
  const summary = useToday();
  const { feed, feedStatus, focusSet } = useWorkspace();
  const sentence = useMemo(() => todaySentence(feed?.cards ?? [], focusSet), [feed, focusSet]);
  const why = feedStatus === "ready" ? sentence : feedStatus === "loading" ? "Loading today's sightings." : "Today's sightings are not in yet.";
  return (
    <div className={`flex items-center ${compact ? "flex-col gap-5 text-center" : "gap-7"}`}>
      <NetRing value={summary.metric.value} size={compact ? 168 : 148} label={summary.metric.label} />
      <div className="min-w-0">
        <p className="text-[12px] text-[#9a9a9a]">{longDate(summary.date)}</p>
        <div className={`mt-1 flex items-center gap-2.5 ${compact ? "justify-center" : ""}`}>
          <h1 className="text-[26px] leading-[34px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            Today
          </h1>
          <HowToReadButton />
        </div>
        <p className="mt-2 max-w-[440px] text-[14px] leading-[21px] text-[#4b4b48]">{why}</p>
      </div>
    </div>
  );
}

export function DashboardTab() {
  const { feed, feedStatus, focus, focusSet, openTab, openTicker } = useWorkspace();
  const summary = useToday();
  const nothingCleared = useNothingCleared();
  const portfolioEmpty = usePortfolioEmptyTitle();
  const exposure = useMemo(() => exposureByTicker(feed, focus), [feed, focus]);
  // Today lists only cards with evidence behind them; the rest sit under "Watching" in the sidebar.
  const listed = useMemo(() => sortByTime(feed?.cards ?? []).filter((c) => cardStrength(c).level !== "watching"), [feed]);
  const latest = listed.slice(0, 6);
  const seeds = useMemo(() => {
    const own = focus.map((f) => f.ticker);
    return own.length ? own : Array.from(new Set((feed?.cards ?? []).map((c) => c.event.ticker))).slice(0, 4);
  }, [feed, focus]);
  const mini = useMemo(() => buildGraph(feed, null, seeds, { maxDepth: 1, maxNodes: 28 }), [feed, seeds]);

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-7 py-6">
      <FeedNotice />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
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

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section>
          <SectionTitle count={summary.portfolio.length}>Hitting your portfolio</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {summary.portfolio.length ? (
              summary.portfolio.slice(0, 3).map((card) => <SightingCard key={card.id} card={card} highlight={focusSet} maxHits={4} />)
            ) : (
              <EmptyState title={portfolioEmpty} />
            )}
          </div>
        </section>
        <section>
          <SectionTitle count={summary.opportunities.length}>Opportunities</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {summary.opportunities.length ? (
              summary.opportunities.slice(0, 2).map((card) => <SightingCard key={card.id} card={card} maxHits={4} />)
            ) : (
              <EmptyState title={feedEmpty(feedStatus, nothingCleared ? NOTHING_CLEARED : "No opportunities right now")} />
            )}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-5 pb-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
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
                <EmptyState title={feedEmpty(feedStatus, nothingCleared ? NOTHING_CLEARED : "No sightings yet")} />
              </div>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}

function LatestRow({ cardId }: { cardId: string }) {
  const { feed } = useWorkspace();
  const card = feed?.cards.find((c) => c.id === cardId);
  if (!card) return null;
  return <LatestRowView card={card} />;
}

function LatestRowView({ card }: { card: RippleCard }) {
  const { openSighting, focusSet } = useWorkspace();
  const ex = useExplain(card);
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
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-[#1d1b1b]">{ex.title}</span>
          <span className="block truncate text-[11.5px] text-[#9a9a9a]">{ex.kicker}</span>
        </span>
        <span className="flex items-center gap-3 whitespace-nowrap text-[12px] text-[#9a9a9a]">
          {mine ? <span className="text-[#4b4b48]">{mine} on your list</span> : null}
          <StrengthBadge strength={ex.strength} />
          <span className="w-14 text-right">{timeAgo(card.event.occurredAt)}</span>
        </span>
      </button>
    </li>
  );
}
