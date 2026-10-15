/**
 * Exposure: what the reader's holdings depend on together, read from the
 * filing graph (step1's 10-K and 20-F extraction). A broker statement lists
 * positions; it never says that three of them buy from the same foundry.
 *
 * Four answers, all from the same links:
 *
 *   shared       Companies (or private names, agencies) that two or more
 *                holdings depend on, ranked by exposed weight:
 *
 *                  exposure(C) = sum over linked holdings h of weight(h) x factor(h, C)
 *
 *                where weight(h) is h's share of the account (portfolio-weights:
 *                market value over cash plus every position) and factor is the
 *                link's strength tier: critical 1, important 0.6, marginal 0.3,
 *                the same scale step1 gives a classified edge. A revenue share
 *                the filing discloses sets the tier (10% and up is critical,
 *                5% and up important) and breaks ties. One link per holding
 *                and company: the strongest.
 *
 *                A link read from the holding's own filing counts at its tier.
 *                A link read only from the other company's filing (TSM's 20-F
 *                naming the holding as a customer) says how much that company
 *                depends on the holding, not the reverse, so it counts at the
 *                marginal factor whatever its tier.
 *
 *   customers    Holdings whose own filing discloses that one customer is 10%
 *                of revenue or more, with the shares.
 *
 *   overlaps     Pairs of holdings that depend on the most of the same names.
 *
 *   gaps         Holdings with no filing of their own in the graph yet.
 *
 * Only links a filing carries (an SEC address, the quote, the accession
 * number) at extraction confidence 0.8 and up, the bar the Earnings tab's
 * "reads through to" uses. Competitors are not dependencies and are left out,
 * as are products and commodities. Short positions are left out of the sums:
 * a short is not exposure to a supplier.
 *
 * Pure: no fs, no clock.
 */

import { LINK_MIN_CONFIDENCE, isFilingBacked } from "./earnings-links";

export type ExposureScope = "account" | "watchlist";
export type ExposureTier = "critical" | "important" | "marginal";
/** How the company relates to the holding, from the holding's side. */
export type ExposureRelation = "supplier" | "customer" | "partner" | "dependency";

export const TIER_FACTOR: Readonly<Record<ExposureTier, number>> = { critical: 1, important: 0.6, marginal: 0.3 };
/** A link only the other company's filing carries counts at this factor. */
export const THEIR_FILING_FACTOR = TIER_FACTOR.marginal;
/** A disclosed customer share at or above this is "heavy" concentration. */
export const CUSTOMER_SHARE_MIN = 10;
/** The headline's thresholds, highest first: the first one any company passes is the one quoted. */
export const HEADLINE_THRESHOLDS: readonly number[] = [0.5, 0.4, 0.3, 0.2];
export const SHARED_LIMIT = 25;
export const OVERLAP_LIMIT = 6;
export const OVERLAP_MIN_SHARED = 2;
export const CUSTOMERS_PER_ROW = 3;

const RELATIONS: ReadonlySet<string> = new Set<ExposureRelation>(["supplier", "customer", "partner", "dependency"]);
const SKIPPED_TYPES: ReadonlySet<string> = new Set(["product", "commodity"]);
const TICKER_SHAPE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

/** A graph edge as the file stores it (main/research/graph-edges.ts), every field optional. */
export type ExposureEdge = {
  root_ticker?: string;
  counterparty_ticker?: string | null;
  counterparty_id?: string | null;
  counterparty_name?: string;
  counterparty_type?: string | null;
  category?: string;
  strength?: number;
  strength_tier?: string;
  strength_basis?: string;
  disclosed_revenue_dependency_pct?: number | null;
  /** The graph's disclosed share, in percent; null when the filing states none; absent on older graphs. */
  disclosed_share_pct?: number | null;
  confidence?: number;
  evidence_quote?: string;
  source_url?: string;
  filing_date?: string;
  accession_number?: string | null;
  form?: "10-K" | "20-F" | null;
};

export type ExposureHoldingInput = {
  ticker: string;
  /** Share of the account, 0 to 1 (negative for a short). */
  weight: number;
  /** A fund: it files no 10-K, so it is never a gap. */
  fund?: boolean;
};

export type ExposureRequest = { scope: ExposureScope; holdings: ExposureHoldingInput[] };

export type ExposureSource = {
  /** The company whose filing carries the link. */
  filer: string;
  form: "10-K" | "20-F" | null;
  filingDate: string | null;
  url: string;
};

export type ExposureVia = {
  ticker: string;
  weight: number;
  relation: ExposureRelation;
  tier: ExposureTier;
  /** True when the holding's own filing carries the link. */
  own: boolean;
  /** Disclosed revenue share, percent; null when the filing gives none. */
  share: number | null;
  /** weight x factor. */
  contribution: number;
};

export type SharedDependency = {
  /** The company's ticker, or a name key for one without. */
  key: string;
  ticker: string | null;
  name: string;
  /** Has a ticker the app can open. */
  listed: boolean;
  /** The reader holds it too. */
  held: boolean;
  /** Strength-weighted share of the account. */
  exposure: number;
  /** Plain share of the account the linked holdings make up. */
  linkedWeight: number;
  /** Linked holdings, largest contribution first. */
  via: ExposureVia[];
  tier: ExposureTier;
  /** The strongest link's filing. */
  source: ExposureSource;
};

export type ConcentratedCustomer = { key: string; name: string; ticker: string | null; share: number };

export type CustomerConcentration = {
  ticker: string;
  weight: number;
  /** Largest share first, at most CUSTOMERS_PER_ROW. */
  customers: ConcentratedCustomer[];
  topShare: number;
  source: ExposureSource;
};

export type HoldingOverlap = {
  a: string;
  b: string;
  /** Names both depend on, strongest shared link first. */
  shared: Array<{ key: string; name: string; ticker: string | null }>;
  weight: number;
};

export type ExposureHeadline = {
  /** Companies above the threshold. */
  count: number;
  threshold: number;
  /** With a single company: its name and figure. */
  name: string | null;
  exposure: number | null;
};

export type ExposureSummary = {
  scope: ExposureScope;
  /** Holdings the request carried that are not funds. */
  companies: number;
  /** Of those, how many have a filing of their own in the graph. */
  covered: number;
  coveredWeight: number;
  headline: ExposureHeadline | null;
  shared: SharedDependency[];
  customers: CustomerConcentration[];
  overlaps: HoldingOverlap[];
  /** Holdings with no filing in the graph, largest first. */
  gaps: Array<{ ticker: string; weight: number }>;
  gapWeight: number;
};

export type ExposureOptions = {
  /** The filing form for an edge that does not carry it (the filer's step1 meta). */
  formOf?: (filer: string) => "10-K" | "20-F" | null;
  /** A company name for a ticker the edges never name (the listing directory). */
  nameOf?: (ticker: string) => string | null | undefined;
  /** Whether the app can open this ticker; every ticker when not given. */
  isListed?: (ticker: string) => boolean;
};

function upper(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toUpperCase();
  return s ? s : null;
}

function tierOf(value: unknown): ExposureTier | null {
  return value === "critical" || value === "important" || value === "marginal" ? value : null;
}

/** The tier a disclosed revenue share stands for (step1/strength.ts, tierFromDisclosedPct). */
export function tierFromShare(pct: number): ExposureTier {
  if (pct >= 10) return "critical";
  if (pct >= 5) return "important";
  return "marginal";
}

/**
 * The revenue share the filing discloses for this link, in percent, or null.
 * Read from the field when the edge carries it; otherwise from `strength`,
 * which step1 sets to share / 100 for a disclosed link and to the tier's
 * default for a classified one, so a strength that is not its tier's default
 * is a disclosed share.
 */
export function disclosedShare(e: ExposureEdge): number | null {
  // The graph's own field decides when present (null: the filing states none).
  if (e.disclosed_share_pct !== undefined) {
    const own = e.disclosed_share_pct;
    return typeof own === "number" && Number.isFinite(own) && own > 0 ? Math.min(100, own) : null;
  }
  const pct = e.disclosed_revenue_dependency_pct;
  if (typeof pct === "number" && Number.isFinite(pct) && pct > 0) return Math.min(100, pct);
  if (e.strength_basis === "classified") return null;
  const tier = tierOf(e.strength_tier);
  const s = e.strength;
  if (!tier || typeof s !== "number" || !Number.isFinite(s) || s <= 0 || s > 1) return null;
  if (e.strength_basis !== "disclosed" && Math.abs(s - TIER_FACTOR[tier]) < 1e-9) return null;
  return Math.round(s * 1000) / 10;
}

/** A name reduced to what identifies it: "Samsung Electronics Co., Ltd." and "Samsung Electronics" meet. */
export function nameKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const tail = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "llc", "plc", "sa", "ag", "nv", "the"]);
  while (words.length > 1 && tail.has(words[words.length - 1]!)) words.pop();
  while (words.length > 1 && words[0] === "the") words.shift();
  return `name:${words.join(" ")}`;
}

type Link = {
  holding: string;
  key: string;
  relation: ExposureRelation;
  tier: ExposureTier;
  factor: number;
  own: boolean;
  share: number | null;
  confidence: number;
  source: ExposureSource;
};

function better(a: Link, b: Link): boolean {
  if (a.factor !== b.factor) return a.factor > b.factor;
  if (a.own !== b.own) return a.own;
  if ((a.share ?? -1) !== (b.share ?? -1)) return (a.share ?? -1) > (b.share ?? -1);
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  return (a.source.filingDate ?? "") > (b.source.filingDate ?? "");
}

const TIER_RANK: Record<ExposureTier, number> = { critical: 3, important: 2, marginal: 1 };

/** From the holding's side: a filing naming the holding as its customer is the holding's supplier. */
function flip(category: ExposureRelation): ExposureRelation | null {
  if (category === "customer") return "supplier";
  if (category === "supplier") return "customer";
  if (category === "partner") return "partner";
  // "We depend on the holding" says nothing about what the holding depends on.
  return null;
}

/** Holdings merged by ticker; weights that are not numbers are dropped. */
function normalizeHoldings(list: readonly ExposureHoldingInput[]): Map<string, { weight: number; fund: boolean }> {
  const out = new Map<string, { weight: number; fund: boolean }>();
  for (const h of list) {
    const t = upper(h?.ticker);
    if (!t || !TICKER_SHAPE.test(t) || typeof h.weight !== "number" || !Number.isFinite(h.weight)) continue;
    const known = out.get(t);
    out.set(t, { weight: (known?.weight ?? 0) + h.weight, fund: Boolean(h.fund) || Boolean(known?.fund) });
  }
  return out;
}

export function computeExposure(
  edges: readonly ExposureEdge[],
  request: ExposureRequest,
  options: ExposureOptions = {},
): ExposureSummary {
  const formOf = options.formOf ?? (() => null);
  const holdings = normalizeHoldings(request.holdings);
  const linked = new Map<string, number>();
  for (const [t, h] of holdings) if (!h.fund && h.weight > 0) linked.set(t, h.weight);

  // Which companies have a filing of their own in the graph, and the ticker
  // each name id carries anywhere (so a name named once without one still meets it).
  const roots = new Set<string>();
  const idTicker = new Map<string, string>();
  for (const e of edges) {
    const r = upper(e.root_ticker);
    if (r) roots.add(r);
    const id = typeof e.counterparty_id === "string" ? e.counterparty_id.trim() : "";
    const t = upper(e.counterparty_ticker);
    if (id && t && TICKER_SHAPE.test(t)) idTicker.set(id, t);
  }
  const keyOf = (e: ExposureEdge): string | null => {
    const t = upper(e.counterparty_ticker);
    if (t && TICKER_SHAPE.test(t)) return t;
    const id = typeof e.counterparty_id === "string" ? e.counterparty_id.trim() : "";
    if (id && idTicker.has(id)) return idTicker.get(id)!;
    // step1's canonical id ("name:us department of defense") is the graph's own identity; a name only when there is none.
    if (id.startsWith("name:") && id.length > 5) return id.toLowerCase();
    const name = typeof e.counterparty_name === "string" ? e.counterparty_name.trim() : "";
    return name ? nameKey(name) : null;
  };

  const nameVotes = new Map<string, Map<string, number>>();
  const vote = (key: string, name: string | undefined) => {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n) return;
    const m = nameVotes.get(key) ?? new Map<string, number>();
    m.set(n, (m.get(n) ?? 0) + 1);
    nameVotes.set(key, m);
  };
  const nameOf = (key: string): string => {
    // US federal bodies share one node (step1 canonical.ts); its agencies stay on each edge.
    if (key === "name:us government") return "U.S. government";
    const votes = nameVotes.get(key);
    if (votes && votes.size > 0) {
      return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]![0];
    }
    if (!key.startsWith("name:")) return options.nameOf?.(key)?.trim() || key;
    return key.slice(5);
  };
  const sourceOf = (e: ExposureEdge, filer: string): ExposureSource => ({
    filer,
    form: e.form === "10-K" || e.form === "20-F" ? e.form : formOf(filer),
    filingDate: typeof e.filing_date === "string" && e.filing_date ? e.filing_date : null,
    url: typeof e.source_url === "string" ? e.source_url : "",
  });

  // Best link per (holding, company); and every disclosed customer share per holding.
  const best = new Map<string, Map<string, Link>>();
  const disclosed = new Map<string, { source: ExposureSource; byKey: Map<string, ConcentratedCustomer> }>();
  const put = (link: Link) => {
    const m = best.get(link.holding) ?? new Map<string, Link>();
    const known = m.get(link.key);
    if (!known || better(link, known)) m.set(link.key, link);
    best.set(link.holding, m);
  };

  for (const e of edges) {
    const root = upper(e.root_ticker);
    const category = e.category;
    const tier = tierOf(e.strength_tier);
    if (!root || !tier || typeof category !== "string" || !RELATIONS.has(category)) continue;
    if (typeof e.counterparty_type === "string" && SKIPPED_TYPES.has(e.counterparty_type)) continue;
    if (!isFilingBacked(e) || typeof e.confidence !== "number" || !(e.confidence >= LINK_MIN_CONFIDENCE)) continue;
    const key = keyOf(e);
    if (!key || key === root) continue;
    vote(key, e.counterparty_name);
    const relation = category as ExposureRelation;
    const share = disclosedShare(e);

    if (linked.has(root)) {
      put({ holding: root, key, relation, tier, factor: TIER_FACTOR[tier], own: true, share, confidence: e.confidence, source: sourceOf(e, root) });
    }
    if (linked.has(key)) {
      const theirs = flip(relation);
      if (theirs) {
        put({
          holding: key,
          key: root,
          relation: theirs,
          // The tier says how much the filer depends on the holding; from the holding's side it counts as marginal.
          tier: "marginal",
          factor: Math.min(TIER_FACTOR[tier], THEIR_FILING_FACTOR),
          own: false,
          share: null,
          confidence: e.confidence,
          source: sourceOf(e, root),
        });
      }
    }
    if (relation === "customer" && share !== null && share >= CUSTOMER_SHARE_MIN && holdings.has(root) && !holdings.get(root)!.fund) {
      const entry = disclosed.get(root) ?? { source: sourceOf(e, root), byKey: new Map<string, ConcentratedCustomer>() };
      const known = entry.byKey.get(key);
      if (!known || share > known.share) {
        entry.byKey.set(key, { key, name: "", ticker: key.startsWith("name:") ? null : key, share });
      }
      disclosed.set(root, entry);
    }
  }

  // Shared dependencies.
  const byKey = new Map<string, Link[]>();
  for (const m of best.values()) {
    for (const link of m.values()) {
      const list = byKey.get(link.key) ?? [];
      list.push(link);
      byKey.set(link.key, list);
    }
  }
  const shared: Array<SharedDependency & { shareSum: number }> = [];
  for (const [key, links] of byKey) {
    if (links.length < 2) continue;
    const via: ExposureVia[] = links
      .map((l) => {
        const weight = linked.get(l.holding)!;
        return { ticker: l.holding, weight, relation: l.relation, tier: l.tier, own: l.own, share: l.share, contribution: weight * l.factor };
      })
      .sort((a, b) => b.contribution - a.contribution || Number(b.own) - Number(a.own) || a.ticker.localeCompare(b.ticker));
    const strongest = [...links].sort((a, b) => {
      const ca = linked.get(a.holding)! * a.factor;
      const cb = linked.get(b.holding)! * b.factor;
      if (ca !== cb) return cb - ca;
      return better(a, b) ? -1 : better(b, a) ? 1 : a.holding.localeCompare(b.holding);
    })[0]!;
    const ticker = key.startsWith("name:") ? null : key;
    shared.push({
      key,
      ticker,
      name: nameOf(key),
      listed: ticker !== null && (options.isListed ? options.isListed(ticker) : true),
      held: ticker !== null && holdings.has(ticker) && (holdings.get(ticker)!.weight ?? 0) > 0,
      exposure: via.reduce((s, v) => s + v.contribution, 0),
      linkedWeight: via.reduce((s, v) => s + v.weight, 0),
      via,
      tier: links.reduce<ExposureTier>((t, l) => (TIER_RANK[l.tier] > TIER_RANK[t] ? l.tier : t), "marginal"),
      source: strongest.source,
      shareSum: via.reduce((s, v) => s + v.weight * (v.share ?? 0), 0),
    });
  }
  shared.sort(
    (a, b) =>
      b.exposure - a.exposure || b.shareSum - a.shareSum || b.via.length - a.via.length || a.name.localeCompare(b.name),
  );
  const sharedRows: SharedDependency[] = shared.slice(0, SHARED_LIMIT).map(({ shareSum: _drop, ...row }) => row);

  // Customer concentration.
  const customers: CustomerConcentration[] = [...disclosed.entries()]
    .map(([ticker, entry]) => {
      const list = [...entry.byKey.values()]
        .map((c) => ({ ...c, name: nameOf(c.key) }))
        .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name))
        .slice(0, CUSTOMERS_PER_ROW);
      return { ticker, weight: holdings.get(ticker)!.weight, customers: list, topShare: list[0]!.share, source: entry.source };
    })
    .sort((a, b) => b.topShare - a.topShare || b.weight - a.weight || a.ticker.localeCompare(b.ticker));

  // Overlap between holdings.
  const held = [...best.keys()].sort();
  const overlaps: Array<HoldingOverlap & { strength: number }> = [];
  for (let i = 0; i < held.length; i++) {
    for (let j = i + 1; j < held.length; j++) {
      const a = held[i]!;
      const b = held[j]!;
      const la = best.get(a)!;
      const lb = best.get(b)!;
      const common: Array<{ key: string; factor: number }> = [];
      for (const [key, link] of la) {
        if (key === a || key === b) continue;
        const other = lb.get(key);
        if (other) common.push({ key, factor: Math.min(link.factor, other.factor) });
      }
      if (common.length < OVERLAP_MIN_SHARED) continue;
      common.sort((x, y) => y.factor - x.factor || nameOf(x.key).localeCompare(nameOf(y.key)));
      overlaps.push({
        a,
        b,
        shared: common.map((c) => ({ key: c.key, name: nameOf(c.key), ticker: c.key.startsWith("name:") ? null : c.key })),
        weight: linked.get(a)! + linked.get(b)!,
        strength: common.reduce((s, c) => s + c.factor, 0),
      });
    }
  }
  overlaps.sort((x, y) => y.shared.length - x.shared.length || y.strength - x.strength || y.weight - x.weight || x.a.localeCompare(y.a));
  const overlapRows: HoldingOverlap[] = overlaps.slice(0, OVERLAP_LIMIT).map(({ strength: _drop, ...row }) => row);

  // Coverage and gaps.
  let companies = 0;
  let covered = 0;
  let coveredWeight = 0;
  const gaps: Array<{ ticker: string; weight: number }> = [];
  for (const [ticker, h] of holdings) {
    if (h.fund) continue;
    companies++;
    if (roots.has(ticker)) {
      covered++;
      coveredWeight += Math.max(0, h.weight);
    } else {
      gaps.push({ ticker, weight: h.weight });
    }
  }
  gaps.sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));

  return {
    scope: request.scope,
    companies,
    covered,
    coveredWeight,
    headline: headlineOf(sharedRows),
    shared: sharedRows,
    customers,
    overlaps: overlapRows,
    gaps,
    gapWeight: gaps.reduce((s, g) => s + Math.max(0, g.weight), 0),
  };
}

/**
 * The one line over the tab: the highest threshold any company passes, and
 * how many pass it. Nothing when no company sits under a fifth of the account.
 */
export function headlineOf(rows: readonly SharedDependency[]): ExposureHeadline | null {
  for (const threshold of HEADLINE_THRESHOLDS) {
    const over = rows.filter((r) => r.exposure > threshold);
    if (over.length === 0) continue;
    return {
      count: over.length,
      threshold,
      name: over.length === 1 ? over[0]!.name : null,
      exposure: over.length === 1 ? over[0]!.exposure : null,
    };
  }
  return null;
}

function percentFormat(lang: string, digits: number): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(lang, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits });
  } catch {
    return new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
}

/** "58%", "4.2%", "<0.1%": whole points from ten up, one decimal under; the sign where `lang` puts it ("%58"). */
export function exposurePct(value: number, lang = "en-US"): string {
  const pct = value * 100;
  if (!Number.isFinite(pct) || pct <= 0) return percentFormat(lang, 0).format(0);
  if (pct < 0.05) return `<${percentFormat(lang, 1).format(0.001)}`;
  if (pct >= 9.95) return percentFormat(lang, 0).format(Math.round(pct) / 100);
  return percentFormat(lang, 1).format(Math.round(pct * 10) / 1000);
}

/** A disclosed share as the filing put it: "29.8%", "17%". */
export function sharePct(pct: number, lang = "en-US"): string {
  const r = Math.round(pct * 10) / 10;
  return percentFormat(lang, Number.isInteger(r) ? 0 : 1).format(r / 100);
}

/**
 * The request as main accepts it, or null: a scope, and at most 300 holdings
 * with a ticker and a finite weight.
 */
export function parseExposureRequest(raw: unknown): ExposureRequest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { scope?: unknown; holdings?: unknown };
  const scope: ExposureScope | null = r.scope === "account" || r.scope === "watchlist" ? r.scope : null;
  if (!scope || !Array.isArray(r.holdings) || r.holdings.length > 300) return null;
  const holdings: ExposureHoldingInput[] = [];
  for (const h of r.holdings) {
    if (h === null || typeof h !== "object") return null;
    const { ticker, weight, fund } = h as { ticker?: unknown; weight?: unknown; fund?: unknown };
    const t = upper(ticker);
    if (!t || !TICKER_SHAPE.test(t) || typeof weight !== "number" || !Number.isFinite(weight) || Math.abs(weight) > 100) return null;
    holdings.push({ ticker: t, weight, fund: fund === true });
  }
  return { scope, holdings };
}

/** The request's identity for caches: the scope and every holding at a tenth of a point. */
export function exposureRequestKey(request: ExposureRequest): string {
  const parts = request.holdings
    .map((h) => `${h.ticker.toUpperCase()}:${Math.round(h.weight * 1000)}${h.fund ? "f" : ""}`)
    .sort();
  return `${request.scope}|${parts.join(",")}`;
}

export type ExposureResult = { ok: true; summary: ExposureSummary } | { ok: false; error: "invalid_request" | "unavailable" };
