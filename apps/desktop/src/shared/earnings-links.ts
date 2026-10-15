/**
 * Earnings: which of the reader's names a report reads through to.
 *
 * A link is a filing naming one company as another's supplier, customer,
 * partner, competitor or dependency, in either direction: the reporting
 * company's own 10-K or 20-F naming the reader's company, or the reader's
 * company's filing naming the reporting one. Only links a filing carries are
 * kept (an SEC address, the quote and the accession number), the extraction
 * has to be confident in them (0.8 and up), and the filing has to say the
 * relationship matters (critical or important): a company named once in a
 * list of competitors does not read through.
 *
 * Closest first: held before watched, then critical before important, then
 * the more confident. At most three, one per company.
 *
 * Pure.
 */

import type { EarningsLink } from "./earnings-types";

export type LinkEdge = {
  root_ticker?: string;
  counterparty_ticker?: string | null;
  category?: string;
  strength_tier?: string;
  /**
   * The share the filing states, in percent (null: none; absent: graph built
   * before it was carried). Links here rank by tier, which step1 already
   * derives from a disclosed share; read a share from this field, never from `strength`.
   */
  disclosed_share_pct?: number | null;
  confidence?: number;
  evidence_quote?: string;
  source_url?: string;
  filing_date?: string;
  accession_number?: string | null;
  form?: "10-K" | "20-F" | null;
};

export const LINK_MIN_CONFIDENCE = 0.8;
export const LINKS_PER_ROW = 3;

/** A link a filing carries: an SEC address, the quote, the accession number. */
export function isFilingBacked(e: LinkEdge): boolean {
  const url = typeof e.source_url === "string" ? e.source_url : "";
  return (
    /^https:\/\/(www\.)?sec\.gov\//i.test(url) &&
    typeof e.evidence_quote === "string" &&
    e.evidence_quote.trim().length > 0 &&
    typeof e.accession_number === "string" &&
    e.accession_number.trim().length > 0
  );
}

function tierOf(e: LinkEdge): "critical" | "important" | null {
  return e.strength_tier === "critical" || e.strength_tier === "important" ? e.strength_tier : null;
}

/** Edges indexed by each ticker they touch, filtered to the ones that can read through. */
export type LinkIndex = ReadonlyMap<string, readonly LinkEdge[]>;

export function indexLinks(edges: readonly LinkEdge[]): LinkIndex {
  const out = new Map<string, LinkEdge[]>();
  const put = (k: string, e: LinkEdge) => {
    const list = out.get(k);
    if (list) list.push(e);
    else out.set(k, [e]);
  };
  for (const e of edges) {
    const root = e.root_ticker?.trim().toUpperCase();
    const other = e.counterparty_ticker?.trim().toUpperCase();
    if (!root || !other || root === other) continue;
    if (!tierOf(e) || !isFilingBacked(e)) continue;
    if (typeof e.confidence !== "number" || !(e.confidence >= LINK_MIN_CONFIDENCE)) continue;
    put(root, e);
    put(other, e);
  }
  return out;
}

/**
 * The reader's names `ticker` reads through to. `formOf` supplies the filing
 * form for an edge that does not carry it (the company whose filing it is).
 */
export function readsThrough(
  index: LinkIndex,
  ticker: string,
  held: ReadonlySet<string>,
  watchlist: ReadonlySet<string>,
  formOf: (filer: string) => "10-K" | "20-F" | null = () => null,
): EarningsLink[] {
  const self = ticker.toUpperCase();
  const best = new Map<string, { link: EarningsLink; confidence: number }>();
  const rank = (l: EarningsLink, confidence: number) => [l.held ? 0 : 1, l.tier === "critical" ? 0 : 1, -confidence] as const;
  const better = (a: { link: EarningsLink; confidence: number }, b: { link: EarningsLink; confidence: number }) => {
    const ra = rank(a.link, a.confidence);
    const rb = rank(b.link, b.confidence);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! < rb[i]!;
    return false;
  };
  for (const e of index.get(self) ?? []) {
    const root = e.root_ticker!.trim().toUpperCase();
    const named = e.counterparty_ticker!.trim().toUpperCase();
    const other = root === self ? named : root;
    if (other === self || (!held.has(other) && !watchlist.has(other))) continue;
    const link: EarningsLink = {
      ticker: other,
      held: held.has(other),
      watchlist: watchlist.has(other),
      category: typeof e.category === "string" ? e.category : "related",
      tier: tierOf(e)!,
      namedBy: root,
      named,
      form: e.form === "10-K" || e.form === "20-F" ? e.form : formOf(root),
      filingDate: typeof e.filing_date === "string" ? e.filing_date : null,
      sourceUrl: typeof e.source_url === "string" ? e.source_url : null,
    };
    const candidate = { link, confidence: e.confidence ?? 0 };
    const known = best.get(other);
    if (!known || better(candidate, known)) best.set(other, candidate);
  }
  return [...best.values()]
    .sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : a.link.ticker.localeCompare(b.link.ticker)))
    .slice(0, LINKS_PER_ROW)
    .map((x) => x.link);
}
