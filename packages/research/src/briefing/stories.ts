/**
 * Handover briefing: the stories the report leads with.
 *
 * "S&P 500 futures are down 0.39%" is a figure, and a reader who opens the app
 * to that figure alone has been told nothing. What they want first is what
 * happened: a held name reported results, a headline landed, a release printed.
 * Then how the tape or the name reacted, with the figures underneath as the
 * evidence. Then what that means for their book. This module assembles those
 * units from the report's own lists and figures.
 *
 * It writes in templates, and a template has no model in front of it to put a
 * third-party headline into other words, so it never quotes one: headlines are
 * counted and named by id in the evidence, never pasted. It never claims a
 * cause either. The reaction stands beside the event, and whether the two are
 * linked is left to the headline that says so, when one does. The model in
 * narrative.ts rewrites these stories in a colleague's voice and falls back to
 * them whenever it cannot be used.
 *
 * Pure and renderer-safe: types only, so the renderer's demo builds its stories
 * with this code instead of a copy. The only clock is `generated_at`.
 */

import type {
  BriefingHandover,
  BriefingReport,
  HeldFiling,
  HeldMover,
  HeldNewsItem,
  Implication,
  MarketGroup,
  MarketRow,
  MarketUnit,
  Story,
  StoryReaction,
} from "./types.js";

export type StoryInput = Pick<
  BriefingReport,
  "generated_at" | "window" | "overnight" | "held_coverage" | "book" | "headlines" | "implications" | "calendar_today" | "earnings_next"
> & {
  /**
   * True when the market-news port failed, so an empty `headlines` is a feed
   * that did not answer rather than a quiet night, and the market story says
   * so instead of calling the tape quiet. Optional: absent reads as "the feed
   * answered", which is what a full gather gives.
   */
  market_news_unavailable?: boolean;
};

/** The contract's cap: past six, the lead is the report again. */
export const MAX_STORIES = 6;

/**
 * A held name's move earns a story of its own at 1% or at one and a half of
 * its normal days. Below both it is a quiet night for the name, and a story
 * about it would be the table read aloud.
 */
const MIN_NAME_MOVE_PCT = 1;
const MIN_NAME_MOVE_Z = 1.5;

/** A region reads as "across the board" past an average move of 1%, every row the same way. */
const MIN_REGION_MOVE_PCT = 1;

/** Below a tenth of a normal day the multiple prints as "0 times", which says nothing. */
const MIN_SPOKEN_Z = 0.1;

const MAX_HEADLINE_EVIDENCE = 5;
const MAX_FORM_CHARS = 20;

/** The two US contracts a market story is measured on; the others are in the table. */
const FUTURES_SYMBOLS: readonly string[] = ["ES=F", "NQ=F"];
const VIX_SYMBOL = "^VIX";

const REGIONS: ReadonlyArray<{ group: MarketGroup; label: string }> = [
  { group: "asia", label: "Asia" },
  { group: "europe", label: "Europe" },
];

/** An 8-K item 2.02 is results of operations; a chain label spells the item name out as well. */
const RESULTS_FILING = /\b2\.02\b|\bresults\b/i;
const INSIDER_FILING = /\bform\s*4\b|\binsider\b/i;

/** Control characters, flattened before any text lands in a one-line sentence. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
/** Figure dash, en dash, em dash, horizontal bar. */
const LONG_DASHES = /[\u2012-\u2015]/g;

/**
 * How the night is named, so a Monday report does not call a whole weekend
 * "overnight". Once the session is open the headlines run into the morning's
 * trading as well, and "since the close" is the only opener that is still true.
 */
const OPENER: Record<BriefingHandover, string> = {
  overnight: "Overnight",
  weekend: "Over the weekend",
  holiday: "Over the holiday break",
};
const IN_SESSION_OPENER = "Since the close";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Arrays from another process (the demo builds its report in the renderer) are not trusted to be arrays. */
function list<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * A symbol as it may appear in a sentence. The contract keeps "$" out of every
 * sentence, and a ticker is the one piece of text here that arrives from a
 * user's typing, so anything outside a symbol's shape is dropped.
 */
function symbol(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "") : "";
}

/**
 * A label or title written by another module. Those are held to the copy rules
 * where they are written; this only guarantees the two properties the contract
 * states outright, no "$" and no long dash, whoever wrote the text.
 */
function plain(text: unknown, maxChars = 400): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(CONTROL_CHARS, " ").replace(/\$/g, "").replace(LONG_DASHES, "-").replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? flat.slice(0, maxChars).trimEnd() : flat;
}

/** A figure the report already carries, quoted as given: at most two decimals, no trailing zeros. */
function given(value: number): string {
  return String(roundTo(Math.abs(value), 2));
}

const UNIT_SUFFIX: Record<MarketUnit, string> = { pct: "%", bp: " bp", pts: " pts" };

/** "up 0.42%", "down 0.55 pts", "flat". Two decimals at most, as the table prints them. */
function moveWords(move: number, unit: MarketUnit = "pct"): string {
  const size = given(move);
  if (size === "0") return "flat";
  return `${move > 0 ? "up" : "down"} ${size}${UNIT_SUFFIX[unit]}`;
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function instant(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** A row whose move is an overnight figure: its own session traded since the last US close. */
function fresh(row: MarketRow | undefined): row is MarketRow & { move: number } {
  return !!row && (row.state === "live" || row.state === "final") && finite(row.move) !== null;
}

function reactionOf(row: MarketRow & { move: number }): StoryReaction {
  return { label: plain(row.label), symbol: row.symbol, move: row.move, unit: row.unit };
}

// ---------------------------------------------------------------------------
// What every rule reads
// ---------------------------------------------------------------------------

type Context = {
  input: StoryInput;
  nowMs: number | null;
  sinceMs: number | null;
  markets: MarketRow[];
  implications: Implication[];
  futures: Array<MarketRow & { move: number }>;
  vix: (MarketRow & { move: number }) | null;
};

function context(input: StoryInput): Context {
  const markets = list(input.overnight?.markets).filter((row): row is MarketRow => !!row && typeof row === "object");
  const vix = markets.find((row) => row.symbol === VIX_SYMBOL);
  return {
    input,
    nowMs: instant(input.generated_at),
    sinceMs: instant(input.window?.overnight_since),
    markets,
    implications: list(input.implications).filter((i): i is Implication => !!i && typeof i === "object" && typeof i.id === "string"),
    // Kept in the order of the symbols, so the sentence always reads S&P then Nasdaq.
    futures: FUTURES_SYMBOLS.map((s) => markets.find((row) => row.symbol === s)).filter(fresh),
    vix: fresh(vix) ? vix : null,
  };
}

/**
 * The futures sentence every market-side story shares: only rows that printed
 * since the close, the VIX level beside its move because a VIX move without
 * the level it moved to says little.
 */
function futuresSentence(ctx: Context): string {
  if (ctx.futures.length === 0) return "US futures carry no move since the close";
  const parts = ctx.futures.map((row, i) => `${plain(row.label)} ${i === 0 ? "are " : ""}${moveWords(row.move, row.unit)}`);
  let text = `${listOf(parts)} since the close`;
  const level = finite(ctx.vix?.last);
  if (ctx.vix && level !== null) text += `; VIX ${moveWords(ctx.vix.move, ctx.vix.unit)} at ${given(level)}`;
  return text;
}

/** The chips mirror the sentence: no futures, no VIX chip beside a sentence that names neither. */
function futuresReactions(ctx: Context): StoryReaction[] {
  if (ctx.futures.length === 0) return [];
  return [...ctx.futures, ...(ctx.vix ? [ctx.vix] : [])].map(reactionOf);
}

function implicationById(ctx: Context, id: string): Implication | null {
  return ctx.implications.find((i) => i.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// scope "name"
// ---------------------------------------------------------------------------

type NameEvidence = {
  ticker: string;
  /** Every listed headline on the name since the close, whichever band. */
  news: HeldNewsItem[];
  priority: HeldNewsItem[];
  results: HeldFiling[];
  insider: HeldFiling[];
  other: HeldFiling[];
  mover: HeldMover | null;
  /** The name's own move, when it is large enough to carry a story by itself. */
  moved: boolean;
};

function emptyEvidence(ticker: string): NameEvidence {
  return { ticker, news: [], priority: [], results: [], insider: [], other: [], mover: null, moved: false };
}

function sinceClose(ctx: Context, at: unknown): boolean {
  const ms = instant(at);
  // An item whose timestamp cannot be read is one the report carries, whatever
  // its date says, the same rule the conclusions count headlines by.
  return ms === null || ctx.sinceMs === null || ms >= ctx.sinceMs;
}

function collectNames(ctx: Context): NameEvidence[] {
  const byTicker = new Map<string, NameEvidence>();
  const evidence = (ticker: string): NameEvidence => {
    let found = byTicker.get(ticker);
    if (!found) {
      found = emptyEvidence(ticker);
      byTicker.set(ticker, found);
    }
    return found;
  };

  for (const item of list(ctx.input.overnight?.held_news)) {
    if (!item || typeof item !== "object" || !sinceClose(ctx, item.published_at)) continue;
    // A syndicated article reaches every held name it mentions; each of them
    // has the headline, so each of them is a candidate.
    for (const raw of [item.ticker, ...list(item.also)]) {
      const ticker = symbol(raw);
      if (ticker === "") continue;
      const own = evidence(ticker);
      own.news.push(item);
      if (item.band === "P0" || item.band === "P1") own.priority.push(item);
    }
  }

  for (const filing of list(ctx.input.overnight?.filings)) {
    const ticker = symbol(filing?.ticker);
    if (!filing || ticker === "" || !sinceClose(ctx, filing.filed_at)) continue;
    const label = plain(filing.label);
    const own = evidence(ticker);
    if (RESULTS_FILING.test(label)) own.results.push(filing);
    else if (filing.kind === "insider" || INSIDER_FILING.test(label)) own.insider.push(filing);
    else own.other.push(filing);
  }

  for (const mover of list(ctx.input.overnight?.held_movers)) {
    const ticker = symbol(mover?.ticker);
    if (!mover || ticker === "") continue;
    const own = byTicker.get(ticker) ?? emptyEvidence(ticker);
    // The engine lists each name once; a list built elsewhere (the demo) may
    // not, and the first row is the one the book was priced on.
    if (own.mover !== null) continue;
    own.mover = mover;
    const move = finite(mover.move_pct);
    const z = finite(mover.move_z);
    // A flagged move is a split or a print too large to trust; a story drawn
    // from it would present a bookkeeping artefact as the name's night.
    own.moved =
      mover.flag === null && move !== null && (Math.abs(move) >= MIN_NAME_MOVE_PCT || (z !== null && Math.abs(z) >= MIN_NAME_MOVE_Z));
    if (own.moved) byTicker.set(ticker, own);
  }

  return [...byTicker.values()].filter((e) => e.priority.length > 0 || e.results.length + e.insider.length + e.other.length > 0 || e.moved);
}

/** "a new 8-K": the form code off the chain's label, never the item names, which nest brackets. */
function formOf(filing: HeldFiling): string {
  const form = plain(filing.label, MAX_FORM_CHARS).split(",")[0]!.trim();
  return form === "" || /^filing$/i.test(form) ? "SEC filing" : form;
}

function newest<T>(items: T[], at: (item: T) => unknown): T | null {
  let best: T | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const ms = instant(at(item)) ?? Number.NEGATIVE_INFINITY;
    if (best === null || ms > bestMs) {
      best = item;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * What happened, in the report's own words and never in a headline's. The
 * order is the order of how much a filing says: results outrank an insider
 * filing, which outranks the fact of headlines, which outranks a filing whose
 * item says nothing by name, which outranks a bare move.
 */
function nameWhat(e: NameEvidence): { what: string; at: string | null } {
  const t = e.ticker;
  if (e.results.length > 0) return { what: `${t} reported results`, at: newest(e.results, (f) => f.filed_at)?.filed_at ?? null };
  if (e.insider.length > 0) return { what: `${t} has an insider filing`, at: newest(e.insider, (f) => f.filed_at)?.filed_at ?? null };
  if (e.news.length > 0) {
    const n = e.news.length;
    return {
      what: `${t} is in the news since the close (${n} ${n === 1 ? "headline" : "headlines"})`,
      at: newest(e.news, (i) => i.published_at)?.published_at ?? null,
    };
  }
  if (e.other.length > 0) {
    const filing = newest(e.other, (f) => f.filed_at)!;
    return { what: `${t} filed a new ${formOf(filing)} since the close`, at: filing.filed_at ?? null };
  }
  return { what: `${t} moved on its own since the close`, at: e.mover?.as_of ?? null };
}

/** "The market explains about 0.71% of it": the conclusion's own figure, or nothing. */
function explainedShare(implication: Implication | null): string | null {
  const match = implication ? /market explains about (\d+(?:\.\d+)?)% of it/i.exec(plain(implication.because)) : null;
  return match ? match[1]! : null;
}

function nameReaction(e: NameEvidence, implication: Implication | null): { reaction: string; reactions: StoryReaction[] } {
  const t = e.ticker;
  const move = finite(e.mover?.move_pct);
  if (e.mover === null || move === null) return { reaction: `${t} has no usable quote since the close`, reactions: [] };
  if (e.mover.flag !== null) {
    return { reaction: `${t}'s move since the close is withheld while a split or other corporate action is checked`, reactions: [] };
  }
  let reaction = `${t} is ${moveWords(move)} since the close`;
  const z = finite(e.mover.move_z);
  if (z !== null && roundTo(Math.abs(z), 1) >= MIN_SPOKEN_Z) reaction += `, ${roundTo(Math.abs(z), 1)} times its normal day`;
  const share = explainedShare(implication);
  if (share !== null) reaction += ` and the market explains about ${share}% of it`;
  return { reaction, reactions: [{ label: t, symbol: t, move, unit: "pct" }] };
}

/** A headline is named by its incident, the id the chain gave the story it belongs to. */
function headlineId(item: HeldNewsItem): string {
  return plain(item.incident_id) || plain(item.url);
}

function nameStory(ctx: Context, e: NameEvidence): Story {
  const implication = implicationById(ctx, `name_specific:${e.ticker}`);
  const { what, at } = nameWhat(e);
  const { reaction, reactions } = nameReaction(e, implication);
  const evidence = [
    ...e.news.map(headlineId),
    ...[...e.results, ...e.insider, ...e.other].map((f) => plain(f.url) || plain(f.label)),
    ...(e.mover ? [`mover:${e.ticker}`] : []),
    ...(implication ? [implication.id] : []),
  ].filter((id) => id !== "");
  return {
    id: `story:name:${e.ticker}`,
    scope: "name",
    at,
    what,
    reaction,
    reactions,
    // The conclusion about the name is the meaning; without one, nothing
    // follows for the book from the event beyond the figures themselves.
    meaning: implication ? plain(implication.headline) || null : null,
    tickers: [e.ticker],
    evidence: [...new Set(evidence)],
    source: "template",
  };
}

// ---------------------------------------------------------------------------
// scope "market"
// ---------------------------------------------------------------------------

function tapeStory(ctx: Context): Story | null {
  // Without a US contract that printed since the close there is no reaction
  // to put beside the headlines, and headlines alone are the news list.
  if (ctx.futures.length === 0) return null;
  const opener = ctx.input.window?.phase === "in_session" ? IN_SESSION_OPENER : OPENER[ctx.input.window?.handover] ?? OPENER.overnight;
  const headlines = list(ctx.input.headlines).filter((h) => !!h && typeof h === "object");
  const n = headlines.length;
  let what: string;
  if (n > 0) what = `${opener}, the tape has ${n} market ${n === 1 ? "headline" : "headlines"}`;
  // A failed feed says nothing about the night; the sentence does not call it quiet.
  else if (ctx.input.market_news_unavailable === true) what = `${opener}, the market headlines could not be read for this report`;
  else what = `${opener}, the tape is quiet: no market headline since the close`;

  // The open indication is what the futures move means for the book; when it
  // could not be sized, the gap that stopped it is the meaning instead.
  const meaning = implicationById(ctx, "open_indication:book") ?? implicationById(ctx, "data_gap:futures");
  return {
    id: "story:market:tape",
    scope: "market",
    at: null,
    what,
    reaction: futuresSentence(ctx),
    reactions: futuresReactions(ctx),
    meaning: meaning ? plain(meaning.headline) || null : null,
    tickers: [],
    evidence: [
      ...ctx.futures.map((row) => row.symbol),
      ...headlines.slice(0, MAX_HEADLINE_EVIDENCE).map((h) => plain(h.id)).filter((id) => id !== ""),
      ...(meaning ? [meaning.id] : []),
    ],
    source: "template",
  };
}

/**
 * A region's session as one story, only when it reads one way: every row
 * printed, every row in the same state (all closed, or all still trading),
 * every move the same sign, and the average past 1%. A mixed region is the
 * table's job.
 */
function regionStory(ctx: Context, group: MarketGroup, label: string): Story | null {
  const rows = ctx.markets.filter((row) => row.group === group);
  if (rows.length === 0 || !rows.every(fresh)) return null;
  const state = rows[0]!.state;
  if (!rows.every((row) => row.state === state && row.unit === "pct")) return null;
  const sign = Math.sign(rows[0]!.move);
  if (sign === 0 || !rows.every((row) => Math.sign(row.move) === sign)) return null;
  const average = rows.reduce((sum, row) => sum + Math.abs(row.move), 0) / rows.length;
  if (average < MIN_REGION_MOVE_PCT) return null;

  const direction = sign > 0 ? "higher" : "lower";
  return {
    id: `story:market:${group}`,
    scope: "market",
    at: null,
    what: state === "final" ? `${label} closed ${direction} across the board` : `${label} is trading ${direction} across the board`,
    reaction: listOf(rows.map((row) => `${plain(row.label)} ${moveWords(row.move, row.unit)}`)),
    reactions: rows.map(reactionOf),
    meaning: null,
    tickers: [],
    evidence: rows.map((row) => row.symbol),
    source: "template",
  };
}

// ---------------------------------------------------------------------------
// scope "release"
// ---------------------------------------------------------------------------

function releaseStories(ctx: Context): Story[] {
  if (ctx.nowMs === null) return [];
  const out: Story[] = [];
  for (const item of list(ctx.input.calendar_today)) {
    if (!item || (item.kind !== "fomc" && item.kind !== "data") || !(item.importance >= 2)) continue;
    const at = instant(item.at);
    const clock = typeof item.time_et === "string" && /^\d{2}:\d{2}$/.test(item.time_et) ? item.time_et : null;
    if (at === null || clock === null || at >= ctx.nowMs) continue;
    const title = plain(item.title) || "A scheduled release";
    // A rate decision lands; a data release prints, as the conclusions word it.
    const verb = item.kind === "fomc" ? "landed" : "printed";
    const meaning = implicationById(ctx, `event_sensitivity:${item.id}`);
    out.push({
      id: `story:release:${item.id}`,
      scope: "release",
      at: item.at,
      what: `${title} ${verb} at ${clock} ET`,
      // The report measures futures from the close, never from the print: it
      // holds no level from just before the release, so "since the print"
      // would attribute the whole night to it.
      reaction: futuresSentence(ctx),
      reactions: futuresReactions(ctx),
      meaning: meaning ? plain(meaning.headline) || null : null,
      tickers: list(item.tickers).map(symbol).filter((t) => t !== ""),
      evidence: [item.id],
      source: "template",
    });
  }
  return out.sort((a, b) => (instant(a.at) ?? 0) - (instant(b.at) ?? 0) || byText(a.id, b.id));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The stories, most consequential first, at most six.
 *
 * A held name with a top-band headline or a results filing leads: it is the
 * reader's own name and the night's most specific event. The tape comes next,
 * then a region that moved as one, then the releases already printed in the
 * order of the day, then the remaining held names by the size of their move.
 * Ties fall to fixed orders, so the same report always gives the same list.
 */
export function deriveStories(input: StoryInput): Story[] {
  if (!input || typeof input !== "object") return [];
  const ctx = context(input);

  const names = collectNames(ctx);
  const leads = (e: NameEvidence): boolean => e.priority.length > 0 || e.results.length > 0;
  const rank = (e: NameEvidence): number => (e.results.length > 0 ? 0 : e.priority.some((n) => n.band === "P0") ? 1 : 2);
  const size = (e: NameEvidence): number => Math.abs(finite(e.mover?.move_pct) ?? 0);

  const leading = names.filter(leads).sort((a, b) => rank(a) - rank(b) || size(b) - size(a) || byText(a.ticker, b.ticker));
  const remaining = names.filter((e) => !leads(e)).sort((a, b) => size(b) - size(a) || byText(a.ticker, b.ticker));

  const stories: Story[] = [
    ...leading.map((e) => nameStory(ctx, e)),
    ...[tapeStory(ctx)].filter((s): s is Story => s !== null),
    ...REGIONS.map((r) => regionStory(ctx, r.group, r.label)).filter((s): s is Story => s !== null),
    ...releaseStories(ctx),
    ...remaining.map((e) => nameStory(ctx, e)),
  ];
  return stories.slice(0, MAX_STORIES);
}
