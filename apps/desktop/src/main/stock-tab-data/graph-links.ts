/**
 * The filing-graph links the Stock tab reads: the companies one hop from a
 * stock (for the lead reports) and its competitors.
 *
 * Only links a filing carries count (shared/earnings-links `isFilingBacked`:
 * an SEC address, the quote, the accession number), with the extraction's
 * confidence at 0.8 or more. One entry per company, the strongest link kept:
 * critical before important before marginal, then the more confident.
 *
 * Pure.
 */

import { LINK_MIN_CONFIDENCE, isFilingBacked, type LinkEdge } from "../../shared/earnings-links";

export const MAX_LINKED = 8;
export const MAX_COMPETITORS = 6;

export type GraphLink = {
  ticker: string;
  name: string | null;
  category: string;
  /** "names": the stock's filing names the other; "named": the other's filing names the stock. */
  direction: "names" | "named";
  tier: string | null;
  confidence: number;
  filingUrl: string | null;
};

const TIER_RANK: Readonly<Record<string, number>> = { critical: 0, important: 1, marginal: 2 };

export function linksAround(edges: ReadonlyArray<LinkEdge & { counterparty_name?: string }>, ticker: string, category?: string): GraphLink[] {
  const self = ticker.toUpperCase();
  const best = new Map<string, GraphLink>();
  const rank = (l: GraphLink) => [TIER_RANK[l.tier ?? ""] ?? 3, -l.confidence] as const;
  for (const e of edges) {
    const root = e.root_ticker?.trim().toUpperCase();
    const named = e.counterparty_ticker?.trim().toUpperCase();
    if (!root || !named || root === named || (root !== self && named !== self)) continue;
    if (category && e.category !== category) continue;
    if (!isFilingBacked(e) || typeof e.confidence !== "number" || !(e.confidence >= LINK_MIN_CONFIDENCE)) continue;
    const direction: "names" | "named" = root === self ? "names" : "named";
    const other = direction === "names" ? named : root;
    const link: GraphLink = {
      ticker: other,
      name: direction === "names" ? (e.counterparty_name?.trim() || null) : null,
      category: (e.category ?? "related").replace(/_/g, " "),
      direction,
      tier: e.strength_tier ?? null,
      confidence: e.confidence,
      filingUrl: e.source_url ?? null,
    };
    const prev = best.get(other);
    if (!prev) {
      best.set(other, link);
      continue;
    }
    const [a0, a1] = rank(link);
    const [b0, b1] = rank(prev);
    if (a0 < b0 || (a0 === b0 && a1 < b1)) best.set(other, { ...link, name: link.name ?? prev.name });
  }
  return [...best.values()].sort((a, b) => {
    const [a0, a1] = rank(a);
    const [b0, b1] = rank(b);
    return a0 - b0 || a1 - b1 || a.ticker.localeCompare(b.ticker);
  });
}
