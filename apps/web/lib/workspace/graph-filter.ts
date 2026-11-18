import type { SightingsFeed } from "@falcon/ripple";
import { ivByTicker, type OptionsAll, type OptionsCompact } from "../options-api";
import { buildTodaySummary } from "./feed";
import type { GraphAll } from "./graph";

/**
 * Narrowing the whole-market graph (GET /api/graph?all=1) by the Graph tab's
 * filter bar. Pure; the bar itself is app/app/_components/graph-filters.tsx.
 *
 * AND across filters, OR within one filter's values.
 *  - Relation, Strength: which links are kept.
 *  - Size, Sector, and "is not" on Portfolio / Opportunities: which
 *    companies are kept (a link needs both ends).
 *  - Company, and "is" on Portfolio / Opportunities / Implied vol: those
 *    companies and their direct neighbours (over the links still kept).
 *  - A company left with no links is hidden, unless picked under Company
 *    (a picked company also ignores Size, Sector and "is not").
 *  - While an Implied vol filter is on, each company's sub-label adds its
 *    ATM IV and 5-session implied move.
 */

export type GraphFilter = { id: string; field: string; operator: string; values: string[] };

/** What the filters read besides the graph: the portfolio, today's Sightings and the universe's options data. */
export type GraphFilterContext = {
  /** The portfolio's tickers (the field keeps the old "focus" name). */
  focus: ReadonlySet<string>;
  /** Tickers listed under Opportunities today (the Dashboard's list). */
  opportunities: ReadonlySet<string>;
  /** ATM implied vol (vol points) by ticker for the whole universe (GET /api/options?all=1); empty when this viewer gets none. */
  iv: ReadonlyMap<string, number>;
  /** Session date of that data (YYYY-MM-DD), null without it. */
  ivAsOf: string | null;
  /** The compact options numbers by ticker, for the sub-labels. */
  options: Readonly<Record<string, OptionsCompact>>;
};

export type ForceNode = { id: string; name: string; focus?: boolean; size?: number };
export type FilteredGraph = { nodes: ForceNode[]; edges: { source: string; target: string; strength?: number }[] };

/**
 * Portfolio and Opportunities from the feed the Workspace already has;
 * implied vol from the whole universe's options data (null while it loads,
 * or for a viewer /api/options gives none: OPTIONS_DISPLAY).
 */
export function graphFilterContext(feed: SightingsFeed | null, portfolioTickers: readonly string[], options: OptionsAll | null = null): GraphFilterContext {
  const opportunities = new Set<string>();
  for (const card of buildTodaySummary(feed, portfolioTickers).opportunities) for (const h of card.hits) opportunities.add(h.ticker.toUpperCase());
  const iv = new Map<string, number>();
  if (options) ivByTicker(options).forEach((value, t) => Number.isFinite(value) && value > 0 && iv.set(t.toUpperCase(), value));
  return {
    focus: new Set(Array.from(portfolioTickers, (t) => t.toUpperCase())),
    opportunities,
    iv,
    ivAsOf: iv.size ? (options?.asOf ?? null) : null,
    options: iv.size && options ? options.tickers : {},
  };
}

/** "Apple Inc · IV 24% · ±3.1% in 5 days" when the ticker has options data. */
function ivSubLabel(name: string, o: OptionsCompact | undefined): string {
  if (!o) return name;
  const move = typeof o.im5 === "number" ? ` · ±${o.im5.toFixed(1)}% in 5 days` : "";
  return `${name} · IV ${Math.round(o.atmIv)}%${move}`;
}

/** Nearest-rank percentile of `values` (sorted ascending), p in 0..100. */
function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** "High" is the top quarter of the names with IV on the data's date, "very high" the top tenth (over the whole universe). */
export function ivCuts(iv: ReadonlyMap<string, number>): { high: number; veryHigh: number; count: number } {
  const sorted = Array.from(iv.values()).sort((a, b) => a - b);
  return { high: percentile(sorted, 75), veryHigh: percentile(sorted, 90), count: sorted.length };
}

/** Values of the Implied vol filter: "high", "very_high", "any", or "ge<N>" (IV at least N vol points). */
export const IV_LEVELS = [40, 60, 80, 100];

function ivMatch(value: number, option: string, cuts: ReturnType<typeof ivCuts>): boolean {
  if (option === "any") return true;
  if (option === "high") return value >= cuts.high;
  if (option === "very_high") return value >= cuts.veryHigh;
  const ge = /^ge(\d+)$/.exec(option);
  return ge ? value >= Number(ge[1]) : false;
}

/** The whole graph narrowed by `filters`; null when no filter has a value (draw everything). */
export function applyGraphFilters(whole: GraphAll, filters: readonly GraphFilter[], ctx: GraphFilterContext): FilteredGraph | null {
  const active = filters.filter((f) => f.values.length);
  if (!active.length) return null;

  const n = whole.n;
  const relations: Set<number>[] = [];
  const strengths: Set<number>[] = [];
  const anchors: Set<string>[] = [];
  const drops: ReadonlySet<string>[] = [];
  const sectorsIn: Set<string>[] = [];
  const sectorsOut: Set<string>[] = [];
  const picked = new Set<string>();
  let minLinks = 0;
  const cuts = ivCuts(ctx.iv);
  const ivOn = active.some((f) => f.field === "iv");

  for (const f of active) {
    switch (f.field) {
      case "relation":
        relations.push(new Set(f.values.map(Number)));
        break;
      case "strength":
        strengths.push(new Set(f.values.map(Number)));
        break;
      case "size":
        for (const v of f.values) minLinks = Math.max(minLinks, Number(v) || 0);
        break;
      case "company":
        anchors.push(new Set(f.values));
        for (const t of f.values) picked.add(t);
        break;
      case "focus":
      case "opportunity": {
        const set = f.field === "focus" ? ctx.focus : ctx.opportunities;
        if (f.operator === "is_not") drops.push(set);
        else anchors.push(new Set(set));
        break;
      }
      case "iv": {
        const set = new Set<string>();
        ctx.iv.forEach((value, t) => {
          if (f.values.some((o) => ivMatch(value, o, cuts))) set.add(t);
        });
        anchors.push(set);
        break;
      }
      case "sector":
        (f.operator === "is_not_any" ? sectorsOut : sectorsIn).push(new Set(f.values));
        break;
    }
  }

  // Companies the node filters keep; picked companies always stay.
  const keepNode = n.map(([t, , degree, sector = ""]) => {
    if (picked.has(t)) return true;
    if (degree < minLinks) return false;
    if (drops.some((d) => d.has(t))) return false;
    if (sectorsIn.some((s) => !s.has(sector))) return false;
    if (sectorsOut.some((s) => s.has(sector))) return false;
    return true;
  });
  let edges = whole.e.filter(
    ([s, t, rel, strength]) => keepNode[s] && keepNode[t] && relations.every((r) => r.has(rel)) && strengths.every((r) => r.has(strength)),
  );

  // Each anchor keeps its companies and their direct neighbours; AND across anchors.
  let shown: Set<number> | null = null;
  for (const anchor of anchors) {
    const ring = new Set<number>();
    n.forEach(([t], i) => {
      if (anchor.has(t) && keepNode[i]) ring.add(i);
    });
    for (const [s, t] of edges) {
      if (anchor.has(n[s][0])) ring.add(t);
      if (anchor.has(n[t][0])) ring.add(s);
    }
    const prev: Set<number> | null = shown;
    if (prev) ring.forEach((i) => !prev.has(i) && ring.delete(i));
    shown = ring;
  }
  if (shown) {
    const inside: Set<number> = shown;
    edges = edges.filter(([s, t]) => inside.has(s) && inside.has(t));
  }

  const linked = new Set<number>();
  for (const [s, t] of edges) {
    linked.add(s);
    linked.add(t);
  }
  const nodes: ForceNode[] = [];
  n.forEach(([id, name, degree], i) => {
    if (linked.has(i) || (picked.has(id) && (!shown || shown.has(i))))
      nodes.push({ id, name: ivOn ? ivSubLabel(name || id, ctx.options[id]) : name, focus: ctx.focus.has(id), size: degree });
  });
  return {
    nodes,
    edges: edges.map(([s, t, , strength]) => ({ source: n[s][0], target: n[t][0], strength })),
  };
}
