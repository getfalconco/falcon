/**
 * Insider activity: the contract between main/insiders and the renderer
 * (the dashboard card, and the Stock tab through `insiders:activity`).
 *
 * An event is a pattern in SEC filings, never a single routine Form 4:
 *
 *   purchase_cluster        2+ distinct insiders, open market purchases (code
 *                           P, not under a Rule 10b5-1 plan), within 30 days
 *   large_purchase          one insider's open market purchase that raised
 *                           their holdings by 20% or more (at least $25,000),
 *                           or any such purchase by the CEO or CFO
 *   sale_cluster            3+ distinct insiders, open market sales outside a
 *                           Rule 10b5-1 plan, within 30 days
 *   large_unplanned_sale    an officer's, director's or 10% owner's open market
 *                           sales outside a plan, $10,000,000 or more in 30
 *                           days, and 10% or more of their holding or
 *                           $50,000,000 or more
 *   unplanned_sale          a CEO or CFO open market sale outside a plan, of
 *                           $1,000,000 or more
 *   activist_13d            a new Schedule 13D (5%+ holder that may seek to
 *                           influence the company)
 *   activist_13d_amendment  a 13D amendment that restates Item 4, the
 *                           purpose of the holding
 *   new_holder_13g          a new Schedule 13G (passive 5%+ holder)
 *
 * The rules and the significance score live in main/insiders/detect.ts.
 */

export type InsiderEventKind =
  | "purchase_cluster"
  | "large_purchase"
  | "sale_cluster"
  | "unplanned_sale"
  | "large_unplanned_sale"
  | "activist_13d"
  | "activist_13d_amendment"
  | "new_holder_13g";

export type InsiderRole = "ceo" | "cfo" | "officer" | "director" | "owner10" | "other";

/** One insider's trades of one code on one Form 4, totalled. */
export type InsiderTrade = {
  name: string;
  role: InsiderRole;
  /** The officer title as the form gives it. */
  title: string | null;
  code: "P" | "S";
  shares: number;
  /** Shares times price over the lines with a price; null when none has one. */
  value: number | null;
  firstDate: string;
  lastDate: string;
  filedAt: string;
  accession: string;
  /** The Form 4 on sec.gov. */
  url: string;
  /** Shares owned before the first counted line, every holding on the form summed; null when the form does not say. */
  sharesBefore: number | null;
  /** Shares owned once the form's last line was done (exercises and awards on it included), every holding summed; null when the form does not say. */
  sharesAfter: number | null;
  /** Purchased shares over `sharesBefore` (0.25 = 25%); null when unknown or nothing was held before. */
  increase: number | null;
  /** True when nothing was held before the purchase. */
  firstPosition: boolean;
  /** Made under a Rule 10b5-1 plan (the form's box or a footnote). Events only count trades outside one. */
  plan: boolean;
};

/** A Schedule 13D or 13G as the card shows it. */
export type OwnershipFiling = {
  /** As EDGAR lists it: "SC 13D", "SCHEDULE 13D/A", "SC 13G". */
  form: string;
  filer: string | null;
  filedAt: string;
  accession: string;
  url: string;
  /** Percent of the class the cover page states (7.2 = 7.2%); null when it cannot be read. */
  percent: number | null;
};

/**
 * The share of their holding an insider sold over a run of sales (oldest
 * first): the shares sold against those sold plus what the last form says was
 * still owned. Options exercised and sold on the same form are in both, so an
 * exercise-and-sell never reads as more than they held. Falls back to the
 * holding before the first sale when the last form does not say what was left;
 * null when neither is known.
 */
export function saleShare(trades: readonly Pick<InsiderTrade, "shares" | "sharesBefore" | "sharesAfter" | "lastDate">[]): number | null {
  if (trades.length === 0) return null;
  const sold = trades.reduce((s, t) => s + t.shares, 0);
  if (!(sold > 0)) return null;
  const last = trades.reduce((a, t) => (t.lastDate >= a.lastDate ? t : a), trades[0]!);
  if (last.sharesAfter !== null && last.sharesAfter >= 0) return sold / (sold + last.sharesAfter);
  const before = trades[0]!.sharesBefore;
  return before !== null && before > 0 ? Math.min(1, sold / before) : null;
}

export type InsiderRelation = "supplier" | "customer" | "competitor";

/** Why a ticker the reader neither holds nor watches is in view: a filing link to one of theirs. */
export type InsiderVia = {
  /** The reader's name. */
  holding: string;
  /** What the event's company is to `holding`: "TSM" supplier of "NVDA". */
  relation: InsiderRelation;
  tier: "critical" | "important";
  /** Whose filing states the link. */
  namedBy: string;
  sourceUrl: string | null;
};

/** "focus": the one company a `ticker` request asked about. */
export type InsiderScope = "held" | "watchlist" | "linked" | "focus";

export type InsiderEvent = {
  id: string;
  ticker: string;
  kind: InsiderEventKind;
  /** The latest trade or filing date, YYYY-MM-DD. */
  date: string;
  /** The earliest, for a cluster's span; equal to `date` otherwise. */
  firstDate: string;
  /** Distinct insiders (0 for a 13D or 13G). */
  insiders: number;
  /** Total value of the trades; null when no line had a price. */
  value: number | null;
  /** Roles in the event, CEO and CFO first. */
  roles: InsiderRole[];
  trades: InsiderTrade[];
  filing: OwnershipFiling | null;
  scope: InsiderScope;
  via: InsiderVia | null;
  /** Significance, 0 to 100 (main/insiders/detect.ts `significance`). */
  score: number;
};

/**
 * `insiders:activity`:
 *   "NVDA" or { ticker: "NVDA" }       that company's events (the Stock tab)
 *   { held: [...], watchlist: [...] }  the reader's names and their filing-linked companies (the card)
 */
export type InsiderActivityRequest = string | { ticker?: string; held?: readonly string[]; watchlist?: readonly string[] };

export type InsiderActivityAnswer = {
  ok: true;
  /** New York date the answer was built on. */
  today: string;
  events: InsiderEvent[];
  /** Companies in scope. */
  companies: number;
  /** Companies whose filings are still to be read; the answer fills in as they are. */
  pending: number;
  /** Oldest read among the companies in scope, ISO; null before the first. */
  checkedAt: string | null;
};

export type InsiderActivityResult = InsiderActivityAnswer | { ok: false; error: "invalid_request" | "unavailable" };

export const INSIDER_KINDS: readonly InsiderEventKind[] = [
  "purchase_cluster",
  "large_purchase",
  "sale_cluster",
  "unplanned_sale",
  "large_unplanned_sale",
  "activist_13d",
  "activist_13d_amendment",
  "new_holder_13g",
];

function ticker(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(t) ? t : null;
}

function tickers(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 500) return null;
  const out: string[] = [];
  for (const item of v) {
    const t = ticker(item);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export type ParsedInsiderRequest = { focus: string | null; held: string[]; watchlist: string[] };

/** The request as main reads it; null when it is malformed. */
export function parseInsiderRequest(raw: unknown): ParsedInsiderRequest | null {
  if (typeof raw === "string") {
    const t = ticker(raw);
    return t ? { focus: t, held: [], watchlist: [] } : null;
  }
  if (raw === undefined || raw === null) return { focus: null, held: [], watchlist: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const focus = r.ticker === undefined || r.ticker === null ? null : ticker(r.ticker);
  if (r.ticker !== undefined && r.ticker !== null && !focus) return null;
  const held = tickers(r.held);
  const watchlist = tickers(r.watchlist);
  if (!held || !watchlist) return null;
  return { focus, held, watchlist: watchlist.filter((t) => !held.includes(t)) };
}
