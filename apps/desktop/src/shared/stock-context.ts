/**
 * The Stock tab header's line for a company the reader does not hold: which
 * of their holdings stand one hop from it in the filing graph.
 *
 *   stock:context  { ticker, held: string[] }  -> StockContextResult
 *
 * A hop is a filing-backed link (shared/earnings-links.ts `isFilingBacked`:
 * an SEC address, the quote and the accession number), in either direction:
 * the company's own 10-K or 20-F naming the holding, or the holding's filing
 * naming the company. One entry per holding, the strongest link first
 * (critical, then important, then the rest; the more confident on a tie).
 *
 * Pure.
 */

import { isFilingBacked, type LinkEdge } from "./earnings-links";

export type StockContextLink = {
  /** The holding. */
  ticker: string;
  /** supplier, customer, partner, competitor, dependency, or another word the extraction used. */
  category: string;
  /** Whose filing names the other. */
  namedBy: string;
  /** The company that filing names. */
  named: string;
  form: "10-K" | "20-F" | null;
  filingDate: string | null;
};

export type StockContextRequest = { ticker: string; held: string[] };
export type StockContextResult = { ok: true; links: StockContextLink[] } | { ok: false; error: "invalid_request" | "unavailable" };

/** Most holdings named in the line. */
export const CONTEXT_MAX_LINKS = 12;
/** Most held tickers a request may carry. */
export const CONTEXT_MAX_HELD = 500;

const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

function cleanTicker(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  return TICKER.test(t) ? t : null;
}

export function parseStockContextRequest(raw: unknown): StockContextRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { ticker?: unknown; held?: unknown };
  const ticker = cleanTicker(r.ticker);
  if (!ticker || !Array.isArray(r.held) || r.held.length > CONTEXT_MAX_HELD) return null;
  const held: string[] = [];
  for (const h of r.held) {
    const t = cleanTicker(h);
    if (t && !held.includes(t)) held.push(t);
  }
  return { ticker, held };
}

const TIER_RANK: Record<string, number> = { critical: 0, important: 1 };

/** The reader's holdings one filing-backed hop from `ticker`, strongest link first. */
export function holdingsOneHop(
  edges: readonly LinkEdge[],
  ticker: string,
  held: readonly string[],
  formOf: (filer: string) => "10-K" | "20-F" | null = () => null,
): StockContextLink[] {
  const self = ticker.trim().toUpperCase();
  const mine = new Set(held.map((h) => h.trim().toUpperCase()).filter((h) => h && h !== self));
  if (!self || mine.size === 0) return [];
  const best = new Map<string, { link: StockContextLink; rank: number; confidence: number }>();
  for (const e of edges) {
    const root = e.root_ticker?.trim().toUpperCase();
    const named = e.counterparty_ticker?.trim().toUpperCase();
    if (!root || !named || root === named) continue;
    if (root !== self && named !== self) continue;
    const other = root === self ? named : root;
    if (!mine.has(other) || !isFilingBacked(e)) continue;
    const rank = TIER_RANK[e.strength_tier ?? ""] ?? 2;
    const confidence = typeof e.confidence === "number" && Number.isFinite(e.confidence) ? e.confidence : 0;
    const known = best.get(other);
    if (known && (known.rank < rank || (known.rank === rank && known.confidence >= confidence))) continue;
    best.set(other, {
      rank,
      confidence,
      link: {
        ticker: other,
        category: typeof e.category === "string" && e.category.trim() ? e.category.trim().toLowerCase() : "related",
        namedBy: root,
        named,
        form: e.form === "10-K" || e.form === "20-F" ? e.form : formOf(root),
        filingDate: typeof e.filing_date === "string" ? e.filing_date : null,
      },
    });
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank || b.confidence - a.confidence || a.link.ticker.localeCompare(b.link.ticker))
    .slice(0, CONTEXT_MAX_LINKS)
    .map((x) => x.link);
}
