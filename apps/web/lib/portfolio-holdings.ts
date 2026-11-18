import { MAX_STOCKS, TICKER_PATTERN, type PickedStock } from "./onboarding";
import { cleanTicker } from "./portfolio";

/**
 * The member's stored portfolio: accounts and positions from a broker import
 * (SnapTrade), a screenshot or a CSV, as kept in public.portfolio_accounts and
 * public.portfolio_positions (supabase/migrations/20261123_portfolio_holdings.sql).
 * Pure and safe on both sides: types, validation of an import, the screenshot
 * and broker mappings, live valuation, weights and the labels the UI shows.
 *
 * Rules (founder decisions, 2026-11):
 *   - Every kind is kept: stocks, ETFs, funds, ADRs, options, crypto, futures
 *     and anything else. Shorts keep a negative quantity.
 *   - A position is keyed by (account, kind, symbol). `symbol` is the
 *     instrument's own symbol (the OCC symbol for an option, "BTC" for
 *     crypto); `ticker` is the equity ticker (or an option's underlying) used
 *     to match Sightings and the graph, null for crypto, futures and others,
 *     so a coin never collides with a stock of the same letters.
 *   - Only stock-like kinds and options' underlyings feed the ticker list
 *     (`watchlist`). Crypto does not: Sightings and the graph cover listed
 *     US companies only.
 *   - No FX conversion: each position stays in its own currency. Weights use
 *     the largest currency group; positions in other currencies have no weight.
 *   - Nothing is invented: a number is kept only when the source reported it.
 */

export const POSITION_KINDS = ["stock", "etf", "fund", "adr", "option", "crypto", "future", "other"] as const;
export type PositionKind = (typeof POSITION_KINDS)[number];

/** Kinds that are a share of one listed company or fund: they feed the ticker list. */
export const STOCK_LIKE: ReadonlySet<PositionKind> = new Set(["stock", "etf", "fund", "adr"]);

export const IMPORT_SOURCES = ["broker", "screenshot", "csv"] as const;
export type ImportOrigin = (typeof IMPORT_SOURCES)[number];
/** An account's source: an import's, or "paper", the paper account the member creates with a cash balance (lib/paper-account.ts). */
export type AccountSource = ImportOrigin | "paper";

/** Positions kept per member, across accounts (was 30 tickers). */
export const MAX_POSITIONS = 200;
/** Accounts kept per member (broker accounts plus "screenshot" and "csv"). */
export const MAX_ACCOUNTS = 20;

/** "screenshot", "csv", "paper", or "b_" + 24 hex of sha256(user_id:snaptrade_account_id) (lib/portfolio-store.ts). */
export const ACCOUNT_ID = /^(screenshot|csv|paper|b_[0-9a-f]{24})$/;
/** The one paper account a member can have. */
export const PAPER_ACCOUNT_ID = "paper";

export type PortfolioAccount = {
  id: string;
  source: AccountSource;
  name: string | null;
  institution: string | null;
  /** The last 4 characters of the account number, never more. */
  numberLast4: string | null;
  currency: string | null;
  totalValue: number | null;
  cash: number | null;
  buyingPower: number | null;
  /** The broker said it could not return this account's holdings. */
  holdingsUnavailable: boolean;
  asOf: string | null;
};

export type OptionType = "call" | "put";

export type PortfolioPosition = {
  accountId: string;
  kind: PositionKind;
  symbol: string;
  /** Equity ticker, or an option's underlying; null for crypto, futures and others. */
  ticker: string | null;
  name: string;
  /** Units held; negative for a short. Null when the source did not show it. */
  quantity: number | null;
  /** Average cost per share (per share for options too). */
  avgCost: number | null;
  /** Price per share at import time. */
  price: number | null;
  /** Market value at import time. */
  marketValue: number | null;
  /** Unrealised P&L at import time, only when reported (or derived from reported price and cost). */
  unrealizedPnl: number | null;
  currency: string | null;
  optionType: OptionType | null;
  strike: number | null;
  /** YYYY-MM-DD. */
  expiry: string | null;
  multiplier: number | null;
  asOf: string | null;
};

export type PortfolioImport = { source: ImportOrigin; accounts: PortfolioAccount[]; positions: PortfolioPosition[] };

/* ------------------------------------------------------------------ numbers and strings */

const LIMIT = { quantity: 1e12, price: 1e9, value: 1e13, strike: 1e7, multiplier: 1e4 };

/** A finite number within ±max, rounded to 8 decimals; null otherwise. Strings like "1,234.5" are read too. */
export function clampNumber(v: unknown, max: number, { min = -max }: { min?: number } = {}): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n) || n > max || n < min) return null;
  return Math.round(n * 1e8) / 1e8;
}

const nonNegative = (v: unknown, max: number) => clampNumber(v, max, { min: 0 });

function shortText(v: unknown, n: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  return s || null;
}

export function cleanCurrency(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

/** YYYY-MM-DD for a real calendar date, else null. */
export function cleanDate(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** An ISO timestamp no more than a day ahead of now, else null. */
export function cleanTimestamp(v: unknown, now = Date.now()): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > now + 86_400_000 || t < Date.UTC(2000, 0, 1)) return null;
  return new Date(t).toISOString();
}

/** The last 4 letters or digits of an account number (masking characters dropped). */
export function last4(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[^A-Za-z0-9]/g, "");
  return s ? s.slice(-4) : null;
}

/* ------------------------------------------------------------------ symbols */

const OCC = /^([A-Z][A-Z0-9.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const CRYPTO = /^[A-Z0-9]{1,12}(-[A-Z]{3,5})?$/;
const OTHER = /^[A-Z0-9][A-Z0-9 ./_:-]{0,31}$/;

/** "AAPL  261218C00150000" or "AAPL261218C00150000" to its parts; null when it is not an OCC symbol. */
export function parseOcc(raw: string): { underlying: string; expiry: string; optionType: OptionType; strike: number } | null {
  const m = OCC.exec(raw.replace(/\s+/g, "").toUpperCase());
  if (!m) return null;
  const expiry = cleanDate(`20${m[2]}-${m[3]}-${m[4]}`);
  if (!expiry) return null;
  return { underlying: m[1]!, expiry, optionType: m[5] === "C" ? "call" : "put", strike: Number(m[6]) / 1000 };
}

/** The compact OCC symbol (no padding), e.g. NVDA261218C00150000; null when a field is missing or out of range. */
export function occSymbol(underlying: string, expiry: string, optionType: OptionType, strike: number): string | null {
  const root = underlying.toUpperCase().replace(/[^A-Z0-9.]/g, "");
  const date = cleanDate(expiry);
  if (!/^[A-Z][A-Z0-9.]{0,5}$/.test(root) || !date || !(strike > 0) || strike >= 100_000) return null;
  const k = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${root}${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}${optionType === "call" ? "C" : "P"}${k}`;
}

function cleanCrypto(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toUpperCase().replace(/^\$/, "").replace(/\//g, "-").replace(/\s+/g, "") : "";
  return CRYPTO.test(s) ? s : null;
}

function cleanOther(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toUpperCase().replace(/\s+/g, " ") : "";
  return OTHER.test(s) ? s : null;
}

/** Pure: a position's equity ticker, if any, as it is matched to Sightings. */
function tickerOf(v: unknown): string | null {
  return typeof v === "string" ? cleanTicker(v) : null;
}

/* ------------------------------------------------------------------ validation */

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {});

export function positionKey(p: Pick<PortfolioPosition, "accountId" | "kind" | "symbol">): string {
  return `${p.accountId}|${p.kind}|${p.symbol}`;
}

function sourceOfAccount(id: string): AccountSource {
  return id === "screenshot" ? "screenshot" : id === "csv" ? "csv" : id === PAPER_ACCOUNT_ID ? "paper" : "broker";
}

/** One account from anywhere (an import, a request body, a database row); null when its id is not ours. */
export function cleanAccount(raw: unknown, now = Date.now()): PortfolioAccount | null {
  const a = obj(raw);
  const id = typeof a.id === "string" && ACCOUNT_ID.test(a.id) ? a.id : null;
  if (!id) return null;
  return {
    id,
    source: sourceOfAccount(id),
    name: shortText(a.name, 80),
    institution: shortText(a.institution, 80),
    numberLast4: last4(a.numberLast4),
    currency: cleanCurrency(a.currency),
    totalValue: clampNumber(a.totalValue, LIMIT.value),
    cash: clampNumber(a.cash, LIMIT.value),
    buyingPower: clampNumber(a.buyingPower, LIMIT.value),
    holdingsUnavailable: a.holdingsUnavailable === true,
    asOf: cleanTimestamp(a.asOf, now),
  };
}

/** One position; null when its kind or symbol does not hold up. Options need their contract (type, strike, expiry, underlying). */
export function cleanPosition(raw: unknown, now = Date.now()): PortfolioPosition | null {
  const p = obj(raw);
  const accountId = typeof p.accountId === "string" && ACCOUNT_ID.test(p.accountId) ? p.accountId : null;
  const kind = POSITION_KINDS.includes(p.kind as PositionKind) ? (p.kind as PositionKind) : null;
  if (!accountId || !kind) return null;

  let symbol: string | null = null;
  let ticker: string | null = null;
  let optionType: OptionType | null = null;
  let strike: number | null = null;
  let expiry: string | null = null;
  let multiplier: number | null = nonNegative(p.multiplier, LIMIT.multiplier) || null;

  if (STOCK_LIKE.has(kind)) {
    symbol = tickerOf(p.symbol) ?? tickerOf(p.ticker);
    ticker = symbol;
  } else if (kind === "option") {
    const occ = typeof p.symbol === "string" ? parseOcc(p.symbol) : null;
    optionType = p.optionType === "call" || p.optionType === "put" ? p.optionType : occ?.optionType ?? null;
    strike = nonNegative(p.strike, LIMIT.strike) || occ?.strike || null;
    expiry = cleanDate(p.expiry) ?? occ?.expiry ?? null;
    ticker = tickerOf(p.ticker) ?? (occ ? tickerOf(occ.underlying) : null);
    if (!ticker || !optionType || !strike || !expiry) return null;
    symbol = occSymbol(occ?.underlying ?? ticker, expiry, optionType, strike);
  } else if (kind === "crypto") {
    symbol = cleanCrypto(p.symbol);
  } else {
    symbol = cleanOther(p.symbol);
  }
  if (!symbol) return null;
  if (kind !== "option" && kind !== "future") multiplier = null;

  return {
    accountId,
    kind,
    symbol,
    ticker,
    name: shortText(p.name, 120) ?? "",
    quantity: clampNumber(p.quantity, LIMIT.quantity),
    avgCost: nonNegative(p.avgCost, LIMIT.price),
    price: nonNegative(p.price, LIMIT.price),
    marketValue: clampNumber(p.marketValue, LIMIT.value),
    unrealizedPnl: clampNumber(p.unrealizedPnl, LIMIT.value),
    currency: cleanCurrency(p.currency),
    optionType,
    strike,
    expiry,
    multiplier,
    asOf: cleanTimestamp(p.asOf, now),
  };
}

const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a + b) * 1e8) / 1e8);

/** Two rows of the same (account, kind, symbol): quantities, values and P&L added up, cost averaged by quantity. */
function combine(a: PortfolioPosition, b: PortfolioPosition): PortfolioPosition {
  const quantity = sum(a.quantity, b.quantity);
  const avgCost =
    a.avgCost !== null && b.avgCost !== null && a.quantity !== null && b.quantity !== null && quantity
      ? Math.round(((a.avgCost * a.quantity + b.avgCost * b.quantity) / quantity) * 1e8) / 1e8
      : null;
  return {
    ...a,
    quantity,
    avgCost: avgCost !== null && avgCost >= 0 ? avgCost : null,
    marketValue: sum(a.marketValue, b.marketValue),
    unrealizedPnl: sum(a.unrealizedPnl, b.unrealizedPnl),
  };
}

export type ImportCheck = { ok: true; value: PortfolioImport } | { ok: false; error: string };

/**
 * A whole import, as the client sends it to POST /api/portfolio/holdings or
 * the import routes build it: known source, accounts of that source only,
 * positions on those accounts, one row per (account, kind, symbol), at most
 * MAX_POSITIONS. Rows that do not hold up are dropped, not guessed at.
 */
export function cleanImport(raw: unknown, now = Date.now()): ImportCheck {
  const r = obj(raw);
  const source = IMPORT_SOURCES.includes(r.source as ImportOrigin) ? (r.source as ImportOrigin) : null;
  if (!source) return { ok: false, error: "Unknown import source." };
  if (!Array.isArray(r.accounts) || !Array.isArray(r.positions)) return { ok: false, error: "Send { source, accounts, positions }." };
  if (r.accounts.length > MAX_ACCOUNTS) return { ok: false, error: `At most ${MAX_ACCOUNTS} accounts.` };
  if (r.positions.length > MAX_POSITIONS * 2) return { ok: false, error: `At most ${MAX_POSITIONS} positions.` };

  const accounts = new Map<string, PortfolioAccount>();
  for (const a of r.accounts) {
    const account = cleanAccount(a, now);
    if (account && account.source === source && !accounts.has(account.id)) accounts.set(account.id, account);
  }
  const positions = new Map<string, PortfolioPosition>();
  for (const raw of r.positions) {
    const p = cleanPosition(raw, now);
    if (!p || !accounts.has(p.accountId)) continue;
    const key = positionKey(p);
    const seen = positions.get(key);
    if (seen) positions.set(key, combine(seen, p));
    else if (positions.size < MAX_POSITIONS) positions.set(key, p);
  }
  return { ok: true, value: { source, accounts: Array.from(accounts.values()), positions: Array.from(positions.values()) } };
}

/* ------------------------------------------------------------------ what feeds the ticker list */

/** Tickers an import adds to the ticker list: stock-like kinds and options' underlyings, in order, no crypto. */
export function watchTickers(positions: readonly Pick<PortfolioPosition, "kind" | "ticker">[]): string[] {
  const out = new Set<string>();
  for (const p of positions) {
    if (!p.ticker || !TICKER_PATTERN.test(p.ticker)) continue;
    if (STOCK_LIKE.has(p.kind) || p.kind === "option") out.add(p.ticker);
  }
  return Array.from(out).slice(0, MAX_STOCKS);
}

/**
 * The import routes' `holdings` (kept for the iPhone app and the welcome flow
 * review): one row per ticker that feeds the list, with shares and value from
 * long stock-like positions only.
 */
export function holdingsOf(imp: Pick<PortfolioImport, "positions">): PickedStock[] {
  const byTicker = new Map<string, PickedStock>();
  for (const ticker of watchTickers(imp.positions)) byTicker.set(ticker, { ticker, name: "" });
  for (const p of imp.positions) {
    const h = p.ticker ? byTicker.get(p.ticker) : undefined;
    if (!h) continue;
    if (STOCK_LIKE.has(p.kind)) {
      if (!h.name && p.name) h.name = p.name;
      if (p.quantity !== null && p.quantity > 0) h.shares = (h.shares ?? 0) + p.quantity;
      if (p.marketValue !== null && p.marketValue > 0) h.value = (h.value ?? 0) + p.marketValue;
    }
  }
  return Array.from(byTicker.values());
}

/**
 * Pure: the import as the member left it in the welcome flow's review list.
 * Positions whose ticker was removed (or renamed) there go; positions without
 * a ticker (crypto, futures, others) were never listed and stay. A share count
 * edited on a ticker with one long stock-like position replaces its quantity
 * (its import-time value and P&L go, live prices recompute them).
 */
export function reviewedImport(imp: PortfolioImport, reviewed: readonly PickedStock[]): PortfolioImport {
  const shown = new Map(reviewed.map((h) => [h.ticker, h]));
  const original = new Map(holdingsOf(imp).map((h) => [h.ticker, h]));
  const longStock = new Map<string, number>();
  for (const p of imp.positions) if (p.ticker && STOCK_LIKE.has(p.kind)) longStock.set(p.ticker, (longStock.get(p.ticker) ?? 0) + 1);
  const positions = imp.positions
    .filter((p) => !p.ticker || shown.has(p.ticker))
    .map((p) => {
      if (!p.ticker || !STOCK_LIKE.has(p.kind) || longStock.get(p.ticker) !== 1 || (p.quantity !== null && p.quantity < 0)) return p;
      const edited = shown.get(p.ticker)?.shares;
      if (edited === original.get(p.ticker)?.shares) return p;
      return { ...p, quantity: edited ?? null, marketValue: null, unrealizedPnl: null };
    });
  return { ...imp, positions };
}

/* ------------------------------------------------------------------ screenshot */

/** One row of the screenshot reader's structured answer (lib/portfolio-server.ts SCREENSHOT_SCHEMA). */
export type ScreenshotRow = {
  ticker: string;
  name: string;
  kind: string;
  shares: number | null;
  value: number | null;
  avg_cost: number | null;
  price: number | null;
  unrealized_pnl: number | null;
  currency: string | null;
  option_type: string | null;
  strike: number | null;
  expiry: string | null;
  multiplier: number | null;
  underlying: string | null;
};

export type ScreenshotAnswer = {
  is_portfolio: boolean;
  account: { name: string | null; currency: string | null; total_value: number | null; cash: number | null; buying_power: number | null };
  holdings: ScreenshotRow[];
};

const SCREENSHOT_KIND: Record<string, PositionKind> = {
  stock: "stock",
  etf: "etf",
  fund: "fund",
  mutual_fund: "fund",
  adr: "adr",
  option: "option",
  crypto: "crypto",
  future: "future",
  other: "other",
};

/** Pure: the reader's answer as an import on the "screenshot" account (rows without a readable symbol are dropped). */
export function screenshotImport(answer: ScreenshotAnswer, now = Date.now()): PortfolioImport {
  const asOf = new Date(now).toISOString();
  const a = answer.account ?? ({} as ScreenshotAnswer["account"]);
  const account: PortfolioAccount = {
    id: "screenshot",
    source: "screenshot",
    name: shortText(a.name, 80),
    institution: null,
    numberLast4: null,
    currency: cleanCurrency(a.currency),
    totalValue: clampNumber(a.total_value, LIMIT.value),
    cash: clampNumber(a.cash, LIMIT.value),
    buyingPower: clampNumber(a.buying_power, LIMIT.value),
    holdingsUnavailable: false,
    asOf,
  };
  const rows = (answer.holdings ?? []).map((h) => {
    const kind = SCREENSHOT_KIND[String(h.kind ?? "").toLowerCase()] ?? "stock";
    if (/money market|cash sweep/i.test(h.name ?? "")) return null;
    return {
      accountId: "screenshot",
      kind,
      symbol: h.ticker,
      ticker: kind === "option" ? h.underlying ?? h.ticker : h.ticker,
      name: h.name,
      quantity: h.shares,
      avgCost: h.avg_cost,
      price: h.price,
      marketValue: h.value,
      unrealizedPnl: h.unrealized_pnl,
      currency: h.currency ?? account.currency,
      optionType: typeof h.option_type === "string" ? h.option_type.toLowerCase() : null,
      strike: h.strike,
      expiry: h.expiry,
      multiplier: h.multiplier,
      asOf,
    };
  });
  const checked = cleanImport({ source: "screenshot", accounts: [account], positions: rows.filter(Boolean) }, now);
  return checked.ok ? checked.value : { source: "screenshot", accounts: [account], positions: [] };
}

/* ------------------------------------------------------------------ CSV */

/** Pure: a broker CSV's rows (parseHoldingsCsv in lib/portfolio.ts) as an import on the "csv" account; equities only. */
export function csvImport(rows: readonly CsvRowLike[], now = Date.now()): PortfolioImport {
  const asOf = new Date(now).toISOString();
  const account: PortfolioAccount = {
    id: "csv",
    source: "csv",
    name: null,
    institution: null,
    numberLast4: null,
    currency: null,
    totalValue: null,
    cash: null,
    buyingPower: null,
    holdingsUnavailable: false,
    asOf,
  };
  const positions = rows
    .filter((r) => !/money market|cash sweep/i.test(r.name ?? ""))
    .map((r) => ({
      accountId: "csv",
      kind: "stock",
      symbol: r.ticker,
      name: r.name,
      quantity: r.shares,
      avgCost: r.avgCost,
      price: r.price,
      marketValue: r.value,
      currency: r.currency,
      asOf,
    }));
  const checked = cleanImport({ source: "csv", accounts: [account], positions }, now);
  return checked.ok ? checked.value : { source: "csv", accounts: [account], positions: [] };
}

type CsvRowLike = { ticker: string; name: string | null; shares: number | null; value: number | null; avgCost: number | null; price: number | null; currency: string | null };

/* ------------------------------------------------------------------ broker (SnapTrade) */

/** SnapTrade's instrument.kind to ours; null for cash (balances carry cash). */
export function brokerKind(kind: unknown): PositionKind | null {
  switch (kind) {
    case "stock":
    case "preferred_stock":
      return "stock";
    case "etf":
      return "etf";
    case "mutualfund":
    case "cef":
      return "fund";
    case "adr":
      return "adr";
    case "option":
      return "option";
    case "crypto":
      return "crypto";
    case "future":
    case "future_option":
      return "future";
    case "cash":
      return null;
    default:
      return "other";
  }
}

/**
 * Pure: one SnapTrade AccountPosition (getAllAccountPositions, SDK 13.2.5)
 * as a position on `accountId`, before validation. Unrealised P&L comes from
 * the reported price and cost basis: (price - cost) x units (x multiplier).
 * Cash and cash equivalents are left out: the account's cash balance counts them.
 */
export function brokerPosition(raw: unknown, accountId: string, asOf: string | null): Loose | null {
  const position = obj(raw);
  if (position.cash_equivalent === true) return null;
  const instrument = obj(position.instrument);
  const kind = brokerKind(instrument.kind);
  if (!kind) return null;
  const units = clampNumber(position.units, LIMIT.quantity);
  const price = nonNegative(position.price, LIMIT.price);
  const cost = nonNegative(position.cost_basis, LIMIT.price);
  const multiplier = kind === "option" || kind === "future" ? nonNegative(instrument.multiplier, LIMIT.multiplier) || null : null;
  const m = multiplier ?? 1;
  const underlying = obj(instrument.underlying);
  const symbol = kind === "option" ? instrument.symbol : STOCK_LIKE.has(kind) ? instrument.symbol ?? instrument.raw_symbol : instrument.symbol ?? instrument.raw_symbol;
  return {
    accountId,
    kind,
    symbol,
    ticker: kind === "option" ? underlying.symbol : STOCK_LIKE.has(kind) ? symbol : null,
    name: instrument.description,
    quantity: units,
    avgCost: cost,
    price,
    marketValue: units !== null && price !== null ? units * price * m : null,
    unrealizedPnl: units !== null && price !== null && cost !== null ? (price - cost) * units * m : null,
    currency: position.currency ?? instrument.currency,
    optionType: typeof instrument.option_type === "string" ? instrument.option_type.toLowerCase() : null,
    strike: instrument.strike_price,
    expiry: instrument.expiration_date,
    multiplier,
    asOf,
  };
}

/** Pure: whether a SnapTrade account is skipped (paper trading, or closed / archived). */
export function brokerAccountSkipped(account: { is_paper?: unknown; status?: unknown }): boolean {
  return account.is_paper === true || account.status === "closed" || account.status === "archived";
}

/* ------------------------------------------------------------------ live valuation */

/** A live (or last close) quote for one position, keyed by quoteSymbol. */
export type Quote = {
  price: number;
  /** Change since the previous close, per share. */
  change: number | null;
  changePct: number | null;
  currency: string | null;
  /** Epoch ms of the quote. */
  at: number | null;
  /** "live": Yahoo Finance quote (may be delayed); "close": Falcon's stored daily close. */
  source: "live" | "close";
  /** Market value of the company (or the coin), in `currency`; only on live quotes that carry one. */
  marketCap?: number | null;
  /** Today's volume (units traded); only on live quotes that carry one. */
  volume?: number | null;
  /** The instrument's name as the quote source writes it. */
  name?: string | null;
};

/** The symbol a quote is looked up by: BRK.B as BRK-B, an option by its OCC symbol, crypto as BTC-USD; null for futures and others. */
export function quoteSymbol(p: Pick<PortfolioPosition, "kind" | "symbol" | "ticker" | "currency">): string | null {
  if (STOCK_LIKE.has(p.kind)) {
    const t = p.ticker ?? p.symbol;
    return /^[A-Z]+\.[A-Z]$/.test(t) ? t.replace(".", "-") : t;
  }
  if (p.kind === "option") return p.symbol;
  if (p.kind === "crypto") return p.symbol.includes("-") ? p.symbol : `${p.symbol}-${p.currency ?? "USD"}`;
  return null;
}

/** Contract size used to value a position: an option's multiplier (100 when the source did not give one), a future's, else 1. */
export function contractSize(p: Pick<PortfolioPosition, "kind" | "multiplier">): number {
  if (p.kind === "option") return p.multiplier ?? 100;
  if (p.kind === "future") return p.multiplier ?? 1;
  return 1;
}

export type PriceSource = "live" | "close" | "import";

export type ValuedPosition = PortfolioPosition & {
  key: string;
  /** Price per share used for value: live, else the last stored close, else the import price. */
  lastPrice: number | null;
  priceSource: PriceSource | null;
  quoteAt: number | null;
  /** Current value in the position's currency: quantity x price x contract size. */
  value: number | null;
  dayChange: number | null;
  dayChangePct: number | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  /** Cost basis (absolute), when quantity and average cost are known. */
  cost: number | null;
  /** Percent of the main currency group's gross value; null outside it or without a value. */
  weight: number | null;
  /** The currency group it is weighed in. */
  group: string;
};

export type CurrencyTotal = {
  currency: string;
  value: number;
  /** Sum over positions with a day change; null when none has one. */
  dayChange: number | null;
  unrealized: number | null;
  cost: number | null;
  positions: number;
};

export type PortfolioValuation = {
  positions: ValuedPosition[];
  /** Largest group first. */
  totals: CurrencyTotal[];
  /** The currency weights are measured in; null without any value. */
  weightCurrency: string | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure: every position valued with its quote (quotes keyed by quoteSymbol).
 * value = quantity x price x contract size, in the position's own currency;
 * a position without a quantity keeps its import value. Weights are signed
 * (shorts negative) and measured against the gross value (sum of absolute
 * values) of the largest currency group; other currencies have no weight.
 * Unrealised P&L uses the average cost when known, else the reported figure.
 */
export function valuePortfolio(
  positions: readonly PortfolioPosition[],
  quotes: Readonly<Record<string, Quote | undefined>>,
  accounts: readonly Pick<PortfolioAccount, "id" | "currency">[] = [],
): PortfolioValuation {
  const accountCurrency = new Map(accounts.map((a) => [a.id, a.currency]));
  const valued: ValuedPosition[] = positions.map((p) => {
    const sym = quoteSymbol(p);
    const q = sym ? quotes[sym] : undefined;
    const size = contractSize(p);
    const lastPrice = q?.price ?? p.price;
    const priceSource: PriceSource | null = q ? q.source : p.price !== null ? "import" : null;
    const value = p.quantity !== null && lastPrice !== null ? r2(p.quantity * lastPrice * size) : p.quantity === null ? p.marketValue : null;
    const dayChange = p.quantity !== null && q?.change != null ? r2(p.quantity * q.change * size) : null;
    const cost = p.quantity !== null && p.avgCost !== null ? r2(Math.abs(p.quantity * p.avgCost * size)) : null;
    const unrealized =
      p.quantity !== null && p.avgCost !== null && lastPrice !== null ? r2((lastPrice - p.avgCost) * p.quantity * size) : p.unrealizedPnl;
    const unrealizedPct = unrealized !== null && cost ? (unrealized / cost) * 100 : null;
    const group = p.currency ?? accountCurrency.get(p.accountId) ?? q?.currency ?? "USD";
    return {
      ...p,
      key: positionKey(p),
      lastPrice,
      priceSource,
      quoteAt: q?.at ?? null,
      value,
      dayChange,
      dayChangePct: q?.changePct ?? null,
      unrealized,
      unrealizedPct,
      cost,
      weight: null,
      group,
    };
  });

  const groups = new Map<string, CurrencyTotal & { gross: number; hasDay: boolean; hasCost: boolean }>();
  for (const v of valued) {
    const g = groups.get(v.group) ?? { currency: v.group, value: 0, dayChange: 0, unrealized: 0, cost: 0, positions: 0, gross: 0, hasDay: false, hasCost: false };
    g.positions += 1;
    if (v.value !== null) {
      g.value += v.value;
      g.gross += Math.abs(v.value);
    }
    if (v.dayChange !== null) {
      g.dayChange = (g.dayChange ?? 0) + v.dayChange;
      g.hasDay = true;
    }
    if (v.unrealized !== null && v.cost !== null) {
      g.unrealized = (g.unrealized ?? 0) + v.unrealized;
      g.cost = (g.cost ?? 0) + v.cost;
      g.hasCost = true;
    }
    groups.set(v.group, g);
  }
  const ordered = Array.from(groups.values()).sort((a, b) => b.gross - a.gross || a.currency.localeCompare(b.currency));
  const main = ordered[0] && ordered[0].gross > 0 ? ordered[0] : null;
  if (main) {
    for (const v of valued) if (v.group === main.currency && v.value !== null) v.weight = (v.value / main.gross) * 100;
  }
  return {
    positions: valued,
    totals: ordered.map((g) => ({
      currency: g.currency,
      value: r2(g.value),
      dayChange: g.hasDay ? r2(g.dayChange ?? 0) : null,
      unrealized: g.hasCost ? r2(g.unrealized ?? 0) : null,
      cost: g.hasCost ? r2(g.cost ?? 0) : null,
      positions: g.positions,
    })),
    weightCurrency: main?.currency ?? null,
  };
}

/** One line per ticker (or crypto symbol) for Falcon AI: whole-percent weight and gain, never amounts. */
export type AiWeight = { ticker: string; kind: "equity" | "crypto"; weightPct: number | null; unrealisedPct: number | null };

/**
 * Pure: weights and gains per ticker, combined across accounts and kinds (a
 * stock and its options count to the ticker; crypto by its symbol), from live
 * values. Whole percents only; the main currency group gives the weights.
 * Futures and others are left out. Largest weight first.
 */
export function aiWeights(valuation: PortfolioValuation): AiWeight[] {
  const by = new Map<string, { kind: AiWeight["kind"]; weight: number | null; unrealized: number; cost: number; hasCost: boolean }>();
  for (const v of valuation.positions) {
    const key = v.kind === "crypto" ? v.symbol.split("-")[0]! : v.ticker;
    if (!key || v.kind === "future" || v.kind === "other") continue;
    const row = by.get(key) ?? { kind: v.kind === "crypto" ? "crypto" : "equity", weight: null, unrealized: 0, cost: 0, hasCost: false };
    if (v.weight !== null) row.weight = (row.weight ?? 0) + v.weight;
    if (v.unrealized !== null && v.cost) {
      row.unrealized += v.unrealized;
      row.cost += v.cost;
      row.hasCost = true;
    }
    by.set(key, row);
  }
  return Array.from(by, ([ticker, r]) => ({
    ticker,
    kind: r.kind,
    weightPct: r.weight === null ? null : Math.round(r.weight),
    unrealisedPct: r.hasCost && r.cost > 0 ? Math.round((r.unrealized / r.cost) * 100) : null,
  })).sort((a, b) => (b.weightPct ?? -Infinity) - (a.weightPct ?? -Infinity) || a.ticker.localeCompare(b.ticker));
}

/* ------------------------------------------------------------------ labels */

export const KIND_LABEL: Record<PositionKind, string> = {
  stock: "Stock",
  etf: "ETF",
  fund: "Fund",
  adr: "ADR",
  option: "Option",
  crypto: "Crypto",
  future: "Future",
  other: "Other",
};

/** "150", "152.5": a strike without trailing zeros. */
function strikeText(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** "NVDA 150C 2026-12-18" for an option; the symbol otherwise. */
export function contractLabel(p: Pick<PortfolioPosition, "kind" | "symbol" | "ticker" | "optionType" | "strike" | "expiry">): string {
  if (p.kind !== "option" || !p.ticker || !p.strike || !p.optionType || !p.expiry) return p.symbol;
  return `${p.ticker} ${strikeText(p.strike)}${p.optionType === "call" ? "C" : "P"} ${p.expiry}`;
}

/** What a done import says: "Added 12 positions and 2 account balances." */
export function importSummary(imp: Pick<PortfolioImport, "accounts" | "positions">): string {
  const n = imp.positions.length;
  const m = imp.accounts.filter((a) => a.totalValue !== null || a.cash !== null || a.buyingPower !== null).length;
  const positions = n === 1 ? "1 position" : `${n} positions`;
  if (!m) return `Added ${positions}.`;
  return `Added ${positions} and ${m === 1 ? "1 account balance" : `${m} account balances`}.`;
}

/* ------------------------------------------------------------------ benchmark */

/** The benchmark the POSITIONS card compares with. */
export const BENCHMARK = "SPY";

export type Benchmark = { symbol: string; from: string; changePct: number };

/**
 * Pure: when the portfolio started (the paper account's creation, else the
 * earliest import date), as YYYY-MM-DD; null without one or when it is less
 * than a day old (no comparison worth showing).
 */
export function benchmarkStart(dates: readonly (string | null)[], now = Date.now()): string | null {
  const times = dates.map((d) => (d ? Date.parse(d) : NaN)).filter((t) => Number.isFinite(t));
  if (!times.length) return null;
  const first = Math.min(...times);
  if (now - first < 86_400_000) return null;
  return new Date(first).toISOString().slice(0, 10);
}

/**
 * Pure: the benchmark's return from `from` (the first close on or after it)
 * to `end` (a live price) or, without one, the last close; null when there is
 * no close from that day on, or no later price to compare with.
 */
export function benchmarkChange(bars: readonly (readonly [string, number])[], from: string, end: number | null = null): number | null {
  const at = bars.findIndex(([d]) => d >= from);
  if (at === -1) return null;
  const base = bars[at]![1];
  const last = end ?? (at < bars.length - 1 ? bars[bars.length - 1]![1] : null);
  if (!(base > 0) || last === null || !(last > 0)) return null;
  return (last / base - 1) * 100;
}
