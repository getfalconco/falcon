/**
 * Read-through radar: which linked companies of the reader's names report
 * soon or just did, and in what order to show them.
 *
 *   pairs     every filing-backed link (shared/earnings-links: an SEC
 *             address, the quote, the accession number, confidence 0.8 and
 *             up, critical or important) between one of the reader's names
 *             (H) and another listed company (C), where the filing calls C
 *             H's supplier, customer or competitor. A link in C's own filing
 *             is read from H's side: H named as C's supplier makes C H's
 *             customer. One pair per C and H: critical before important,
 *             then the more confident.
 *   weight    held: 0.5 plus the position's share of the held value (shares
 *             x last close); watchlist only: 0.25. The account's mix moves
 *             the order without hiding a watched name.
 *   score     sensitivity (event-study.ts) x weight. Pairs without figures
 *             (fewer than three reports measured) score 0 and come after
 *             every measured pair.
 *   order     score, then the nearer report date (upcoming soonest first,
 *             recent latest first), then the tickers.
 *
 * Pure.
 */

import { indexLinks, type LinkEdge } from "../../shared/earnings-links";
import type { ReadthroughRelation, ReadthroughRow } from "../../shared/readthrough-types";

export type Pair = {
  counterparty: string;
  holding: string;
  relation: ReadthroughRelation;
  tier: "critical" | "important";
  confidence: number;
  namedBy: string;
  form: "10-K" | "20-F" | null;
  filingDate: string | null;
  sourceUrl: string | null;
};

const INVERSE: Record<ReadthroughRelation, ReadthroughRelation> = {
  supplier: "customer",
  customer: "supplier",
  competitor: "competitor",
};

function relationOf(category: unknown): ReadthroughRelation | null {
  return category === "supplier" || category === "customer" || category === "competitor" ? category : null;
}

/** The pairs for the reader's names, closest links first (held, critical, more confident). */
export function pairsFor(
  edges: readonly LinkEdge[],
  names: ReadonlyMap<string, { held: boolean }>,
  formOf: (filer: string) => "10-K" | "20-F" | null = () => null,
): Pair[] {
  const index = indexLinks(edges);
  const best = new Map<string, Pair>();
  for (const holding of names.keys()) {
    for (const e of index.get(holding) ?? []) {
      const root = e.root_ticker!.trim().toUpperCase();
      const named = e.counterparty_ticker!.trim().toUpperCase();
      const category = relationOf(e.category);
      if (!category) continue;
      const counterparty = root === holding ? named : root;
      if (counterparty === holding) continue;
      const relation = root === holding ? category : INVERSE[category];
      const pair: Pair = {
        counterparty,
        holding,
        relation,
        tier: e.strength_tier === "critical" ? "critical" : "important",
        confidence: typeof e.confidence === "number" ? e.confidence : 0,
        namedBy: root,
        form: e.form === "10-K" || e.form === "20-F" ? e.form : formOf(root),
        filingDate: typeof e.filing_date === "string" ? e.filing_date : null,
        sourceUrl: typeof e.source_url === "string" ? e.source_url : null,
      };
      const key = `${counterparty}>${holding}`;
      const known = best.get(key);
      if (!known || closer(pair, known, names) < 0) best.set(key, pair);
    }
  }
  return [...best.values()].sort((a, b) => closer(a, b, names));
}

function closer(a: Pair, b: Pair, names: ReadonlyMap<string, { held: boolean }>): number {
  const ha = names.get(a.holding)?.held ? 0 : 1;
  const hb = names.get(b.holding)?.held ? 0 : 1;
  if (ha !== hb) return ha - hb;
  const ta = a.tier === "critical" ? 0 : 1;
  const tb = b.tier === "critical" ? 0 : 1;
  if (ta !== tb) return ta - tb;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.counterparty.localeCompare(b.counterparty) || a.holding.localeCompare(b.holding);
}

/**
 * The closest pairs whose counterparties fit in `maxCounterparties`, in the
 * order given; `truncated` when some were dropped.
 */
export function capPairs(pairs: readonly Pair[], maxCounterparties: number): { pairs: Pair[]; truncated: boolean } {
  const kept = new Set<string>();
  const out: Pair[] = [];
  let truncated = false;
  for (const p of pairs) {
    if (!kept.has(p.counterparty)) {
      if (kept.size >= maxCounterparties) {
        truncated = true;
        continue;
      }
      kept.add(p.counterparty);
    }
    out.push(p);
  }
  return { pairs: out, truncated };
}

export const HELD_BASE_WEIGHT = 0.5;
export const WATCH_WEIGHT = 0.25;

/**
 * Each held name's weight: 0.5 plus its share of the held value. A position
 * whose value cannot be read (no share count, no close) counts as an equal
 * share of what is left after the valued ones; with no value at all, every
 * held name shares equally.
 */
export function accountWeights(
  held: ReadonlyArray<{ ticker: string; shares: number | null }>,
  lastClose: (ticker: string) => number | null,
): Map<string, number> {
  const values = held.map((h) => {
    const close = lastClose(h.ticker);
    return h.shares !== null && h.shares > 0 && close !== null && close > 0 ? h.shares * close : null;
  });
  const valued = values.filter((v): v is number => v !== null);
  const total = valued.reduce((a, b) => a + b, 0);
  const n = held.length;
  const out = new Map<string, number>();
  held.forEach((h, i) => {
    const v = values[i];
    // Valued positions split their part of the book by value; an unvalued one takes an even slice.
    const share = total > 0 && v !== null && v !== undefined ? (v / total) * (valued.length / n) : 1 / n;
    out.set(h.ticker, Math.round((HELD_BASE_WEIGHT + share) * 1000) / 1000);
  });
  return out;
}

export function weightOf(holding: string, weights: ReadonlyMap<string, number>): number {
  return weights.get(holding) ?? WATCH_WEIGHT;
}

export function scoreOf(row: Pick<ReadthroughRow, "stats" | "weight">): number {
  const s = row.stats?.sensitivity ?? null;
  return s === null ? 0 : Math.round(s * row.weight * 1000) / 1000;
}

const KIND_ORDER = { upcoming: 0, recent: 1, later: 2 } as const;

/** The radar's order (see the header). `today` decides "nearer". */
export function rankRows(rows: readonly ReadthroughRow[], today: string): ReadthroughRow[] {
  const distance = (r: ReadthroughRow): number => {
    if (!r.date) return Number.MAX_SAFE_INTEGER;
    const days = Math.round((Date.parse(`${r.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    return Math.abs(days);
  };
  return [...rows].sort((a, b) => {
    const ma = a.stats ? 0 : 1;
    const mb = b.stats ? 0 : 1;
    if (ma !== mb) return ma - mb;
    if (a.score !== b.score) return b.score - a.score;
    const da = distance(a);
    const db = distance(b);
    if (da !== db) return da - db;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.counterparty.localeCompare(b.counterparty) || a.holding.localeCompare(b.holding);
  });
}
