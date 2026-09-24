/**
 * Handover briefing: assembly.
 *
 * Calls every port (quotes, the chain, the market-wide headlines, the
 * calendars), hands the answers to the pure modules beside this file and
 * puts their output together into one `BriefingReport`. The arithmetic lives
 * in those modules; what lives here is the part that touches the outside
 * world, and the rule that goes with it: every input can fail on its own, and
 * the report still ships with that section marked, because a briefing that
 * refuses to open when one quote times out is worth less than one that says
 * which quote is missing.
 *
 * The only clock is the `now` the caller passes in. Timers are used to bound
 * the port calls, never to read the time.
 */

import { normaliseUrl } from "../base/article-dedupe.js";
import { DEFAULT_BASE_CONFIG } from "../base/config.js";
import { addTradingDays, nyWallTimeToUtc, nyYmd, tradingDaysBetween } from "../tracker/calendar.js";
import { buildBook, heldMovers, mergeHoldings, positionValues } from "./book.js";
import { expiryEventsBetween, type ExpiryEvent } from "./expiry.js";
import { deriveImplications, type ImplicationInput, type ImplicationPosition } from "./implications.js";
import { heldFundsTracking } from "./index-map.js";
import { coverageStatus, loadMacroCalendar, macroEventId, macroEventsOn, validateMacroCalendar } from "./macro-calendar.js";
import { MARKET_SYMBOLS, marketRows } from "./markets.js";
import { buildNarrativeFacts, narrativeFactsHash, templateNarrative } from "./narrative.js";
import { rebalanceEventsBetween, type RebalanceEvent } from "./rebalance.js";
import { deriveStories, type StoryInput } from "./stories.js";
import { resolveBriefingWindow } from "./window.js";
import {
  BRIEFING_SCHEMA_VERSION,
  type BriefingDegraded,
  type BriefingHolding,
  type BriefingNarrative,
  type BriefingPorts,
  type BriefingPriorityBand,
  type BriefingReport,
  type BriefingRequest,
  type BriefingRisk,
  type BriefingSectionKey,
  type BriefingWindow,
  type CalendarItem,
  type ChainTickerSlice,
  type CorporateCalendarRaw,
  type CorporateCoverage,
  type CorporateEvent,
  type CorporateEventKind,
  type HeldCoverage,
  type HeldEarnings,
  type HeldFiling,
  type HeldMeasurement,
  type HeldNewsItem,
  type HeldQuote,
  type Implication,
  type MacroCalendarFile,
  type MacroCalendarOverlay,
  type MarketHeadline,
  type MarketSnapshot,
  type QuantSlice,
  type RiskLatestLite,
  type Story,
} from "./types.js";

/** How far ahead, in US sessions counted from the target session, each list looks. */
export const CORPORATE_HORIZON_SESSIONS = 10;
export const EARNINGS_HORIZON_SESSIONS = 10;
/**
 * Longer than the other horizons: a rebalance is announced weeks ahead and the
 * flows it causes build up before the effective date, so a reader holding an
 * index fund wants to see it coming from further out than a dividend.
 */
export const REBALANCE_HORIZON_SESSIONS = 15;
/** A split stays listed this many sessions after it took effect, while price history still looks broken. */
export const RECENT_SPLIT_SESSIONS = 5;

export type GatherOptions = {
  /** The clock was supplied by a developer, not read from the machine. */
  syntheticNow?: boolean;
  /** The caller has asked a model for the narrative and is still waiting. */
  narrativePending?: boolean;
  /** Longest a single port call may take. Default 6000. */
  perCallTimeoutMs?: number;
  /** Longest the whole gathering may take; whatever is unfinished then counts as failed. Default 12000. */
  deadlineMs?: number;
  /** Port calls in flight per section. Default 4. */
  concurrency?: number;
};

const DEFAULT_PER_CALL_TIMEOUT_MS = 6000;
const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_CONCURRENCY = 4;
/**
 * A chain slice is a replay over the Tracker's message log, by far the
 * heaviest port; three at a time keeps a twenty-name book from starving the
 * quote calls running beside it.
 */
const CHAIN_CONCURRENCY = 3;

const MAX_NEWS = 12;
const MAX_FILINGS = 12;
const MAX_MEASUREMENTS = 12;

/**
 * What a held symbol may look like. The symbol is interpolated into provider
 * URLs by the ports, and it arrives over IPC from a renderer-side account a
 * user types into, so anything outside this shape is dropped before a port
 * ever sees it.
 */
const SYMBOL_SHAPE = /^[A-Z0-9.\-^=]{1,12}$/;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ---------------------------------------------------------------------------
// Bounded, failure-collecting port calls
// ---------------------------------------------------------------------------

/**
 * The whole vocabulary of `BriefingDegraded.detail`. A caught error's own text
 * is never used: provider errors carry request ids, URLs and now and then a
 * key, and the report crosses into the renderer and onto disk.
 */
type FailureDetail =
  | "timed out"
  | "request failed"
  | "deadline reached"
  | "unusable response"
  | "invalid symbol dropped"
  | "overlay rejected, shipped calendar used"
  | "calendar file does not reach this session"
  | "schedule rules failed"
  | "template failed"
  | "implications failed"
  | "stories failed"
  | "invalid clock"
  | "assembly failed";

/** `seq` is the order in which calls were started, which is the order of the symbols they were started for. */
type Failure = { section: BriefingSectionKey; detail: FailureDetail; symbols: string[]; call: boolean; seq: number };

type Settled<T> = { ok: true; value: T } | { ok: false };

const SECTION_ORDER: readonly BriefingSectionKey[] = [
  "markets",
  "held_quotes",
  "chain_news",
  "market_news",
  "quant",
  "risk",
  "corporate_actions",
  "macro_calendar",
  "narrative",
];

type Settler = {
  settle<T>(
    section: BriefingSectionKey,
    symbols: string[],
    fn: () => Promise<T>,
    usable?: (value: T) => boolean,
  ): Promise<Settled<T>>;
  note(section: BriefingSectionKey, detail: FailureDetail, symbols?: string[]): void;
  degraded(): BriefingDegraded[];
  dispose(): void;
};

function createSettler(perCallTimeoutMs: number, deadlineMs: number): Settler {
  const failures: Failure[] = [];
  const attempts = new Map<BriefingSectionKey, number>();
  let started = 0;

  let expired = false;
  let expire: () => void = () => {};
  const deadline = new Promise<"deadline">((resolve) => {
    expire = () => resolve("deadline");
  });
  const deadlineTimer = setTimeout(() => {
    expired = true;
    expire();
  }, deadlineMs);

  const fail = (section: BriefingSectionKey, detail: FailureDetail, symbols: string[], call: boolean, seq: number): void => {
    failures.push({ section, detail, symbols, call, seq });
  };

  return {
    async settle(section, symbols, fn, usable) {
      attempts.set(section, (attempts.get(section) ?? 0) + 1);
      const seq = ++started;
      // A call still queued behind the concurrency limit when the deadline
      // passes is not started at all: its answer could not be used, and the
      // request would only add load to a provider that is already slow.
      if (expired) {
        fail(section, "deadline reached", symbols, true, seq);
        return { ok: false };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), perCallTimeoutMs);
      });
      try {
        // Started inside a then() so a port that throws synchronously is
        // caught like one that rejects.
        const call = Promise.resolve()
          .then(fn)
          .then((value) => ({ value }));
        const outcome = await Promise.race([call, timeout, deadline]);
        if (outcome === "timeout" || outcome === "deadline") {
          fail(section, outcome === "timeout" ? "timed out" : "deadline reached", symbols, true, seq);
          return { ok: false };
        }
        if (usable && !usable(outcome.value)) {
          fail(section, "unusable response", symbols, true, seq);
          return { ok: false };
        }
        return { ok: true, value: outcome.value };
      } catch {
        fail(section, "request failed", symbols, true, seq);
        return { ok: false };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    note(section, detail, symbols = []) {
      fail(section, detail, symbols, false, ++started);
    },

    /**
     * One entry per section and reason, sections in a fixed order and symbols
     * in the order their calls were started, so the same failures produce the
     * same list whichever call happened to come back first. The reader of this list treats an entry
     * without symbols as "the whole section failed" and one with symbols as
     * "the rest of the section stands", so a section whose every call failed
     * is reported once, without symbols, instead of naming every symbol.
     */
    degraded() {
      const out: BriefingDegraded[] = [];
      for (const section of SECTION_ORDER) {
        const own = failures.filter((f) => f.section === section).sort((a, b) => a.seq - b.seq);
        if (own.length === 0) continue;

        const calls = own.filter((f) => f.call);
        const attempted = attempts.get(section) ?? 0;
        const wholeSection = calls.length > 0 && calls.length === attempted && (attempted > 1 || calls[0]!.symbols.length === 0);
        if (wholeSection) {
          const details = [...new Set(calls.map((f) => f.detail))];
          out.push({ section, detail: details.length === 1 ? details[0]! : "request failed" });
        }

        const byDetail = new Map<FailureDetail, string[] | null>();
        for (const f of wholeSection ? own.filter((x) => !x.call) : own) {
          const known = byDetail.get(f.detail);
          if (f.symbols.length === 0 || known === null) byDetail.set(f.detail, null);
          else byDetail.set(f.detail, [...new Set([...(known ?? []), ...f.symbols])]);
        }
        for (const [detail, symbols] of byDetail) {
          out.push(symbols === null ? { section, detail } : { section, detail, symbols });
        }
      }
      return out;
    },

    dispose() {
      clearTimeout(deadlineTimer);
    },
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

/** What is left of a rejected symbol that is still safe to print in a note. */
function printable(symbol: unknown): string {
  const text = typeof symbol === "string" ? symbol.toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "").slice(0, 12) : "";
  return text === "" ? "?" : text;
}

function normaliseHoldings(raw: unknown): { holdings: BriefingHolding[]; invalid: string[] } {
  const valid: BriefingHolding[] = [];
  const invalid: string[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!isRecord(row)) continue;
    const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    if (!SYMBOL_SHAPE.test(symbol)) {
      invalid.push(printable(row.symbol));
      continue;
    }
    valid.push({ symbol, shares: Number(row.shares), cost_usd: Number(row.cost_usd) });
  }
  return { holdings: mergeHoldings(valid), invalid: [...new Set(invalid)] };
}

// ---------------------------------------------------------------------------
// Chain: news, filings, measurements, coverage
// ---------------------------------------------------------------------------

const BAND_RANK: Record<BriefingPriorityBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function recency(a: string, b: string): number {
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) ? d : 0;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A syndicated article reaches every held name it mentions, once per slice.
 * Listing it once per name would let one story fill the section, so the copies
 * are folded into the most urgent one and the other names are kept in `also`.
 * The URL is the identity (tracking parameters stripped, the way Base strips
 * them); only an item with no usable URL falls back to its headline.
 */
function mergeNews(slices: ChainTickerSlice[], held: string[]): HeldNewsItem[] {
  const order = new Map(held.map((symbol, index) => [symbol, index]));
  const groups = new Map<string, HeldNewsItem[]>();
  for (const slice of slices) {
    for (const raw of list(slice.news)) {
      if (!isRecord(raw) || typeof raw.headline !== "string" || raw.headline.trim() === "") continue;
      const item: HeldNewsItem = {
        ...raw,
        ticker: slice.ticker,
        also: list(raw.also).filter((s): s is string => typeof s === "string"),
        band: raw.band in BAND_RANK ? raw.band : "P3",
        tags: list(raw.tags).filter((s): s is string => typeof s === "string"),
        url: typeof raw.url === "string" ? raw.url : "",
      };
      const key = normaliseUrl(item.url, DEFAULT_BASE_CONFIG) ?? `headline:${item.headline.trim().toLowerCase().replace(/\s+/g, " ")}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  }

  const merged: HeldNewsItem[] = [];
  for (const items of groups.values()) {
    const ranked = [...items].sort(
      (a, b) =>
        BAND_RANK[a.band] - BAND_RANK[b.band] ||
        recency(a.published_at, b.published_at) ||
        (order.get(a.ticker) ?? 0) - (order.get(b.ticker) ?? 0),
    );
    const survivor = ranked[0]!;
    const others = new Set<string>();
    for (const item of items) {
      for (const symbol of [item.ticker, ...item.also]) {
        const upper = symbol.trim().toUpperCase();
        if (upper !== survivor.ticker && order.has(upper)) others.add(upper);
      }
    }
    merged.push({ ...survivor, also: [...others].sort((a, b) => order.get(a)! - order.get(b)!) });
  }

  return merged.sort(
    (a, b) => BAND_RANK[a.band] - BAND_RANK[b.band] || recency(a.published_at, b.published_at) || byText(a.ticker, b.ticker),
  );
}

/**
 * Headlines per held name since the close, counted over the merged list before
 * the display cap takes the top `MAX_NEWS` of it.
 *
 * The conclusions say "no headline on X accounts for it" only where this is
 * zero. Counting the capped list instead would let a P0 item about another
 * name cut a tracked name's own headlines and turn that cut into the evidence
 * for a conclusion. An item whose `published_at` cannot be read counts as
 * present: it is a headline the night carried, whatever its date says.
 */
function newsCounts(merged: HeldNewsItem[], held: string[], since: string): Record<string, number> {
  const sinceMs = Date.parse(since);
  const counts: Record<string, number> = {};
  for (const symbol of held) counts[symbol] = 0;
  for (const item of merged) {
    const at = Date.parse(item.published_at);
    if (Number.isFinite(at) && Number.isFinite(sinceMs) && at < sinceMs) continue;
    for (const raw of [item.ticker, ...item.also]) {
      const symbol = String(raw).trim().toUpperCase();
      const known = counts[symbol];
      if (known !== undefined) counts[symbol] = known + 1;
    }
  }
  return counts;
}

function mergeFilings(slices: ChainTickerSlice[]): HeldFiling[] {
  const seen = new Set<string>();
  const out: HeldFiling[] = [];
  for (const slice of slices) {
    for (const f of list(slice.filings)) {
      if (!isRecord(f) || typeof f.label !== "string") continue;
      const key = `${slice.ticker}|${f.kind}|${f.url}|${f.label}|${f.filed_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, ticker: slice.ticker });
    }
  }
  return out.sort((a, b) => recency(a.filed_at, b.filed_at) || byText(a.ticker, b.ticker)).slice(0, MAX_FILINGS);
}

function mergeMeasurements(slices: ChainTickerSlice[]): HeldMeasurement[] {
  const out: HeldMeasurement[] = [];
  for (const slice of slices) {
    for (const m of list(slice.measurements)) {
      if (isRecord(m) && typeof m.detail === "string") out.push({ ...m, ticker: slice.ticker });
    }
  }
  return out.sort((a, b) => recency(a.at, b.at) || byText(a.ticker, b.ticker) || byText(a.type, b.type)).slice(0, MAX_MEASUREMENTS);
}

function coverageOf(slice: ChainTickerSlice | null): HeldCoverage {
  // A slice that failed is reported as "pending", the weakest claim: the panel
  // then says the name has no chain coverage yet, never that its night was quiet.
  if (slice === null) return "pending";
  return slice.coverage === "tracked" || slice.coverage === "price_only" ? slice.coverage : "pending";
}

// ---------------------------------------------------------------------------
// Market headlines
// ---------------------------------------------------------------------------

const MAX_HEADLINES = 12;
const MAX_HEADLINE_TITLE_CHARS = 300;
const MAX_HEADLINE_FIELD_CHARS = 80;
const MAX_HEADLINE_URL_CHARS = 2048;
const MAX_HEADLINE_RELATED = 8;

/** Third-party text, flattened to one line and capped before it is stored or shown. */
function oneLine(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) out += ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch;
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxChars ? `${out.slice(0, maxChars).trimEnd()}...` : out;
}

/** Only http(s) links are kept: the URL ends up behind a click in the panel. */
function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_HEADLINE_URL_CHARS) return "";
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

/**
 * The market-wide headlines since the close, as the report stores them: one
 * per article (the URL is the identity, tracking parameters stripped the way
 * Base strips them, and the tickers the copies were tagged with are merged),
 * newest first, capped at the display. The port filters by `since` already,
 * but it is an outside call, so the filter is applied again here; an item
 * whose date cannot be read is dropped rather than shown as "since the close"
 * on the strength of nothing.
 */
function marketHeadlines(raw: unknown, since: string): MarketHeadline[] {
  const sinceMs = Date.parse(since);
  const byUrl = new Map<string, MarketHeadline>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item)) continue;
    const title = oneLine(item.title, MAX_HEADLINE_TITLE_CHARS);
    const url = webUrl(item.url);
    const at = Date.parse(typeof item.published_at === "string" ? item.published_at : "");
    if (title === "" || url === "" || !Number.isFinite(at) || (Number.isFinite(sinceMs) && at < sinceMs)) continue;
    const related = list(item.related as unknown[])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s !== "");
    const key = normaliseUrl(url, DEFAULT_BASE_CONFIG) ?? url;
    const known = byUrl.get(key);
    if (known) {
      known.related = [...new Set([...known.related, ...related])].slice(0, MAX_HEADLINE_RELATED);
      continue;
    }
    byUrl.set(key, {
      id: oneLine(item.id, MAX_HEADLINE_FIELD_CHARS) || key,
      title,
      source: oneLine(item.source, MAX_HEADLINE_FIELD_CHARS),
      url,
      published_at: new Date(at).toISOString(),
      related: [...new Set(related)].slice(0, MAX_HEADLINE_RELATED),
      via: oneLine(item.via, MAX_HEADLINE_FIELD_CHARS),
    });
  }
  return [...byUrl.values()].sort((a, b) => recency(a.published_at, b.published_at) || byText(a.url, b.url)).slice(0, MAX_HEADLINES);
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

function toRisk(latest: RiskLatestLite, held: string[], overnightSince: string): BriefingRisk {
  const theirs = new Set(list(latest.tickers).map((t) => String(t).trim().toUpperCase()).filter((t) => t !== ""));
  const ours = new Set(held);
  // The risk host recomputes on its own schedule, so `risk:latest` is routinely
  // the snapshot from before the last close: it describes the book as it stood
  // in a session that has ended, and its figures would size a book the reader
  // has since resized or moved to cash. A snapshot older than the close this
  // report measures from is treated as another book's.
  const at = Date.parse(typeof latest.computed_at === "string" ? latest.computed_at : "");
  const since = Date.parse(overnightSince);
  const fresh = Number.isFinite(at) && (!Number.isFinite(since) || at >= since);
  // The engine keeps a single risk account. Its figures are carried either
  // way, and this flag is what stops them being shown against another book.
  const matches = fresh && ours.size > 0 && theirs.size === ours.size && [...ours].every((t) => theirs.has(t));
  return {
    score: latest.score ?? null,
    band: latest.band ?? null,
    driver_component: latest.driver_component ?? null,
    driver_sentence: latest.driver_sentence ?? null,
    beta_eff: latest.beta_eff ?? null,
    beta_port: latest.beta_port ?? null,
    port_vol_daily_pct: latest.port_vol_daily_pct ?? null,
    computed_at: typeof latest.computed_at === "string" ? latest.computed_at : "",
    matches_book: matches,
  };
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

function realYmd(value: unknown): string | null {
  if (typeof value !== "string" || !YMD.test(value)) return null;
  const d = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/** Signed sessions from the target session: 0 on it, negative once behind it. */
function sessionsFrom(targetYmd: string, ymd: string): number {
  return ymd >= targetYmd ? tradingDaysBetween(targetYmd, ymd) : -tradingDaysBetween(ymd, targetYmd);
}

function nextEarnings(
  held: string[],
  slices: Map<string, ChainTickerSlice | null>,
  corporate: Map<string, CorporateCalendarRaw | null>,
  targetYmd: string,
): HeldEarnings[] {
  const lastYmd = addTradingDays(targetYmd, EARNINGS_HORIZON_SESSIONS);
  const inRange = (ymd: string): boolean => ymd >= targetYmd && ymd <= lastYmd;
  const out: HeldEarnings[] = [];

  for (const ticker of held) {
    // The chain's dates are the ones the company announced, with the hour; the
    // provider calendar mixes those with its own projections and gives no
    // hour. So the chain is believed first and the provider only fills a gap.
    const tracked: HeldEarnings[] = [];
    for (const row of list(slices.get(ticker)?.scheduled_earnings)) {
      const due = isRecord(row) && typeof row.due_at === "string" ? new Date(row.due_at) : null;
      if (due === null || Number.isNaN(due.getTime())) continue;
      const dueYmd = nyYmd(due);
      if (!inRange(dueYmd)) continue;
      tracked.push({
        ticker,
        due_ymd: dueYmd,
        // The Tracker stamps a before-the-open release 12:00Z and everything
        // else 20:00Z, so an hour nobody has announced is stored as after the
        // close and cannot be told apart from a real one.
        timing: due.getUTCHours() === 12 && due.getUTCMinutes() === 0 ? "bmo" : "amc_or_unspecified",
        sessions_until: sessionsFrom(targetYmd, dueYmd),
        fiscal_period: typeof row.fiscal_period === "string" && row.fiscal_period.trim() !== "" ? row.fiscal_period.trim() : null,
        confirmed: row.confirmed === true,
        source: "tracker",
      });
    }

    const raw = corporate.get(ticker) ?? null;
    const provided: HeldEarnings[] = list(raw?.earnings_dates)
      .map(realYmd)
      .filter((ymd): ymd is string => ymd !== null && inRange(ymd))
      .map((ymd) => ({
        ticker,
        due_ymd: ymd,
        timing: "amc_or_unspecified" as const,
        sessions_until: sessionsFrom(targetYmd, ymd),
        fiscal_period: null,
        confirmed: raw?.earnings_estimated === false,
        source: "yahoo" as const,
      }));

    const nearest = (tracked.length > 0 ? tracked : provided).sort((a, b) => byText(a.due_ymd, b.due_ymd))[0];
    if (nearest) out.push(nearest);
  }

  return out.sort((a, b) => byText(a.due_ymd, b.due_ymd) || byText(a.ticker, b.ticker));
}

function earningsTimingWords(e: HeldEarnings): string {
  return e.timing === "bmo" ? "before the open" : "after the close, or at an hour not yet announced";
}

// ---------------------------------------------------------------------------
// Corporate events
// ---------------------------------------------------------------------------

const KIND_ORDER: Record<CorporateEventKind, number> = { dividend: 0, split: 1, rebalance: 2, earnings: 3 };

function usd(amount: number): string {
  // Fund distributions are declared to four decimals; trailing zeros past the
  // cents are noise.
  const fixed = amount.toFixed(4).replace(/0{1,2}$/, "");
  return `$${fixed}`;
}

function ratioPart(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * The empty case is scoped to the list, not to the book: `heldFundsTracking`
 * knows the hand-kept fund map in index-map.ts and nothing else, so "no held
 * fund tracks this family" would be a completeness claim that map cannot
 * support, and a plainly false one for a reader holding a fund it has yet to
 * learn. `corporate_coverage` is where the limits of the lists are said.
 */
function rebalanceDetail(event: RebalanceEvent, funds: string[]): string {
  return funds.length > 0
    ? `${event.detail} Held funds tracking it: ${funds.join(", ")}.`
    : `${event.detail} None of the funds this report tracks for that family is held.`;
}

/**
 * Family and date are enough: the calendar merge keeps one index event per
 * family and date, and a curated entry in a quarter-end month replaces the
 * rule date instead of standing beside it.
 */
function rebalanceId(event: RebalanceEvent): string {
  return `reb:${event.family}:${event.date}`;
}

function corporateEvents(
  held: string[],
  corporate: Map<string, CorporateCalendarRaw | null>,
  rebalances: RebalanceEvent[],
  earnings: HeldEarnings[],
  window: BriefingWindow,
): CorporateEvent[] {
  const target = window.target_session_ymd;
  const lastYmd = addTradingDays(target, CORPORATE_HORIZON_SESSIONS);
  const firstSplitYmd = addTradingDays(target, -RECENT_SPLIT_SESSIONS);
  const events = new Map<string, CorporateEvent>();

  for (const ticker of held) {
    const raw = corporate.get(ticker) ?? null;
    if (raw === null) continue;

    // Only dates from the target session on. The provider keeps the last
    // ex-date in this field until the next one is declared, so most of the
    // time it holds a date months in the past, and listing that would read as
    // an upcoming event.
    const exDate = realYmd(raw.ex_dividend_date);
    if (exDate !== null && exDate >= target && exDate <= lastYmd) {
      const rate = typeof raw.dividend_rate === "number" && Number.isFinite(raw.dividend_rate) && raw.dividend_rate > 0 ? raw.dividend_rate : null;
      events.set(`div:${ticker}:${exDate}`, {
        id: `div:${ticker}:${exDate}`,
        kind: "dividend",
        date: exDate,
        sessions_until: sessionsFrom(target, exDate),
        ticker,
        index: null,
        title: `${ticker} ex-dividend date`,
        detail:
          rate === null
            ? "Shares held before this date carry the payment."
            : `Indicated annual rate ${usd(rate)} per share. Shares held before this date carry the payment.`,
        affects_held: [ticker],
        certainty: "confirmed",
        source: "yahoo_calendar",
      });
    }

    // Funds have no provider calendar at all, so their distributions are only
    // ever seen here: on the ex-date itself, once the payment shows up in the
    // session's price history.
    for (const paid of list(raw.recent_dividends)) {
      const date = isRecord(paid) ? realYmd(paid.date) : null;
      if (date !== target) continue;
      const amount = typeof paid.amount === "number" && Number.isFinite(paid.amount) && paid.amount > 0 ? paid.amount : null;
      const id = `div:${ticker}:${date}`;
      const perShare = amount === null ? "A distribution" : `${usd(amount)} per share`;
      const known = events.get(id);
      events.set(id, {
        id,
        kind: "dividend",
        date,
        sessions_until: 0,
        ticker,
        index: null,
        title: `${ticker} ex-dividend date`,
        detail: `${perShare} went ex-dividend this session, read from the price history.`,
        affects_held: [ticker],
        certainty: "confirmed",
        // When the calendar had the date too, the calendar stays the source of
        // the date and the price history only supplies the exact amount.
        source: known ? known.source : "yahoo_chart",
      });
    }

    for (const split of list(raw.recent_splits)) {
      const date = isRecord(split) ? realYmd(split.date) : null;
      if (date === null || date < firstSplitYmd || date > target) continue;
      const { numerator, denominator } = split;
      if (!(Number.isFinite(numerator) && Number.isFinite(denominator) && numerator > 0 && denominator > 0)) continue;
      const inWindow = date > window.prev_session_ymd;
      events.set(`split:${ticker}:${date}`, {
        id: `split:${ticker}:${date}`,
        kind: "split",
        date,
        sessions_until: sessionsFrom(target, date),
        ticker,
        index: null,
        title: `${ticker} ${ratioPart(numerator)}-for-${ratioPart(denominator)} ${numerator < denominator ? "reverse split" : "split"} took effect`,
        detail: inWindow
          ? "The move since the last close is withheld for this name until the provider's prices are on the new share count."
          : "Price history from before this date is on the old share count.",
        affects_held: [ticker],
        certainty: "confirmed",
        source: "yahoo_chart",
      });
    }
  }

  // Kept even when no held fund tracks the family: an index rebalance moves
  // closing-auction volume across every constituent, held stocks included.
  for (const event of rebalances) {
    const funds = heldFundsTracking(event.family, held);
    const id = rebalanceId(event);
    events.set(id, {
      id,
      kind: "rebalance",
      date: event.date,
      sessions_until: sessionsFrom(target, event.date),
      ticker: null,
      index: event.family,
      title: event.title,
      detail: rebalanceDetail(event, funds),
      affects_held: funds,
      certainty: event.certainty,
      source: event.source,
    });
  }

  for (const e of earnings) {
    const period = e.fiscal_period ? `${e.fiscal_period} results` : "Results";
    events.set(`earn:${e.ticker}:${e.due_ymd}`, {
      id: `earn:${e.ticker}:${e.due_ymd}`,
      kind: "earnings",
      date: e.due_ymd,
      sessions_until: e.sessions_until,
      ticker: e.ticker,
      index: null,
      title: `${e.ticker} earnings report`,
      detail:
        e.source === "tracker"
          ? `${period} ${earningsTimingWords(e)}. Date confirmed by the company.`
          : e.confirmed
            ? `${period}, hour not announced. Date confirmed, per the data provider.`
            : `${period}, hour not announced. Date projected by the data provider and not confirmed by the company.`,
      affects_held: [e.ticker],
      certainty: e.confirmed ? "confirmed" : "estimated",
      source: e.source === "tracker" ? "tracker" : "yahoo_calendar",
    });
  }

  return [...events.values()].sort(
    (a, b) => byText(a.date, b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byText(a.id, b.id),
  );
}

/**
 * Said in the report itself, because both gaps are silent otherwise: the
 * provider publishes no forward calendar for funds and announces no split
 * before it happens, so an empty list here must never be read as "nothing is
 * scheduled".
 */
function corporateCoverage(held: string[], corporate: Map<string, CorporateCalendarRaw | null>): CorporateCoverage {
  return {
    dividends:
      "Ex-dividend dates cover companies, as declared to the data provider. Upcoming fund distributions are not available from the provider; a fund's distribution is listed on its ex-date, once it shows in the price history.",
    splits:
      "Splits are listed once they take effect, from the price history. Upcoming splits are not available from the provider.",
    unknown_symbols: held.filter((symbol) => corporate.get(symbol)?.available !== true),
  };
}

// ---------------------------------------------------------------------------
// Calendar for the target session
// ---------------------------------------------------------------------------

const EXPIRY_IMPORTANCE: Record<ExpiryEvent["kind"], 1 | 2 | 3> = {
  quarterly_expiry: 3,
  monthly_opex: 2,
  vix_expiry: 1,
};

function calendarToday(
  window: BriefingWindow,
  cal: MacroCalendarFile,
  expiries: ExpiryEvent[],
  rebalances: RebalanceEvent[],
  earnings: HeldEarnings[],
  held: string[],
): CalendarItem[] {
  const target = window.target_session_ymd;
  const items: CalendarItem[] = [];

  // All-day on purpose, although the close has a clock time: the title already
  // carries it, and a timed item would have it printed twice in any sentence
  // built as "title at time".
  if (window.early_close) {
    items.push({
      id: "session:early_close",
      kind: "session",
      time_et: null,
      at: null,
      title: "Early close at 13:00 ET",
      detail: "US equities close at 13:00 ET this session.",
      importance: 2,
      tickers: [],
      source: "rule",
    });
  }
  if (window.handover === "holiday") {
    items.push({
      id: "session:after_holiday",
      kind: "session",
      time_et: null,
      at: null,
      title: "First session after a US market holiday",
      detail: "Markets abroad traded while the US was closed.",
      importance: 1,
      tickers: [],
      source: "rule",
    });
  }

  for (const e of macroEventsOn(target, cal)) {
    const clock = typeof e.time_et === "string" ? HHMM.exec(e.time_et) : null;
    items.push({
      id: `macro:${macroEventId(e)}`,
      kind: e.kind,
      time_et: clock ? e.time_et : null,
      at: clock ? nyWallTimeToUtc(target, Number(clock[1]), Number(clock[2])).toISOString() : null,
      title: e.title,
      detail: e.period ? `Covers ${e.period}.` : null,
      importance: e.importance,
      tickers: [],
      source: e.source,
    });
  }

  for (const e of expiries) {
    if (e.date !== target) continue;
    items.push({
      id: `opex:${e.kind}:${e.date}`,
      kind: "opex",
      time_et: null,
      at: null,
      title: e.title,
      detail: e.detail,
      importance: EXPIRY_IMPORTANCE[e.kind],
      tickers: [],
      source: "rule",
    });
  }

  for (const e of rebalances) {
    if (e.date !== target) continue;
    const funds = heldFundsTracking(e.family, held);
    items.push({
      id: rebalanceId(e),
      kind: "rebalance",
      time_et: null,
      at: null,
      title: e.title,
      detail: rebalanceDetail(e, funds),
      importance: 2,
      tickers: funds,
      source: e.source,
    });
  }

  for (const e of earnings) {
    if (e.due_ymd !== target) continue;
    const when = earningsTimingWords(e);
    items.push({
      id: `earn:${e.ticker}:${e.due_ymd}`,
      kind: "earnings",
      // The hour is known only as before or after the session, so there is no
      // clock time to place it at.
      time_et: null,
      at: null,
      title: `${e.ticker} earnings report`,
      detail: `${when.charAt(0).toUpperCase()}${when.slice(1)}.`,
      importance: 3,
      tickers: [e.ticker],
      source: e.source,
    });
  }

  const allDay = items.filter((i) => i.time_et === null).sort((a, b) => b.importance - a.importance || byText(a.id, b.id));
  const timed = items
    .filter((i) => i.time_et !== null)
    .sort((a, b) => byText(a.time_et!, b.time_et!) || b.importance - a.importance || byText(a.id, b.id));
  return [...allDay, ...timed];
}

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

type ReportBody = Omit<BriefingReport, "narrative" | "facts_hash">;

/**
 * The conclusions over the finished figures. A fault in them costs the
 * conclusions only: the figures they are drawn from still stand, and the note
 * goes on the narrative, the other section that interprets rather than
 * measures.
 */
function implicationsOf(input: ImplicationInput, positions: ImplicationPosition[], settler: Settler): Implication[] {
  try {
    return deriveImplications(input, positions);
  } catch {
    settler.note("narrative", "implications failed");
    return [];
  }
}

/**
 * The stories over the finished body. A fault in them costs the stories only:
 * the figures and conclusions they are built from still stand, and the note
 * goes on the narrative, as the conclusions' does.
 */
function storiesOf(input: StoryInput, settler: Settler): Story[] {
  try {
    return deriveStories(input);
  } catch {
    settler.note("narrative", "stories failed");
    return [];
  }
}

/**
 * The template narrative over the finished body. A demo book is never sent to
 * a model, so it can never be waiting for one, whatever the caller passed.
 */
function narrate(body: ReportBody, nowIso: string, pending: boolean): { narrative: BriefingNarrative; hash: string; failed: boolean } {
  try {
    const facts = buildNarrativeFacts(body);
    const hash = narrativeFactsHash(facts);
    return { narrative: { ...templateNarrative(facts, nowIso, hash, null), pending: pending && !body.demo }, hash, failed: false };
  } catch {
    return {
      failed: true,
      hash: "none",
      narrative: {
        text: "The written summary is not available for this report. The figures below are complete.",
        source: "template",
        model: null,
        generated_at: nowIso,
        facts_hash: "none",
        pending: false,
        reason: "template failed",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

async function assemble(
  req: BriefingRequest,
  now: Date,
  ports: BriefingPorts,
  opts: GatherOptions,
  settler: Settler,
): Promise<BriefingReport> {
  const nowIso = now.toISOString();
  const scheduled = resolveBriefingWindow(now);
  const concurrency = Math.floor(positiveOr(opts.concurrency, DEFAULT_CONCURRENCY));

  const { holdings, invalid } = normaliseHoldings(req.holdings);
  if (invalid.length > 0) settler.note("held_quotes", "invalid symbol dropped", invalid);
  const held = holdings.map((h) => h.symbol);

  const perSymbol = async <T>(
    section: BriefingSectionKey,
    symbols: string[],
    limit: number,
    call: (symbol: string) => Promise<T>,
    usable: (value: T) => boolean,
  ): Promise<Map<string, T | null>> => {
    const settled = await mapLimit(symbols, limit, (symbol) => settler.settle(section, [symbol], () => call(symbol), usable));
    const out = new Map<string, T | null>();
    symbols.forEach((symbol, i) => {
      const result = settled[i]!;
      out.set(symbol, result.ok ? result.value : null);
    });
    return out;
  };

  const [snapshots, quotes, quants, slices, riskLatest, corporate, news, overlay] = await Promise.all([
    perSymbol<MarketSnapshot>("markets", MARKET_SYMBOLS.map((d) => d.symbol), concurrency, (s) => ports.marketSnapshot(s), isRecord),
    perSymbol<HeldQuote>("held_quotes", held, concurrency, (s) => ports.heldQuote(s), isRecord),
    // Null is an answer here ("not tracked"), not a failure.
    perSymbol<QuantSlice | null>("quant", held, concurrency, (s) => ports.quant(s), (v) => v === null || isRecord(v)),
    perSymbol<ChainTickerSlice>(
      "chain_news",
      held,
      Math.min(concurrency, CHAIN_CONCURRENCY),
      (s) => ports.chainSlice(s, held, scheduled.overnight_since),
      isRecord,
    ),
    settler.settle<RiskLatestLite | null>("risk", [], () => ports.riskLatest(), (v) => v === null || isRecord(v)),
    perSymbol<CorporateCalendarRaw>("corporate_actions", held, concurrency, (s) => ports.corporateCalendar(s), isRecord),
    settler.settle<MarketHeadline[]>("market_news", [], () => ports.marketNews(scheduled.overnight_since), Array.isArray),
    ports.calendarOverlay
      ? settler.settle<MacroCalendarOverlay | null>("macro_calendar", [], () => ports.calendarOverlay!(), (v) => v === null || isRecord(v))
      : Promise.resolve<Settled<MacroCalendarOverlay | null>>({ ok: true, value: null }),
  ]);

  // The overlay is fetched at run time and hand-written, so it is held to the
  // same validator as the shipped file. A rejected overlay costs its
  // corrections, not the calendar.
  let cal = loadMacroCalendar(null);
  if (overlay.ok && overlay.value !== null) {
    try {
      const merged = loadMacroCalendar(overlay.value);
      if (validateMacroCalendar(merged).length === 0) cal = merged;
      else settler.note("macro_calendar", "overlay rejected, shipped calendar used");
    } catch {
      settler.note("macro_calendar", "overlay rejected, shipped calendar used");
    }
  }

  // Resolved a second time, now that the curated calendar and its overlay have
  // answered: an ad-hoc close decides which session the report hands over to,
  // and the scheduled window above only existed so the port calls could start
  // without waiting for the file. The chain slices were asked for with the
  // scheduled close, so when an override moves the previous close earlier the
  // hours in between are not covered by them, which is the price of not
  // holding every other call back until the overlay is in.
  const window = resolveBriefingWindow(now, cal.session_overrides);
  const target = window.target_session_ymd;

  // A split that took effect after the previous close leaves the provider's
  // reference price on the old share count, so the name's move is withheld.
  const splitSymbols = new Set<string>();
  for (const symbol of held) {
    for (const split of list(corporate.get(symbol)?.recent_splits)) {
      const date = isRecord(split) ? realYmd(split.date) : null;
      if (date !== null && date > window.prev_session_ymd && date <= target) splitSymbols.add(symbol);
    }
  }

  // The date rules throw on a malformed bound instead of returning an empty
  // list, which would read as "nothing scheduled".
  let expiries: ExpiryEvent[] = [];
  let rebalances: RebalanceEvent[] = [];
  try {
    expiries = expiryEventsBetween(target, target);
    rebalances = rebalanceEventsBetween(target, addTradingDays(target, REBALANCE_HORIZON_SESSIONS), cal.index_events);
  } catch {
    settler.note("macro_calendar", "schedule rules failed");
  }

  // The held symbol, not whatever the port echoed back, names the slice.
  const namedSlices = held.flatMap((symbol) => {
    const slice = slices.get(symbol) ?? null;
    return slice === null ? [] : [{ ...slice, ticker: symbol }];
  });

  // Merged once and capped at the display, so the count the conclusions read
  // is of the whole night rather than of the twelve rows that fit.
  const mergedNews = mergeNews(namedSlices, held);
  const earnings = nextEarnings(held, slices, corporate, target);
  const calendarCoverage = coverageStatus(target, cal);
  if (!calendarCoverage.covers_target) settler.note("macro_calendar", "calendar file does not reach this session");

  const figures: Omit<ReportBody, "implications" | "stories" | "degraded"> = {
    schema_version: BRIEFING_SCHEMA_VERSION,
    generated_at: nowIso,
    demo: req.demo === true,
    synthetic_now: opts.syntheticNow === true,
    window,
    overnight: {
      markets: marketRows(snapshots, window.overnight_since),
      held_movers: heldMovers(holdings, quotes, quants, window.phase, splitSymbols),
      held_news: mergedNews.slice(0, MAX_NEWS),
      filings: mergeFilings(namedSlices),
      measurements: mergeMeasurements(namedSlices),
    },
    held_coverage: held.map((ticker) => ({ ticker, coverage: coverageOf(slices.get(ticker) ?? null) })),
    book: buildBook(holdings, Number(req.cash), quotes, window.phase, nowIso, splitSymbols),
    risk: riskLatest.ok && riskLatest.value !== null ? toRisk(riskLatest.value, held, window.overnight_since) : null,
    earnings_next: earnings,
    corporate_events: corporateEvents(held, corporate, rebalances, earnings, window),
    corporate_coverage: corporateCoverage(held, corporate),
    calendar_today: calendarToday(window, cal, expiries, rebalances, earnings, held),
    calendar_coverage: calendarCoverage,
    // Filtered against the final window's close, not the scheduled one the
    // port was asked with, so an ad-hoc early close keeps the rule the chain
    // slices follow: nothing from before the close the report measures from.
    headlines: news.ok ? marketHeadlines(news.value, window.overnight_since) : [],
  };
  // Valued by the same rule as the book, so the weights behind a conclusion
  // add up to the invested figure printed beside it.
  const positions = positionValues(holdings, quotes);
  const implications = implicationsOf(
    { ...figures, news_counts: newsCounts(mergedNews, held, window.overnight_since) },
    positions,
    settler,
  );
  const body: ReportBody = {
    ...figures,
    implications,
    // Built after the conclusions, which the stories read: a name's own move
    // is that name's story's meaning, and the open indication is the tape's.
    stories: storiesOf({ ...figures, implications, market_news_unavailable: !news.ok }, settler),
    degraded: [],
  };

  const { narrative, hash, failed } = narrate(body, nowIso, opts.narrativePending === true);
  if (failed) settler.note("narrative", "template failed");
  return { ...body, narrative, facts_hash: hash, degraded: settler.degraded() };
}

/**
 * The report for when assembly itself cannot run: an unreadable clock, or a
 * bug in the code above. Every section is empty and marked, no port is
 * called, and the shape is still a full `BriefingReport`, so a caller never
 * needs a second code path for "the briefing threw".
 */
function emptyReport(req: BriefingRequest, now: Date, opts: GatherOptions, detail: FailureDetail): BriefingReport {
  const nowIso = now.toISOString();
  const window = resolveBriefingWindow(now);
  const cal = loadMacroCalendar(null);
  const body: ReportBody = {
    schema_version: BRIEFING_SCHEMA_VERSION,
    generated_at: nowIso,
    demo: req.demo === true,
    synthetic_now: opts.syntheticNow === true,
    window,
    overnight: { markets: marketRows(new Map(), window.overnight_since), held_movers: [], held_news: [], filings: [], measurements: [] },
    held_coverage: [],
    book: buildBook([], Number(req.cash), new Map(), window.phase, nowIso),
    risk: null,
    earnings_next: [],
    corporate_events: [],
    corporate_coverage: corporateCoverage([], new Map()),
    calendar_today: [],
    calendar_coverage: coverageStatus(window.target_session_ymd, cal),
    headlines: [],
    stories: [],
    implications: [],
    degraded: [],
  };
  const { narrative, hash, failed } = narrate(body, nowIso, false);
  const degraded: BriefingDegraded[] = SECTION_ORDER.filter((section) => section !== "narrative").map((section) => ({ section, detail }));
  if (failed) degraded.push({ section: "narrative", detail: "template failed" satisfies FailureDetail });
  return { ...body, narrative, facts_hash: hash, degraded };
}

/**
 * Builds the report. Never throws and never rejects: a port that fails, hangs
 * or answers with nonsense costs its own section, which is listed in
 * `degraded`, and the rest of the report stands.
 */
export async function gatherBriefing(
  req: BriefingRequest,
  now: Date,
  ports: BriefingPorts,
  opts: GatherOptions = {},
): Promise<BriefingReport> {
  const options = isRecord(opts) ? (opts as GatherOptions) : {};
  const request = (isRecord(req) ? req : { holdings: [], cash: 0 }) as BriefingRequest;

  // There is no honest report for a clock that cannot be read, and no other
  // clock to fall back on here. The epoch keeps the shape valid; every
  // section says why it is empty.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return emptyReport(request, new Date(0), options, "invalid clock");
  }

  const settler = createSettler(
    positiveOr(options.perCallTimeoutMs, DEFAULT_PER_CALL_TIMEOUT_MS),
    positiveOr(options.deadlineMs, DEFAULT_DEADLINE_MS),
  );
  try {
    return await assemble(request, now, ports, options, settler);
  } catch {
    try {
      return emptyReport(request, now, options, "assembly failed");
    } catch {
      // A Date can be valid and still beyond what the session calendar can
      // resolve (a machine clock set to the far end of the Date range makes
      // Intl throw inside the window rule). The empty report resolves a window
      // too, so it would throw the same way and this function would reject,
      // which is the one thing it says it never does.
      return emptyReport(request, new Date(0), options, "invalid clock");
    }
  } finally {
    settler.dispose();
  }
}
