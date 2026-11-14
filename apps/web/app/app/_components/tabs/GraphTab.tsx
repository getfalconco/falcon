"use client";

import { useMemo, useState } from "react";
import type { Relation } from "@falcon/ripple";
import { RELATIONS, relationLabel } from "@/lib/workspace/feed";
import { buildGraph, graphFacets, type GraphFilter } from "@/lib/workspace/graph";
import { useGraphNeighborhood } from "@/lib/workspace/graph-api";
import { useWorkspace } from "../context";
import { GraphView, relationColor } from "../GraphView";
import { EmptyState, MONO } from "../parts";
import { FeedNotice } from "../FeedNotice";

function Toggle({ on, onClick, children, swatch }: { on: boolean; onClick: () => void; children: React.ReactNode; swatch?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] outline-none transition-colors focus-visible:border-black/50 ${
        on ? "border-black/25 bg-white text-[#1d1b1b]" : "border-black/[0.08] bg-transparent text-[#9a9a9a] hover:text-[#4b4b48]"
      }`}
    >
      {swatch ? <span className="h-[2px] w-3 rounded-full" style={{ background: on ? swatch : "rgba(0,0,0,0.2)" }} aria-hidden /> : null}
      {children}
    </button>
  );
}

/** Toggle `value` in a set where null means "all". */
function toggleIn<T>(current: Set<T> | null, value: T, all: readonly T[]): Set<T> | null {
  const next = new Set(current ?? all);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next.size === all.length ? null : next;
}

export function useSeeds() {
  const { feed, focus } = useWorkspace();
  return useMemo(() => {
    const own = focus.map((f) => f.ticker);
    return own.length ? own : Array.from(new Set((feed?.cards ?? []).map((c) => c.event.ticker))).slice(0, 6);
  }, [feed, focus]);
}

export function GraphTab() {
  const { feed, feedStatus, openTicker, focus } = useWorkspace();
  const seeds = useSeeds();
  const extra = useGraphNeighborhood(seeds, 2);
  const [sectors, setSectors] = useState<Set<string> | null>(null);
  const [relations, setRelations] = useState<Set<Relation> | null>(null);
  const [depth, setDepth] = useState<1 | 2>(2);

  const full = useMemo(() => buildGraph(feed, extra, seeds, { maxDepth: depth }), [feed, extra, seeds, depth]);
  const facets = useMemo(() => graphFacets(full), [full]);
  const filter: GraphFilter = useMemo(() => ({ sectors, relations }), [sectors, relations]);
  const graph = useMemo(
    () => (sectors || relations ? buildGraph(feed, extra, seeds, { maxDepth: depth, filter }) : full),
    [depth, extra, feed, filter, full, relations, sectors, seeds],
  );
  const relationOptions = RELATIONS.filter((r) => facets.relations.includes(r));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-black/[0.06] px-5 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/40" style={{ fontFamily: MONO }}>
            Degrees
          </span>
          <Toggle on={depth === 1} onClick={() => setDepth(1)}>
            1
          </Toggle>
          <Toggle on={depth === 2} onClick={() => setDepth(2)}>
            2
          </Toggle>
        </div>
        {relationOptions.length ? (
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/40" style={{ fontFamily: MONO }}>
              Relation
            </span>
            {relationOptions.map((r) => (
              <Toggle key={r} on={!relations || relations.has(r)} onClick={() => setRelations((c) => toggleIn(c, r, relationOptions))} swatch={relationColor(r)}>
                {relationLabel(r)}
              </Toggle>
            ))}
          </div>
        ) : null}
        {facets.sectors.length > 1 ? (
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/40" style={{ fontFamily: MONO }}>
              Sector
            </span>
            {facets.sectors.map((s) => (
              <Toggle key={s} on={!sectors || sectors.has(s)} onClick={() => setSectors((c) => toggleIn(c, s, facets.sectors))}>
                {s}
              </Toggle>
            ))}
          </div>
        ) : null}
        <span className="ml-auto text-[12px] tabular-nums text-[#9a9a9a]">
          {graph.nodes.length} companies · {graph.edges.length} links
        </span>
      </div>
      <div className="px-5 pt-3 empty:hidden">
        <FeedNotice />
      </div>
      <div className="relative min-h-0 flex-1">
        {graph.edges.length ? (
          <GraphView graph={graph} onOpen={openTicker} ring={150} ariaLabel="Connections of your focus list" />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <div className="w-[360px]">
              <EmptyState
                title={
                  feedStatus === "loading"
                    ? "Loading"
                    : sectors || relations
                      ? "No links match these filters"
                      : focus.length
                        ? "No connections for your focus list yet"
                        : "Your focus list is empty"
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
