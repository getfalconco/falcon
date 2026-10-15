/**
 * Stock tab, "since you were away": the dated changes on one stock, read from
 * the providers' and the SEC's own records.
 *
 *   estimate revisions  Yahoo `earningsTrend`: how many analysts revised the
 *                       EPS estimate up and down over the provider's last 7
 *                       or 30 days, and the mean then and now, per period
 *   short interest      Yahoo `defaultKeyStatistics`: the latest exchange
 *                       report against the one before, with both settlement
 *                       dates. Listed while the report is new: settled at
 *                       most SHORT_INTEREST_LAG_DAYS before the window opens,
 *                       which is how long the exchanges take to publish
 *   price estimate      Yahoo `financialData.targetMeanPrice` has no history,
 *                       so the tab keeps one reading a day per stock; the
 *                       change is shown only once a reading from about thirty
 *                       days back is on record (26 to 45 days)
 *   insider trades      SEC Form 4 filed in the window: open market purchases
 *                       and sales, totalled per filing, plan trades marked
 *   graph links         filing-graph links touching the stock that were not
 *                       there at the last visit, or (first visit) whose
 *                       extraction ran inside the window
 *
 * The window is the longer of seven days and the time since the reader last
 * opened this stock's tab, capped at ninety days.
 *
 * Each item carries `fact`, one English line with its figures. It is never
 * shown: it is what the thesis tags are asked about and checked against.
 *
 * Pure: no fs, no network, no clock (the clock is a parameter).
 */

import type {
  ChangeItem,
  EstimateRevisionChange,
  InsiderChange,
  LinkAddedChange,
  PriceEstimateChange,
  ShortInterestChange,
  TrendPeriod,
} from "../../shared/stock-tab-data";
import { isFilingBacked, type LinkEdge } from "../../shared/earnings-links";
import { nyYmdOf } from "../../shared/earnings-time";
import type { Form4Totals } from "./form4";

const DAY_MS = 86_400_000;
export const MIN_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 90;
export const SHORT_INTEREST_LAG_DAYS = 16;
export const ESTIMATE_HISTORY_DAYS = 120;
export const ESTIMATE_LOOKBACK_MIN_DAYS = 26;
export const ESTIMATE_LOOKBACK_MAX_DAYS = 45;
export const ESTIMATE_LOOKBACK_DAYS = 30;
export const MAX_INSIDER_ITEMS = 10;
export const MAX_LINK_ITEMS = 10;

export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
}

export type ChangeWindow = { sinceMs: number; since: string; sinceVisit: boolean; days: number };

/** The longer of seven days and the time since the last visit, at most ninety days. */
export function changeWindow(lastVisitMs: number | null, nowMs: number): ChangeWindow {
  const week = nowMs - MIN_WINDOW_DAYS * DAY_MS;
  const floor = nowMs - MAX_WINDOW_DAYS * DAY_MS;
  const sinceVisit = lastVisitMs !== null && Number.isFinite(lastVisitMs) && lastVisitMs < week;
  const sinceMs = sinceVisit ? Math.max(lastVisitMs!, floor) : week;
  return { sinceMs, since: nyYmdOf(sinceMs), sinceVisit, days: Math.round((nowMs - sinceMs) / DAY_MS) };
}

// ---------------------------------------------------------------------------
// Yahoo reads
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function rawNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = record(value)?.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function ymdOf(value: unknown): string | null {
  const fmt = record(value)?.fmt;
  if (typeof fmt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fmt)) return fmt;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const raw = rawNum(value);
  return raw !== null && raw > 0 ? new Date(raw * 1000).toISOString().slice(0, 10) : null;
}

function code(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;
}

export type TrendRead = {
  period: TrendPeriod;
  periodEnd: string | null;
  currency: string | null;
  now: number | null;
  ago7: number | null;
  ago30: number | null;
  up7: number | null;
  down7: number | null;
  up30: number | null;
  down30: number | null;
};

export type ShortRead = { shares: number; previousShares: number; date: string; previousDate: string | null; floatShare: number | null };

export type PriceEstimateRead = { value: number; analysts: number | null; currency: string | null };

/** What one daily Yahoo read keeps: parsed figures, never the raw reply. */
export type YahooChangesRead = { trend: TrendRead[]; short: ShortRead | null; priceEstimate: PriceEstimateRead | null };

const PERIODS: readonly TrendPeriod[] = ["0q", "+1q", "0y", "+1y"];

export function readYahooChanges(modules: Record<string, unknown> | null): YahooChangesRead {
  const trendList = record(modules?.earningsTrend)?.trend;
  const trend: TrendRead[] = [];
  if (Array.isArray(trendList)) {
    for (const t of trendList.map(record)) {
      const period = t?.period;
      if (!t || typeof period !== "string" || !(PERIODS as readonly string[]).includes(period)) continue;
      const et = record(t.epsTrend);
      const er = record(t.epsRevisions);
      trend.push({
        period: period as TrendPeriod,
        periodEnd: ymdOf(t.endDate),
        currency: code(et?.epsTrendCurrency) ?? code(er?.epsRevisionsCurrency),
        now: rawNum(et?.current),
        ago7: rawNum(et?.["7daysAgo"]),
        ago30: rawNum(et?.["30daysAgo"]),
        up7: rawNum(er?.upLast7days),
        // The provider spells this one with a capital D.
        down7: rawNum(er?.downLast7Days) ?? rawNum(er?.downLast7days),
        up30: rawNum(er?.upLast30days),
        down30: rawNum(er?.downLast30days),
      });
    }
  }

  const ks = record(modules?.defaultKeyStatistics);
  const shares = rawNum(ks?.sharesShort);
  const previousShares = rawNum(ks?.sharesShortPriorMonth);
  const date = ymdOf(ks?.dateShortInterest);
  const short: ShortRead | null =
    shares !== null && previousShares !== null && date !== null && shares >= 0 && previousShares > 0
      ? { shares, previousShares, date, previousDate: ymdOf(ks?.sharesShortPreviousMonthDate), floatShare: rawNum(ks?.shortPercentOfFloat) }
      : null;

  const fd = record(modules?.financialData);
  const value = rawNum(fd?.targetMeanPrice);
  const priceEstimate: PriceEstimateRead | null =
    value !== null && value > 0 ? { value, analysts: rawNum(fd?.numberOfAnalystOpinions), currency: code(fd?.financialCurrency) } : null;

  return { trend, short, priceEstimate };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const PERIOD_WORDS: Readonly<Record<TrendPeriod, string>> = {
  "0q": "the current quarter",
  "+1q": "the next quarter",
  "0y": "the current fiscal year",
  "+1y": "the next fiscal year",
};

function fixed(n: number | null, digits = 2): string {
  return n === null ? "n/a" : n.toFixed(digits);
}

export function revisionItems(trend: readonly TrendRead[], windowDays: number, asOf: string): EstimateRevisionChange[] {
  const days: 7 | 30 = windowDays > MIN_WINDOW_DAYS ? 30 : 7;
  const out: EstimateRevisionChange[] = [];
  for (const t of trend) {
    const up = (days === 7 ? t.up7 : t.up30) ?? 0;
    const down = (days === 7 ? t.down7 : t.down30) ?? 0;
    const before = days === 7 ? t.ago7 : t.ago30;
    const moved = t.now !== null && before !== null && before !== 0 && Math.abs(t.now - before) / Math.abs(before) >= 0.001;
    if (up + down === 0 && !moved) continue;
    out.push({
      kind: "estimate_revision",
      id: `rev:${t.period}:${t.periodEnd ?? "na"}:${days}`,
      date: asOf,
      source: { kind: "yahoo", url: null },
      period: t.period,
      periodEnd: t.periodEnd,
      days,
      up,
      down,
      epsNow: t.now,
      epsBefore: before,
      currency: t.currency,
      fact:
        `Mean EPS estimate for ${PERIOD_WORDS[t.period]}${t.periodEnd ? ` (period ending ${t.periodEnd})` : ""}: ` +
        `${up} analysts revised up and ${down} revised down in the last ${days} days; ` +
        `the mean was ${fixed(before)} ${days} days ago and is ${fixed(t.now)} now.`,
    });
  }
  return out;
}

export function shortInterestItem(read: ShortRead | null, since: string): ShortInterestChange | null {
  if (!read || read.date < addDaysYmd(since, -SHORT_INTEREST_LAG_DAYS)) return null;
  const change = (read.shares - read.previousShares) / read.previousShares;
  const pct = read.floatShare !== null ? ` (${(read.floatShare * 100).toFixed(2)}% of the float)` : "";
  return {
    kind: "short_interest",
    id: `si:${read.date}`,
    date: read.date,
    source: { kind: "yahoo", url: null },
    previousDate: read.previousDate,
    shares: read.shares,
    previousShares: read.previousShares,
    floatShare: read.floatShare,
    fact:
      `Short interest on ${read.date}: ${Math.round(read.shares).toLocaleString("en-US")} shares${pct}, ` +
      `against ${Math.round(read.previousShares).toLocaleString("en-US")} on ${read.previousDate ?? "the prior report"}, ` +
      `a change of ${(change * 100).toFixed(1)}%.`,
  };
}

export type EstimatePoint = { d: string; v: number; n: number | null };

/** Today's reading added (or replacing today's), older than ESTIMATE_HISTORY_DAYS dropped, oldest first. */
export function recordEstimate(history: readonly EstimatePoint[], today: string, read: PriceEstimateRead | null): EstimatePoint[] {
  const floor = addDaysYmd(today, -ESTIMATE_HISTORY_DAYS);
  const kept = history.filter((p) => p.d !== today && p.d >= floor && Number.isFinite(p.v) && p.v > 0);
  if (read) kept.push({ d: today, v: read.value, n: read.analysts });
  return kept.sort((a, b) => a.d.localeCompare(b.d));
}

/** The mean estimate now against the reading closest to thirty days back (26 to 45 days); null without both. */
export function priceEstimateItem(history: readonly EstimatePoint[], today: string, currency: string | null): PriceEstimateChange | null {
  const now = history.find((p) => p.d === today);
  if (!now) return null;
  let best: EstimatePoint | null = null;
  for (const p of history) {
    const age = daysBetween(p.d, today);
    if (age < ESTIMATE_LOOKBACK_MIN_DAYS || age > ESTIMATE_LOOKBACK_MAX_DAYS) continue;
    if (!best || Math.abs(age - ESTIMATE_LOOKBACK_DAYS) < Math.abs(daysBetween(best.d, today) - ESTIMATE_LOOKBACK_DAYS)) best = p;
  }
  if (!best || Math.abs(now.v - best.v) / best.v < 0.001) return null;
  return {
    kind: "price_estimate",
    id: `pe:${best.d}:${today}`,
    date: today,
    source: { kind: "yahoo", url: null },
    value: now.v,
    previous: best.v,
    previousDate: best.d,
    analysts: now.n,
    currency,
    fact:
      `Analysts' mean price estimate: ${now.v.toFixed(2)} on ${today}${now.n !== null ? ` from ${now.n} analysts` : ""}, ` +
      `against ${best.v.toFixed(2)} on ${best.d}, a change of ${(((now.v - best.v) / best.v) * 100).toFixed(1)}%.`,
  };
}

export type InsiderFiling = { accession: string; filedAt: string; url: string; totals: Form4Totals };

/** Open market trades on forms filed in the window, newest first, the largest kept when there are more than the cap. */
export function insiderItems(filings: readonly InsiderFiling[], since: string): InsiderChange[] {
  const items: InsiderChange[] = [];
  for (const f of filings) {
    if (f.filedAt < since) continue;
    const t = f.totals;
    const date = t.date ?? f.filedAt;
    const what = t.code === "P" ? "open market purchase" : "open market sale";
    items.push({
      kind: "insider",
      id: `ins:${f.accession}`,
      date,
      source: { kind: "form4", url: f.url },
      name: t.name,
      role: t.role,
      code: t.code,
      shares: t.shares,
      value: t.value,
      plan: t.plan,
      fact:
        `${t.name} (${t.role}) reported an ${what} of ${t.shares.toLocaleString("en-US")} shares` +
        `${t.value !== null ? ` worth $${t.value.toLocaleString("en-US")}` : ""} on ${date}` +
        `${t.plan ? ", under a Rule 10b5-1 plan set up in advance" : ""} (Form 4 filed ${f.filedAt}).`,
    });
  }
  const largest = [...items].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, MAX_INSIDER_ITEMS);
  return largest.sort((a, b) => b.date.localeCompare(a.date) || (b.value ?? 0) - (a.value ?? 0));
}

export type GraphEdgeForChanges = LinkEdge & { id?: string; counterparty_name?: string };

/** The id an edge is remembered by between visits. */
export function edgeKey(e: GraphEdgeForChanges): string {
  return e.id ?? `${e.root_ticker ?? ""}:${e.counterparty_ticker ?? ""}:${e.category ?? ""}:${e.accession_number ?? ""}`;
}

/** The filing-backed links touching `ticker`, by key. */
export function linksOf(edges: readonly GraphEdgeForChanges[], ticker: string): GraphEdgeForChanges[] {
  const self = ticker.toUpperCase();
  return edges.filter((e) => {
    const root = e.root_ticker?.trim().toUpperCase();
    const other = e.counterparty_ticker?.trim().toUpperCase();
    return !!root && !!other && root !== other && (root === self || other === self) && isFilingBacked(e);
  });
}

const TIER_RANK: Readonly<Record<string, number>> = { critical: 0, important: 1, marginal: 2 };

export type LinkItemOptions = {
  since: string;
  today: string;
  /** Keys seen at the last visit; null on a first visit. */
  previous: ReadonlySet<string> | null;
  /** New York date the filer's links were extracted (step1 meta), when on disk. */
  builtOn: (filer: string) => string | null;
  /** New York date of the graph file's build. */
  graphDate: string | null;
};

export function linkItems(edges: readonly GraphEdgeForChanges[], ticker: string, o: LinkItemOptions): LinkAddedChange[] {
  const self = ticker.toUpperCase();
  const seen = new Set<string>();
  const out: Array<LinkAddedChange & { rank: number }> = [];
  for (const e of linksOf(edges, self)) {
    const root = e.root_ticker!.trim().toUpperCase();
    const other = e.counterparty_ticker!.trim().toUpperCase();
    const key = edgeKey(e);
    const built = o.builtOn(root) ?? o.graphDate;
    const isNew = o.previous !== null ? !o.previous.has(key) : built !== null && built >= o.since;
    if (!isNew) continue;
    const direction: "names" | "named" = root === self ? "names" : "named";
    const counterparty = direction === "names" ? other : root;
    const category = (e.category ?? "related").replace(/_/g, " ");
    const dedupe = `${counterparty}:${category}:${direction}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const date = built !== null && built >= o.since ? built : (o.graphDate !== null && o.graphDate >= o.since ? o.graphDate : o.today);
    const form = e.form ?? null;
    const filer = direction === "names" ? self : counterparty;
    out.push({
      kind: "link_added",
      id: `link:${key}`,
      date,
      source: { kind: "filing", url: e.source_url ?? null },
      counterparty,
      counterpartyName: direction === "names" ? (e.counterparty_name ?? null) : null,
      category,
      direction,
      form,
      filingDate: e.filing_date ?? null,
      fact:
        `${filer}'s ${form ?? "annual report"}${e.filing_date ? ` filed ${e.filing_date}` : ""} names ` +
        `${direction === "names" ? counterparty : self} as a ${category}; the link was added to the filing graph on ${date}.`,
      rank: TIER_RANK[e.strength_tier ?? ""] ?? 3,
    });
  }
  return out
    .sort((a, b) => a.rank - b.rank || b.date.localeCompare(a.date))
    .slice(0, MAX_LINK_ITEMS)
    .map(({ rank: _rank, ...item }) => item);
}

/** All items, newest first; ties keep the kinds in a fixed order. */
export function sortItems(items: readonly ChangeItem[]): ChangeItem[] {
  const order: Record<ChangeItem["kind"], number> = { estimate_revision: 0, price_estimate: 1, short_interest: 2, insider: 3, link_added: 4 };
  return [...items].sort((a, b) => b.date.localeCompare(a.date) || order[a.kind] - order[b.kind]);
}
