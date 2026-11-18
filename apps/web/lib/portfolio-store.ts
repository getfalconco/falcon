import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin";
import { MAX_STOCKS, TICKER_PATTERN } from "./onboarding";
import {
  BENCHMARK,
  PAPER_ACCOUNT_ID,
  benchmarkChange,
  benchmarkStart,
  type Benchmark,
  STOCK_LIKE,
  aiWeights,
  cleanAccount,
  cleanPosition,
  quoteSymbol,
  valuePortfolio,
  watchTickers,
  type AiWeight,
  type PortfolioAccount,
  type PortfolioImport,
  type PortfolioPosition,
  type PortfolioValuation,
} from "./portfolio-holdings";
import { liveQuotes } from "./portfolio-prices";
import { getHistory } from "./prices-api";
import { yahooChart } from "./desk/tools/yahoo";
import { sameHoldings, snapshotOf, type HoldingsSnapshot, type SnapshotCash, type SnapshotPosition, type SnapshotSource } from "./workspace/equity";

/**
 * Server side of the stored portfolio: public.portfolio_accounts and
 * public.portfolio_positions (supabase/migrations/20261123_portfolio_holdings.sql),
 * always read and written with the service role for one member's id.
 *
 * Merge rules:
 *   - a broker import replaces the positions of each account it returned
 *     (other accounts stay);
 *   - a screenshot or CSV import merges by symbol into its account
 *     ("screenshot" / "csv"): rows in the import are replaced, others stay;
 *   - every import adds its tickers (stock-like and options' underlyings) to
 *     onboarding_responses.watchlist; tickers that later disappear from an
 *     import stay until "Clear portfolio";
 *   - when the ticker list changes (/api/onboarding), positions whose ticker
 *     left it go (crypto, futures and others have no ticker and stay).
 *
 * Every change to the stored holdings also records a snapshot of the full
 * holdings in public.portfolio_holdings_history
 * (supabase/migrations/20261125_portfolio_snapshots_v2.sql) for the Equity
 * chart (recordSnapshot); skipped when nothing changed or that table is missing.
 *
 * While the tables are missing (migration not applied) every call reports
 * `available: false` and saves nothing. Errors are logged by code only, never
 * with rows or amounts.
 */

export const ACCOUNTS_TABLE = "portfolio_accounts";
export const POSITIONS_TABLE = "portfolio_positions";
export const HISTORY_TABLE = "portfolio_holdings_history";

/** A Postgres or PostgREST error that means the table (or a column) is not there yet. */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "42703") return true;
  return /does not exist|could not find the table|schema cache/i.test(error.message ?? "");
}

type DbError = { code?: string; message?: string } | null;

/** Thrown for a database failure other than a missing table; carries the code only. */
export class StoreError extends Error {
  constructor(public code: string) {
    super(`portfolio store ${code}`);
  }
}

function fail(error: DbError): never {
  throw new StoreError(error?.code ?? "unknown");
}

/** The stored id of a SnapTrade account: never the raw id. */
export function brokerAccountId(userId: string, snaptradeAccountId: string): string {
  return `b_${createHash("sha256").update(`${userId}:${snaptradeAccountId}`).digest("hex").slice(0, 24)}`;
}

/* ------------------------------------------------------------------ rows */

type AccountRow = {
  id: string;
  source: string;
  name: string | null;
  institution: string | null;
  number_last4: string | null;
  currency: string | null;
  total_value: number | string | null;
  cash: number | string | null;
  buying_power: number | string | null;
  holdings_unavailable: boolean | null;
  as_of: string | null;
  updated_at?: string | null;
};

type PositionRow = {
  account_id: string;
  kind: string;
  symbol: string;
  ticker: string | null;
  name: string | null;
  quantity: number | string | null;
  avg_cost: number | string | null;
  price: number | string | null;
  market_value: number | string | null;
  unrealized_pnl: number | string | null;
  currency: string | null;
  option_type: string | null;
  strike: number | string | null;
  expiry: string | null;
  multiplier: number | string | null;
  as_of: string | null;
};

const ACCOUNT_COLUMNS = "id, source, name, institution, number_last4, currency, total_value, cash, buying_power, holdings_unavailable, as_of, updated_at";
const POSITION_COLUMNS =
  "account_id, kind, symbol, ticker, name, quantity, avg_cost, price, market_value, unrealized_pnl, currency, option_type, strike, expiry, multiplier, as_of";

function accountRow(userId: string, a: PortfolioAccount, now: string) {
  return {
    user_id: userId,
    id: a.id,
    source: a.source,
    name: a.name,
    institution: a.institution,
    number_last4: a.numberLast4,
    currency: a.currency,
    total_value: a.totalValue,
    cash: a.cash,
    buying_power: a.buyingPower,
    holdings_unavailable: a.holdingsUnavailable,
    as_of: a.asOf,
    updated_at: now,
  };
}

function positionRow(userId: string, p: PortfolioPosition, now: string) {
  return {
    user_id: userId,
    account_id: p.accountId,
    kind: p.kind,
    symbol: p.symbol,
    ticker: p.ticker,
    name: p.name,
    quantity: p.quantity,
    avg_cost: p.avgCost,
    price: p.price,
    market_value: p.marketValue,
    unrealized_pnl: p.unrealizedPnl,
    currency: p.currency,
    option_type: p.optionType,
    strike: p.strike,
    expiry: p.expiry,
    multiplier: p.multiplier,
    as_of: p.asOf,
    updated_at: now,
  };
}

function fromAccountRow(r: AccountRow): PortfolioAccount | null {
  return cleanAccount({
    id: r.id,
    name: r.name,
    institution: r.institution,
    numberLast4: r.number_last4,
    currency: r.currency,
    totalValue: r.total_value,
    cash: r.cash,
    buyingPower: r.buying_power,
    holdingsUnavailable: r.holdings_unavailable === true,
    asOf: r.as_of ?? r.updated_at ?? null,
  });
}

function fromPositionRow(r: PositionRow): PortfolioPosition | null {
  return cleanPosition({
    accountId: r.account_id,
    kind: r.kind,
    symbol: r.symbol,
    ticker: r.ticker,
    name: r.name,
    quantity: r.quantity,
    avgCost: r.avg_cost,
    price: r.price,
    marketValue: r.market_value,
    unrealizedPnl: r.unrealized_pnl,
    currency: r.currency,
    optionType: r.option_type,
    strike: r.strike,
    expiry: r.expiry,
    multiplier: r.multiplier,
    asOf: r.as_of,
  });
}

/* ------------------------------------------------------------------ reads */

export type StoredPortfolio =
  | { available: true; accounts: PortfolioAccount[]; positions: PortfolioPosition[] }
  | { available: false; accounts: []; positions: [] };

const UNAVAILABLE: StoredPortfolio = { available: false, accounts: [], positions: [] };

function admin(): SupabaseClient | null {
  try {
    return getSupabaseAdmin();
  } catch {
    return null;
  }
}

/** The member's accounts and positions; `available: false` while the tables are missing or Supabase is not configured. */
export async function readPortfolio(userId: string, db: SupabaseClient | null = admin()): Promise<StoredPortfolio> {
  if (!db) return UNAVAILABLE;
  const [accounts, positions] = await Promise.all([
    db.from(ACCOUNTS_TABLE).select(ACCOUNT_COLUMNS).eq("user_id", userId).limit(100),
    db.from(POSITIONS_TABLE).select(POSITION_COLUMNS).eq("user_id", userId).limit(1000),
  ]);
  if (isMissingTable(accounts.error) || isMissingTable(positions.error)) return UNAVAILABLE;
  if (accounts.error) fail(accounts.error);
  if (positions.error) fail(positions.error);
  return {
    available: true,
    accounts: ((accounts.data ?? []) as AccountRow[]).map(fromAccountRow).filter((a): a is PortfolioAccount => a !== null),
    positions: ((positions.data ?? []) as PositionRow[]).map(fromPositionRow).filter((p): p is PortfolioPosition => p !== null),
  };
}

/** Quotes for the given positions and extra tickers (the ticker-only rows), keyed by quote symbol. */
export async function quotesFor(positions: readonly PortfolioPosition[], tickers: readonly string[] = []) {
  const symbols = new Set<string>();
  const closeOk = new Set<string>();
  for (const p of positions) {
    const s = quoteSymbol(p);
    if (!s) continue;
    symbols.add(s);
    if (STOCK_LIKE.has(p.kind)) closeOk.add(s);
  }
  for (const t of tickers) {
    const s = quoteSymbol({ kind: "stock", symbol: t, ticker: t, currency: null });
    if (!s) continue;
    symbols.add(s);
    closeOk.add(s);
  }
  return liveQuotes(Array.from(symbols), closeOk);
}

/**
 * Falcon AI's view of the member's sizes, read here by user id (never from the
 * request): whole-percent weight and gain per ticker, from live values.
 * Empty while the tables are missing or nothing is stored. Never throws.
 */
export async function portfolioForAi(userId: string | null): Promise<{ weights: AiWeight[]; paper: boolean }> {
  if (!userId) return { weights: [], paper: false };
  try {
    const stored = await readPortfolio(userId);
    if (!stored.available) return { weights: [], paper: false };
    const paper = stored.accounts.some((a) => a.id === PAPER_ACCOUNT_ID);
    if (!stored.positions.length) return { weights: [], paper };
    const quotes = await quotesFor(stored.positions);
    const valuation: PortfolioValuation = valuePortfolio(stored.positions, quotes, stored.accounts);
    return { weights: aiWeights(valuation), paper };
  } catch (error) {
    console.error("[portfolio store] weights for AI failed", error instanceof StoreError ? error.code : "unknown");
    return { weights: [], paper: false };
  }
}

/* ------------------------------------------------------------------ writes */

export type SaveResult = { available: false } | { available: true; accounts: number; positions: number; tickers: string[] };

function quotedList(values: readonly string[]): string {
  // Tickers match TICKER_PATTERN (letters, digits, "." and "-"), so double quotes are safe in a PostgREST list.
  return `(${values.map((v) => `"${v}"`).join(",")})`;
}

/** Adds tickers to the account's ticker list (onboarding_responses.watchlist), keeping its order and the cap. */
export async function addWatchTickers(userId: string, tickers: readonly string[], db: SupabaseClient): Promise<string[]> {
  if (!tickers.length) return [];
  const { data, error } = await db.from("onboarding_responses").select("watchlist").eq("user_id", userId).maybeSingle();
  if (error) fail(error);
  const have = Array.isArray((data as { watchlist?: unknown } | null)?.watchlist)
    ? ((data as { watchlist: unknown[] }).watchlist.filter((t): t is string => typeof t === "string" && TICKER_PATTERN.test(t)))
    : [];
  const next = Array.from(new Set([...have, ...tickers])).slice(0, MAX_STOCKS);
  if (next.length === have.length) return have;
  const { error: upsertError } = await db
    .from("onboarding_responses")
    .upsert({ user_id: userId, watchlist: next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (upsertError) fail(upsertError);
  return next;
}

/**
 * Saves a validated import (lib/portfolio-holdings.ts cleanImport) for the
 * member, then adds its tickers to the ticker list. `available: false` and
 * nothing saved while the tables are missing.
 */
export async function saveImport(userId: string, imp: PortfolioImport, db: SupabaseClient | null = admin()): Promise<SaveResult> {
  if (!db) return { available: false };
  const now = new Date().toISOString();
  if (imp.accounts.length) {
    // A screenshot or CSV merges: a balance it did not show keeps the one stored before.
    const rows = imp.accounts.map((a) => {
      const row: Record<string, unknown> = accountRow(userId, a, now);
      if (imp.source !== "broker") for (const k of Object.keys(row)) if (row[k] === null) delete row[k];
      return row;
    });
    const { error } = await db.from(ACCOUNTS_TABLE).upsert(rows, { onConflict: "user_id,id" });
    if (isMissingTable(error)) return { available: false };
    if (error) fail(error);
  }
  if (imp.source === "broker" && imp.accounts.length) {
    // A broker import is the whole truth for the accounts it returned.
    const { error } = await db
      .from(POSITIONS_TABLE)
      .delete()
      .eq("user_id", userId)
      .in(
        "account_id",
        imp.accounts.map((a) => a.id),
      );
    if (isMissingTable(error)) return { available: false };
    if (error) fail(error);
  }
  if (imp.positions.length) {
    const { error } = await db
      .from(POSITIONS_TABLE)
      .upsert(imp.positions.map((p) => positionRow(userId, p, now)), { onConflict: "user_id,account_id,kind,symbol" });
    if (isMissingTable(error)) return { available: false };
    if (error) fail(error);
  }
  const tickers = watchTickers(imp.positions);
  await addWatchTickers(userId, tickers, db);
  await recordSnapshot(userId, imp.source, db);
  return { available: true, accounts: imp.accounts.length, positions: imp.positions.length, tickers };
}

/** "Clear portfolio": every account (and with it every position) of the member. */
export async function clearPortfolio(userId: string, db: SupabaseClient | null = admin()): Promise<{ available: boolean }> {
  if (!db) return { available: false };
  const positions = await db.from(POSITIONS_TABLE).delete().eq("user_id", userId);
  if (isMissingTable(positions.error)) return { available: false };
  if (positions.error) fail(positions.error);
  const accounts = await db.from(ACCOUNTS_TABLE).delete().eq("user_id", userId);
  if (isMissingTable(accounts.error)) return { available: false };
  if (accounts.error) fail(accounts.error);
  await recordSnapshot(userId, "clear", db);
  return { available: true };
}

/**
 * After the ticker list changed: removes positions whose ticker is no longer
 * in it. Rows without a ticker (crypto, futures, others) stay; an option goes
 * with its underlying. Never throws; logs the error code only.
 */
export async function prunePositions(userId: string, watchlist: readonly string[], db: SupabaseClient | null = admin()): Promise<void> {
  if (!db) return;
  try {
    let q = db.from(POSITIONS_TABLE).delete().eq("user_id", userId).not("ticker", "is", null);
    const keep = watchlist.filter((t) => TICKER_PATTERN.test(t));
    if (keep.length) q = q.not("ticker", "in", quotedList(keep));
    const { error } = await q;
    if (error && !isMissingTable(error)) console.error("[portfolio store] prune failed", error.code ?? "unknown");
    if (!error) await recordSnapshot(userId, "prune", db);
  } catch {
    console.error("[portfolio store] prune failed", "exception");
  }
}

/* ------------------------------------------------------------------ paper account */

/** Creates or replaces the member's paper account (lib/paper-account.ts): a cash balance, no positions. */
export async function savePaperAccount(userId: string, account: PortfolioAccount, db: SupabaseClient | null = admin()): Promise<{ available: boolean }> {
  if (!db || account.id !== PAPER_ACCOUNT_ID || account.source !== "paper") return { available: false };
  const { error } = await db.from(ACCOUNTS_TABLE).upsert(accountRow(userId, account, new Date().toISOString()), { onConflict: "user_id,id" });
  if (isMissingTable(error)) return { available: false };
  if (error) fail(error);
  await recordSnapshot(userId, "paper", db);
  return { available: true };
}

/** "Clear paper portfolio": only the paper account (and anything on it) goes; every other account stays. */
export async function clearPaperAccount(userId: string, db: SupabaseClient | null = admin()): Promise<{ available: boolean }> {
  if (!db) return { available: false };
  const { error } = await db.from(ACCOUNTS_TABLE).delete().eq("user_id", userId).eq("id", PAPER_ACCOUNT_ID);
  if (isMissingTable(error)) return { available: false };
  if (error) fail(error);
  await recordSnapshot(userId, "clear", db);
  return { available: true };
}

/* ------------------------------------------------------------------ holdings history (the Equity chart) */

type HistoryRow = { effective_at: string; source: string; positions: unknown; cash: unknown };

const SOURCES: ReadonlySet<string> = new Set(["broker", "screenshot", "csv", "paper", "clear", "prune", "initial"]);

/** Pure: a stored row as a snapshot; null when unreadable. Bad array entries are dropped. */
export function fromHistoryRow(r: HistoryRow): HoldingsSnapshot | null {
  const at = Date.parse(r.effective_at);
  if (!Number.isFinite(at) || !SOURCES.has(r.source)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const positions = (Array.isArray(r.positions) ? r.positions : []).flatMap((x): SnapshotPosition[] => {
    const o = x as Record<string, unknown>;
    const quantity = num(o.quantity);
    const multiplier = num(o.multiplier);
    const account_id = str(o.account_id);
    const kind = str(o.kind);
    const symbol = str(o.symbol);
    if (quantity === null || multiplier === null || !account_id || !kind || !symbol) return [];
    return [{ account_id, kind: kind as SnapshotPosition["kind"], symbol, ticker: str(o.ticker), quantity, multiplier, currency: str(o.currency) ?? "USD", price: num(o.price) }];
  });
  const cash = (Array.isArray(r.cash) ? r.cash : []).flatMap((x): SnapshotCash[] => {
    const o = x as Record<string, unknown>;
    const amount = num(o.cash);
    const account_id = str(o.account_id);
    return amount === null || !account_id ? [] : [{ account_id, currency: str(o.currency) ?? "USD", cash: amount }];
  });
  return { at, source: r.source as SnapshotSource, positions, cash };
}

/** The member's snapshots, oldest first; [] while the table is missing. Never throws; logs the error code only. */
export async function readSnapshots(userId: string, db: SupabaseClient | null = admin()): Promise<HoldingsSnapshot[]> {
  if (!db) return [];
  try {
    const { data, error } = await db.from(HISTORY_TABLE).select("effective_at, source, positions, cash").eq("user_id", userId).order("effective_at", { ascending: true }).limit(5000);
    if (error) {
      if (!isMissingTable(error)) console.error("[portfolio store] history read failed", error.code ?? "unknown");
      return [];
    }
    return ((data ?? []) as HistoryRow[]).map(fromHistoryRow).filter((s): s is HoldingsSnapshot => s !== null);
  } catch {
    console.error("[portfolio store] history read failed", "exception");
    return [];
  }
}

/**
 * Records the member's FULL stored holdings as a snapshot from now on, after
 * a change (or, with "initial", for a member who had holdings before the
 * table existed). Skipped when they equal the latest snapshot, and for an
 * "initial" when there is nothing held. Never throws; logs the error code
 * only, never quantities. Returns the snapshot written, else null.
 */
export async function recordSnapshot(userId: string, source: SnapshotSource, db: SupabaseClient | null = admin()): Promise<HoldingsSnapshot | null> {
  if (!db) return null;
  try {
    const stored = await readPortfolio(userId, db);
    if (!stored.available) return null;
    const next = snapshotOf(stored.accounts, stored.positions);
    if (source === "initial" && !next.positions.length && !next.cash.length) return null;
    const { data, error } = await db.from(HISTORY_TABLE).select("effective_at, source, positions, cash").eq("user_id", userId).order("effective_at", { ascending: false }).limit(1);
    if (error) {
      if (!isMissingTable(error)) console.error("[portfolio store] history read failed", error.code ?? "unknown");
      return null;
    }
    const last = data?.[0] ? fromHistoryRow(data[0] as HistoryRow) : null;
    if (last && sameHoldings(last, next)) return null;
    // Never two rows at the same instant: a later write in the same millisecond moves 1 ms on.
    const at = Math.max(Date.now(), (last?.at ?? 0) + 1);
    const row = { user_id: userId, effective_at: new Date(at).toISOString(), source, positions: next.positions, cash: next.cash };
    const { error: insertError } = await db.from(HISTORY_TABLE).insert(row);
    if (insertError) {
      if (!isMissingTable(insertError)) console.error("[portfolio store] history write failed", insertError.code ?? "unknown");
      return null;
    }
    return { at, source, ...next };
  } catch {
    console.error("[portfolio store] history write failed", "exception");
    return null;
  }
}

/* ------------------------------------------------------------------ benchmark */

/** Daily closes for the benchmark: Falcon's stored closes, else Yahoo's chart. Oldest first; empty on failure. */
async function benchmarkCloses(): Promise<[string, number][]> {
  try {
    const h = await getHistory(BENCHMARK, "5y");
    if (h.bars.length) return h.bars.map((b) => [b[0], b[4]] as [string, number]);
  } catch {
    // Fall through to Yahoo.
  }
  try {
    const c = await yahooChart(BENCHMARK, "5y", "1d", AbortSignal.timeout(5_000));
    const ts = c?.timestamp ?? [];
    const close = c?.indicators?.quote?.[0]?.close ?? [];
    return ts.flatMap((t, i) => (typeof close[i] === "number" ? [[new Date(t * 1000).toISOString().slice(0, 10), close[i] as number] as [string, number]] : []));
  } catch {
    return [];
  }
}

/**
 * SPY's return over the same time as the portfolio: from its start (the paper
 * account's creation, else the earliest import date) to SPY's live price, or
 * its last close. Null without a start, under a day old, or without prices.
 */
export async function benchmarkFor(accounts: readonly PortfolioAccount[], positions: readonly PortfolioPosition[]): Promise<Benchmark | null> {
  const paper = accounts.find((a) => a.id === PAPER_ACCOUNT_ID);
  const from = benchmarkStart(paper ? [paper.asOf] : [...accounts.map((a) => a.asOf), ...positions.map((p) => p.asOf)]);
  if (!from) return null;
  const [bars, quotes] = await Promise.all([benchmarkCloses(), liveQuotes([BENCHMARK])]);
  const change = benchmarkChange(bars, from, quotes[BENCHMARK]?.price ?? null);
  return change === null ? null : { symbol: BENCHMARK, from, changePct: change };
}
