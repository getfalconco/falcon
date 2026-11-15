/**
 * Graph extraction from annual reports (design 4.2, step 2): the prompt and
 * schema the model answers, and the deterministic checks every link must
 * pass before it becomes an edge. The model proposes; code decides:
 *
 *   - the quote is in the filing word for word (`quoteInDocument`, the same
 *     check scripts/build-graph.ts runs on the seed graph);
 *   - the counterparty's name, as the model says it is written, is inside
 *     that quote (a quote about "our customers" does not name Walmart);
 *   - a revenue share is a number the quote holds, 0 < share <= 100;
 *   - "sole source" needs sole / single / exclusive / only wording in the quote;
 *   - no director biography, no bank or depositary, no government or
 *     non-company counterparty, no link to the filer itself.
 *
 * Tier (the `StrengthTier` src/graph.ts and src/rank.ts read):
 *   critical   the quote states a share or a sole / single source (rank's "disclosed")
 *   important  a counterparty named on its own (rank's "named")
 *   marginal   one name in a list of several (rank's "list")
 *
 * Pure apart from nothing: the script does the reading and calling.
 */

import type { EdgeCategory, GraphEdge, StrengthTier } from "../graph.ts";
import { normalizeForMatch, quoteInDocument } from "../text.ts";
import { UNTRUSTED_NOTE } from "../detectors/llm.ts";
import type { Filing } from "../sec.ts";

export const EXTRACTOR_VERSION = "graph-extract-v1";

/** Annual report forms, original before amendment. */
const ANNUAL = /^(10-K|10-K405|10-KT|20-F|40-F)$/;

/**
 * The filer's latest annual report (10-K, 20-F or 40-F; an amendment only
 * when no original is listed), or null. Filings come newest first. Pure.
 */
export function latestAnnual(filings: Filing[]): Filing | null {
  return filings.find((f) => ANNUAL.test(f.form)) ?? filings.find((f) => /^(10-K|20-F|40-F)\/A$/.test(f.form)) ?? null;
}

export const RELATIONS = ["customer", "supplier", "competitor", "partner"] as const;
export const STRENGTHS = ["disclosed", "named", "list"] as const;
export const KINDS = ["company", "government", "other"] as const;

export type RawLink = {
  counterparty: string;
  name_in_quote: string;
  relation: (typeof RELATIONS)[number];
  kind: (typeof KINDS)[number];
  quote: string;
  section: string;
  share_text: string;
  sole_source: boolean;
  strength: (typeof STRENGTHS)[number];
  us_ticker: string;
};

export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["links"],
  properties: {
    links: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["counterparty", "name_in_quote", "relation", "kind", "quote", "section", "share_text", "sole_source", "strength", "us_ticker"],
        properties: {
          counterparty: { type: "string", description: "The other company's name as the filing writes it (the fullest form the filing gives)." },
          name_in_quote: { type: "string", description: "The counterparty's name exactly as it appears inside `quote` (may be an abbreviation such as TSMC)." },
          relation: { type: "string", enum: [...RELATIONS], description: "What the counterparty is TO THE FILER." },
          kind: { type: "string", enum: [...KINDS], description: "company for a business (public or private); government for a government, agency or state-owned program; other for anything else (a market, a product, a person)." },
          quote: { type: "string", description: "One or two consecutive sentences copied word for word from the passage, containing the counterparty's name and stating the relation." },
          section: { type: "string", description: "The passage's [Item ...] label, e.g. Item 1A." },
          share_text: { type: "string", description: "The share the quote states for this counterparty exactly as written (e.g. \"14%\"), empty when the quote states none." },
          sole_source: { type: "boolean", description: "True only when the quote says the counterparty is the sole, single, exclusive or only source of something the filer buys." },
          strength: { type: "string", enum: [...STRENGTHS], description: "disclosed: the quote states a revenue / purchase share or a sole or single source; named: the counterparty is named on its own as a key or major relation; list: one name among several in a list." },
          us_ticker: { type: "string", description: "The counterparty's ticker on a US exchange (NYSE, Nasdaq) when you are certain; empty otherwise or for a private company." },
        },
      },
    },
  },
} as const;

export const EXTRACT_SYSTEM = `You read passages of a company's annual report (Form 10-K, 20-F or 40-F) and list its business links to other named companies: customers, suppliers, competitors and partners. ${UNTRUSTED_NOTE}

Each passage starts with a label in square brackets, [Item 1 > Customers], giving its section and the heading above it. The label is not filing text: never copy it into a quote.

Rules:
- Only links to a company the passage NAMES (Walmart, TSMC, "Amazon.com, Inc."). Never "a large customer", "Customer A", "certain distributors" or other unnamed parties.
- relation is what the counterparty is to the filer:
  customer: the filer sells to it, or it accounts for part of the filer's revenue or receivables (a distributor or wholesaler that buys from the filer is a customer);
  supplier: the filer buys from it, licenses technology from it, or relies on it to make, host or deliver products (foundry, contract manufacturer, cloud provider, raw material);
  competitor: the filing says the filer competes with it;
  partner: a collaboration, joint venture, co-development, co-promotion, alliance or reseller arrangement that is neither a plain sale nor a plain purchase.
- Read the direction carefully. "We purchase chips from X" makes X a supplier. "X accounted for 12% of our net sales" makes X a customer. "We supply X" makes X a customer. A licensee paying the filer royalties is a customer; a licensor the filer pays is a supplier.
- Not links: the filer itself or its own subsidiaries; a company the filer acquired, agreed to acquire, merged with or sold a business to; investors buying or selling the filer's shares; banks, lenders, trustees, depositaries, auditors, index providers; parties to lawsuits or settlements; former employers in biographies; companies named only in a regulatory, export-control or legal context, or as examples of an industry trend.
- quote: copy one or two consecutive sentences exactly as written, keeping the counterparty's name inside. Do not fix typos, do not join text from different places, do not paraphrase.
- share_text only when the quote itself states this counterparty's share; copy it as written.
- One entry per (counterparty, relation). If a company is both a customer and a competitor, give two entries.
- Return an empty list when the passages name no such company.`;

export function extractUser(filer: { name: string; ticker: string; form: string; filedAt: string }, passages: string): string {
  return `Filer: ${filer.name} (${filer.ticker}), Form ${filer.form} filed ${filer.filedAt}.\n<filing>\n${passages}\n</filing>`;
}

/** Banks and depositaries are not supply-chain links; nor is a director's former employer. */
export const BIOGRAPHY = /\b(served|serves|serving) (at|as|in)\b|prior to (that|joining)|\b(Mr|Ms|Mrs|Dr)\. [A-Z]|\b(is|was) (currently )?the (Chairman|Director|Chief)|\bthe Director of\b|board of directors of/i;
export const NOT_A_BUSINESS_LINK = /\b(bank|citibank|depositary|depository|clearing|trust company)\b/i;

const SOLE = /\b(sole|single|exclusive|only)\b/i;

/** "14%", "approximately 14.5 percent" -> 14 / 14.5; null when not one share in (0, 100]. Pure. */
export function parseSharePct(text: string): number | null {
  const m = /(\d{1,3}(?:\.\d+)?)\s?(?:%|percent)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

export type CheckedLink = {
  link: RawLink;
  quote: string;
  sharePct: number | null;
  shareBasis: ShareBasis | null;
  soleSource: boolean;
  tier: StrengthTier;
};

/** Why a proposed link is not an edge, or the link as checked. Pure. */
export function checkLink(raw: RawLink, doc: string, filerName: string): { ok: true; value: CheckedLink } | { ok: false; reason: string } {
  let quote = raw.quote.trim().replace(/^\[[^\]]{1,120}\]\s*/, "");
  if (!raw.counterparty.trim()) return { ok: false, reason: "no counterparty" };
  if (raw.kind !== "company") return { ok: false, reason: `not a company (${raw.kind})` };
  if (quote.length < 20) return { ok: false, reason: "quote too short" };
  if (quote.length > 1500) return { ok: false, reason: "quote too long" };
  if (!quoteInDocument(quote, doc)) {
    // A heading the model copied in front ("Customers: The top five ...").
    const rest = quote.replace(/^[^:.]{1,90}:\s+/, "");
    if (rest === quote || rest.length < 20 || !quoteInDocument(rest, doc)) return { ok: false, reason: "quote not in filing" };
    quote = rest;
  }
  if (!namedIn(quote, raw.name_in_quote, raw.counterparty)) return { ok: false, reason: "counterparty not named in quote" };
  if (BIOGRAPHY.test(quote)) return { ok: false, reason: "biography" };
  if (NOT_A_BUSINESS_LINK.test(raw.counterparty)) return { ok: false, reason: "bank or depositary" };
  if (sameCompany(raw.counterparty, filerName)) return { ok: false, reason: "the filer itself" };
  let sharePct: number | null = null;
  const shareBasis = shareBasisOf(quote);
  // A share counts only for a customer or supplier, as a number the quote holds,
  // of revenue, receivables or purchases (a joint venture's 50% stake is not one).
  if (raw.share_text.trim() && shareBasis && (raw.relation === "customer" || raw.relation === "supplier")) {
    const pct = parseSharePct(raw.share_text);
    if (pct !== null && quoteHasNumber(quote, pct)) sharePct = pct;
  }
  const soleSource = raw.sole_source && raw.relation === "supplier" && SOLE.test(quote);
  const tier: StrengthTier = sharePct !== null || soleSource ? "critical" : raw.strength === "list" ? "marginal" : "important";
  return { ok: true, value: { link: raw, quote, sharePct, shareBasis: sharePct !== null ? shareBasis : null, soleSource, tier } };
}

export type ShareBasis = "revenue" | "receivables" | "purchases";

/** What a share in the quote is a share of: revenue first, then receivables, then purchases. Pure. */
export function shareBasisOf(quote: string): ShareBasis | null {
  if (/\b(revenues?|net sales|sales|billings|shipments)\b/i.test(quote)) return "revenue";
  if (/\breceivables?\b/i.test(quote)) return "receivables";
  if (/\b(purchases|purchased|cost of (sales|goods|revenue)|spend)\b/i.test(quote)) return "purchases";
  return null;
}

/** Words too common in company names to show which company a quote names. */
const GENERIC = new Set(
  "general american national international united global first new advanced applied energy systems solutions technologies technology semiconductor semiconductors pharmaceuticals pharmaceutical pharma therapeutics biosciences sciences health healthcare motor motors airlines air airways industries industrial electric electronics communications networks services financial capital partners resources products manufacturing materials medical devices software data digital group holdings company corporation".split(" "),
);

/**
 * Whether the quote names the counterparty: the name the model says it
 * used, the full name, a distinctive word of it ("Nvidia" for "Nvidia
 * Corporation", "Stellantis" for "Stellantis N.V."), or its initials ("GM"
 * for "General Motors"). Pure.
 */
export function namedIn(quote: string, nameInQuote: string, counterparty: string): boolean {
  const q = normalizeForMatch(quote);
  for (const n of [nameInQuote, counterparty]) {
    const s = normalizeForMatch(n);
    if (s.length >= 2 && q.includes(s)) return true;
  }
  const qWords = new Set(q.split(/[^a-z0-9&]+/).filter(Boolean));
  const words = normalizeForMatch(counterparty)
    .replace(LEGAL, " ")
    .split(/[^a-z0-9&]+/)
    .filter((w) => w.length > 0);
  if (words.some((w) => w.length >= 4 && !GENERIC.has(w) && qWords.has(w))) return true;
  const initials = words.filter((w) => w !== "and" && w !== "of").map((w) => w[0]).join("");
  return initials.length >= 2 && new RegExp(`\\b${initials.toUpperCase()}\\b`).test(quote);
}

function quoteHasNumber(quote: string, n: number): boolean {
  return (quote.match(/\d+(?:\.\d+)?/g) ?? []).some((s) => Number(s) === n);
}

const LEGAL = /\b(the|inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|lp|n\.?v|s\.?a|ag|se|holdings?|group)\b\.?/g;

/** Two names for the same company, legal suffixes aside ("Walmart Inc." vs "WALMART INC"). Pure. */
export function sameCompany(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[.,'’"()]/g, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  const x = n(a);
  const y = n(b);
  return x.length >= 3 && x === y;
}

/** The pilot's edge: the seed graph's shape plus where in the filing and how it was read. */
export type ExtractedEdge = GraphEdge & {
  accession: string;
  section: string;
  /** What `disclosedSharePct` is a share of; null without a share. */
  shareBasis: ShareBasis | null;
  soleSource: boolean;
  /** How the counterparty's ticker was found (src/graph/resolve.ts), or "unresolved". */
  resolvedBy: string;
  extractor: string;
  /** Stage B: whether the second read supports the link; absent when none ran. */
  verified?: boolean;
  /** Stage B read the relation differently: the stage A category it replaced. */
  extractedAs?: EdgeCategory;
};

/**
 * An edge after stage B's verdict: dropped when not supported; the verdict's
 * relation replaces stage A's when they differ (the id follows). Pure.
 */
export function applyVerdict<E extends ExtractedEdge>(e: E, v: Verdict | undefined): E | null {
  if (!v) return e;
  if (!v.supported || v.relation === "none") return null;
  if (v.relation === e.category) return { ...e, verified: true };
  // A share or a sole source was read for stage A's relation; it does not carry over.
  const moved: E = { ...e, verified: true, extractedAs: e.category, category: v.relation, disclosedSharePct: null, shareBasis: null, soleSource: false, tier: e.tier === "critical" ? "important" : e.tier };
  return { ...moved, id: edgeIdOf(moved) };
}

export function edgeKey(e: Pick<GraphEdge, "from" | "to" | "toName" | "category">): string {
  return `${e.from}|${e.to ?? `name:${normalizeForMatch(e.toName)}`}|${e.category}`;
}

export function edgeIdOf(e: Pick<GraphEdge, "from" | "to" | "toName" | "category">): string {
  return `${e.from}:${e.category}:${e.to ?? e.toName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

const TIER_RANK: Record<StrengthTier, number> = { critical: 3, important: 2, marginal: 1 };

/**
 * One edge per (filer, counterparty, category): the stronger tier wins, then
 * the one with a share, then the longer quote. Pure.
 */
export function dedupeEdges<E extends ExtractedEdge>(edges: E[]): E[] {
  const by = new Map<string, E>();
  for (const e of edges) {
    const k = edgeKey(e);
    const known = by.get(k);
    if (
      !known ||
      TIER_RANK[e.tier] > TIER_RANK[known.tier] ||
      (TIER_RANK[e.tier] === TIER_RANK[known.tier] && (e.disclosedSharePct ?? -1) > (known.disclosedSharePct ?? -1))
    ) {
      by.set(k, e);
    }
  }
  return [...by.values()].sort((a, b) => a.from.localeCompare(b.from) || edgeKey(a).localeCompare(edgeKey(b)));
}

// ---------------------------------------------------------------------------
// Stage B: an independent read of each kept link against its quote alone.

export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "supported", "relation"],
        properties: {
          n: { type: "integer", description: "The claim's number." },
          supported: { type: "boolean", description: "True when the quote alone shows a current business link between the filer and the named company." },
          relation: { type: "string", enum: [...RELATIONS, "none"], description: "What the named company is to the filer according to the quote; none when there is no link." },
        },
      },
    },
  },
} as const;

export const VERIFY_SYSTEM = `You check claimed business links read from a company's annual report. For each numbered claim you get the filer, a named company and a quote from the filer's filing. Decide from the quote alone. ${UNTRUSTED_NOTE.replace("between <filing> tags", "inside the quotes")}

- supported: the quote shows the named company is a current customer, supplier, competitor or partner of the filer. False for a biography; an acquisition, merger or divestiture; an equity investment, stake or offer for shares (the filer investing in the company, or the company in the filer); a lender; a lawsuit; a mere example; a past relationship that ended; or when the named company is not the one the quote is about.
- relation: what the named company is TO THE FILER. customer: buys from the filer or is a share of its revenue (distributors that buy from the filer are customers). supplier: the filer buys from it, licenses from it or relies on it to make, host or deliver. competitor: the filer competes with it. partner: collaboration, joint venture, co-development or alliance. none when not supported.`;

export function verifyUser(filer: { name: string; ticker: string }, claims: Array<{ counterparty: string; quote: string }>): string {
  const lines = claims.map((c, i) => `${i + 1}. Named company: ${c.counterparty}\n   Quote: "${c.quote}"`);
  return `Filer: ${filer.name} (${filer.ticker})\n<filing>\n${lines.join("\n")}\n</filing>`;
}

export type Verdict = { n: number; supported: boolean; relation: EdgeCategory | "none" };

/** Verdicts by claim number (1-based); malformed rows dropped. Pure. */
export function parseVerdicts(json: unknown): Map<number, Verdict> {
  const out = new Map<number, Verdict>();
  const rows = (json as { verdicts?: unknown[] } | null)?.verdicts;
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const v = r as Partial<Verdict>;
    if (typeof v.n !== "number" || typeof v.supported !== "boolean") continue;
    const rel = v.relation;
    if (rel !== "none" && !(RELATIONS as readonly string[]).includes(String(rel))) continue;
    out.set(v.n, { n: v.n, supported: v.supported, relation: rel as Verdict["relation"] });
  }
  return out;
}

/** The model's raw answer as links; malformed rows dropped. Pure. */
export function parseLinks(json: unknown): RawLink[] {
  const rows = (json as { links?: unknown[] } | null)?.links;
  if (!Array.isArray(rows)) return [];
  const out: RawLink[] = [];
  for (const r of rows) {
    const l = r as Partial<RawLink>;
    if (typeof l.counterparty !== "string" || typeof l.quote !== "string") continue;
    if (!(RELATIONS as readonly string[]).includes(String(l.relation))) continue;
    out.push({
      counterparty: l.counterparty,
      name_in_quote: typeof l.name_in_quote === "string" ? l.name_in_quote : "",
      relation: l.relation as RawLink["relation"],
      kind: (KINDS as readonly string[]).includes(String(l.kind)) ? (l.kind as RawLink["kind"]) : "other",
      quote: l.quote,
      section: typeof l.section === "string" ? l.section : "",
      share_text: typeof l.share_text === "string" ? l.share_text : "",
      sole_source: l.sole_source === true,
      strength: (STRENGTHS as readonly string[]).includes(String(l.strength)) ? (l.strength as RawLink["strength"]) : "list",
      us_ticker: typeof l.us_ticker === "string" ? l.us_ticker.trim().toUpperCase() : "",
    });
  }
  return out;
}
