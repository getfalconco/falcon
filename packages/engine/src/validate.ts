/**
 * Checks on everything the engine writes, against the @falcon/ripple
 * contract and the framing rule (vault: Legal and Compliance): information
 * about what happened and what the record shows, never a call to act.
 *
 * Pure. Each check returns a list of problems; empty means it passes.
 */

import { bestTier, cardConfidenceOf, TIERS, type Confidence, type Direction, type LinkEvidence, type Relation, type RippleCard, type RippleEvent, type RippleHistory, type RippleHit, type RippleSinceEvent, type SightingsFeed } from "@falcon/ripple";

const DIRECTIONS: readonly Direction[] = ["up", "down", "unclear"];
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];
const RELATIONS: readonly Relation[] = ["customer", "supplier", "competitor", "peer", "self"];
const LINK_CLARITIES = ["direct", "inferred", "weak"];
/** Where link evidence may come from: SEC filings, and (v1) the Federal Register, BIS and war.gov for government events. */
const EVIDENCE_HOSTS = /^https:\/\/(www\.sec\.gov|www\.federalregister\.gov|www\.bis\.gov|www\.war\.gov)\//;
const KINDS: readonly RippleEvent["kind"][] = ["earnings_surprise", "guidance", "filing", "news"];

/** Words that turn information into advice, a promise or hype. */
const ADVICE = [
  // "Customers buy wafers" is information; "buy the stock" is advice.
  /\b(buy|sell|hold)(ing)? (rating|signal|call|the (stock|shares|dip)|now)\b/i,
  /\b(time|good|great|chance) to (buy|sell|add|trim)\b/i,
  /\b(a|strong) (buy|sell)\b/i,
  /\bshould\b/i,
  /\bopportunit(y|ies)\b/i,
  /\brecommend\w*/i,
  /\b(price )?target\b/i,
  /\bundervalued\b|\bovervalued\b/i,
  /\b(go(ing)?|long|short) (on|the stock)\b/i,
  /\bguarantee\w*/i,
  /\bmust\b/i,
  /\bwill (rise|fall|rally|surge|soar|jump|drop|climb|outperform|underperform)\b/i,
  /\b(soar|skyrocket|explode|moon|rocket|massive|huge|blockbuster|game[- ]?chang\w*)\b/i,
  /\bprice (will|to) /i,
  /\bshares? (will|are set to|are likely to)\b/i,
  /\boutperform\w*|\bunderperform\w*/i,
];

/** UI copy rules: no em dashes, no emojis, no sparkle labels. */
const STYLE = [/—/, /\p{Extended_Pictographic}/u];

export function framingProblems(text: string, where: string): string[] {
  const out: string[] = [];
  for (const re of ADVICE) if (re.test(text)) out.push(`${where}: advice or hype wording (${re.source})`);
  for (const re of STYLE) if (re.test(text)) out.push(`${where}: em dash or emoji`);
  return out;
}

/** Numbers written in a text ("59.7", "$1.622", "12%"), as bare digit strings. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(\.\d+)?/g)].map((m) => m[0].replace(/,/g, "").replace(/\.0+$/, ""));
}

/**
 * Numbers in `text` that none of the `sources` contain: what the model must
 * not invent. Small counting words are fine; years and quarter numbers count
 * as numbers too, so a mechanism cannot date anything the sources do not.
 */
export function inventedNumbers(text: string, sources: string[]): string[] {
  const known = new Set(sources.flatMap(numbersIn));
  return [...new Set(numbersIn(text))].filter((n) => !known.has(n) && !/^[1-5]$/.test(n));
}

function isIso(s: unknown): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
}

function nonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

export function evidenceProblems(e: LinkEvidence, where: string): string[] {
  const out: string[] = [];
  if (!nonEmpty(e.quote) || e.quote.length < 20) out.push(`${where}: quote missing or too short`);
  if (!nonEmpty(e.form)) out.push(`${where}: form missing`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.filedAt ?? "")) out.push(`${where}: filedAt not a date`);
  if (!EVIDENCE_HOSTS.test(e.url ?? "")) out.push(`${where}: url is not an SEC filing or a government source`);
  return out;
}

/** The text with a company's name taken out, for the framing check. Pure. */
export function withoutName(text: string, name: string | undefined): string {
  return name && name.trim().length > 1 ? text.split(name).join("the company") : text;
}

export function hitProblems(h: RippleHit, where: string): string[] {
  const out: string[] = [];
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(h.ticker ?? "")) out.push(`${where}: bad ticker`);
  if (!nonEmpty(h.companyName)) out.push(`${where}: companyName missing`);
  if (!RELATIONS.includes(h.relation)) out.push(`${where}: bad relation`);
  if (h.degree !== 1 && h.degree !== 2) out.push(`${where}: degree must be 1 or 2`);
  if (h.degree === 2 && !nonEmpty(h.via)) out.push(`${where}: degree 2 needs via`);
  if (h.relation === "self" && h.degree !== 1) out.push(`${where}: a self hit is degree 1`);
  if (h.degree === 1 && h.via !== undefined) out.push(`${where}: degree 1 has no via`);
  if (!DIRECTIONS.includes(h.direction)) out.push(`${where}: bad direction`);
  if (!CONFIDENCES.includes(h.confidence)) out.push(`${where}: bad confidence`);
  if (!nonEmpty(h.window)) out.push(`${where}: window missing`);
  if (!nonEmpty(h.mechanism)) out.push(`${where}: mechanism missing`);
  else {
    const n = h.mechanism.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
    if (n > 2) out.push(`${where}: mechanism longer than two sentences`);
    if (h.mechanism.length > 420) out.push(`${where}: mechanism too long`);
    // A company's own name ("Target Hospitality") is not advice wording.
    out.push(...framingProblems(withoutName(h.mechanism, h.companyName), `${where}.mechanism`));
  }
  if (!Array.isArray(h.evidence) || h.evidence.length === 0) out.push(`${where}: no evidence`);
  else h.evidence.forEach((e, i) => out.push(...evidenceProblems(e, `${where}.evidence[${i}]`)));
  if (h.degree === 2 && Array.isArray(h.evidence) && h.evidence.length < 2) out.push(`${where}: degree 2 needs a quote for each link`);
  if (h.history !== null) out.push(...historyProblems(h.history, `${where}.history`, h.direction));
  if (h.score !== undefined && !(typeof h.score === "number" && Number.isFinite(h.score) && h.score >= 0 && h.score <= 100)) out.push(`${where}: score must be 0 to 100`);
  if (h.scoreReason !== undefined) {
    if (!nonEmpty(h.scoreReason)) out.push(`${where}: scoreReason empty`);
    else {
      if (h.scoreReason.length > 200) out.push(`${where}: scoreReason too long`);
      if (h.scoreReason.split(/(?<=[.!?])\s+(?=[A-Z])/).length > 1) out.push(`${where}: scoreReason longer than one sentence`);
      out.push(...framingProblems(h.scoreReason, `${where}.scoreReason`));
    }
  }
  if (h.sinceEvent !== undefined && h.sinceEvent !== null) out.push(...sinceEventProblems(h.sinceEvent, `${where}.sinceEvent`));
  if (h.votes !== undefined) {
    const v = h.votes as Record<string, unknown> | null;
    const keys = ["up", "down", "unclear", "excluded"] as const;
    if (!v || keys.some((k) => !Number.isInteger(v[k]) || (v[k] as number) < 0)) out.push(`${where}: votes must be whole counts`);
    else if (h.direction !== "unclear" && (v[h.direction] as number) === 0) out.push(`${where}: no vote for the hit's direction`);
  }
  if (h.analysts !== undefined && h.analysts !== null && !(Number.isInteger(h.analysts) && h.analysts >= 0 && h.analysts < 500)) out.push(`${where}: analysts must be a whole number or null`);
  if (h.pricedIn !== undefined && typeof h.pricedIn !== "boolean") out.push(`${where}: pricedIn must be true or false`);
  if (h.pricedIn === true && (!h.sinceEvent || h.sinceEvent.pricedInAtPct === null || !h.history)) out.push(`${where}: priced in without a measured move and record`);
  if (h.tier !== undefined && !TIERS.includes(h.tier)) out.push(`${where}: bad tier`);
  if (h.linkClarity !== undefined && !LINK_CLARITIES.includes(h.linkClarity)) out.push(`${where}: bad linkClarity`);
  if (h.documentedBy !== undefined) {
    const d = h.documentedBy;
    if (!d || !nonEmpty(d.citation) || !/^https:\/\//.test(d.url ?? "") || !nonEmpty(d.effect) || !nonEmpty(d.period) || (d.match !== "exact" && d.match !== "analogous")) out.push(`${where}: documentedBy incomplete`);
  }
  if (h.tier === "documented" && h.documentedBy === undefined) out.push(`${where}: a documented hit needs documentedBy`);
  if (h.invalidatedBy !== undefined) {
    if (!nonEmpty(h.invalidatedBy) || h.invalidatedBy.length > 240) out.push(`${where}: invalidatedBy empty or too long`);
    else out.push(...framingProblems(h.invalidatedBy, `${where}.invalidatedBy`));
  }
  if (h.opportunityEligible !== undefined) {
    if (typeof h.opportunityEligible !== "boolean") out.push(`${where}: opportunityEligible must be true or false`);
    else if (h.opportunityEligible) {
      if (h.pricedIn === true || h.direction === "unclear") out.push(`${where}: opportunityEligible on a priced-in or unclear hit`);
      // v1: Measured, or Documented (interim rule); v0 cards without a tier: a record and not low.
      if (h.tier !== undefined) {
        if (h.tier === "watch") out.push(`${where}: opportunityEligible on a watch hit`);
      } else if (h.confidence === "low" || !h.history) out.push(`${where}: opportunityEligible on a low or unrecorded hit`);
    }
  }
  return out;
}

/** A since-event move must look like one: a plausible percent and dates in order. Pure. */
export function sinceEventProblems(x: RippleSinceEvent, where: string): string[] {
  const out: string[] = [];
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof x.movePct !== "number" || !Number.isFinite(x.movePct) || Math.abs(x.movePct) > 200) out.push(`${where}: movePct not a plausible percent`);
  if (!date.test(x.fromDate ?? "") || !date.test(x.reactionDate ?? "") || !date.test(x.asOf ?? "")) out.push(`${where}: dates must be YYYY-MM-DD`);
  else if (!(x.fromDate < x.reactionDate && x.reactionDate <= x.asOf)) out.push(`${where}: dates out of order`);
  if (!nonEmpty(x.benchmark)) out.push(`${where}: benchmark missing`);
  if (x.pricedInAtPct !== null && (typeof x.pricedInAtPct !== "number" || !Number.isFinite(x.pricedInAtPct))) out.push(`${where}: pricedInAtPct must be a number or null`);
  return out;
}

/**
 * A measured history (src/history.ts) must look like one: at least 6 events,
 * a whole count behind the hit rate, a window of 1 to 20 days, and no history
 * for an "unclear" hit. Pure.
 */
export function historyProblems(x: RippleHistory | undefined, where: string, direction: RippleHit["direction"]): string[] {
  if (!x || typeof x !== "object") return [`${where}: must be null or a measured history`];
  const out: string[] = [];
  if (direction === "unclear") out.push(`${where}: an unclear hit has no implied way to measure`);
  if (!Number.isInteger(x.sample) || x.sample < 6) out.push(`${where}: sample must be a whole number of at least 6`);
  if (typeof x.avgMovePct !== "number" || !Number.isFinite(x.avgMovePct) || Math.abs(x.avgMovePct) > 200) out.push(`${where}: avgMovePct not a plausible percent`);
  if (typeof x.hitRate !== "number" || !(x.hitRate >= 0 && x.hitRate <= 1)) out.push(`${where}: hitRate must be 0 to 1`);
  else if (Number.isInteger(x.sample) && Math.abs(x.hitRate * x.sample - Math.round(x.hitRate * x.sample)) > 0.01) out.push(`${where}: hitRate is not a count of the sample`);
  if (!Number.isInteger(x.windowDays) || x.windowDays < 1 || x.windowDays > 20) out.push(`${where}: windowDays must be 1 to 20`);
  for (const k of ["from", "to"] as const) if (x[k] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(x[k] ?? "")) out.push(`${where}: ${k} not a date`);
  if (x.events !== undefined) {
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!Array.isArray(x.events)) out.push(`${where}: events must be a list`);
    else if (x.events.some((e) => !e || !nonEmpty(e.accession) || !date.test(e.eventDate ?? "") || !date.test(e.reactionDate ?? "") || !Number.isFinite(e.movePct) || !Number.isFinite(e.benchmarkPct))) out.push(`${where}: an event in the record is incomplete`);
    else if (x.events.length !== x.sample) out.push(`${where}: events do not match the sample`);
  }
  return out;
}

export function eventProblems(e: RippleEvent, where: string): string[] {
  const out: string[] = [];
  if (!nonEmpty(e.id)) out.push(`${where}: id missing`);
  if (!nonEmpty(e.ticker)) out.push(`${where}: ticker missing`);
  if (!nonEmpty(e.companyName)) out.push(`${where}: companyName missing`);
  if (!KINDS.includes(e.kind)) out.push(`${where}: bad kind`);
  if (!nonEmpty(e.headline)) out.push(`${where}: headline missing`);
  if (!isIso(e.occurredAt)) out.push(`${where}: occurredAt not ISO`);
  if (!nonEmpty(e.summary)) out.push(`${where}: summary missing`);
  if (!e.source || !nonEmpty(e.source.url) || !nonEmpty(e.source.title) || !nonEmpty(e.source.publisher)) out.push(`${where}: source incomplete`);
  out.push(...framingProblems(`${e.headline} ${e.summary}`, `${where}.text`).filter((p) => !/advice/.test(p)));
  return out;
}

export function cardProblems(c: RippleCard, where = "card"): string[] {
  const out: string[] = [];
  if (!nonEmpty(c.id)) out.push(`${where}: id missing`);
  if (!nonEmpty(c.sector)) out.push(`${where}: sector missing`);
  if (!isIso(c.generatedAt)) out.push(`${where}: generatedAt not ISO`);
  if (!c.event) out.push(`${where}: event missing`);
  else out.push(...eventProblems(c.event, `${where}.event`));
  if (c.confidence !== undefined && !CONFIDENCES.includes(c.confidence)) out.push(`${where}: bad confidence`);
  if (c.pricedIn !== undefined && typeof c.pricedIn !== "boolean") out.push(`${where}: pricedIn must be true or false`);
  if (c.tier !== undefined && !TIERS.includes(c.tier)) out.push(`${where}: bad tier`);
  if (c.expiresAt !== undefined && !isIso(c.expiresAt)) out.push(`${where}: expiresAt not ISO`);
  if (!Array.isArray(c.hits) || c.hits.length === 0) out.push(`${where}: no hits`);
  else {
    c.hits.forEach((h, i) => out.push(...hitProblems(h, `${where}.hits[${i}]`)));
    const tickers = c.hits.map((h) => h.ticker);
    if (new Set(tickers).size !== tickers.length) out.push(`${where}: a company appears twice`);
    if (c.event && c.hits.some((h) => h.ticker === c.event.ticker && h.relation !== "self")) out.push(`${where}: the event company is listed as its own hit`);
    if (c.event && c.hits.some((h) => h.relation === "self" && h.ticker !== c.event.ticker)) out.push(`${where}: a self hit must be the event company`);
    if (c.tier !== undefined && bestTier(c.hits) !== null && c.tier !== bestTier(c.hits)) out.push(`${where}: tier must be the best of its hits'`);
    if (c.confidence !== undefined && c.confidence !== cardConfidenceOf(c.hits)) out.push(`${where}: confidence must be the highest of its directional hits'`);
  }
  return out;
}

export function feedProblems(f: SightingsFeed): string[] {
  const out: string[] = [];
  if (!isIso(f.generatedAt)) out.push("feed: generatedAt not ISO");
  if (!Array.isArray(f.cards)) return [...out, "feed: cards not a list"];
  f.cards.forEach((c, i) => out.push(...cardProblems(c, `cards[${i}]`)));
  const ids = f.cards.map((c) => c.id);
  if (new Set(ids).size !== ids.length) out.push("feed: duplicate card ids");
  return out;
}
