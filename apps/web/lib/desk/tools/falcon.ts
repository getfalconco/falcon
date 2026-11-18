/**
 * Falcon AI's tools on Falcon's own data and app (server-only, read-only):
 * the Sightings feed, the filing graph, implied volatility (lib/desk/tools/iv.ts:
 * the daily options snapshot, or one capped on-demand OPRA snapshot) and a
 * company's profile, plus the app actions (lib/desk/app-actions.ts)
 * that operate the member's workspace. Same sources as /api/sightings,
 * /api/graph and /api/options, read directly (no HTTP to ourselves).
 *
 * runFalconTool never throws: failures come back as `{ error }` with ok false.
 */

import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { cardLive, opportunityCards, tierLabel, type RippleCard, type RippleHit, type SightingsFeed } from "@falcon/ripple";
import { optionsDisplayMode, optionsForViewer } from "@/lib/sightings-options";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ActionInputError, actionFromTool, actionLabel, actionTicker, isAppActionTool, type AppAction, type AppContext, type PortfolioWeight } from "../app-actions";
import type { DeskToolOutcome } from "./index";
import { IV_TOOL, IV_TOOL_NAME, ivTool, ivToolLabel } from "./iv";
import { ToolError, ToolPending, type ToolProgress } from "./util";
import { knownAsOf, parseAsOf, type PitShardEdge } from "@/lib/workspace/graph-pit";
import companySic from "../../../../../packages/engine/data/company-sic.json";

const ticker = { type: "string", description: "US stock ticker, e.g. NVDA, BRK.B.", minLength: 1, maxLength: 10 } as const;
const SECTORS = ["Communication Services", "Consumer Discretionary", "Consumer Staples", "Energy", "Financials", "Health Care", "Industrials", "Information Technology", "Materials", "Real Estate", "Utilities"];
const RELATIONS = ["customer", "supplier", "competitor", "partner"] as const;

export const FALCON_DATA_TOOLS = [
  {
    name: "falcon_sightings",
    description:
      "Falcon's own Sightings feed (what the Dashboard and Sightings list show): live event cards (earnings surprise, guidance, filing, news at one company) and the companies each one ripples to through filing links, with direction, confidence, the evidence label (Measured / Documented / Watch), the window, the mechanism and the filing quote. `list: \"opportunities\"` gives only today's Opportunities (the Dashboard's list, outside the member's portfolio); `list: \"portfolio\"` only cards touching the member's portfolio. Filter by ticker (the event company or a hit), sector or hit direction. Free, fast; use it for any question about Falcon's sightings, opportunities, ripples or what Falcon sees on a stock.",
    input_schema: {
      type: "object",
      properties: {
        list: { type: "string", enum: ["all", "opportunities", "portfolio"], description: "all (default), opportunities (today's list), portfolio (cards touching the member's portfolio: the tickers they imported, or their paper portfolio's)." },
        ticker: { ...ticker, description: "Only cards whose event company or a hit is this ticker." },
        sector: { type: "string", enum: SECTORS, description: "Only cards in this sector." },
        direction: { type: "string", enum: ["up", "down"], description: "Only hits pointing this way." },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "Cards to return (default 8)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "falcon_graph",
    description:
      "A company's neighbours in Falcon's market-wide filing graph (the Graph tab): its customers, suppliers, competitors and partners as disclosed in SEC filings, each with the relationship (what the neighbour is to this company), strength (critical / important / marginal), disclosed revenue share when given, the filing quote, form and date, and first_seen (the filing date of the first annual report since 2014 that states the link, when its history was read). Strongest first. Free, fast. Use for supply chain, exposure, ripple paths or 'who is connected to X'. " +
      "Point in time: give as_of (YYYY-MM-DD) for the links known on that date (first annual report filed on or before it, not dropped by a later one), with the first report's quote; use it for any question about a past date and for every ripple or link backtest, never today's graph for a past event.",
    input_schema: {
      type: "object",
      properties: {
        ticker,
        relation: { type: "string", enum: [...RELATIONS], description: "Only neighbours that are this to the company." },
        strength: { type: "string", enum: ["critical", "important", "marginal"], description: "Only links of this strength or stronger." },
        limit: { type: "integer", minimum: 1, maximum: 40, description: "Neighbours to return (default 20)." },
        as_of: { type: "string", maxLength: 10, description: "Point in time: only links known on this date, YYYY-MM-DD (YYYY-MM or YYYY mean the period's last day)." },
        include_ended: { type: "boolean", description: "With as_of: also links a later annual report (filed by as_of) stopped naming." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  IV_TOOL,
  {
    name: "falcon_company",
    description:
      "A company's profile in Falcon: name, sector, SEC SIC industry code, how many filing links it has in the graph and its strongest neighbours, whether it is in the member's portfolio, and how many live Sightings cards touch it. Free, fast. Use to check a ticker's sector before filtering the Graph, or for a quick overview.",
    input_schema: { type: "object", properties: { ticker }, required: ["ticker"], additionalProperties: false },
  },
] satisfies Anthropic.Beta.BetaTool[];

export const FALCON_ACTION_TOOLS = [
  {
    name: "open_ticker",
    description: "Opens the company's page in the member's Falcon app (a tab; beside the Falcon AI chat when it is open). App action: read-only navigation.",
    input_schema: { type: "object", properties: { ticker }, required: ["ticker"], additionalProperties: false },
  },
  {
    name: "show_in_graph",
    description:
      "Shows the company in the member's Graph tab: the graph narrows to it and its direct neighbours (optionally only some relations) and highlights it. App action. Pair it with falcon_graph when you also describe the neighbours.",
    input_schema: {
      type: "object",
      properties: { ticker, relations: { type: "array", items: { type: "string", enum: [...RELATIONS] }, maxItems: 4, description: "Only these relations (default all)." } },
      required: ["ticker"],
      additionalProperties: false,
    },
  },
  {
    name: "set_graph_filters",
    description:
      "Replaces the filters of the member's Graph tab and shows it. AND across filters. Sectors use the Graph's names (semiconductors and software are Information Technology). `opportunities: true` keeps today's Opportunities and their neighbours; `portfolio: true` the member's portfolio (their imported holdings, or their paper portfolio's tickers). `clear: true` alone removes every filter. App action.",
    input_schema: {
      type: "object",
      properties: {
        sectors: { type: "array", items: { type: "string", enum: SECTORS }, maxItems: 8 },
        exclude_sectors: { type: "array", items: { type: "string", enum: SECTORS }, maxItems: 8 },
        relations: { type: "array", items: { type: "string", enum: [...RELATIONS] }, maxItems: 4 },
        strength: { type: "array", items: { type: "string", enum: ["critical", "important", "marginal"] }, maxItems: 3 },
        companies: { type: "array", items: ticker, maxItems: 12, description: "These companies and their direct neighbours." },
        opportunities: { type: "boolean" },
        portfolio: { type: "boolean" },
        implied_vol: { type: "string", enum: ["very_high", "high", "ge40", "ge60", "ge80", "ge100", "any"], description: "very_high = top 10% of the universe, high = top 25%, geN = ATM IV at least N%." },
        min_links: { type: "integer", enum: [1, 3, 5, 10, 20] },
        clear: { type: "boolean", description: "True with no other filter: clear the Graph's filters." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "open_sighting",
    description: "Opens one Sightings card (card_id from falcon_sightings) in the member's app. App action.",
    input_schema: {
      type: "object",
      properties: { card_id: { type: "string", maxLength: 160 }, title: { type: "string", maxLength: 60, description: "Short title for the tab, e.g. 'NVDA earnings surprise'." } },
      required: ["card_id"],
      additionalProperties: false,
    },
  },
  {
    name: "open_dashboard",
    description: "Opens the member's Dashboard (today's portfolio hits and Opportunities), or the Sightings list with view: sightings. App action.",
    input_schema: { type: "object", properties: { view: { type: "string", enum: ["dashboard", "sightings"] } }, additionalProperties: false },
  },
] satisfies Anthropic.Beta.BetaTool[];

export const FALCON_TOOLS = [...FALCON_DATA_TOOLS, ...FALCON_ACTION_TOOLS];
const DATA_NAMES = new Set<string>(FALCON_DATA_TOOLS.map((t) => t.name));
export const isFalconTool = (name: string) => DATA_NAMES.has(name) || isAppActionTool(name);

/** `pending`: the tool's work is still running (ToolPending; the route waits on it in the next request); `content` then tells the model what to do if it cannot. */
export type FalconOutcome = DeskToolOutcome & { action?: AppAction; pending?: ToolProgress };
type Input = Record<string, unknown>;

/* ------------------------------------------------------------------ labels */

function tickerOf(i: Input): string {
  try {
    return actionTicker(i.ticker);
  } catch {
    return typeof i.ticker === "string" ? i.ticker.slice(0, 10).toUpperCase() : "?";
  }
}

export function falconToolLabel(name: string, input: unknown, phase: "running" | "done" = "done"): string {
  const i = (input && typeof input === "object" ? input : {}) as Input;
  const run = phase === "running";
  switch (name) {
    case "falcon_sightings":
      return `${run ? "Reading" : "Read"} Falcon ${i.list === "opportunities" ? "opportunities" : "sightings"}${typeof i.ticker === "string" ? ` for ${tickerOf(i)}` : ""}`;
    case "falcon_graph":
      return `${run ? "Walking" : "Walked"} ${tickerOf(i)} graph links${typeof i.as_of === "string" && i.as_of ? ` as of ${i.as_of.slice(0, 10)}` : ""}`;
    case IV_TOOL_NAME:
      return ivToolLabel(i, phase);
    case "falcon_company":
      return `${run ? "Loading" : "Loaded"} ${tickerOf(i)} profile`;
    default:
      if (run) return "Updating the app";
      try {
        return actionLabel(actionFromTool(name, i));
      } catch {
        return run ? `Running ${name}` : `Ran ${name}`;
      }
  }
}

/* ------------------------------------------------------------------ data */

class FalconError extends Error {}

const GRAPH_DIR = [path.join(process.cwd(), "data", "graph"), path.join(process.cwd(), "apps", "web", "data", "graph")].find((d) => fs.existsSync(path.join(d, "_names.json")));

type ShardEdge = { from: string; to: string; category: string; tier: string; disclosedSharePct: number | null; quote: string; form: string; filedAt: string; url: string };
type AllGraph = { n: [string, string, number, string?][]; e: [number, number, number, number][] };

let allGraph: { data: AllGraph; byTicker: Map<string, number> } | null = null;
function wholeGraph() {
  if (!allGraph) {
    let data: AllGraph = { n: [], e: [] };
    try {
      if (GRAPH_DIR) data = JSON.parse(fs.readFileSync(path.join(GRAPH_DIR, "_all.json"), "utf8")) as AllGraph;
    } catch {
      // not built: empty
    }
    allGraph = { data, byTicker: new Map(data.n.map((n, i) => [n[0], i])) };
  }
  return allGraph;
}

const shards = new Map<string, ShardEdge[]>();
function shard(t: string): ShardEdge[] {
  const known = shards.get(t);
  if (known) return known;
  let edges: ShardEdge[] = [];
  try {
    if (GRAPH_DIR && /^[A-Z][A-Z0-9.-]{0,9}$/.test(t)) edges = (JSON.parse(fs.readFileSync(path.join(GRAPH_DIR, `${t}.json`), "utf8")) as { edges: ShardEdge[] }).edges;
  } catch {
    edges = [];
  }
  if (shards.size > 500) shards.clear();
  shards.set(t, edges);
  return edges;
}

const pitShards = new Map<string, PitShardEdge[]>();
/** A ticker's point-in-time links (data/graph/_pit/, lib/workspace/graph-pit.ts); none when not built. */
function pitShard(t: string): PitShardEdge[] {
  const known = pitShards.get(t);
  if (known) return known;
  let edges: PitShardEdge[] = [];
  try {
    if (GRAPH_DIR && /^[A-Z][A-Z0-9.-]{0,9}$/.test(t)) edges = (JSON.parse(fs.readFileSync(path.join(GRAPH_DIR, "_pit", `${t}.json`), "utf8")) as { edges: PitShardEdge[] }).edges;
  } catch {
    edges = [];
  }
  if (pitShards.size > 500) pitShards.clear();
  pitShards.set(t, edges);
  return edges;
}
const pitBuilt = () => !!GRAPH_DIR && fs.existsSync(path.join(GRAPH_DIR, "_pit", "_all.json"));

/** SEC SIC code by ticker (scripts/graph-sic.mjs), bundled into the function at build time. */
const SIC: Record<string, number> = (companySic as { sic: Record<string, number> }).sic ?? {};
function sicOf(t: string): number | null {
  return SIC[t] ?? SIC[t.replace("-", ".")] ?? null;
}

const INVERSE: Record<string, string> = { customer: "supplier", supplier: "customer", competitor: "competitor", partner: "partner" };
const TIER_RANK: Record<string, number> = { critical: 0, important: 1, marginal: 2 };
const clip = (s: string | undefined | null, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Neighbour = {
  ticker: string;
  name: string;
  relation: string;
  strength: string;
  sharePct: number | null;
  quote: string;
  form: string;
  filedAt: string;
  url: string;
  first_seen?: string;
  last_seen?: string;
  ended?: string | null;
  seen_in?: string;
};

/**
 * A company's links from its own shard, as neighbours (relation = what the neighbour is to `t`), strongest first.
 * With `asOf`: the point-in-time shard's links known on that date, the first report as evidence.
 */
export function neighbours(t: string, asOf: string | null = null, includeEnded = false): Neighbour[] {
  const g = wholeGraph();
  const out = new Map<string, Neighbour>();
  const pit = pitShard(t);
  const pitKey = (e: { from: string; to: string; category: string }) => `${e.from}|${e.to}|${e.category}`;
  const pitBy = new Map(pit.map((e) => [pitKey(e), e]));
  const list: Array<ShardEdge & Partial<PitShardEdge>> = asOf ? pit.filter((e) => knownAsOf(e, asOf, includeEnded)) : shard(t).map((e) => ({ ...e, ...pickPit(pitBy.get(pitKey(e))) }));
  for (const e of list) {
    const other = e.from === t ? e.to : e.from;
    if (other === t) continue;
    const relation = e.from === t ? e.category : INVERSE[e.category] ?? e.category;
    const prev = out.get(other);
    if (prev && (TIER_RANK[prev.strength] ?? 3) <= (TIER_RANK[e.tier] ?? 3)) continue;
    const i = g.byTicker.get(other);
    out.set(other, {
      ticker: other,
      name: i !== undefined ? g.data.n[i][1] : other,
      relation,
      strength: e.tier,
      sharePct: e.disclosedSharePct ?? null,
      quote: clip(e.quote, 220),
      form: e.form,
      filedAt: e.filedAt,
      url: e.url,
      ...(e.firstSeen ? { first_seen: e.basis === "history" ? e.firstSeen : `${e.firstSeen} (only this report read)`, last_seen: e.lastSeen, ended: e.endedAt ?? null, seen_in: `${e.seenIn} of ${e.checkedIn} annual reports` } : {}),
    });
  }
  return Array.from(out.values()).sort((a, b) => (TIER_RANK[a.strength] ?? 3) - (TIER_RANK[b.strength] ?? 3) || (b.sharePct ?? 0) - (a.sharePct ?? 0));
}

/** The point-in-time fields of a live edge (first, last and ended), when its history is built. */
function pickPit(p: PitShardEdge | undefined): Partial<PitShardEdge> {
  return p ? { firstSeen: p.firstSeen, lastSeen: p.lastSeen, endedAt: p.endedAt, seenIn: p.seenIn, checkedIn: p.checkedIn, basis: p.basis } : {};
}

function graphTool(i: Input) {
  const t = actionTicker(i.ticker);
  const g = wholeGraph();
  const at = g.byTicker.get(t);
  const asOfRaw = typeof i.as_of === "string" && i.as_of.trim() ? i.as_of : null;
  const asOf = asOfRaw ? parseAsOf(asOfRaw) : null;
  if (asOfRaw && !asOf) throw new FalconError("as_of must be a date: YYYY-MM-DD (or YYYY-MM, YYYY).");
  if (asOf && !pitBuilt()) throw new FalconError("Falcon's point-in-time graph is not built here, so links cannot be dated. Say so; do not use today's links for a past date.");
  const includeEnded = asOf ? i.include_ended === true : false;
  let list = neighbours(t, asOf, includeEnded);
  if (asOf) {
    const all = neighbours(t, asOf, true);
    const pit = pitShard(t);
    const history = pit.filter((e) => e.from === t && e.basis === "history").length > 0;
    const later = pit.filter((e) => e.firstSeen > asOf).length;
    const total = list.length;
    if (typeof i.relation === "string") list = list.filter((n) => n.relation === i.relation);
    if (typeof i.strength === "string") list = list.filter((n) => (TIER_RANK[n.strength] ?? 3) <= (TIER_RANK[i.strength as string] ?? 3));
    const limit = Math.min(40, Math.max(1, Number(i.limit) || 20));
    const counts: Record<string, number> = {};
    for (const n of neighbours(t, asOf, includeEnded)) counts[n.relation] = (counts[n.relation] ?? 0) + 1;
    return {
      ticker: t,
      name: at !== undefined ? g.data.n[at][1] : t,
      as_of: asOf,
      source: "Falcon point-in-time filing graph: links stated in annual reports (10-K, 20-F, 40-F and amendments) filed on or before as_of, read with the live graph's own extraction",
      links: total,
      byRelation: counts,
      ...(includeEnded ? {} : { ended_by_then: all.length - total }),
      not_yet_known: later,
      notes: [
        "Each neighbour's quote, form and filedAt are from the FIRST annual report that states the link (first_seen); last_seen is the latest report naming it; ended is when a later annual report stopped naming it.",
        history
          ? `${t}'s own annual reports since 2014 were read. Links stated in other companies' reports are dated by those companies' reports (first_seen marked 'only this report read' when that filer's history is not read yet: then the link is known only from that recent report).`
          : `${t}'s own annual reports before its latest were not read yet: its own links are dated by that latest report only, so before it they are not known. Say so.`,
        "The extraction reads annual reports only (not 10-Qs or 8-Ks) and can miss a link in a given year; first_seen is the earliest annual report where it was found.",
      ],
      neighbours: list.slice(0, limit).map(({ url, ...n }) => ({ ...n, url: clip(url, 160) })),
      shown: Math.min(limit, list.length),
    };
  }
  if (!list.length && at === undefined) throw new FalconError(`${t} is not in Falcon's filing graph (no disclosed links).`);
  const total = list.length;
  if (typeof i.relation === "string") list = list.filter((n) => n.relation === i.relation);
  if (typeof i.strength === "string") list = list.filter((n) => (TIER_RANK[n.strength] ?? 3) <= (TIER_RANK[i.strength as string] ?? 3));
  const limit = Math.min(40, Math.max(1, Number(i.limit) || 20));
  const counts: Record<string, number> = {};
  for (const n of neighbours(t)) counts[n.relation] = (counts[n.relation] ?? 0) + 1;
  return {
    ticker: t,
    name: at !== undefined ? g.data.n[at][1] : t,
    sector: at !== undefined ? g.data.n[at][3] || null : null,
    source: "Falcon filing graph (relationships disclosed in SEC filings: 10-K, 10-Q, 8-K)",
    links: total,
    byRelation: counts,
    neighbours: list.slice(0, limit).map(({ url, ...n }) => ({ ...n, url: clip(url, 160) })),
    shown: Math.min(limit, list.length),
  };
}

/* ---------------------------------------------------------------- sightings */

let feedCache: { at: number; feed: SightingsFeed } | null = null;
const FEED_TTL = 60_000;

async function loadRawFeed(): Promise<SightingsFeed> {
  if (feedCache && Date.now() - feedCache.at < FEED_TTL) return feedCache.feed;
  const local = async (): Promise<SightingsFeed | null> => {
    try {
      const f = JSON.parse(await fs.promises.readFile(path.resolve(process.cwd(), "..", "..", "packages", "engine", "out", "sightings.json"), "utf8")) as SightingsFeed;
      return Array.isArray(f.cards) ? f : null;
    } catch {
      return null;
    }
  };
  let feed: SightingsFeed | null = null;
  if (process.env.NODE_ENV !== "production" && process.env.SIGHTINGS_SOURCE === "local") feed = await local();
  if (!feed) {
    try {
      const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
      const db = getSupabaseAdmin();
      let res = await db.from("sightings_cards").select("card, generated_at, event_at").gte("event_at", since).eq("stale", false).order("event_at", { ascending: false }).limit(200);
      if (res.error?.code === "42703") res = await db.from("sightings_cards").select("card, generated_at, event_at").gte("event_at", since).order("event_at", { ascending: false }).limit(200);
      if (res.error) throw res.error;
      const now = Date.now();
      const rows = (res.data ?? []) as { card: RippleCard; generated_at: string }[];
      const cards = rows
        .map((r) => (r.card && Array.isArray(r.card.hits) ? { ...r.card, generatedAt: r.card.generatedAt ?? r.generated_at } : null))
        .filter((c): c is RippleCard => c !== null && cardLive(c, now))
        .slice(0, 50);
      if (cards.length) feed = { generatedAt: rows[0]!.generated_at, cards };
    } catch (error) {
      console.error("[desk/falcon] sightings read failed", error instanceof Error ? error.message : String(error));
    }
  }
  if (!feed && process.env.NODE_ENV !== "production") feed = await local();
  feed ??= { generatedAt: new Date().toISOString(), cards: [] };
  feedCache = { at: Date.now(), feed };
  return feed;
}

/** The feed as this viewer may see it: the same OPTIONS_DISPLAY rule as /api/sightings (admin = founder admin session). */
async function loadFeed(admin: boolean): Promise<SightingsFeed> {
  return optionsForViewer(await loadRawFeed(), optionsDisplayMode(), admin);
}

const touches = (c: RippleCard, set: ReadonlySet<string>) => set.has(c.event.ticker) || c.hits.some((h) => set.has(h.ticker));

function hitOut(h: RippleHit) {
  return {
    ticker: h.ticker,
    company: h.companyName,
    relation: h.relation,
    degree: h.degree,
    ...(h.via ? { via: h.via } : {}),
    direction: h.direction,
    confidence: h.confidence,
    evidence: tierLabel(h.tier),
    window: h.window,
    mechanism: clip(h.mechanism, 220),
    ...(h.evidence?.[0] ? { filing: { quote: clip(h.evidence[0].quote, 200), form: h.evidence[0].form, filedAt: h.evidence[0].filedAt } } : {}),
    ...(h.sinceEvent ? { sinceEventPct: h.sinceEvent.movePct, sinceAsOf: h.sinceEvent.asOf } : {}),
    ...(h.pricedIn ? { pricedIn: true } : {}),
    ...(h.invalidatedBy ? { invalidatedBy: clip(h.invalidatedBy, 120) } : {}),
  };
}

/** Sizes per ticker, read on the server by user id (lib/portfolio-store.ts portfolioForAi): whole percents only. */
export type Weights = ReadonlyMap<string, PortfolioWeight>;

/** `weightPct` and `unrealisedPct` for a held ticker, when the member's sizes are stored; nothing otherwise. */
function sizeOf(weights: Weights | undefined, t: string): { weightPct?: number | null; unrealisedPct?: number | null } {
  const w = weights?.get(t) ?? weights?.get(t.replace("-", "."));
  return w ? { weightPct: w.weightPct, unrealisedPct: w.unrealisedPct } : {};
}

async function sightingsTool(i: Input, app: AppContext | null, admin: boolean, weights?: Weights) {
  const feed = await loadFeed(admin);
  // The app context's `focus` field carries the portfolio (its old name); "focus" is still read as the list name.
  const own = new Set([...(app?.focus ?? []), ...Array.from(weights?.keys() ?? [])]);
  const mode = i.list === "opportunities" ? "opportunities" : i.list === "portfolio" || i.list === "focus" ? "portfolio" : "all";
  let cards: RippleCard[] = mode === "opportunities" ? opportunityCards(feed.cards.filter((c) => !touches(c, own)), own) : mode === "portfolio" ? feed.cards.filter((c) => touches(c, own)) : feed.cards;
  const opp = new Set(opportunityCards(feed.cards.filter((c) => !touches(c, own)), own).map((c) => c.id));
  if (typeof i.ticker === "string") {
    const t = actionTicker(i.ticker);
    const alt = t.replace("-", ".");
    cards = cards.filter((c) => touches(c, new Set([t, alt])));
  }
  if (typeof i.sector === "string") {
    const g = wholeGraph();
    const sectorOf = (t: string) => {
      const k = g.byTicker.get(t);
      return k !== undefined ? g.data.n[k][3] : undefined;
    };
    const s = String(i.sector).toLowerCase();
    cards = cards.filter((c) => c.sector?.toLowerCase() === s || sectorOf(c.event.ticker)?.toLowerCase() === s || c.hits.some((h) => sectorOf(h.ticker)?.toLowerCase() === s));
  }
  const direction = i.direction === "up" || i.direction === "down" ? i.direction : null;
  if (direction) cards = cards.filter((c) => c.hits.some((h) => h.direction === direction));
  const limit = Math.min(15, Math.max(1, Number(i.limit) || 8));
  return {
    source: "Falcon Sightings (Ripple Engine, daily)",
    generatedAt: feed.generatedAt,
    list: mode,
    matched: cards.length,
    totalLive: feed.cards.length,
    cards: cards.slice(0, limit).map((c) => ({
      card_id: c.id,
      event: { ticker: c.event.ticker, company: c.event.companyName, kind: c.event.kind, headline: clip(c.event.headline, 160), occurredAt: c.event.occurredAt, summary: clip(c.event.summary, 260) },
      sector: c.sector,
      evidence: tierLabel(c.tier),
      opportunity: opp.has(c.id),
      ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
      hits: c.hits.filter((h) => !direction || h.direction === direction).slice(0, 6).map(hitOut),
      ...(c.hits.length > 6 ? { moreHits: c.hits.length - 6 } : {}),
      ...(weights?.size
        ? (() => {
            const held = [c.event.ticker, ...c.hits.map((h) => h.ticker)].filter((t, k, a) => a.indexOf(t) === k && weights.has(t));
            return held.length ? { portfolioSizes: held.map((t) => ({ ticker: t, ...sizeOf(weights, t) })) } : {};
          })()
        : {}),
    })),
  };
}

/* ------------------------------------------------------------------ company */

async function companyTool(i: Input, app: AppContext | null, admin: boolean, weights?: Weights) {
  const t = actionTicker(i.ticker);
  const g = wholeGraph();
  const at = g.byTicker.get(t);
  const near = neighbours(t);
  const feed = await loadFeed(admin).catch(() => null);
  const set = new Set([t, t.replace("-", ".")]);
  const cards = feed ? feed.cards.filter((c) => touches(c, set)) : [];
  const code = sicOf(t);
  if (at === undefined && code === null && !cards.length) throw new FalconError(`Falcon has no profile for ${t}. Check the symbol.`);
  return {
    ticker: t,
    name: at !== undefined ? g.data.n[at][1] : null,
    sector: at !== undefined ? g.data.n[at][3] || null : null,
    sic: code,
    graphLinks: near.length,
    topNeighbours: near.slice(0, 6).map((n) => `${n.ticker} (${n.relation}, ${n.strength})`),
    inPortfolio: (app?.focus?.includes(t) ?? false) || weights?.has(t) === true,
    ...sizeOf(weights, t),
    liveSightings: cards.length,
    sightings: cards.slice(0, 5).map((c) => ({ card_id: c.id, event: c.event.ticker, headline: clip(c.event.headline, 120), evidence: tierLabel(c.tier) })),
  };
}

/* ------------------------------------------------------------------ run */

/**
 * Runs a falcon_* data tool or an app action. `app` is the request's app context (the portfolio for the feed);
 * `admin` is whether the request carries a valid founder admin session (OPTIONS_DISPLAY=admin).
 * `signal` and `timeoutMs` bound falcon_options (lib/desk/tools/iv.ts), which may buy one options snapshot;
 * `onProgress` reports a history pull's points as they load.
 */
export async function runFalconTool(
  name: string,
  input: unknown,
  opts: { app?: AppContext | null; weights?: Weights; admin?: boolean; signal?: AbortSignal; timeoutMs?: number; onProgress?: (p: ToolProgress) => void } = {},
): Promise<FalconOutcome> {
  const admin = opts.admin === true;
  const started = Date.now();
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  const label = falconToolLabel(name, i, "done");
  const ok = (content: unknown, action?: AppAction): FalconOutcome => ({ name, ok: true, content: JSON.stringify(content), label, ms: Date.now() - started, ...(action ? { action } : {}) });
  try {
    if (isAppActionTool(name)) {
      const action = actionFromTool(name, i);
      return ok({ done: true, inApp: actionLabel(action), note: "Done in the member's Falcon app; they can see it now. Mention it in a few words, do not repeat it." }, action);
    }
    switch (name) {
      case "falcon_sightings":
        return ok(await sightingsTool(i, opts.app ?? null, admin, opts.weights));
      case "falcon_graph":
        return ok(graphTool(i));
      case IV_TOOL_NAME:
        return ok(await ivTool(i, { admin, signal: opts.signal, timeoutMs: opts.timeoutMs, onProgress: opts.onProgress }));
      case "falcon_company":
        return ok(await companyTool(i, opts.app ?? null, admin, opts.weights));
      default:
        throw new FalconError(`Unknown tool "${name}".`);
    }
  } catch (err) {
    if (err instanceof ToolPending) return { name, ok: false, content: JSON.stringify({ error: err.message }), label, ms: Date.now() - started, pending: err.progress };
    const known = err instanceof FalconError || err instanceof ActionInputError || err instanceof ToolError;
    if (!known) console.error("[desk/falcon]", JSON.stringify({ tool: name, error: err instanceof Error ? err.message : String(err) }));
    const message = known ? (err as Error).message : "Falcon's data is unavailable right now. Answer without it and say so.";
    return { name, ok: false, content: JSON.stringify({ error: message }), label, ms: Date.now() - started };
  }
}
