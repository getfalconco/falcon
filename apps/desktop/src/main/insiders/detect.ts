/**
 * Insider activity: from parsed Form 4s and Schedule 13D/13G filings to the
 * few events worth a line, ranked.
 *
 * Trades (`tradesOf`): per Form 4, the non-derivative lines of code P (open
 * market or private purchase) and S (open market or private sale), totalled
 * per code and per plan flag. Derivative lines (options, warrants, RSUs) are
 * never counted: an exercise or a grant is not a decision to put money in or
 * take it out at the market price. Awards (A), exercises (M), tax
 * withholding (F) and gifts (G) are left out for the same reason.
 *
 * Holdings before a purchase: per ownership line (direct, or each indirect
 * holder such as "By Trust"), the shares owned after the line's last
 * transaction less every share that line moved on the form, plus the
 * holdings rows the form lists without a transaction. When a transacted
 * line does not state what it owned after, the figure is unknown.
 *
 * Rules (dates are trade dates; only trades outside a Rule 10b5-1 plan):
 *
 *   purchase_cluster   2+ distinct insiders with purchases inside one 30-day
 *                      window. Windows are taken greedily: the window with
 *                      the most insiders first (the later one on a tie), its
 *                      trades removed, again until no window has two.
 *   large_purchase     one insider's purchases inside 30 days, not part of a
 *                      cluster, by the CEO or CFO (any amount), or worth
 *                      $25,000 or more and raising what they held by 20% or
 *                      more (or opening a position from nothing).
 *   sale_cluster       3+ distinct insiders with sales inside one 30-day
 *                      window, taken like purchase clusters. Sales are routine
 *                      (diversification, taxes), so it takes three.
 *   large_unplanned_sale  one officer's, director's or 10% owner's sales
 *                      inside 30 days, not part of a cluster and not already a
 *                      CEO or CFO unplanned_sale, worth $10,000,000 or more,
 *                      and either 10% or more of what they held before the
 *                      first sale or $50,000,000 or more (so a founder
 *                      trimming a mega cap stake is not a row every week).
 *   unplanned_sale     one CEO's or CFO's sales inside 30 days, not part of a
 *                      cluster, worth $1,000,000 or more.
 *   activist_13d       a new Schedule 13D.
 *   activist_13d_amendment  a 13D amendment restating Item 4 (purpose).
 *   new_holder_13g     a new Schedule 13G (amendments are routine and left out).
 *
 * Significance (`significance`), 0 to 100:
 *
 *   base       purchase_cluster 60, activist_13d 55, 13D amendment 45,
 *              large_purchase 40, sale_cluster 35, unplanned_sale 30,
 *              large_unplanned_sale 25,
 *              new_holder_13g 20
 *   + size     6 x log10(value / $100,000), from 0 to 18 ($1M adds 6, $10M 12)
 *   + breadth  8 per insider past the rule's minimum, up to 24
 *   + role     10 when the CEO or CFO is among them
 *   + increase 6 when a purchase doubled the holding or opened one
 *   + stake    1.5 per point of the class past 5%, up to 12 (13D, 13G)
 *   x recency  1 on the day, falling evenly to 0.5 at 90 days old
 *   x scope    held 1, focus 1, watchlist 0.9, linked by a critical filing
 *              link 0.75, by an important one 0.65
 *
 * capped at 100 and rounded. Ties go to the later date, then the ticker.
 *
 * Pure.
 */

import { roleOf, titleOf, type Form4Document, type Form4Line } from "../edgar/form4";
import type {
  InsiderEvent,
  InsiderEventKind,
  InsiderRole,
  InsiderScope,
  InsiderTrade,
  InsiderVia,
  OwnershipFiling,
} from "../../shared/insider-types";

export const CLUSTER_WINDOW_DAYS = 30;
export const LOOKBACK_DAYS = 90;
export const PURCHASE_CLUSTER_MIN = 2;
export const SALE_CLUSTER_MIN = 3;
export const LARGE_INCREASE = 0.2;
export const LARGE_PURCHASE_MIN_VALUE = 25_000;
export const UNPLANNED_SALE_MIN_VALUE = 1_000_000;
export const LARGE_UNPLANNED_SALE_MIN_VALUE = 10_000_000;
export const LARGE_UNPLANNED_SALE_SHARE = 0.1;
export const LARGE_UNPLANNED_SALE_ANY_SHARE_VALUE = 50_000_000;

/** A trade with who made it, for counting distinct insiders. */
export type TradeRecord = InsiderTrade & { insiderKey: string };

export type Form4Source = { accession: string; filedAt: string; url: string };

const DAY_MS = 86_400_000;

function dayNumber(ymd: string): number {
  return Math.floor(Date.parse(`${ymd}T12:00:00Z`) / DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Shares held before the form's first transaction, over every non-derivative ownership line; null when unknown. */
export function holdingsBefore(doc: Form4Document): number | null {
  const groups = new Map<string, Form4Line[]>();
  for (const line of doc.lines) {
    if (line.derivative) continue;
    const key = `${line.ownership ?? "D"}|${(line.nature ?? "").toLowerCase()}`;
    const list = groups.get(key);
    if (list) list.push(line);
    else groups.set(key, [line]);
  }
  let total = 0;
  for (const lines of groups.values()) {
    const after = lines[lines.length - 1]!.sharesAfter;
    if (after === null) return null;
    let moved = 0;
    for (const l of lines) {
      if (l.shares === null) return null;
      moved += l.acquiredDisposed === "D" ? -l.shares : l.shares;
    }
    total += after - moved;
  }
  for (const h of doc.holdings) {
    if (h.derivative) continue;
    if (h.shares !== null) total += h.shares;
  }
  return Math.max(0, Math.round(total));
}

/** The P and S trades of one Form 4, one per code and plan flag. */
export function tradesOf(doc: Form4Document, source: Form4Source): TradeRecord[] {
  const reporter = doc.reporters[0];
  const role = roleOf(reporter);
  const insiderKey = reporter?.cik?.replace(/^0+/, "") || (reporter?.name ?? "unknown").toLowerCase();
  const before = holdingsBefore(doc);
  const out: TradeRecord[] = [];
  for (const code of ["P", "S"] as const) {
    for (const plan of [false, true]) {
      const lines = doc.lines.filter((l) => !l.derivative && l.code === code && l.plan === plan && l.shares !== null && l.shares > 0);
      if (lines.length === 0) continue;
      const dates = lines.map((l) => l.date ?? doc.periodOfReport ?? source.filedAt).sort();
      const shares = lines.reduce((s, l) => s + l.shares!, 0);
      const priced = lines.filter((l) => l.price !== null && l.price > 0);
      const value = priced.length === 0 ? null : Math.round(priced.reduce((s, l) => s + l.shares! * l.price!, 0));
      const signed = code === "P" ? shares : -shares;
      out.push({
        insiderKey,
        name: reporter?.name ?? "unknown",
        role,
        title: titleOf(reporter),
        code,
        shares: Math.round(shares),
        value,
        firstDate: dates[0]!,
        lastDate: dates[dates.length - 1]!,
        filedAt: source.filedAt,
        accession: source.accession,
        url: source.url,
        sharesBefore: before,
        sharesAfter: before === null ? null : Math.max(0, Math.round(before + signed)),
        increase: code === "P" && before !== null && before > 0 ? shares / before : null,
        firstPosition: code === "P" && before === 0,
        plan,
      });
    }
  }
  return out;
}

/**
 * Windows of `windowDays` holding at least `min` distinct insiders, taken
 * greedily (most insiders first, the later window on a tie), each trade in
 * at most one. Each cluster's trades come oldest first.
 */
export function findClusters(trades: readonly TradeRecord[], min: number, windowDays = CLUSTER_WINDOW_DAYS): TradeRecord[][] {
  let left = [...trades].sort((a, b) => a.lastDate.localeCompare(b.lastDate) || a.accession.localeCompare(b.accession));
  const out: TradeRecord[][] = [];
  for (;;) {
    let best: TradeRecord[] | null = null;
    let bestCount = 0;
    for (let i = 0; i < left.length; i++) {
      const start = left[i]!.lastDate;
      const window = left.filter((t) => t.lastDate >= start && daysBetween(start, t.lastDate) < windowDays);
      const count = new Set(window.map((t) => t.insiderKey)).size;
      // ">=": a later window with as many insiders wins the tie.
      if (count >= bestCount) {
        best = window;
        bestCount = count;
      }
    }
    if (!best || bestCount < min) break;
    out.push(best);
    const taken = new Set(best);
    left = left.filter((t) => !taken.has(t));
  }
  return out.sort((a, b) => b[b.length - 1]!.lastDate.localeCompare(a[a.length - 1]!.lastDate));
}

/** One insider's trades split into runs no longer than the window, oldest first. */
function perInsider(trades: readonly TradeRecord[], windowDays = CLUSTER_WINDOW_DAYS): TradeRecord[][] {
  const by = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const list = by.get(t.insiderKey);
    if (list) list.push(t);
    else by.set(t.insiderKey, [t]);
  }
  const runs: TradeRecord[][] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.firstDate.localeCompare(b.firstDate));
    let run: TradeRecord[] = [];
    for (const t of list) {
      if (run.length > 0 && daysBetween(run[0]!.firstDate, t.lastDate) >= windowDays) {
        runs.push(run);
        run = [];
      }
      run.push(t);
    }
    if (run.length > 0) runs.push(run);
  }
  return runs;
}

const ROLE_ORDER: readonly InsiderRole[] = ["ceo", "cfo", "officer", "director", "owner10", "other"];

function rolesOf(trades: readonly TradeRecord[]): InsiderRole[] {
  const set = new Set(trades.map((t) => t.role));
  return ROLE_ORDER.filter((r) => set.has(r));
}

function sumValue(trades: readonly TradeRecord[]): number | null {
  const priced = trades.filter((t) => t.value !== null);
  return priced.length === 0 ? null : priced.reduce((s, t) => s + t.value!, 0);
}

const isTop = (r: InsiderRole) => r === "ceo" || r === "cfo";

/** A purchase run raises the holding by the shares bought over what was held before its first trade. */
function runIncrease(run: readonly TradeRecord[]): { increase: number | null; firstPosition: boolean } {
  const first = run[0]!;
  if (first.firstPosition) return { increase: null, firstPosition: true };
  if (first.sharesBefore === null || first.sharesBefore <= 0) return { increase: null, firstPosition: false };
  const bought = run.reduce((s, t) => s + t.shares, 0);
  return { increase: bought / first.sharesBefore, firstPosition: false };
}

export type EventContext = { ticker: string; today: string; scope: InsiderScope; via: InsiderVia | null };

function eventOf(ctx: EventContext, kind: InsiderEventKind, trades: readonly TradeRecord[], filing: OwnershipFiling | null = null): InsiderEvent {
  const sorted = [...trades].sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.accession.localeCompare(b.accession));
  const date = filing ? filing.filedAt : sorted.reduce((m, t) => (t.lastDate > m ? t.lastDate : m), sorted[0]!.lastDate);
  const firstDate = filing ? filing.filedAt : sorted[0]!.firstDate;
  const event: InsiderEvent = {
    id: `${ctx.ticker}:${kind}:${filing ? filing.accession : sorted[0]!.accession}`,
    ticker: ctx.ticker,
    kind,
    date,
    firstDate,
    insiders: new Set(sorted.map((t) => t.insiderKey)).size,
    value: sumValue(sorted),
    roles: rolesOf(sorted),
    trades: sorted.map(({ insiderKey: _k, ...t }) => t),
    filing,
    scope: ctx.scope,
    via: ctx.via,
    score: 0,
  };
  event.score = significance(event, ctx.today);
  return event;
}

/** The trade events of one company (rules above), trades older than the lookback left out. */
export function tradeEvents(trades: readonly TradeRecord[], ctx: EventContext): InsiderEvent[] {
  const recent = trades.filter((t) => !t.plan && daysBetween(t.lastDate, ctx.today) <= LOOKBACK_DAYS && daysBetween(t.lastDate, ctx.today) >= -1);
  const out: InsiderEvent[] = [];

  const purchases = recent.filter((t) => t.code === "P");
  const pClusters = findClusters(purchases, PURCHASE_CLUSTER_MIN);
  for (const c of pClusters) out.push(eventOf(ctx, "purchase_cluster", c));
  const inPCluster = new Set(pClusters.flat());
  for (const run of perInsider(purchases.filter((t) => !inPCluster.has(t)))) {
    const value = sumValue(run) ?? 0;
    const { increase, firstPosition } = runIncrease(run);
    const big = value >= LARGE_PURCHASE_MIN_VALUE && (firstPosition || (increase !== null && increase >= LARGE_INCREASE));
    if (isTop(run[0]!.role) || big) out.push(eventOf(ctx, "large_purchase", run));
  }

  const sales = recent.filter((t) => t.code === "S");
  const sClusters = findClusters(sales, SALE_CLUSTER_MIN);
  for (const c of sClusters) out.push(eventOf(ctx, "sale_cluster", c));
  const inSCluster = new Set(sClusters.flat());
  for (const run of perInsider(sales.filter((t) => !inSCluster.has(t) && isTop(t.role)))) {
    if ((sumValue(run) ?? 0) >= UNPLANNED_SALE_MIN_VALUE) out.push(eventOf(ctx, "unplanned_sale", run));
  }
  const large = (r: InsiderRole) => r === "officer" || r === "director" || r === "owner10";
  for (const run of perInsider(sales.filter((t) => !inSCluster.has(t) && large(t.role)))) {
    const value = sumValue(run) ?? 0;
    if (value < LARGE_UNPLANNED_SALE_MIN_VALUE) continue;
    const before = run[0]!.sharesBefore;
    const sold = run.reduce((s, t) => s + t.shares, 0);
    const share = before !== null && before > 0 ? sold / before : null;
    if (value >= LARGE_UNPLANNED_SALE_ANY_SHARE_VALUE || (share !== null && share >= LARGE_UNPLANNED_SALE_SHARE)) {
      out.push(eventOf(ctx, "large_unplanned_sale", run));
    }
  }
  return out;
}

export type ScheduleKind = "13d" | "13d_a" | "13g" | "13g_a";

/** "SC 13D", "SCHEDULE 13D/A", "SC 13G" ...; null for any other form. */
export function scheduleKind(form: string): ScheduleKind | null {
  const m = form.trim().toUpperCase().match(/^(?:SC|SCHEDULE)\s*13([DG])(\/A)?$/);
  if (!m) return null;
  return `13${m[1]!.toLowerCase()}${m[2] ? "_a" : ""}` as ScheduleKind;
}

/** A 13D or 13G read: what the card needs, and whether an amendment restates the purpose. */
export type ScheduleRecord = OwnershipFiling & { purposeAmended: boolean };

/** The 13D / 13G events of one company inside the lookback. */
export function scheduleEvents(records: readonly ScheduleRecord[], ctx: EventContext): InsiderEvent[] {
  const out: InsiderEvent[] = [];
  for (const r of records) {
    const age = daysBetween(r.filedAt, ctx.today);
    if (age > LOOKBACK_DAYS || age < -1) continue;
    const kind = scheduleKind(r.form);
    const { purposeAmended: _p, ...filing } = r;
    if (kind === "13d") out.push(eventOf(ctx, "activist_13d", [], filing));
    else if (kind === "13d_a" && r.purposeAmended) out.push(eventOf(ctx, "activist_13d_amendment", [], filing));
    else if (kind === "13g") out.push(eventOf(ctx, "new_holder_13g", [], filing));
  }
  return out;
}

const BASE: Readonly<Record<InsiderEventKind, number>> = {
  purchase_cluster: 60,
  activist_13d: 55,
  activist_13d_amendment: 45,
  large_purchase: 40,
  sale_cluster: 35,
  unplanned_sale: 30,
  large_unplanned_sale: 25,
  new_holder_13g: 20,
};

export function scopeWeight(scope: InsiderScope, via: InsiderVia | null): number {
  if (scope === "held" || scope === "focus") return 1;
  if (scope === "watchlist") return 0.9;
  return via?.tier === "critical" ? 0.75 : 0.65;
}

/** The significance score; see the module comment. */
export function significance(e: Pick<InsiderEvent, "kind" | "value" | "insiders" | "roles" | "trades" | "filing" | "date" | "scope" | "via">, today: string): number {
  let raw = BASE[e.kind];
  if (e.value !== null && e.value > 0) raw += Math.min(18, Math.max(0, 6 * Math.log10(e.value / 100_000)));
  if (e.kind === "purchase_cluster") raw += Math.min(24, 8 * Math.max(0, e.insiders - PURCHASE_CLUSTER_MIN));
  if (e.kind === "sale_cluster") raw += Math.min(24, 8 * Math.max(0, e.insiders - SALE_CLUSTER_MIN));
  if (e.roles.some(isTop)) raw += 10;
  if (e.kind === "large_purchase" && e.trades.length > 0) {
    const bought = e.trades.reduce((s, t) => s + t.shares, 0);
    const first = e.trades[0]!;
    if (first.firstPosition || (first.sharesBefore !== null && first.sharesBefore > 0 && bought / first.sharesBefore >= 1)) raw += 6;
  }
  if (e.filing?.percent != null) raw += Math.min(12, Math.max(0, (e.filing.percent - 5) * 1.5));
  const age = Math.min(LOOKBACK_DAYS, Math.max(0, daysBetween(e.date, today)));
  const recency = 1 - 0.5 * (age / LOOKBACK_DAYS);
  return Math.round(Math.min(100, raw * recency * scopeWeight(e.scope, e.via)));
}

/** Highest score first, then the later date, then the ticker. */
export function rankEvents(events: readonly InsiderEvent[]): InsiderEvent[] {
  return [...events].sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.ticker.localeCompare(b.ticker) || a.id.localeCompare(b.id));
}

/** Every event of one company, from its trades and its 13D / 13G filings. */
export function companyEvents(trades: readonly TradeRecord[], schedules: readonly ScheduleRecord[], ctx: EventContext): InsiderEvent[] {
  return [...tradeEvents(trades, ctx), ...scheduleEvents(schedules, ctx)];
}
