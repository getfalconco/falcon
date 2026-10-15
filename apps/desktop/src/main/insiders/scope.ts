/**
 * Which companies the Insider activity card reads: the reader's positions,
 * their watchlist, and the companies one filing link away from those.
 *
 * A link is one the read-through and earnings views already trust
 * (shared/earnings-links `indexLinks`: an SEC address, the quote, the
 * accession number, confidence 0.8 and up, critical or important), naming a
 * supplier, customer or competitor. It is read from the reader's side: NVDA's
 * 10-K naming TSM a supplier, or TSM's 20-F naming NVDA a customer, both make
 * TSM "supplier of NVDA".
 *
 * Per reader name at most `perName` linked companies (critical first, then
 * the more confident), and at most `maxLinked` in all, held names' links
 * before watched names'. A company the reader holds or watches is never also
 * listed as linked.
 *
 * Pure.
 */

import { indexLinks, type LinkEdge } from "../../shared/earnings-links";
import type { InsiderRelation, InsiderScope, InsiderVia } from "../../shared/insider-types";

export const LINKED_PER_NAME = 3;
export const MAX_LINKED = 30;

export type ScopeEntry = { ticker: string; scope: InsiderScope; via: InsiderVia | null };

const INVERSE: Record<InsiderRelation, InsiderRelation> = { supplier: "customer", customer: "supplier", competitor: "competitor" };

function relationOf(category: unknown): InsiderRelation | null {
  return category === "supplier" || category === "customer" || category === "competitor" ? category : null;
}

/** Held, then watched, then linked; each company once. */
export function buildScope(
  held: readonly string[],
  watchlist: readonly string[],
  edges: readonly LinkEdge[],
  { perName = LINKED_PER_NAME, maxLinked = MAX_LINKED }: { perName?: number; maxLinked?: number } = {},
): ScopeEntry[] {
  const out: ScopeEntry[] = [];
  const seen = new Set<string>();
  for (const t of held) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ ticker: t, scope: "held", via: null });
  }
  for (const t of watchlist) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ ticker: t, scope: "watchlist", via: null });
  }
  const own = [...out];
  const index = indexLinks(edges);
  let linked = 0;
  for (const name of own) {
    if (linked >= maxLinked) break;
    const candidates = new Map<string, { via: InsiderVia; confidence: number }>();
    for (const e of index.get(name.ticker) ?? []) {
      const root = e.root_ticker!.trim().toUpperCase();
      const named = e.counterparty_ticker!.trim().toUpperCase();
      const category = relationOf(e.category);
      if (!category) continue;
      const other = root === name.ticker ? named : root;
      if (other === name.ticker || seen.has(other)) continue;
      const via: InsiderVia = {
        holding: name.ticker,
        // The other company's role for the reader's name, read from whichever filing states it.
        relation: root === name.ticker ? category : INVERSE[category],
        tier: e.strength_tier === "critical" ? "critical" : "important",
        namedBy: root,
        sourceUrl: typeof e.source_url === "string" ? e.source_url : null,
      };
      const confidence = typeof e.confidence === "number" ? e.confidence : 0;
      const known = candidates.get(other);
      const better = !known || (via.tier === "critical" && known.via.tier !== "critical") || (via.tier === known.via.tier && confidence > known.confidence);
      if (better) candidates.set(other, { via, confidence });
    }
    const ranked = [...candidates.entries()].sort(
      ([ta, a], [tb, b]) => Number(b.via.tier === "critical") - Number(a.via.tier === "critical") || b.confidence - a.confidence || ta.localeCompare(tb),
    );
    for (const [ticker, { via }] of ranked.slice(0, perName)) {
      if (linked >= maxLinked) break;
      seen.add(ticker);
      out.push({ ticker, scope: "linked", via });
      linked++;
    }
  }
  return out;
}
