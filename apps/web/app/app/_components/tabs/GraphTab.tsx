"use client";

import { useMemo } from "react";
import { FilterBar } from "@/components/ui/filter-token-bar";
import { buildGraph } from "@/lib/workspace/graph";
import { useOptionsAll, useWholeGraph } from "@/lib/workspace/graph-api";
import { applyGraphFilters, graphFilterContext } from "@/lib/workspace/graph-filter";
import { useWorkspace } from "../context";
import { GraphView, type ForceGraph } from "../GraphView";
import { useGraphFilterFields, useGraphFilters } from "../graph-filters";
import { EmptyState } from "../parts";
import { AskFalconButton } from "../lab/AskFalconButton";

export function useSeeds() {
  const { feed, portfolio } = useWorkspace();
  return useMemo(() => {
    const own = portfolio.map((f) => f.ticker);
    return own.length ? own : Array.from(new Set((feed?.cards ?? []).map((c) => c.event.ticker))).slice(0, 6);
  }, [feed, portfolio]);
}

/**
 * Every listed company and every filing link between them, like Obsidian's
 * graph of a whole vault (GET /api/graph?all=1). Portfolio companies are only
 * a slightly brighter dot. Without the whole graph it falls back to what the
 * Sightings feed links to the portfolio. The filter bar narrows the whole
 * graph (lib/workspace/graph-filter.ts); it is saved per workspace for the
 * browser session. Implied vol covers every ticker priced by the daily
 * options job (GET /api/options?all=1).
 */
export function GraphTab() {
  const { feed, feedStatus, openTicker, portfolio, portfolioSet, userId } = useWorkspace();
  const whole = useWholeGraph();
  const seeds = useSeeds();
  const [saved, setFilters] = useGraphFilters(userId);
  const options = useOptionsAll();
  const ctx = useMemo(() => graphFilterContext(feed, portfolio.map((f) => f.ticker), options), [feed, portfolio, options]);
  const fields = useGraphFilterFields(whole, ctx);
  // A saved filter whose field is not offered now (Implied vol without options data) is left out.
  const filters = useMemo(() => saved.filter((f) => fields.some((d) => d.id === f.field)), [saved, fields]);
  // One company picked (by the member or by Falcon AI's show_in_graph): highlighted, with an "Ask Falcon AI" button.
  const picked = filters.find((f) => f.field === "company" && f.values.length === 1)?.values[0];

  const full: ForceGraph | null = useMemo(() => {
    if (whole) {
      return {
        nodes: whole.n.map(([id, name]) => ({ id, name, focus: portfolioSet.has(id) })),
        edges: whole.e.map(([s, t, , strength]) => ({ source: whole.n[s][0], target: whole.n[t][0], strength })),
      };
    }
    if (whole === null) return buildGraph(feed, null, seeds, { maxDepth: 2 });
    return null;
  }, [feed, portfolioSet, seeds, whole]);

  const filtered = useMemo(() => (whole ? applyGraphFilters(whole, filters, ctx) : null), [whole, filters, ctx]);
  const graph = filtered ?? full;
  const noMatch = !!filtered && filtered.nodes.length === 0;

  return (
    <div className="relative h-full min-h-0 bg-surface">
      {graph === null || graph.edges.length || filtered ? (
        <>
          <GraphView
            graph={graph ?? EMPTY}
            onOpen={openTicker}
            highlight={picked}
            ariaLabel="Graph of every company and its filing links"
            controlsTop={GRAPH_TITLE_CLEARANCE}
            toolbarBottom
            settings={false}
            toolbar={
              whole ? (
                <FilterBar fields={fields} value={filters} onChange={setFilters} aria-label="Graph filters" className="[&>*]:pointer-events-auto" />
              ) : null
            }
          />
          {picked ? (
            <div className="absolute bottom-14 left-3">
              <AskFalconButton label={`Ask Falcon AI about ${picked}`} prompt={`${picked} in the graph: what are its most important links, and what do they mean for it?`} />
            </div>
          ) : null}
          {noMatch ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
              <p className="text-fs-13 text-quiet">No companies match these filters.</p>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex h-full items-center justify-center p-8">
          <div className="w-[360px]">
            <EmptyState title={feedStatus === "loading" ? "Loading" : "The graph is not available"} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The Graph title floats over the canvas (Workspace renders its header as an overlay); controls sit below it. */
const GRAPH_TITLE_CLEARANCE = 80;

const EMPTY: ForceGraph = { nodes: [], edges: [] };
