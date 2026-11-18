/**
 * Point-in-time links: when each edge of the filing graph was first stated in
 * the filer's annual reports, so a backtest of an event on date t uses only
 * the links a reader could have known on t (first seen on or before t).
 *
 * scripts/graph-history.ts reads every annual report a filer sent since 2014
 * with the same extraction as the live graph (stage A of
 * scripts/graph-extract.ts: same prompt, model, passages, code checks and
 * ticker resolution) and keeps, per filing, the links it found. `buildPit`
 * lines those reads up against the live graph:
 *
 *   firstSeen  the earliest annual report (10-K, 10-K/A, 20-F, 40-F and their
 *              amendments) whose read holds the link, or the edge's own source
 *              filing when the filer's history was not read (basis "source")
 *   lastSeen   the latest one that holds it
 *   endedAt    the filing date of the first ORIGINAL annual report after
 *              lastSeen that was read and does not hold it ("possibly ended":
 *              a later report stopped naming the company); null while the
 *              link is still in the latest report
 *   seenIn / checkedIn   reports holding it / reports read since firstSeen
 *
 * A link is known at t when firstSeen <= t, and still current at t when also
 * not (endedAt <= t). Links found only in older reports (current: false) are
 * kept too, so the graph on a past date is not just today's survivors.
 *
 * Pure: no I/O.
 */

import type { EdgeCategory, GraphEdge, StrengthTier } from "../graph.ts";
import { MARKET_MAKER_QUOTE } from "./merge.ts";
import { namesAgree } from "./resolve.ts";

/** Annual report forms, originals and amendments. */
export const ANNUAL_FORM = /^(10-K|10-K405|10-KT|20-F|40-F)(\/A)?$/;

export type FilingRef = { form: string; accession: string; filedAt: string; url: string };

/** A link one filing's read found (stage A, checked and resolved). */
export type FilingLink = {
  to: string | null;
  toName: string;
  category: EdgeCategory;
  tier: StrengthTier;
  disclosedSharePct: number | null;
  quote: string;
};

/** One annual report's read: ok false when it could not be read (fetch or model failure), which never counts as absence. */
export type FilingRead = FilingRef & { ok: boolean; links: FilingLink[] };

export type Sighting = FilingRef & { tier: StrengthTier; quote: string };

export type PitEdge = {
  id: string;
  from: string;
  to: string;
  toName: string;
  category: EdgeCategory;
  /** Tier in the latest report holding the link. */
  tier: StrengthTier;
  firstSeen: Sighting;
  lastSeen: FilingRef;
  endedAt: string | null;
  seenIn: number;
  checkedIn: number;
  /** "history": the filer's reports since `since` were read; "source": only the edge's own filing is known. */
  basis: "history" | "source";
  /** In today's live graph (data/graph.json). */
  current: boolean;
  /** Every report holding it, oldest first: [filedAt, accession, form]. */
  seen: Array<[string, string, string]>;
};

type RecentLike = { accessionNumber?: string[]; filingDate?: string[]; form?: string[]; primaryDocument?: string[] };

/** "https://www.sec.gov/Archives/edgar/data/6281/000000628125000153/x.htm" -> "0000006281-25-000153"; null otherwise. Pure. */
export function accessionFromUrl(url: string): string | null {
  const m = /\/Archives\/edgar\/data\/\d+\/(\d{10})(\d{2})(\d{6})\//.exec(url);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Annual reports in a submissions index (the `recent` block and any older
 * pages), filed on or after `since`, oldest first, one per accession. Pure.
 */
export function annualFilings(cik: string, blocks: RecentLike[], since: string): FilingRef[] {
  const seen = new Set<string>();
  const out: FilingRef[] = [];
  const base = (acc: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}`;
  for (const r of blocks) {
    const n = r.form?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const form = r.form?.[i] ?? "";
      const accession = r.accessionNumber?.[i] ?? "";
      const filedAt = r.filingDate?.[i] ?? "";
      if (!ANNUAL_FORM.test(form) || !accession || !filedAt || filedAt < since || seen.has(accession)) continue;
      seen.add(accession);
      const doc = r.primaryDocument?.[i] ?? "";
      out.push({ form, accession, filedAt, url: doc ? `${base(accession)}/${doc}` : `${base(accession)}/${accession}-index.htm` });
    }
  }
  return out.sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.accession.localeCompare(b.accession));
}

/** Whether a filing's link is the edge: same relation, and the same ticker, or (unresolved) the same name. Pure. */
export function sameLink(edge: Pick<GraphEdge, "to" | "toName" | "category">, link: Pick<FilingLink, "to" | "toName" | "category">, toTitle = ""): boolean {
  if (edge.category !== link.category) return false;
  if (edge.to && link.to) return edge.to === link.to;
  return namesAgree(link.toName, edge.toName) || (!!toTitle && namesAgree(link.toName, toTitle));
}

const isAmendment = (form: string) => form.endsWith("/A");

/**
 * Point-in-time edges for the live graph's links and the links only older
 * reports state. `reads` holds each filer's annual reports read since 2014,
 * the source filings included (a filer missing from it gets basis "source").
 * `titles` gives a ticker's company name, for matching an unresolved name. Pure.
 */
export function buildPit(current: GraphEdge[], reads: Record<string, FilingRead[]>, titles: Record<string, string> = {}): PitEdge[] {
  const out: PitEdge[] = [];
  const byFiler = new Map<string, GraphEdge[]>();
  for (const e of current) {
    if (!e.to || e.to === e.from) continue;
    const list = byFiler.get(e.from) ?? [];
    list.push(e);
    byFiler.set(e.from, list);
  }
  const filers = new Set([...byFiler.keys(), ...Object.keys(reads)]);
  for (const filer of [...filers].sort()) {
    const list = [...(reads[filer] ?? [])].sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.accession.localeCompare(b.accession));
    const okReads = list.filter((r) => r.ok);
    const edges = byFiler.get(filer) ?? [];

    const place = (match: (l: FilingLink) => boolean, source: (FilingRef & { tier: StrengthTier; quote: string }) | null) => {
      const seen: Sighting[] = [];
      for (const r of okReads) {
        const hits = r.links.filter(match);
        if (!hits.length) continue;
        const best = hits.find((h) => h.tier === "critical") ?? hits.find((h) => h.tier === "important") ?? hits[0]!;
        seen.push({ form: r.form, accession: r.accession, filedAt: r.filedAt, url: r.url, tier: best.tier, quote: best.quote });
      }
      if (source && !seen.some((s) => s.accession === source.accession)) seen.push(source);
      seen.sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.accession.localeCompare(b.accession));
      if (!seen.length) return null;
      const first = seen[0]!;
      const last = seen[seen.length - 1]!;
      const after = okReads.find((r) => r.filedAt > last.filedAt && !isAmendment(r.form) && !seen.some((s) => s.accession === r.accession));
      const checked = new Set([...okReads.filter((r) => r.filedAt >= first.filedAt).map((r) => r.accession), ...seen.map((s) => s.accession)]);
      return { seen, first, last, endedAt: after?.filedAt ?? null, checkedIn: checked.size };
    };

    const claimed = new Set<string>();
    for (const e of edges) {
      const srcAcc = (e as GraphEdge & { accession?: string }).accession ?? accessionFromUrl(e.url) ?? `url:${e.url}`;
      const source = { form: e.form, accession: srcAcc, filedAt: e.filedAt, url: e.url, tier: e.tier, quote: e.quote };
      const p = place((l) => sameLink(e, l, titles[e.to!] ?? ""), source)!;
      out.push({
        id: e.id,
        from: e.from,
        to: e.to!,
        toName: e.toName,
        category: e.category,
        tier: p.last.tier,
        firstSeen: p.first,
        lastSeen: { form: p.last.form, accession: p.last.accession, filedAt: p.last.filedAt, url: p.last.url },
        endedAt: p.endedAt,
        seenIn: p.seen.length,
        checkedIn: p.checkedIn,
        basis: okReads.length ? "history" : "source",
        current: true,
        seen: p.seen.map((s) => [s.filedAt, s.accession, s.form]),
      });
      claimed.add(`${e.to}|${e.category}`);
    }

    // Links only older reports state: resolved, not today's, not a market maker's.
    const older = new Map<string, FilingLink>();
    for (const r of okReads) {
      for (const l of r.links) {
        if (!l.to || l.to === filer || MARKET_MAKER_QUOTE.test(l.quote)) continue;
        const k = `${l.to}|${l.category}`;
        if (claimed.has(k) || edges.some((e) => sameLink(e, l, titles[e.to!] ?? ""))) continue;
        if (!older.has(k)) older.set(k, l);
      }
    }
    for (const [k, l] of older) {
      const p = place((x) => !!x.to && `${x.to}|${x.category}` === k, null);
      if (!p) continue;
      out.push({
        id: `${filer}:${l.category}:${l.to}`,
        from: filer,
        to: l.to!,
        toName: l.toName,
        category: l.category,
        tier: p.last.tier,
        firstSeen: p.first,
        lastSeen: { form: p.last.form, accession: p.last.accession, filedAt: p.last.filedAt, url: p.last.url },
        endedAt: p.endedAt,
        seenIn: p.seen.length,
        checkedIn: p.checkedIn,
        basis: "history",
        current: false,
        seen: p.seen.map((s) => [s.filedAt, s.accession, s.form]),
      });
    }
  }
  return out;
}

/**
 * The edges known on `asOf` (YYYY-MM-DD): first seen on or before it and,
 * unless `includeEnded`, not dropped by a later report filed on or before it. Pure.
 */
export function edgesAsOf<E extends { firstSeen: { filedAt: string }; endedAt: string | null }>(edges: E[], asOf: string, includeEnded = false): E[] {
  return edges.filter((e) => e.firstSeen.filedAt <= asOf && (includeEnded || !e.endedAt || e.endedAt > asOf));
}
