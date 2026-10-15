/**
 * Stock tab: the contracts behind three of its sections, between the
 * renderer and the main process (main/stock-tab-data).
 *
 *   stocktab:changes       what changed on a stock since the reader last
 *                          opened it (or the last seven days, whichever is
 *                          longer): estimate revisions, short interest, the
 *                          analysts' mean price estimate, open market insider
 *                          trades, and links added to the filing graph
 *   stocktab:change-tags   each of those items set against the reader's
 *                          thesis (stock:thesis:get, read by the main
 *                          process): supports, weakens or neutral
 *   stocktab:earnings      the next report, the last reports on record and
 *                          what companies linked by a filing reported first
 *   stocktab:peers         competitors, how they have moved with the stock,
 *                          and whether its large moves were shared
 *
 * Every figure is a provider's or a filing's, or computed from one; a field
 * no source gave stays null and the views print nothing in its place.
 *
 * Pure: no fs, no DOM, no clock.
 */

import type { EarningsConsensus, EarningsFx, EarningsTime } from "./earnings-types";

export type SourceRef = {
  /** Which record the figure comes from. */
  kind: "yahoo" | "finnhub" | "form4" | "filing";
  /** The record on the web, when it has an address. */
  url: string | null;
};

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** The consensus periods Yahoo's earnings trend covers. */
export type TrendPeriod = "0q" | "+1q" | "0y" | "+1y";

type ChangeBase = {
  /** Stable across reads of the same fact, so a tag can be matched back to it. */
  id: string;
  /** The date the fact belongs to, YYYY-MM-DD. */
  date: string;
  source: SourceRef;
  /** One plain English line with the figures: what the thesis tag is asked about. Never shown. */
  fact: string;
};

export type EstimateRevisionChange = ChangeBase & {
  kind: "estimate_revision";
  period: TrendPeriod;
  /** End of the period, YYYY-MM-DD, when given. */
  periodEnd: string | null;
  /** The provider's window the counts and the earlier mean are for. */
  days: 7 | 30;
  up: number;
  down: number;
  /** Mean EPS estimate now and `days` ago. */
  epsNow: number | null;
  epsBefore: number | null;
  currency: string | null;
};

export type ShortInterestChange = ChangeBase & {
  kind: "short_interest";
  /** Settlement date of the earlier report. */
  previousDate: string | null;
  shares: number;
  previousShares: number;
  /** Shares as a fraction of the float (0.0134 is 1.34 percent), when given. */
  floatShare: number | null;
};

export type PriceEstimateChange = ChangeBase & {
  kind: "price_estimate";
  /** The analysts' mean price estimate now, and on `previousDate`. */
  value: number;
  previous: number;
  previousDate: string;
  analysts: number | null;
  currency: string | null;
};

export type InsiderChange = ChangeBase & {
  kind: "insider";
  name: string;
  role: string;
  /** P is an open market purchase, S an open market sale. */
  code: "P" | "S";
  shares: number;
  /** Shares times price, summed over the filing's lines of that code; null when no price is on the form. */
  value: number | null;
  /** The filer ticked the Rule 10b5-1 box: a sale or purchase set up in advance under a plan. */
  plan: boolean;
};

export type LinkAddedChange = ChangeBase & {
  kind: "link_added";
  counterparty: string;
  counterpartyName: string | null;
  /** supplier, customer, partner, competitor, dependency, as the filing puts it. */
  category: string;
  /** "names": this company's filing names the other; "named": the other's filing names this one. */
  direction: "names" | "named";
  form: "10-K" | "20-F" | null;
  filingDate: string | null;
};

export type ChangeItem =
  | EstimateRevisionChange
  | ShortInterestChange
  | PriceEstimateChange
  | InsiderChange
  | LinkAddedChange;

export type ChangeKind = ChangeItem["kind"];

export type StockChanges = {
  ticker: string;
  /** First day the list covers, YYYY-MM-DD (New York). */
  since: string;
  /** True when the window starts at the reader's last visit (longer than seven days). */
  sinceVisit: boolean;
  /** New York date of the answer. */
  asOf: string;
  items: ChangeItem[];
  /** Hash of the items, the thesis tags' cache key. */
  itemsHash: string;
  /** Sources that could not be read this time; the list stands without them. */
  degraded: Array<"yahoo" | "insiders" | "graph">;
};

export type StockChangesResult = { ok: true; changes: StockChanges } | { ok: false; error: "invalid_request" | "unavailable" };

export type ThesisTag = "supports" | "weakens" | "neutral";

export type ChangeTag = {
  id: string;
  tag: ThesisTag;
  /** Twelve words or fewer, in the reader's language when the translation passed; null when none survived the checks. */
  reason: string | null;
};

export type ChangeTagsResult =
  | { ok: true; itemsHash: string; tags: ChangeTag[] }
  | { ok: false; error: "invalid_request" | "no_thesis" | "not_configured" | "no_changes" | "unavailable" };

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

export type NextReport = {
  date: string;
  /** Set when the provider only gives a window: its last day. */
  windowEnd: string | null;
  time: EarningsTime;
  status: "confirmed" | "estimated" | "unknown";
  fiscalPeriod: string | null;
  epsEstimate: number | null;
  epsCurrency: string | null;
  consensus: EarningsConsensus | null;
  revenueEstimate: number | null;
  revenueCurrency: string | null;
  revenueEstimateUsd: number | null;
  fx: EarningsFx | null;
  source: SourceRef;
};

export type ReportRow = {
  /** New York date of the release. */
  date: string;
  time: EarningsTime;
  /** "Q3 2026" style, when the provider names it. */
  fiscalPeriod: string | null;
  periodEnd: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  /** (actual - estimate) / |estimate| in percent. */
  surprisePct: number | null;
  revenueActual: number | null;
  /** The close-to-close move of the session that first traded the report (signed fraction). */
  move: number | null;
  reactionDay: string | null;
  /** Where the date comes from: Yahoo's quarters on record, or the 8-K (item 2.02) on EDGAR. */
  source: SourceRef;
};

export type LeadReport = {
  ticker: string;
  /** supplier, customer, partner, competitor, dependency. */
  category: string;
  /** "names": this company's filing names the other; "named": the other's filing names this one. */
  direction: "names" | "named";
  filingUrl: string | null;
  date: string;
  fiscalPeriod: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  move: number | null;
};

export type StockEarnings = {
  ticker: string;
  today: string;
  next: NextReport | null;
  reports: ReportRow[];
  epsCurrency: string | null;
  revenueCurrency: string | null;
  /** First day of the season the lead reports are drawn from. */
  leadSince: string | null;
  leads: LeadReport[];
};

export type StockEarningsResult = { ok: true; earnings: StockEarnings } | { ok: false; error: "invalid_request" | "unavailable" };

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

export type PeerRow = {
  ticker: string;
  name: string | null;
  /** "filing": a competitor link a filing carries; "sector": a large company in the same sector (no such link on file). */
  basis: "filing" | "sector";
  filingUrl: string | null;
  /** Correlation of daily returns, over about a year and about three months of sessions. */
  corr1y: number | null;
  corr3m: number | null;
};

export type MoveVerdict = "sector" | "shift";

export type NotableMoveRow = {
  date: string;
  /** The stock's move (signed fraction) and its size in standard deviations of a year of daily moves. */
  move: number;
  z: number;
  /** Each peer's move that session, null when it did not trade or is not on record. */
  peerMoves: Record<string, number | null>;
  same: number;
  opposite: number;
  flat: number;
  verdict: MoveVerdict;
};

export type StockPeers = {
  ticker: string;
  asOf: string | null;
  peers: PeerRow[];
  moves: NotableMoveRow[];
};

export type StockPeersResult = { ok: true; peers: StockPeers } | { ok: false; error: "invalid_request" | "unavailable" };
