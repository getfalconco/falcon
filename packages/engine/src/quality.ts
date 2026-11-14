/**
 * Card tiers (docs/design/ripple-engine-v1.md, 7.1): every hit is Measured,
 * Documented or Watch, and the card takes the best of its hits. Screens read
 * `hit.tier` and `card.tier` and never re-derive them.
 *
 *   measured:   directional, liquid, not priced in, no watch-only flag, every
 *               link at least "named" in a filing quote, and the hit's family
 *               passes Falcon's own statistical test (data/family-stats.json:
 *               BH q <= 0.10, calendar-time t > 1.65, validation mean y > 0,
 *               n >= 300 over >= 100 event dates). That file does not exist
 *               until the family model runs (milestone 1b), so nothing is
 *               Measured yet.
 *   documented: directional, liquid, not priced in, no watch-only flag, links
 *               as for Measured, and the family is in data/evidence-registry.json
 *               with a primary citation and Falcon's own post-2015 estimate
 *               above 0; "analogous" evidence also needs the estimate's p < 0.20.
 *   watch:      everything else.
 *
 * Liquid: last price above $5 and, when known, a 20-day median dollar volume
 * of at least $5M. An unknown price is not liquid.
 *
 * The old fields stay for shipped app builds: `opportunityEligible` is true
 * only for a Measured hit, or (interim rule, design 7.3, flag
 * OPPORTUNITIES_INTERIM_DOCUMENTED, on by default) a Documented own-firm hit
 * whose evidence is an exact match. Pure, apart from the two file loaders.
 */

import fs from "node:fs";
import path from "node:path";
import type { Confidence, Direction, DocumentedBy, Relation, Tier } from "@falcon/ripple";
import { ENGINE_ROOT } from "./http.ts";

export const EVIDENCE_REGISTRY_PATH = path.join(ENGINE_ROOT, "data", "evidence-registry.json");
export const FAMILY_STATS_PATH = path.join(ENGINE_ROOT, "data", "family-stats.json");

// ---------------------------------------------------------------------------
// Inputs

export type OwnEstimate = {
  period: string;
  n: number;
  nEvents: number;
  windowDays: number;
  meanAbnPct: number;
  medianAbnPct: number;
  tStat: number;
  p: number;
  benchmark: string;
  computedAt: string;
};

export type RegistryFamily = {
  eventType: string;
  label: string;
  match: "exact" | "analogous";
  citation: string;
  url: string;
  effect: string;
  period: string;
  ownEstimate: OwnEstimate | null;
};

/** data/evidence-registry.json (written by the measurement workstream). */
export type EvidenceRegistry = { version: number; families: Record<string, RegistryFamily> };

/** One family's statistical result (data/family-stats.json, written by the family model in milestone 1b). */
export type FamilyStat = { bhQ: number; calendarT: number; validationMeanY: number; n: number; nEvents: number; computedAt?: string };
export type FamilyStats = { version: number; families: Record<string, FamilyStat> };

export const EMPTY_REGISTRY: EvidenceRegistry = { version: 1, families: {} };
export const EMPTY_STATS: FamilyStats = { version: 1, families: {} };

function readJson<T>(file: string, empty: T, log?: (l: string) => void): T {
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return empty;
  }
  try {
    const parsed = JSON.parse(body) as T & { families?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.families !== "object" || parsed.families === null) throw new Error("no families object");
    return parsed;
  } catch (err) {
    log?.(`  ${path.basename(file)} unreadable (${err instanceof Error ? err.message : String(err)}); treated as empty`);
    return empty;
  }
}

/** The evidence registry; absent or unreadable: empty (nothing is Documented). */
export function loadEvidenceRegistry(file = EVIDENCE_REGISTRY_PATH, log?: (l: string) => void): EvidenceRegistry {
  return readJson(file, EMPTY_REGISTRY, log);
}

/** The family statistics; absent or unreadable: empty (nothing is Measured). */
export function loadFamilyStats(file = FAMILY_STATS_PATH, log?: (l: string) => void): FamilyStats {
  return readJson(file, EMPTY_STATS, log);
}

/** Whether the interim Opportunities rule is on: env OPPORTUNITIES_INTERIM_DOCUMENTED, default on ("0", "false", "off" turn it off). */
export function interimDocumentedFlag(value: string | undefined = process.env.OPPORTUNITIES_INTERIM_DOCUMENTED): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !/^(0|false|off|no)$/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// Gates

export const MIN_PRICE_USD = 5;
export const MIN_MEDIAN_DOLLAR_VOLUME = 5_000_000;
export const MEASURED_RULES = { maxBhQ: 0.1, minCalendarT: 1.65, minN: 300, minEvents: 100 } as const;
/** Analogous evidence needs the own estimate's one-sided p below this. */
export const ANALOGOUS_MAX_P = 0.2;
/** Falcon's own estimate must start in or after this year. */
export const OWN_ESTIMATE_FROM_YEAR = 2015;

export type Liquidity = { price: number | null; medianDollarVolume20d: number | null };

/** Price above $5 and, when known, 20-day median dollar volume of $5M or more. Pure. */
export function isLiquid(l: Liquidity | null | undefined): boolean {
  if (!l || l.price === null || !Number.isFinite(l.price) || !(l.price > MIN_PRICE_USD)) return false;
  if (l.medianDollarVolume20d !== null && Number.isFinite(l.medianDollarVolume20d) && l.medianDollarVolume20d < MIN_MEDIAN_DOLLAR_VOLUME) return false;
  return true;
}

/** Whether a family passes Falcon's own statistical test (the Measured gate). Pure. */
export function familyPasses(stat: FamilyStat | null | undefined): boolean {
  if (!stat) return false;
  return (
    stat.bhQ <= MEASURED_RULES.maxBhQ &&
    stat.calendarT > MEASURED_RULES.minCalendarT &&
    stat.validationMeanY > 0 &&
    stat.n >= MEASURED_RULES.minN &&
    stat.nEvents >= MEASURED_RULES.minEvents
  );
}

/** Whether an own estimate's period starts in 2015 or later ("2015-01 to 2026-06"). Pure. */
export function postCutoffEstimate(e: Pick<OwnEstimate, "period">): boolean {
  const year = Number(/(\d{4})/.exec(e.period ?? "")?.[1]);
  return Number.isFinite(year) && year >= OWN_ESTIMATE_FROM_YEAR;
}

/** The registry entry that documents a family, or why it does not. Pure. */
export function documentation(family: string | null | undefined, registry: EvidenceRegistry): { documentedBy: DocumentedBy } | { why: string } {
  if (!family) return { why: "no family" };
  const f = registry.families[family];
  if (!f) return { why: `family ${family} not in the evidence registry` };
  if (!f.citation || !f.url) return { why: `family ${family} has no primary citation` };
  const own = f.ownEstimate;
  if (!own) return { why: `family ${family} has no own estimate yet` };
  if (!postCutoffEstimate(own)) return { why: `family ${family} own estimate is not post-2015` };
  if (!(own.meanAbnPct > 0)) return { why: `family ${family} own estimate is not above 0` };
  if (f.match !== "exact" && !(own.p < ANALOGOUS_MAX_P)) return { why: `family ${family} analogous evidence with own p ${own.p}` };
  return { documentedBy: { citation: f.citation, url: f.url, effect: f.effect, period: f.period, match: f.match } };
}

export type QualityInput = {
  family: string | null;
  direction: Direction;
  relation: Relation;
  liquidity: Liquidity | null;
  pricedIn: boolean;
  /** Detector flags that cap the event at Watch (anti-pump, shell, recent offering...). */
  watchOnlyReasons: readonly string[];
  /** The weakest link's tier on a linked path (src/rank.ts pathStrength); null for an own-firm hit. */
  linkTier: "disclosed" | "named" | "list" | null;
  /** Whether every link has a filing quote (own-firm: the event's own quotes). */
  quoted: boolean;
};

export type QualityContext = { registry: EvidenceRegistry; stats: FamilyStats; interimDocumented: boolean };

export type TierRead = {
  tier: Tier;
  /** Why the hit is not higher, plain phrases (for the run log). */
  why: string[];
  documentedBy?: DocumentedBy;
  opportunityEligible: boolean;
};

/** A hit's tier, the published research behind it, and its Opportunities flag. Pure. */
export function assignTier(q: QualityInput, ctx: QualityContext): TierRead {
  const base: string[] = [];
  if (q.direction === "unclear") base.push("no implied way");
  if (!isLiquid(q.liquidity)) base.push(q.liquidity?.price == null ? "price unknown" : "illiquid");
  if (q.pricedIn) base.push("priced in");
  if (q.watchOnlyReasons.length) base.push(...q.watchOnlyReasons.map((r) => `watch only: ${r}`));
  if (!q.quoted) base.push("a link has no quote");
  if (q.linkTier === "list") base.push("a link is only a list mention");

  const doc = documentation(q.family, ctx.registry);
  const documentedBy = "documentedBy" in doc ? doc.documentedBy : undefined;
  const stat = q.family ? ctx.stats.families[q.family] : undefined;

  if (base.length === 0 && familyPasses(stat)) {
    return { tier: "measured", why: [], ...(documentedBy ? { documentedBy } : {}), opportunityEligible: true };
  }
  const measuredWhy = familyPasses(stat) ? [] : [`family ${q.family ?? "none"} has not passed Falcon's own test`];
  if (base.length === 0 && documentedBy) {
    const interim = ctx.interimDocumented && q.relation === "self" && documentedBy.match === "exact";
    return { tier: "documented", why: measuredWhy, documentedBy, opportunityEligible: interim };
  }
  return { tier: "watch", why: [...base, ...measuredWhy, ...("why" in doc ? [doc.why] : [])], opportunityEligible: false };
}

const TIER_RANK: Record<Tier, number> = { watch: 0, documented: 1, measured: 2 };

/** Order of tiers for featuring: measured first. Pure. */
export function tierRank(t: Tier | undefined | null): number {
  return t ? TIER_RANK[t] : -1;
}

/** An own-firm hit's old-style confidence, for shipped app builds. Pure. */
export function tierConfidence(t: Tier): Confidence {
  return t === "measured" ? "high" : t === "documented" ? "medium" : "low";
}

// ---------------------------------------------------------------------------
// Expiry (design a6)

const DAY_MS = 86_400_000;

/**
 * The trading sessions a window in words spans at its upper end ("1 to 5
 * trading days" 5, "1 to 4 weeks" 20, "1 to 3 months" 63); 5 when the words
 * give no number. Uncapped. Pure.
 */
export function windowSessions(window: string): number {
  const m = /(\d+)(?:\s*(?:to|-|–)\s*(\d+))?\s*(trading days?|days?|sessions?|weeks?|months?)/i.exec(window);
  if (!m) return 5;
  const n = Number(m[2] ?? m[1]);
  const unit = m[3]!.toLowerCase();
  const days = unit.startsWith("week") ? n * 5 : unit.startsWith("month") ? n * 21 : n;
  return Math.max(1, Math.round(days));
}

/** Calendar days a card is served per trading session of its window. */
export const EXPIRY_DAYS_PER_SESSION = 1.5;

/** When a card stops being served: publish time + its longest hit window (sessions x1.5 calendar days, rounded up). Pure. */
export function expiresAtOf(publishedAt: string, windows: readonly string[]): string {
  const sessions = Math.max(1, ...windows.map(windowSessions));
  return new Date(Date.parse(publishedAt) + Math.ceil(sessions * EXPIRY_DAYS_PER_SESSION) * DAY_MS).toISOString();
}
