/**
 * Point-in-time filing links: when each link was first stated in the filer's
 * annual reports (packages/engine/data/graph-pit.json, made by the engine's
 * scripts/graph-history.ts; split per ticker by scripts/graph-shards.mjs into
 * data/graph/_pit/<TICKER>.json and data/graph/_pit/_all.json).
 *
 * A link is known on date t when its first report was filed on or before t.
 * It counts as possibly ended on t when a later annual report, filed on or
 * before t, no longer names it (`endedAt <= t`). Backtests of ripples and
 * links must use only the links known on the event date.
 *
 * Pure and client-safe.
 */

/** One link in a per-ticker point-in-time shard: the live shard's fields, evidence from its FIRST report. */
export type PitShardEdge = {
  from: string;
  to: string;
  category: string;
  /** Tier in the latest report naming it. */
  tier: string;
  /** Always null here: a share is read per report and today's need not hold on a past date. */
  disclosedSharePct: number | null;
  /** Quote, form, date and URL of the first report naming it. */
  quote: string;
  form: string;
  filedAt: string;
  url: string;
  firstSeen: string;
  firstAccession: string;
  lastSeen: string;
  /** Filing date of the first later original annual report that no longer names it; null while still named. */
  endedAt: string | null;
  seenIn: number;
  checkedIn: number;
  /** "history": every annual report since 2014 was read; "source": only the edge's own (recent) report. */
  basis: "history" | "source";
  /** In today's graph. */
  current: boolean;
};

/**
 * The whole point-in-time graph, compact (data/graph/_pit/_all.json):
 * `t` tickers; `e` [from index, to index, relation (0 supplier, 1 customer,
 * 2 competitor, 3 partner), strength (3 critical, 2 important, 1 marginal),
 * firstSeen, lastSeen, endedAt or "", current 1/0, seenIn, checkedIn, basis (1 history, 0 source)].
 */
export type PitAll = {
  generatedAt: string;
  since: string;
  t: string[];
  e: [number, number, number, number, string, string, string, number, number, number, number][];
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An as-of date: "2018-06-30", "2018-06" (its last day) or "2018" (31 December). Null for
 * anything else or an impossible date. Pure.
 */
export function parseAsOf(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  let y: number;
  let m: number;
  let d: number;
  const full = DAY.exec(s);
  if (full) {
    [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
  } else if (/^\d{4}-\d{2}$/.test(s)) {
    [y, m] = s.split("-").map(Number) as [number, number];
    d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  } else if (/^\d{4}$/.test(s)) {
    [y, m, d] = [Number(s), 12, 31];
  } else return null;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Whether a link was known on `asOf` (first report filed on or before it) and, unless `includeEnded`, not yet dropped. Pure. */
export function knownAsOf(e: { firstSeen: string; endedAt: string | null }, asOf: string, includeEnded = false): boolean {
  return e.firstSeen <= asOf && (includeEnded || !e.endedAt || e.endedAt > asOf);
}
