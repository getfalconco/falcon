/**
 * What the agent engine reads from the world, as one interface.
 *
 * The trigger rules and the write-ups only ever see `AgentDataSources`, so a
 * test hands in a fake and the engine never touches a provider. The live
 * implementation (`sources-live.ts`) maps each method onto services the app
 * already has: Yahoo through `main/stock/market-data-service.ts` (quotes,
 * charts, news, the earnings calendar, consensus), SEC EDGAR through
 * `edgar.ts`, the curated macro calendar shipped in @meridian/research, and
 * the US stock catalog. None of them spends the shared Finnhub quota.
 *
 * The parsers at the bottom are pure and tested.
 */

import { parseOwnershipXml, roleText } from "../edgar/form4";
import type { NewsFeedResult } from "../../shared/news-feed";
import type { FilingChanges } from "../../shared/filing-changes";

export type FilingRef = {
  cik: string;
  form: string;
  accession: string;
  /** "YYYY-MM-DD" */
  filedAt: string;
  /**
   * ISO instant EDGAR accepted it, when the index carries one. With
   * `acceptedAtUtc` it is the true instant (read at fetch time); without, SEC's
   * raw stamp, not always UTC. Read it through
   * `filingAcceptedMs` (@meridian/research/edgar-time).
   */
  acceptedAt: string | null;
  /** True when `acceptedAt` is the true UTC instant rather than SEC's raw stamp. */
  acceptedAtUtc?: boolean;
  /** 8-K item codes ("2.02", "7.01"). */
  items: string[];
  primaryDocument: string | null;
  /** Human-readable document on sec.gov. */
  url: string;
};

export type FilingText = { title: string; url: string; text: string };

export type InsiderTxn = {
  insiderName: string;
  role: string;
  /** P purchase, S sale, A award, M exercise, F tax, G gift. */
  code: string;
  shares: number | null;
  price: number | null;
  value: number | null;
  direction: "acquired" | "disposed" | null;
  date: string | null;
  plan10b51: boolean;
};

export type NewsItem = { id: string; title: string; url: string; source?: string; publishedAt?: string };

export type QuoteRead = {
  symbol: string;
  price: number;
  /** Move against the previous close including extended hours, in percent. */
  changePct: number;
  /** Regular-session move against the previous close, in percent, when known. */
  regularChangePct: number | null;
  previousClose: number | null;
  session: "pre" | "regular" | "post" | "closed";
  asOf: string;
};

export type DailyClose = { date: string; close: number };

export type ConsensusRead = {
  /** Plain lines with the figures, quoted to the model and checked against. */
  lines: string[];
  readAt: string;
};

export type MacroEventRead = {
  date: string;
  timeEt: string | null;
  code: string;
  title: string;
  period?: string;
  importance: 1 | 2 | 3;
};

export type CatalogLookup = { symbol: string; companyName: string } | null;

/**
 * One edge of the local filing graph, as `main/research/graph-edges.ts` reads
 * it: every field optional, since older graphs carry fewer.
 */
export type LinkGraphEdge = {
  root_ticker?: string;
  counterparty_ticker?: string | null;
  counterparty_id?: string;
  counterparty_name?: string;
  counterparty_type?: string | null;
  category?: string;
  subtype?: string;
  strength_tier?: string;
  disclosed_share_pct?: number | null;
  disclosed_share_quote?: string | null;
  confidence?: number;
  evidence_quote?: string;
  source_url?: string;
  filing_date?: string;
  accession_number?: string | null;
  form?: "10-K" | "20-F" | null;
};

/** A story the news feed's classifier cleared as material, with the names it is material for. */
export type MaterialNewsItem = NewsItem & { tickers: string[] };

/**
 * The read-through radar's measured history of one linked pair (see
 * shared/readthrough-types `ReadthroughStats`): how `holding` closed on
 * `counterparty`'s past report days. Moves are signed fractions.
 */
export type ReadthroughRead = {
  counterparty: string;
  holding: string;
  /** Reports measured, also when fewer than three. */
  sample: number;
  stats: {
    events: number;
    withIt: number;
    avgAbsMove: number;
    avgAbsAbnormal: number;
    sensitivity: number | null;
    from: string;
    to: string;
  } | null;
};

export interface AgentDataSources {
  /** Upcoming and recent earnings dates (YYYY-MM-DD), soonest first. */
  earningsDates(ticker: string): Promise<{ dates: string[]; estimated: boolean | null }>;
  /** Recent filings, newest first. */
  filings(ticker: string): Promise<FilingRef[]>;
  /** A filing's text: the press release exhibit for an 8-K when there is one. */
  filingText(filing: FilingRef): Promise<FilingText>;
  /** The first transaction of a Form 4. */
  insiderTxn(filing: FilingRef): Promise<InsiderTxn | null>;
  quote(ticker: string): Promise<QuoteRead>;
  /** One close per session, oldest first, roughly the last month. */
  dailyCloses(ticker: string): Promise<DailyClose[]>;
  news(ticker: string): Promise<NewsItem[]>;
  marketNews(sinceIso: string): Promise<NewsItem[]>;
  consensus(ticker: string): Promise<ConsensusRead | null>;
  macroEvents(fromYmd: string, toYmd: string): MacroEventRead[];
  /** Last date the shipped macro calendar is complete for. */
  macroCoverageUntil(): string;
  /** The catalog entry for a ticker; null when it is not listed; throws when the catalog cannot be read. */
  lookupTicker(ticker: string): Promise<CatalogLookup>;
  /** Best catalog matches for a company name. */
  searchCompany(query: string): Promise<CatalogLookup[]>;
  /** The local filing graph's edges; empty when there is no graph. Read again when the file changes. */
  linkEdges(): Promise<LinkGraphEdge[]>;
  /** The form of the filing step1 read for a filer ("10-K" or "20-F"), when the edge does not carry it. */
  filingFormOf(filer: string): "10-K" | "20-F" | null;
  /** Stories since `sinceIso` the news feed shows (cleared as material), newest first. Throws when the feed cannot be read. */
  materialNews(sinceIso: string): Promise<MaterialNewsItem[]>;
  /** The read-through radar's measured pairs for one name (every filing link of it); empty when it has none. */
  readthrough(holding: string): Promise<ReadthroughRead[]>;
  /**
   * What the company's latest periodic reports changed (main/filings, the
   * Stock tab's Filing changes). `covering`: an accession just seen in the
   * index, so a kept answer that predates it is read again. Throws when
   * EDGAR cannot be read and nothing is kept.
   */
  filingChanges(ticker: string, covering?: string): Promise<FilingChanges>;
}

/* ------------------------------------------------------------------ */
/* Pure parsers                                                         */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  mdash: ", ",
  ndash: "-",
  hellip: "...",
  bull: "*",
};

/** Filing HTML to plain text: tags out, entities decoded, tables kept one row per line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return code === 8212 ? ", " : code === 8211 ? "-" : code === 160 ? " " : String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    .replace(/( \| ){2,}/g, " | ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The parts of a long document worth a model's attention: the opening (where
 * a press release puts its headline numbers) plus every paragraph that names
 * one of `terms`, up to `max` characters. Kept in document order.
 */
export function focusText(text: string, terms: readonly string[], max = 24_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.45));
  const rest = text.slice(head.length);
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  const blocks = rest.split(/\n+/);
  const picked: string[] = [];
  let used = head.length;
  for (const block of blocks) {
    const lower = block.toLowerCase();
    if (!needles.some((n) => lower.includes(n))) continue;
    const piece = block.slice(0, 1200);
    if (used + piece.length + 1 > max) break;
    picked.push(piece);
    used += piece.length + 1;
  }
  return [head, ...picked].join("\n");
}

type Raw = { raw?: unknown; fmt?: unknown } | number | undefined | null;

function rawNum(v: Raw): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && typeof v.raw === "number" && Number.isFinite(v.raw)) return v.raw;
  return null;
}

function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString("en-US");
  return String(Math.round(n * 100) / 100);
}

/**
 * Consensus lines from Yahoo's `earningsTrend` + `earningsHistory` modules.
 * Every figure is the provider's own, printed as it came, so the grounding
 * check can find it again in the write-up.
 */
export function parseConsensus(modules: Record<string, unknown> | null, readAt: string): ConsensusRead | null {
  if (!modules) return null;
  const lines: string[] = [];
  const trend = (modules.earningsTrend as { trend?: Array<Record<string, unknown>> } | undefined)?.trend ?? [];
  for (const t of trend) {
    const period = t.period;
    if (period !== "0q" && period !== "+1q") continue;
    const end = typeof t.endDate === "string" ? t.endDate : "unknown";
    const eps = t.earningsEstimate as Record<string, Raw> | undefined;
    const rev = t.revenueEstimate as Record<string, Raw> | undefined;
    const parts: string[] = [];
    const epsAvg = rawNum(eps?.avg);
    const epsN = rawNum(eps?.numberOfAnalysts);
    const revAvg = rawNum(rev?.avg);
    const revN = rawNum(rev?.numberOfAnalysts);
    const revAgo = rawNum(rev?.yearAgoRevenue);
    const epsAgo = rawNum(eps?.yearAgoEps);
    if (epsAvg !== null) parts.push(`EPS estimate ${fmtNum(epsAvg)}${epsN !== null ? ` (${fmtNum(epsN)} analysts)` : ""}`);
    if (epsAgo !== null) parts.push(`EPS a year earlier ${fmtNum(epsAgo)}`);
    if (revAvg !== null) parts.push(`revenue estimate ${fmtNum(revAvg)}${revN !== null ? ` (${fmtNum(revN)} analysts)` : ""}`);
    if (revAgo !== null) parts.push(`revenue a year earlier ${fmtNum(revAgo)}`);
    if (parts.length === 0) continue;
    const label = period === "0q" ? "Current quarter" : "Next quarter";
    lines.push(`${label} ending ${end}: ${parts.join("; ")}.`);
  }
  const history = (modules.earningsHistory as { history?: Array<Record<string, unknown>> } | undefined)?.history ?? [];
  for (const h of history.slice(-2)) {
    const actual = rawNum(h.epsActual as Raw);
    const estimate = rawNum(h.epsEstimate as Raw);
    const quarter = (h.quarter as { fmt?: unknown } | undefined)?.fmt;
    if (actual === null && estimate === null) continue;
    lines.push(
      `Reported quarter ${typeof quarter === "string" ? quarter : "unknown"}: EPS actual ${actual !== null ? fmtNum(actual) : "n/a"}, estimate ${estimate !== null ? fmtNum(estimate) : "n/a"}.`,
    );
  }
  return lines.length > 0 ? { lines, readAt } : null;
}

/**
 * The first non-derivative transaction of a Form 4 ownership document, read
 * through the shared Form 4 reader (main/edgar/form4.ts). `plan10b51` is the
 * form's Rule 10b5-1 box or a plan footnote on that line.
 */
export function parseForm4(xml: string): InsiderTxn | null {
  const doc = parseOwnershipXml(xml);
  const line = doc?.lines.find((l) => !l.derivative);
  if (!doc || !line) return null;
  const { shares, price } = line;
  return {
    insiderName: doc.reporters[0]?.name ?? "unknown",
    role: roleText(doc.reporters[0]),
    code: line.code,
    shares,
    price,
    value: shares !== null && price !== null ? Math.round(shares * price) : null,
    direction: line.acquiredDisposed === "A" ? "acquired" : line.acquiredDisposed === "D" ? "disposed" : null,
    date: line.date,
    plan10b51: line.plan,
  };
}

/** The feed's stories the engine decided to show (material, a title written), newest first. */
export function materialFromFeed(result: NewsFeedResult, sinceMs: number): MaterialNewsItem[] {
  if (!result || result.ok !== true) throw new Error("the news feed is unavailable");
  const out: MaterialNewsItem[] = [];
  for (const a of result.articles) {
    const f = a.falcon;
    if (!f || f.decision !== "show" || !f.headline || !f.headline.trim()) continue;
    const at = a.datetime * 1000;
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const tickers = (f.tickers.length > 0 ? f.tickers : a.tickers).map((t) => t.trim().toUpperCase()).filter(Boolean);
    out.push({
      id: String(a.id),
      // Falcon's own line, never the publisher's headline (the News card's rule).
      title: f.headline.trim(),
      url: a.url,
      source: a.source,
      publishedAt: new Date(at).toISOString(),
      tickers,
    });
  }
  return out.sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!));
}
