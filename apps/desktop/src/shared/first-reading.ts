import type { GraphEdge } from "./graph-types";
import { SECTOR_IDS, type SectorId } from "./user-preferences";

/**
 * The first reading: one or two sourced facts about the reader's own names,
 * shown when onboarding closes ("TSM is a supplier to NVDA (NVDA 10-K).
 * NVDA reports in 12 days.").
 *
 * Every fact is a record the app already holds: a relationship edge read out
 * of a company's annual filing, with that filing's form and date, or an
 * earnings date from the corporate calendar. Nothing is written here that the
 * data does not say, and when nothing qualifies the answer is an empty list,
 * which the screen says plainly.
 *
 * Pure: the renderer gathers the data (lib/onboarding-reading.ts) and words
 * the facts in the reader's language.
 */

export type ReadingEdge = Pick<
  GraphEdge,
  "root_ticker" | "counterparty_ticker" | "counterparty_name" | "category" | "confidence" | "strength" | "strength_tier"
> &
  Partial<Pick<GraphEdge, "filing_date" | "valid_from" | "form">>;

export type ReadingEarnings = {
  ticker: string;
  /** New York calendar date, YYYY-MM-DD. */
  date: string;
  /** The provider marks the date as its own projection. */
  estimated: boolean;
};

export const RELATION_CATEGORIES = ["supplier", "customer", "partner", "competitor", "dependency"] as const;
export type RelationCategory = (typeof RELATION_CATEGORIES)[number];

/** From `root`'s filing: `counterparty` is the root's {category}. */
export type RelationFact = {
  kind: "relation";
  counterparty: string;
  root: string;
  category: RelationCategory;
  form: "10-K" | "20-F" | null;
  /** YYYY-MM-DD, when the filing date is known. */
  filingDate: string | null;
};

export type EarningsFact = {
  kind: "earnings";
  ticker: string;
  date: string;
  /** Whole days from today; 0 is today. */
  days: number;
  estimated: boolean;
};

export type ReadingFact = RelationFact | EarningsFact;

export type FirstReadingInput = {
  /** The reader's names: typed holdings, watched names, or held paper positions. */
  tickers: readonly string[];
  edges: readonly ReadingEdge[];
  earnings: readonly ReadingEarnings[];
  /** Today, YYYY-MM-DD (New York). */
  today: string;
};

/** How far ahead an earnings date still counts as news about the position. */
export const EARNINGS_HORIZON_DAYS = 45;
export const MAX_FACTS = 2;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `from` to `to`, both YYYY-MM-DD; null when either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  if (!DATE.test(from) || !DATE.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function isRelationCategory(value: string): value is RelationCategory {
  return (RELATION_CATEGORIES as readonly string[]).includes(value);
}

/** Supply, demand and dependence move a position more directly than a named rival or partner does. */
const CATEGORY_WEIGHT: Record<RelationCategory, number> = {
  supplier: 2,
  customer: 2,
  dependency: 2,
  partner: 1,
  competitor: 0,
};

const TIER_WEIGHT: Record<string, number> = { critical: 2, important: 1, marginal: 0 };

const upper = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** The relation facts that touch the reader's names, best first, one per pair of companies. */
export function rankRelations(tickers: readonly string[], edges: readonly ReadingEdge[]): RelationFact[] {
  const held = new Set(tickers.map(upper));
  type Scored = { fact: RelationFact; score: number[] };
  const scored: Scored[] = [];
  for (const edge of edges) {
    const root = upper(edge.root_ticker);
    const cpTicker = upper(edge.counterparty_ticker);
    if (!root || !isRelationCategory(edge.category)) continue;
    const rootHeld = held.has(root);
    const cpHeld = cpTicker !== "" && held.has(cpTicker);
    if (!rootHeld && !cpHeld) continue;
    // A named private company or agency is a fact too, but a ticker is what the reader can place.
    const counterparty = cpTicker || edge.counterparty_name.trim();
    if (!counterparty || counterparty === root) continue;
    const filingDate = [edge.filing_date, edge.valid_from].find((d) => typeof d === "string" && DATE.test(d)) ?? null;
    scored.push({
      fact: {
        kind: "relation",
        counterparty,
        root,
        category: edge.category,
        form: edge.form === "10-K" || edge.form === "20-F" ? edge.form : null,
        filingDate,
      },
      score: [
        rootHeld && cpHeld ? 1 : 0,
        cpTicker ? 1 : 0,
        CATEGORY_WEIGHT[edge.category],
        TIER_WEIGHT[edge.strength_tier ?? ""] ?? 0,
        Number.isFinite(edge.strength) ? Number(edge.strength) : 0,
        Number.isFinite(edge.confidence) ? edge.confidence : 0,
      ],
    });
  }
  scored.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) {
      const d = b.score[i]! - a.score[i]!;
      if (d !== 0) return d;
    }
    return `${a.fact.root}|${a.fact.counterparty}`.localeCompare(`${b.fact.root}|${b.fact.counterparty}`);
  });
  const seen = new Set<string>();
  const out: RelationFact[] = [];
  for (const { fact } of scored) {
    const pair = [fact.root, fact.counterparty].sort().join("|");
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push(fact);
  }
  return out;
}

/** Each name's next earnings date within the horizon, soonest first. */
export function upcomingEarnings(
  tickers: readonly string[],
  earnings: readonly ReadingEarnings[],
  today: string,
): EarningsFact[] {
  const held = new Set(tickers.map(upper));
  const best = new Map<string, EarningsFact>();
  for (const row of earnings) {
    const ticker = upper(row.ticker);
    if (!held.has(ticker)) continue;
    const days = daysBetween(today, row.date);
    if (days === null || days < 0 || days > EARNINGS_HORIZON_DAYS) continue;
    const current = best.get(ticker);
    if (!current || days < current.days) {
      best.set(ticker, { kind: "earnings", ticker, date: row.date, days, estimated: row.estimated });
    }
  }
  return [...best.values()].sort((a, b) => a.days - b.days || a.ticker.localeCompare(b.ticker));
}

/**
 * At most two facts: the strongest relationship and the nearest earnings date
 * when both exist, otherwise the best two of whichever kind there is. A
 * second relationship prefers a name the first one did not touch, so two
 * lines cover two positions where they can.
 */
export function selectFirstReading(input: FirstReadingInput): ReadingFact[] {
  if (input.tickers.length === 0) return [];
  const relations = rankRelations(input.tickers, input.edges);
  const dates = upcomingEarnings(input.tickers, input.earnings, input.today);
  const facts: ReadingFact[] = [];
  if (relations[0]) facts.push(relations[0]);
  if (dates[0]) facts.push(dates[0]);
  if (facts.length < MAX_FACTS && relations.length > 1) {
    const held = new Set(input.tickers.map(upper));
    const first = relations[0]!;
    const touched = new Set([first.root, first.counterparty].filter((t) => held.has(t)));
    const other =
      relations.slice(1).find((r) => [r.root, r.counterparty].every((t) => !held.has(t) || !touched.has(t))) ??
      relations[1]!;
    facts.push(other);
  }
  if (facts.length < MAX_FACTS && dates.length > 1) facts.push(dates[1]!);
  return facts.slice(0, MAX_FACTS);
}

/**
 * The names the Tracker does not have yet. A name outside the tracked set has
 * no data until its year of history is fetched; the closing screen says so
 * rather than showing a blank.
 */
export function untrackedTickers(tickers: readonly string[], tracked: Iterable<string>): string[] {
  const known = new Set([...tracked].map(upper));
  return tickers.map(upper).filter((t, i, all) => t && !known.has(t) && all.indexOf(t) === i);
}

/**
 * The sectors setup no longer asks for, read off the reader's own names: the
 * corporate calendar files each name under a GICS sector, and the ones the
 * app's sector list shares are kept, in its order. A name the calendar could
 * not place adds nothing rather than a guess.
 */
const SECTOR_FROM_GICS: Readonly<Record<string, SectorId>> = {
  Technology: "technology",
  Energy: "energy",
  Healthcare: "healthcare",
  Financials: "financials",
  "Consumer Discretionary": "consumer",
  "Consumer Staples": "consumer",
  Industrials: "industrials",
};

export function sectorsFromCalendar(bySymbol: Readonly<Record<string, string | null>>): SectorId[] {
  const found = new Set<SectorId>();
  for (const gics of Object.values(bySymbol)) {
    const id = gics ? SECTOR_FROM_GICS[gics] : undefined;
    if (id) found.add(id);
  }
  return SECTOR_IDS.filter((id) => found.has(id));
}
