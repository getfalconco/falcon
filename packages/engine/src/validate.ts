/**
 * Checks on everything the engine writes, against the @falcon/ripple
 * contract and the framing rule (vault: Legal and Compliance): information
 * about what happened and what the record shows, never a call to act.
 *
 * Pure. Each check returns a list of problems; empty means it passes.
 */

import type { Confidence, Direction, LinkEvidence, Relation, RippleCard, RippleEvent, RippleHistory, RippleHit, SightingsFeed } from "@falcon/ripple";

const DIRECTIONS: readonly Direction[] = ["up", "down", "unclear"];
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];
const RELATIONS: readonly Relation[] = ["customer", "supplier", "competitor", "peer"];
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
  if (!/^https:\/\/www\.sec\.gov\//.test(e.url ?? "")) out.push(`${where}: url is not an SEC filing`);
  return out;
}

export function hitProblems(h: RippleHit, where: string): string[] {
  const out: string[] = [];
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(h.ticker ?? "")) out.push(`${where}: bad ticker`);
  if (!nonEmpty(h.companyName)) out.push(`${where}: companyName missing`);
  if (!RELATIONS.includes(h.relation)) out.push(`${where}: bad relation`);
  if (h.degree !== 1 && h.degree !== 2) out.push(`${where}: degree must be 1 or 2`);
  if (h.degree === 2 && !nonEmpty(h.via)) out.push(`${where}: degree 2 needs via`);
  if (h.degree === 1 && h.via !== undefined) out.push(`${where}: degree 1 has no via`);
  if (!DIRECTIONS.includes(h.direction)) out.push(`${where}: bad direction`);
  if (!CONFIDENCES.includes(h.confidence)) out.push(`${where}: bad confidence`);
  if (!nonEmpty(h.window)) out.push(`${where}: window missing`);
  if (!nonEmpty(h.mechanism)) out.push(`${where}: mechanism missing`);
  else {
    const n = h.mechanism.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
    if (n > 2) out.push(`${where}: mechanism longer than two sentences`);
    if (h.mechanism.length > 420) out.push(`${where}: mechanism too long`);
    out.push(...framingProblems(h.mechanism, `${where}.mechanism`));
  }
  if (!Array.isArray(h.evidence) || h.evidence.length === 0) out.push(`${where}: no evidence`);
  else h.evidence.forEach((e, i) => out.push(...evidenceProblems(e, `${where}.evidence[${i}]`)));
  if (h.degree === 2 && Array.isArray(h.evidence) && h.evidence.length < 2) out.push(`${where}: degree 2 needs a quote for each link`);
  if (h.history !== null) out.push(...historyProblems(h.history, `${where}.history`, h.direction));
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
  if (!Array.isArray(c.hits) || c.hits.length === 0) out.push(`${where}: no hits`);
  else {
    c.hits.forEach((h, i) => out.push(...hitProblems(h, `${where}.hits[${i}]`)));
    const tickers = c.hits.map((h) => h.ticker);
    if (new Set(tickers).size !== tickers.length) out.push(`${where}: a company appears twice`);
    if (c.event && tickers.includes(c.event.ticker)) out.push(`${where}: the event company is listed as its own hit`);
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
