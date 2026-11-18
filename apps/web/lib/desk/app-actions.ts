/**
 * Falcon AI operating the app: the actions it may take (read-only navigation,
 * never deletes or trades), checked the same way on the server (the tool's
 * input) and on the client (the stream's `action`, and again from storage),
 * and the snapshot of what the member is looking at that rides with each Desk
 * request. Pure: no server or browser imports, so both sides and the tests use it.
 *
 * Flow: the model calls an action tool (lib/desk/tools/falcon.ts) -> the route
 * sends the tool's done line with `action` -> the client (lab/sessions.ts run)
 * executes each new action once through the workspace (lab/app-bridge.ts) and
 * the reply shows it as a chip (lab/AppActionChip.tsx); after a reload the chip
 * is drawn again but nothing re-runs.
 */

export const GRAPH_RELATIONS = { supplier: "0", customer: "1", competitor: "2", partner: "3" } as const;
export const GRAPH_STRENGTHS = { critical: "3", important: "2", marginal: "1" } as const;
export const IV_FILTER_VALUES = ["very_high", "high", "ge40", "ge60", "ge80", "ge100", "any"] as const;
export const MIN_LINKS = [1, 3, 5, 10, 20] as const;

export type GraphRelationName = keyof typeof GRAPH_RELATIONS;
export type GraphStrengthName = keyof typeof GRAPH_STRENGTHS;

/** One token of the Graph tab's filter bar (components/ui/filter-token-bar Filter; meaning: lib/workspace/graph-filter.ts). */
export type GraphFilterToken = { id: string; field: string; operator: string; values: string[] };

export type AppAction =
  | { type: "open_ticker"; ticker: string }
  | { type: "open_dashboard" }
  | { type: "open_sightings" }
  | { type: "open_sighting"; cardId: string; title?: string }
  /** Graph narrowed to the ticker and its direct neighbours (a Company filter), the ticker highlighted. */
  | { type: "show_in_graph"; ticker: string; relations?: GraphRelationName[] }
  /** Replaces the Graph's filters (empty list = clear) and shows the Graph. */
  | { type: "set_graph_filters"; filters: GraphFilterToken[]; summary: string };

export const APP_ACTION_TOOLS = ["open_ticker", "open_dashboard", "open_sighting", "show_in_graph", "set_graph_filters"] as const;
export type AppActionTool = (typeof APP_ACTION_TOOLS)[number];
export const isAppActionTool = (name: string): name is AppActionTool => (APP_ACTION_TOOLS as readonly string[]).includes(name);

const TICKER = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;
const CARD_ID = /^[A-Za-z0-9:_.-]{1,160}$/;
const SECTOR = /^[A-Za-z][A-Za-z &,/-]{1,60}$/;

type Input = Record<string, unknown>;
const obj = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {});

export class ActionInputError extends Error {}

/** "nvda" / "$NVDA" / "brk.b" -> "NVDA" / "BRK-B" (the graph's form); throws ActionInputError otherwise. */
export function actionTicker(v: unknown): string {
  if (typeof v !== "string") throw new ActionInputError("ticker is required (a US stock symbol such as NVDA).");
  const t = v.trim().toUpperCase().replace(/^\$/, "").replace(/[./]/g, "-");
  if (!TICKER.test(t)) throw new ActionInputError(`"${String(v).slice(0, 20)}" is not a ticker. Use the symbol, e.g. NVDA.`);
  return t;
}

function list(v: unknown, max: number): string[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, max);
}

function pick<K extends string>(values: string[], allowed: Record<K, string>, what: string): K[] {
  const out: K[] = [];
  for (const raw of values) {
    const k = raw.toLowerCase().replace(/^peer$/, "partner") as K;
    if (!(k in allowed)) throw new ActionInputError(`${what} must be among ${Object.keys(allowed).join(", ")}.`);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * The model's set_graph_filters input as filter-bar tokens, plus a short summary
 * ("sector Information Technology · opportunities"). Throws ActionInputError.
 */
export function graphFilterTokens(input: unknown): { filters: GraphFilterToken[]; summary: string } {
  const i = obj(input);
  const filters: GraphFilterToken[] = [];
  const parts: string[] = [];
  const add = (field: string, operator: string, values: string[], text: string) => {
    filters.push({ id: `ai-${field}-${filters.length}`, field, operator, values });
    parts.push(text);
  };
  const sectors = list(i.sectors, 8);
  for (const s of sectors) if (!SECTOR.test(s)) throw new ActionInputError(`"${s.slice(0, 30)}" is not a sector name. Use the Graph's sector names (falcon_company lists a company's sector).`);
  if (sectors.length) add("sector", "is_any", sectors, `sector ${sectors.join(", ")}`);
  const without = list(i.exclude_sectors, 8);
  for (const s of without) if (!SECTOR.test(s)) throw new ActionInputError(`"${s.slice(0, 30)}" is not a sector name.`);
  if (without.length) add("sector", "is_not_any", without, `not ${without.join(", ")}`);
  const relations = pick(list(i.relations, 4), GRAPH_RELATIONS, "relations");
  if (relations.length) add("relation", "is_any", relations.map((r) => GRAPH_RELATIONS[r]), relations.join(", "));
  const strength = pick(list(i.strength, 3), GRAPH_STRENGTHS, "strength");
  if (strength.length) add("strength", "is_any", strength.map((s) => GRAPH_STRENGTHS[s]), `${strength.join(", ")} links`);
  const companies = list(i.companies, 12).map(actionTicker);
  if (companies.length) add("company", "is_any", Array.from(new Set(companies)), companies.join(", "));
  if (typeof i.opportunities === "boolean") add("opportunity", i.opportunities ? "is" : "is_not", ["has"], i.opportunities ? "opportunities" : "no opportunities");
  // `focus_list` is the old name of `portfolio`; the filter field keeps the id "focus".
  const own = typeof i.portfolio === "boolean" ? i.portfolio : typeof i.focus_list === "boolean" ? i.focus_list : undefined;
  if (own !== undefined) add("focus", own ? "is" : "is_not", ["in"], own ? "portfolio" : "not in portfolio");
  if (i.implied_vol !== undefined) {
    const iv = String(i.implied_vol);
    if (!(IV_FILTER_VALUES as readonly string[]).includes(iv)) throw new ActionInputError(`implied_vol must be one of ${IV_FILTER_VALUES.join(", ")}.`);
    add("iv", "is_any", [iv], `IV ${iv.replace("_", " ").replace(/^ge(\d+)/, "≥$1%")}`);
  }
  if (i.min_links !== undefined) {
    const n = Number(i.min_links);
    const size = MIN_LINKS.filter((m) => m <= n).pop();
    if (!size) throw new ActionInputError(`min_links must be one of ${MIN_LINKS.join(", ")}.`);
    add("size", "at_least", [String(size)], `${size}+ links`);
  }
  if (!filters.length && i.clear !== true) throw new ActionInputError("Give at least one filter, or clear: true to clear the Graph's filters.");
  return { filters, summary: parts.join(" · ") || "cleared" };
}

/** The action an action tool's input asks for. Throws ActionInputError for a bad input. */
export function actionFromTool(name: string, input: unknown): AppAction {
  const i = obj(input);
  switch (name) {
    case "open_ticker":
      return { type: "open_ticker", ticker: actionTicker(i.ticker) };
    case "open_dashboard":
      return i.view === "sightings" ? { type: "open_sightings" } : { type: "open_dashboard" };
    case "open_sighting": {
      const id = typeof i.card_id === "string" ? i.card_id.trim() : "";
      if (!CARD_ID.test(id)) throw new ActionInputError("card_id is required: a card id from falcon_sightings.");
      const title = typeof i.title === "string" ? i.title.trim().slice(0, 60) : "";
      return { type: "open_sighting", cardId: id, ...(title ? { title } : {}) };
    }
    case "show_in_graph": {
      const relations = pick(list(i.relations, 4), GRAPH_RELATIONS, "relations");
      return { type: "show_in_graph", ticker: actionTicker(i.ticker), ...(relations.length ? { relations } : {}) };
    }
    case "set_graph_filters":
      return { type: "set_graph_filters", ...graphFilterTokens(i) };
    default:
      throw new ActionInputError(`Unknown app action "${name}".`);
  }
}

const FIELDS = new Set(["relation", "strength", "company", "sector", "size", "focus", "opportunity", "iv"]);
const OPERATORS = new Set(["is", "is_not", "is_any", "is_not_any", "at_least"]);

/** An action from the stream or storage, re-checked; null when it is not one this client runs. */
export function parseAppAction(v: unknown): AppAction | null {
  const a = obj(v);
  try {
    switch (a.type) {
      case "open_ticker":
        return { type: "open_ticker", ticker: actionTicker(a.ticker) };
      case "open_dashboard":
      case "open_sightings":
        return { type: a.type };
      case "open_sighting":
        return typeof a.cardId === "string" && CARD_ID.test(a.cardId)
          ? { type: "open_sighting", cardId: a.cardId, ...(typeof a.title === "string" && a.title ? { title: a.title.slice(0, 60) } : {}) }
          : null;
      case "show_in_graph": {
        const relations = Array.isArray(a.relations) ? pick(list(a.relations, 4), GRAPH_RELATIONS, "relations") : [];
        return { type: "show_in_graph", ticker: actionTicker(a.ticker), ...(relations.length ? { relations } : {}) };
      }
      case "set_graph_filters": {
        if (!Array.isArray(a.filters)) return null;
        const filters = a.filters
          .map(obj)
          .filter((f) => typeof f.field === "string" && FIELDS.has(f.field) && typeof f.operator === "string" && OPERATORS.has(f.operator) && Array.isArray(f.values))
          .slice(0, 12)
          .map((f, k) => ({ id: typeof f.id === "string" ? f.id.slice(0, 40) : `ai-${k}`, field: f.field as string, operator: f.operator as string, values: list(f.values, 12) }));
        return { type: "set_graph_filters", filters, summary: typeof a.summary === "string" ? a.summary.slice(0, 120) : "" };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** The chip's words: "Opened NVDA", "Showed NVDA in the Graph". */
export function actionLabel(a: AppAction): string {
  switch (a.type) {
    case "open_ticker":
      return `Opened ${a.ticker}`;
    case "open_dashboard":
      return "Opened the Dashboard";
    case "open_sightings":
      return "Opened Sightings";
    case "open_sighting":
      return `Opened ${a.title ? `sighting: ${a.title}` : "a sighting"}`;
    case "show_in_graph":
      return `Showed ${a.ticker} in the Graph${a.relations?.length ? ` (${a.relations.join(", ")})` : ""}`;
    case "set_graph_filters":
      return a.filters.length ? `Filtered the Graph: ${a.summary}` : "Cleared the Graph filters";
  }
}

/** The filter tokens show_in_graph applies: the ticker as a Company, plus any relation filter. */
export function showInGraphFilters(a: Extract<AppAction, { type: "show_in_graph" }>): GraphFilterToken[] {
  const out: GraphFilterToken[] = [{ id: "ai-company", field: "company", operator: "is_any", values: [a.ticker] }];
  if (a.relations?.length) out.push({ id: "ai-relation", field: "relation", operator: "is_any", values: a.relations.map((r) => GRAPH_RELATIONS[r]) });
  return out;
}

/* ------------------------------------------------------------------ app context */

/** What the member is looking at when they send a Desk message (Workspace builds it; the route reads it). */
export type AppContext = {
  /** The view in focus, e.g. "Graph", "Ticker page for NVDA", "Falcon AI (research chat)". */
  view?: string;
  /** The other pane in split view. */
  beside?: string;
  /** Open tabs, short titles. */
  tabs?: string[];
  /** The ticker of the page in view or beside Falcon AI (ticker tab, sighting's company, graph highlight). */
  ticker?: string;
  /** A Sightings card open in a tab: id, title and company. */
  sighting?: { id: string; title: string; ticker?: string };
  /** The Graph's active filters, in words. */
  graphFilters?: string[];
  /** The Graph's highlighted company (show_in_graph or the member's pick). */
  graphTicker?: string;
  /** The member's portfolio (tickers from imports, or the old tickers-only paper portfolio); the field keeps its old focus-list name. */
  focus?: string[];
};

const text = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n) : "");
const texts = (v: unknown, each: number, max: number) => (Array.isArray(v) ? v.map((x) => text(x, each)).filter(Boolean).slice(0, max) : []);
const tick = (v: unknown) => {
  try {
    return actionTicker(v);
  } catch {
    return "";
  }
};

/** The request's `app` field, trimmed to known keys and short strings; null when empty or not an object. */
export function cleanAppContext(v: unknown): AppContext | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Input;
  const out: AppContext = {};
  const view = text(a.view, 80);
  if (view) out.view = view;
  const beside = text(a.beside, 80);
  if (beside) out.beside = beside;
  const tabs = texts(a.tabs, 40, 12);
  if (tabs.length) out.tabs = tabs;
  const ticker = tick(a.ticker);
  if (ticker) out.ticker = ticker;
  const s = obj(a.sighting);
  const sid = text(s.id, 160);
  if (sid && CARD_ID.test(sid)) out.sighting = { id: sid, title: text(s.title, 120), ...(tick(s.ticker) ? { ticker: tick(s.ticker) } : {}) };
  const gf = texts(a.graphFilters, 80, 10);
  if (gf.length) out.graphFilters = gf;
  const gt = tick(a.graphTicker);
  if (gt) out.graphTicker = gt;
  const focus = (Array.isArray(a.focus) ? a.focus : []).map(tick).filter(Boolean).slice(0, 200);
  if (focus.length) out.focus = focus;
  return Object.keys(out).length ? out : null;
}

/** The short block the model reads (after the system prompt): what is on the member's screen right now. */
export function appContextText(c: AppContext | null): string {
  if (!c) return "";
  const lines = ["What the member has open in Falcon right now (from the app; \"this stock\" or \"what I'm looking at\" means this):"];
  if (c.view) lines.push(`- In view: ${c.view}${c.beside ? ` (beside it: ${c.beside})` : ""}`);
  if (c.ticker) lines.push(`- Company on screen: ${c.ticker}`);
  if (c.sighting) lines.push(`- Sighting card open: "${c.sighting.title}"${c.sighting.ticker ? ` at ${c.sighting.ticker}` : ""} (card_id ${c.sighting.id})`);
  if (c.graphTicker) lines.push(`- Graph highlights: ${c.graphTicker}`);
  if (c.graphFilters?.length) lines.push(`- Graph filters on: ${c.graphFilters.join("; ")}`);
  if (c.tabs?.length) lines.push(`- Open tabs: ${c.tabs.join(", ")}`);
  if (c.focus?.length) lines.push(`- Portfolio (tickers the member imported, or their paper portfolio's): ${c.focus.join(", ")}`);
  return lines.join("\n");
}

/** One ticker's size for Falcon AI (lib/portfolio-holdings.ts aiWeights): whole percents only, never amounts. */
export type PortfolioWeight = { ticker: string; kind: "equity" | "crypto"; weightPct: number | null; unrealisedPct: number | null };

/**
 * The block on the member's sizes, read on the server by user id (lib/portfolio-store.ts
 * portfolioForAi), never from the request: whole-percent weight and gain per ticker,
 * from live values, combined across accounts. No dollar amounts, share counts or cash.
 */
export function portfolioWeightsText(weights: readonly PortfolioWeight[], paper: boolean): string {
  const lines: string[] = [];
  if (weights.length) {
    const fmt = (w: PortfolioWeight) => {
      const name = w.kind === "crypto" ? `${w.ticker} (crypto)` : w.ticker;
      const weight = w.weightPct === null ? "no weight (other currency)" : `${w.weightPct}%`;
      const gain = w.unrealisedPct === null ? "" : `, ${w.unrealisedPct >= 0 ? "+" : ""}${w.unrealisedPct}% vs cost`;
      return `${name} ${weight}${gain}`;
    };
    lines.push(
      "The member's position sizes (from their saved holdings, read by Falcon with live prices; whole percents of the portfolio, a negative weight is a short; no amounts are given and none may be stated or guessed):",
      `- ${weights.slice(0, 200).map(fmt).join("; ")}`,
    );
  }
  if (paper) lines.push("The member has a paper portfolio: a paper account they created with a cash balance and no positions yet. It is not real money; call it their paper portfolio.");
  return lines.join("\n");
}

/** Words for one filter token, for the context block ("sector is any of Information Technology"). */
export function describeFilterToken(f: GraphFilterToken): string {
  const rel = Object.fromEntries(Object.entries(GRAPH_RELATIONS).map(([k, v]) => [v, k]));
  const str = Object.fromEntries(Object.entries(GRAPH_STRENGTHS).map(([k, v]) => [v, k]));
  const values = f.values.map((v) => (f.field === "relation" ? rel[v] ?? v : f.field === "strength" ? str[v] ?? v : v));
  const field = f.field === "opportunity" ? "opportunities" : f.field === "iv" ? "implied vol" : f.field === "size" ? "links" : f.field;
  if (f.field === "opportunity" || f.field === "focus") return `${f.operator === "is_not" ? "not " : ""}${f.field === "focus" ? "in portfolio" : "listed under opportunities today"}`;
  return `${field} ${f.operator.replace(/_/g, " ")} ${values.join(", ")}`;
}
