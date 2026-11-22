import { STOCK_LIKE, contractLabel, quoteSymbol, type PortfolioAccount, type PositionKind, type Quote, type ValuedPosition } from "../portfolio-holdings";
import { nyDate } from "./market-status";

/**
 * Pure: how the Dashboard's Portfolio Overview card and Settings > Portfolio
 * show the stored portfolio (lib/workspace/holdings.ts): one combined row per
 * instrument across accounts, groups by kind, the total and gain, the line
 * under them, the market table's rows, and number formats. Nothing here
 * invents a figure: a missing one stays null and shows as "—".
 */

export const MISSING = "—";
export const HIDDEN = "••••";

export type GroupId = "stocks" | "etfs" | "options" | "crypto" | "other";

export const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: "stocks", label: "Stocks" },
  { id: "etfs", label: "ETFs" },
  { id: "options", label: "Options" },
  { id: "crypto", label: "Crypto" },
  { id: "other", label: "Other" },
];

export function groupOf(kind: PositionKind): GroupId {
  if (kind === "stock" || kind === "adr") return "stocks";
  if (kind === "etf") return "etfs";
  if (kind === "option") return "options";
  if (kind === "crypto") return "crypto";
  return "other";
}

/** One row of the card: an instrument combined across the chosen accounts, or a ticker without a stored size. */
export type PositionRow = {
  key: string;
  group: GroupId;
  kind: PositionKind;
  symbol: string;
  /** What the row reads: the ticker, "NVDA 150C 2026-12-18", or the crypto symbol. */
  label: string;
  name: string;
  /** The ticker its page and Sightings use (options: the underlying); null for crypto and others. */
  ticker: string | null;
  /** The symbol its quote and 7-day line are looked up by (BRK-B, BTC-USD, an OCC symbol); null for futures and others. */
  quoteSymbol: string | null;
  currency: string;
  quantity: number | null;
  avgCost: number | null;
  lastPrice: number | null;
  priceSource: ValuedPosition["priceSource"];
  value: number | null;
  dayChange: number | null;
  dayChangePct: number | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  /** Cost basis (absolute) when every combined part had one. */
  cost: number | null;
  weight: number | null;
  short: boolean;
  /** No stored size: a ticker from the list (paper portfolio, older imports). */
  tickerOnly: boolean;
  accounts: string[];
};

const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);

/**
 * Pure: the stored positions (only those on `accountIds` when given) combined
 * per (kind, symbol) across accounts, then a ticker-only row for every list
 * ticker no stored position covers, with its live price and day change.
 */
export function positionRows(
  positions: readonly ValuedPosition[],
  { accountIds = null, tickers = [], quotes = {}, names = {} }: { accountIds?: ReadonlySet<string> | null; tickers?: readonly string[]; quotes?: Readonly<Record<string, Quote>>; names?: Readonly<Record<string, string>> } = {},
): PositionRow[] {
  const rows = new Map<string, PositionRow & { qtyForCost: number }>();
  for (const p of positions) {
    if (accountIds && !accountIds.has(p.accountId)) continue;
    const key = `${p.kind}|${p.symbol}|${p.group}`;
    const seen = rows.get(key);
    if (seen) {
      seen.quantity = add(seen.quantity, p.quantity);
      seen.value = add(seen.value, p.value);
      seen.dayChange = add(seen.dayChange, p.dayChange);
      // Gain and cost only when every part has them, so a part without a cost never reads as a partial gain.
      seen.unrealized = seen.unrealized === null || p.unrealized === null || seen.cost === null || p.cost === null ? null : seen.unrealized + p.unrealized;
      seen.weight = add(seen.weight, p.weight);
      seen.cost = p.cost === null || seen.cost === null ? null : seen.cost + p.cost;
      seen.qtyForCost += p.cost !== null && p.quantity !== null ? Math.abs(p.quantity) : 0;
      seen.accounts.push(p.accountId);
      seen.short = (seen.quantity ?? 0) < 0;
      continue;
    }
    rows.set(key, {
      key,
      group: groupOf(p.kind),
      kind: p.kind,
      symbol: p.symbol,
      label: p.kind === "crypto" ? p.symbol.split("-")[0]! : contractLabel(p),
      name: p.name,
      ticker: STOCK_LIKE.has(p.kind) || p.kind === "option" ? p.ticker : null,
      quoteSymbol: quoteSymbol(p),
      currency: p.group,
      quantity: p.quantity,
      avgCost: p.avgCost,
      lastPrice: p.lastPrice,
      priceSource: p.priceSource,
      value: p.value,
      dayChange: p.dayChange,
      dayChangePct: p.dayChangePct,
      unrealized: p.unrealized,
      unrealizedPct: null,
      cost: p.cost,
      weight: p.weight,
      short: (p.quantity ?? 0) < 0,
      tickerOnly: false,
      accounts: [p.accountId],
      qtyForCost: p.cost !== null && p.quantity !== null ? Math.abs(p.quantity) : 0,
    });
  }
  const out: PositionRow[] = [];
  for (const { qtyForCost, ...r } of rows.values()) {
    // Average cost across accounts, weighted by quantity, when every part had one (per share, so options divide by their size).
    if (r.accounts.length > 1) r.avgCost = r.cost !== null && qtyForCost > 0 ? r.cost / qtyForCost / (r.kind === "option" ? optionSize(positions, r) : 1) : null;
    r.unrealizedPct = r.unrealized !== null && r.cost ? (r.unrealized / r.cost) * 100 : null;
    out.push(r);
  }
  const covered = new Set(out.filter((r) => r.group === "stocks" || r.group === "etfs" || r.group === "other").map((r) => r.ticker).filter(Boolean));
  for (const t of tickers) {
    if (covered.has(t)) continue;
    covered.add(t);
    const q = quotes[t];
    out.push({
      key: `ticker|${t}`,
      group: "stocks",
      kind: "stock",
      symbol: t,
      label: t,
      name: names[t] ?? "",
      ticker: t,
      quoteSymbol: quoteSymbol({ kind: "stock", symbol: t, ticker: t, currency: null }),
      currency: q?.currency ?? "USD",
      quantity: null,
      avgCost: null,
      lastPrice: q?.price ?? null,
      priceSource: q ? q.source : null,
      value: null,
      dayChange: null,
      dayChangePct: q?.changePct ?? null,
      unrealized: null,
      unrealizedPct: null,
      cost: null,
      weight: null,
      short: false,
      tickerOnly: true,
      accounts: [],
    });
  }
  return out;
}

function optionSize(positions: readonly ValuedPosition[], r: Pick<PositionRow, "kind" | "symbol">): number {
  const p = positions.find((x) => x.kind === r.kind && x.symbol === r.symbol);
  return p?.multiplier ?? 100;
}

export type RowGroup = { id: GroupId; label: string; rows: PositionRow[]; value: number | null; weight: number | null };

/** Pure: largest position value first (by size, so a short ranks by its size too); rows without a value after, by symbol. */
export function byValueThenSymbol(a: Pick<PositionRow, "value" | "label">, b: Pick<PositionRow, "value" | "label">): number {
  const ra = a.value === null ? -1 : Math.abs(a.value);
  const rb = b.value === null ? -1 : Math.abs(b.value);
  return rb - ra || a.label.localeCompare(b.label);
}

/** Pure: rows grouped by kind in the fixed order, each sorted by value (largest first), then symbol. */
export function groupRows(rows: readonly PositionRow[]): RowGroup[] {
  return GROUPS.map((g) => {
    const list = rows.filter((r) => r.group === g.id).sort(byValueThenSymbol);
    const value = list.reduce<number | null>((s, r) => add(s, r.value), null);
    const weight = list.reduce<number | null>((s, r) => add(s, r.weight), null);
    return { id: g.id, label: g.label, rows: list, value, weight };
  }).filter((g) => g.rows.length);
}

/** Pure: rows whose label, symbol or name contains the query (case-insensitive). */
export function searchRows(rows: readonly PositionRow[], query: string): PositionRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => `${r.label} ${r.symbol} ${r.name}`.toLowerCase().includes(q));
}

/* ------------------------------------------------------------------ formats */

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", TRY: "₺", CAD: "CA$", AUD: "A$" };

/** "$", "€", "CA$"; null for a currency without a symbol here (CHF). */
export const currencySymbol = (currency: string): string | null => SYMBOL[currency] ?? null;

/** "$1,234.56", "-$12.00", "€3.10", "1,234.56 CHF". */
export function money(n: number, currency = "USD", { digits = 2 }: { digits?: number } = {}): string {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sym = SYMBOL[currency];
  const body = sym ? `${sym}${abs}` : `${abs} ${currency}`;
  return n < 0 ? `-${body}` : body;
}

/** "+$1,234.56" / "-$1,234.56" ("-$412" with 0 digits). */
export function signedMoney(n: number, currency = "USD", digits = 2): string {
  const shown = Number(Math.abs(n).toFixed(digits));
  return `${n > 0 && shown ? "+" : n < 0 && shown ? "-" : ""}${money(shown, currency, { digits })}`;
}

/** A price: 2 decimals, more under $1 (crypto and cheap contracts). */
export function priceText(n: number, currency = "USD"): string {
  return money(n, currency, { digits: Math.abs(n) > 0 && Math.abs(n) < 1 ? 4 : 2 });
}

/** "+1.23%", "-0.40%". */
export function pctText(n: number, digits = 2): string {
  const shown = Math.abs(n).toFixed(digits);
  // A move that rounds to zero carries no sign ("0.00%", never "-0.00%").
  const sign = Number(shown) === 0 ? "" : n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${shown}%`;
}

/** "1,200", "0.35", "-200": up to 4 decimals. */
export function qtyText(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** "48.2M", "950", "1.2K", "3.42T": three significant digits, trailing zeros dropped. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  const units = ["K", "M", "B", "T"] as const;
  let i = Math.min(units.length - 1, Math.floor(Math.log10(abs) / 3) - 1);
  let v = abs / 1000 ** (i + 1);
  let text = v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
  // 999.6K rounds to 1000K: one unit up instead.
  if (Number(text) >= 1000 && i < units.length - 1) {
    i += 1;
    v = abs / 1000 ** (i + 1);
    text = v.toFixed(2);
  }
  return `${sign}${text.includes(".") ? text.replace(/\.?0+$/, "") : text}${units[i]}`;
}

/** "$3.42T", "$812B", "€41.5B", "2.1B CHF". */
export function compactMoney(n: number, currency = "USD"): string {
  const sym = SYMBOL[currency];
  const body = compactNumber(Math.abs(n));
  const out = sym ? `${sym}${body}` : `${body} ${currency}`;
  return n < 0 ? `-${out}` : out;
}

/** "12.3%" (one decimal; "<0.1%" for a tiny non-zero weight). */
export function weightText(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.05) return n < 0 ? "-<0.1%" : "<0.1%";
  return `${n.toFixed(1)}%`;
}

export type Tone = "up" | "down" | "flat";
export const tone = (n: number | null | undefined): Tone => (!n ? "flat" : n > 0 ? "up" : "down");

/** "Individual ••4821", "Roth IRA", "Sample Brokerage". */
export function accountLabel(a: Pick<PortfolioAccount, "name" | "institution" | "numberLast4" | "source">): string {
  const name = a.name ?? a.institution ?? (a.source === "screenshot" ? "Screenshot" : a.source === "csv" ? "CSV import" : "Broker account");
  return a.numberLast4 ? `${name} ••${a.numberLast4}` : name;
}

/** Up to two letters for a monogram tile: "NV", "BT". */
export function monogram(label: string): string {
  const letters = label.replace(/[^A-Za-z0-9]/g, "");
  return (letters.slice(0, 2) || "?").toUpperCase();
}

/* ------------------------------------------------------------------ account weights (the card, concentration and rule cards) */

export type AccountWeights = {
  currency: string;
  /** Gross account value: the size of every position in `currency` plus positive cash. */
  gross: number;
  /** A value's share of the account, 0 to 100 (a short by its size); null outside `currency`, without a value or an account. */
  of: (value: number | null, currency: string) => number | null;
  /** The cash's share, or null without cash. */
  cash: number | null;
};

/**
 * Pure: the one place a holding's weight is worked out, for the Portfolio
 * Overview and, later, the concentration and rule cards: its size as a share
 * of the whole account in the main currency, cash included. A cash-only
 * account is 100% cash.
 */
export function accountWeights(rows: readonly Pick<PositionRow, "value" | "currency" | "tickerOnly">[], cash: number | null, currency: string): AccountWeights {
  const sized = rows.filter((r) => !r.tickerOnly && r.value !== null && r.currency === currency);
  const cashPart = cash !== null && cash > 0 ? cash : 0;
  const gross = sized.reduce((s, r) => s + Math.abs(r.value!), 0) + cashPart;
  return {
    currency,
    gross,
    of: (value, cur) => (value === null || cur !== currency || gross <= 0 ? null : (Math.abs(value) / gross) * 100),
    cash: cashPart > 0 && gross > 0 ? (cashPart / gross) * 100 : null,
  };
}

/** "22% of the account, above your 10% cap"; null at or under the cap. */
export function capText(weight: number | null, cap: number): string | null {
  return weight !== null && weight > cap ? `${Math.round(weight)}% of the account, above your ${cap}% cap` : null;
}

/* ------------------------------------------------------------------ the Portfolio Overview card */

/** One part of the line under the total; `em` marks a key number or name, drawn brighter; `tone` colours a gain (up) or loss (down). */
export type LinePart = { text: string; em?: true; tone?: "up" | "down" };

export const lineText = (parts: readonly LinePart[]): string => parts.map((p) => p.text).join("");

/** One row of the overview's table: what the member holds, and the instrument's market data. */
export type OverviewRow = {
  key: string;
  group: GroupId;
  kind: PositionKind;
  symbol: string;
  label: string;
  /** Muted beside the symbol; empty for options (the label says it all). */
  name: string;
  /** Opens the ticker page (options: the underlying's); null for crypto and others. */
  ticker: string | null;
  quoteSymbol: string | null;
  /** Live position value in `currency` (options with their multiplier); null for ticker-only rows. */
  value: number | null;
  currency: string;
  /** Share of the whole account, cash included (accountWeights); null for ticker-only rows and other currencies. */
  weight: number | null;
  /** Above the member's position cap. */
  overCap: boolean;
  /** Today's move of the position in `currency`: quantity x change per share x multiplier (a short gains when the price falls); null for ticker-only rows. */
  dayMove: number | null;
  /** Today's change of the instrument, percent. */
  changePct: number | null;
  price: number | null;
  priceCurrency: string;
  /** Null for options: a contract has no market cap. */
  marketCap: number | null;
  volume: number | null;
};

export type OverviewGroup = { id: GroupId; label: string; rows: OverviewRow[] };

/** One row of the overview's Cash group: the cash in one currency, summed over the accounts, and its share of the account. */
export type CashRow = { currency: string; amount: number; weight?: number | null };

/** Pure: cash per currency over the accounts (zero and unknown left out), the main currency first, then by code (amounts in different currencies do not compare). */
export function cashRows(accounts: readonly Pick<PortfolioAccount, "cash" | "currency">[], mainCurrency: string | null): CashRow[] {
  const by = new Map<string, number>();
  for (const a of accounts) {
    if (a.cash === null || !Number.isFinite(a.cash)) continue;
    const c = a.currency ?? "USD";
    by.set(c, (by.get(c) ?? 0) + a.cash);
  }
  return Array.from(by, ([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => Number(b.currency === (mainCurrency ?? "USD")) - Number(a.currency === (mainCurrency ?? "USD")) || a.currency.localeCompare(b.currency));
}

/** A change of the account over a period: in money, in percent of the value it started from, and its tone. */
export type Move = { amount: number; pct: number; tone: Tone };

/** When "today" is: the session the quotes are from. */
export type DayWord = "today" | "last session";

/**
 * Beside the total, every period named:
 *   sinceBought  since what the member paid: the gain over the positions with a cost, in percent of that cost
 *   today    today's move of the positions, in percent of the account's value before it (yesterday's close, cash included)
 * Both null (cash only, nothing known): the card shows $0.00 · 0.00%.
 */
export type Indicator = { sinceBought: Move | null; today: (Move & { when: DayWord }) | null };

export type OverviewModel = {
  currency: string;
  /** Live value of the positions plus cash (main currency); null without any size. */
  total: number | null;
  /** Gain since cost over the positions with a cost; null without a cost basis. */
  gain: number | null;
  gainPct: number | null;
  /** Beside the total; null only when there is no total. */
  indicator: Indicator | null;
  /** Which period the line speaks of. */
  linePeriod: "today" | "sinceBought" | null;
  line: LinePart[] | null;
  groups: OverviewGroup[];
  /** The Cash group, last in the table: one row per currency. */
  cash: CashRow[];
  /** False for a ticker-only portfolio: no total or gain. */
  sized: boolean;
  /** Cash only (a fresh paper account): only the Cash group in the table. */
  cashOnly: boolean;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const flatOr = (n: number): Tone => (Math.abs(n) < 0.005 ? "flat" : tone(n));

/** Pure: the overview row for a combined row: its value, weight (with the cap) and today's move, and its quote's market data. */
export function overviewRow(r: PositionRow, market: Readonly<Record<string, Quote>>, weights: AccountWeights | null = null, cap: number | null = null): OverviewRow {
  const q = r.quoteSymbol ? market[r.quoteSymbol] : undefined;
  const weight = r.tickerOnly || !weights ? null : weights.of(r.value, r.currency);
  return {
    key: r.key,
    group: r.group,
    kind: r.kind,
    symbol: r.symbol,
    label: r.label,
    name: r.kind === "option" ? "" : r.name || q?.name || "",
    ticker: r.ticker,
    quoteSymbol: r.quoteSymbol,
    value: r.tickerOnly ? null : r.value,
    currency: r.currency,
    weight,
    overCap: cap !== null && weight !== null && weight > cap,
    dayMove: r.tickerOnly ? null : r.dayChange,
    changePct: r.dayChangePct,
    price: r.lastPrice,
    priceCurrency: r.kind === "option" || r.tickerOnly ? q?.currency ?? r.currency : r.currency,
    marketCap: r.kind === "option" ? null : num(q?.marketCap),
    volume: num(q?.volume),
  };
}

/** Pure: "today" when the stock quotes (else any) are from `nowMs`'s New York day, else "last session"; "today" when no time is known. */
export function dayWord(rows: readonly Pick<PositionRow, "group" | "quoteSymbol">[], market: Readonly<Record<string, Quote>>, nowMs: number): DayWord {
  const stockish = rows.filter((r) => r.group === "stocks" || r.group === "etfs");
  const times = (stockish.length ? stockish : rows).map((r) => (r.quoteSymbol ? market[r.quoteSymbol]?.at ?? null : null)).filter((t): t is number => t !== null);
  return !times.length || times.some((t) => nyDate(t) === nyDate(nowMs)) ? "today" : "last session";
}

/**
 * Pure: the overview from the combined rows (positionRows), the cash in the
 * main currency (and per currency for the Cash group: cashRows), whether a
 * paper account holds it, the quotes by quote symbol, the member's position
 * cap, whether the US market is open, and the time.
 *
 * The line's period: today while the market is open and today's moves are
 * known; otherwise since what the member paid; today's (or the last
 * session's) moves when there is no cost basis. The table lists the sized
 * rows, grouped by kind, or the ticker list when nothing is sized, then the cash.
 */
export function overviewModel({
  rows,
  cash,
  cashByCurrency = [],
  mainCurrency,
  paper = false,
  market = {},
  cap = null,
  marketOpen = false,
  nowMs = Date.now(),
}: {
  rows: readonly PositionRow[];
  cash: number | null;
  cashByCurrency?: readonly CashRow[];
  mainCurrency: string | null;
  paper?: boolean;
  market?: Readonly<Record<string, Quote>>;
  cap?: number | null;
  marketOpen?: boolean;
  nowMs?: number;
}): OverviewModel {
  const held = rows.filter((r) => !r.tickerOnly);
  const valued = held.filter((r) => r.value !== null);
  const currency = mainCurrency ?? valued[0]?.currency ?? "USD";
  const main = valued.filter((r) => r.currency === currency);
  const cashAmount = cash !== null && cash !== 0 ? cash : null;
  const sized = main.length > 0 || cashAmount !== null;
  const total = sized ? main.reduce((s, r) => s + r.value!, 0) + (cashAmount ?? 0) : null;
  const weights = accountWeights(rows, cashAmount, currency);

  // Since cost: the gain over the positions with a cost, against that cost.
  const withCost = main.filter((r) => r.unrealized !== null && r.cost !== null && r.cost > 0);
  const gain = withCost.length ? withCost.reduce((s, r) => s + r.unrealized!, 0) : null;
  const costSum = withCost.reduce((s, r) => s + r.cost!, 0);
  const gainPct = gain !== null && costSum > 0 ? (gain / costSum) * 100 : null;
  // Today: the positions' moves, against the account's value before them (yesterday's close, cash included).
  const withDay = main.filter((r) => r.dayChange !== null);
  const day = withDay.length ? withDay.reduce((s, r) => s + r.dayChange!, 0) : null;
  const yesterday = total !== null && day !== null ? total - day : null;
  const when = dayWord(held.length ? held : rows, market, nowMs);
  const today = day !== null ? { amount: day, pct: yesterday ? (day / yesterday) * 100 : 0, tone: flatOr(day), when } : null;
  const sinceBought = gain !== null ? { amount: gain, pct: gainPct ?? 0, tone: flatOr(gain) } : null;
  const indicator: Indicator | null = total === null ? null : { sinceBought, today };

  const listed = held.length ? held : rows.filter((r) => r.tickerOnly);
  const cashOnly = !listed.length && cashAmount !== null;
  const groups = groupRows(listed).map((g) => ({ id: g.id, label: g.label, rows: g.rows.map((r) => overviewRow(r, market, weights, cap)) }));
  const cashList = cashByCurrency.map((c) => ({ ...c, weight: c.currency === currency && c.amount > 0 && weights.gross > 0 ? (c.amount / weights.gross) * 100 : null }));

  const weightOf = (r: Pick<PositionRow, "value" | "currency">) => weights.of(r.value, r.currency);
  let linePeriod: OverviewModel["linePeriod"] = null;
  let line: LinePart[] | null;
  if (cashOnly) line = cashLine(cashAmount!, currency, paper);
  else if (held.length && today && (marketOpen || gain === null)) {
    linePeriod = "today";
    line = todayLine(withDay, day!, currency, when, weightOf);
  } else if (held.length && gain !== null) {
    linePeriod = "sinceBought";
    line = gainLine(withCost, gain, currency, weightOf);
  } else line = dayLine(listed, market, nowMs);

  return { currency, total, gain, gainPct, indicator, linePeriod, line, groups, cash: cashList, sized, cashOnly };
}

/** Each group's word, singular and plural, for the holdings summary. */
const GROUP_NOUNS: Record<GroupId, readonly [string, string]> = {
  stocks: ["stock", "stocks"],
  etfs: ["ETF", "ETFs"],
  options: ["option", "options"],
  crypto: ["crypto", "crypto"],
  other: ["other holding", "other holdings"],
};

/** Joins "a", "a and b", "a, b and c". */
function andList(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Pure: how many positions the card lists (every row, plus one per cash
 * currency) and what they are, in the card's group order: "Cash only",
 * "3 stocks", "3 stocks and cash", "2 stocks, 1 ETF and cash in 2 currencies".
 * Null text when there is nothing.
 */
export function holdingsSummary(groups: readonly Pick<OverviewGroup, "id" | "rows">[], cash: readonly unknown[]): { count: number; text: string | null } {
  const parts = GROUPS.flatMap((g) => {
    const n = groups.filter((x) => x.id === g.id).reduce((s, x) => s + x.rows.length, 0);
    return n ? [`${n} ${GROUP_NOUNS[g.id][n === 1 ? 0 : 1]}`] : [];
  });
  // Cash is not a position: it never counts, only the held rows do.
  const count = groups.reduce((s, g) => s + g.rows.length, 0);
  const cashText = cash.length > 1 ? `cash in ${cash.length} currencies` : "cash";
  let text: string | null = null;
  if (parts.length) text = andList(cash.length ? [...parts, cashText] : parts);
  else if (cash.length) text = cash.length > 1 ? `Cash only, in ${cash.length} currencies` : "Cash only";
  return { count, text };
}

/** "Your paper account is ready. $50,000 to put to work." (or "All in cash: $12,480.22." for another account). */
export function cashLine(cash: number, currency: string, paper: boolean): LinePart[] {
  const amount = money(cash, currency, { digits: Math.abs(cash) >= 1000 && Number.isInteger(cash) ? 0 : 2 });
  return paper
    ? [{ text: "Your paper account is ready. " }, { text: amount, em: true }, { text: " to put to work." }]
    : [{ text: "All in cash: " }, { text: amount, em: true }, { text: "." }];
}

type Contributor = { name: string; amount: number; weight: number | null; pct: number | null };

/** The holding (a stock and its options counted together) that moved the most in the total's direction; null when none did. */
function topContributor<R extends Pick<PositionRow, "label" | "ticker" | "kind" | "dayChangePct">>(
  rows: readonly R[],
  amountOf: (r: R) => number,
  total: number,
  weightOf: (r: R) => number | null,
): { top: Contributor; count: number } | null {
  const by = new Map<string, Contributor>();
  for (const r of rows) {
    const k = r.ticker ?? r.label;
    const seen = by.get(k) ?? { name: k, amount: 0, weight: null, pct: null };
    seen.amount += amountOf(r);
    const w = weightOf(r);
    if (w !== null) seen.weight = (seen.weight ?? 0) + w;
    // The instrument's own move: the stock's, else the first part's.
    if (r.kind !== "option" || seen.pct === null) seen.pct = r.kind !== "option" ? r.dayChangePct : seen.pct ?? r.dayChangePct;
    by.set(k, seen);
  }
  const up = total > 0;
  const top = Array.from(by.values()).sort((a, b) => (up ? b.amount - a.amount : a.amount - b.amount))[0];
  if (!top || (up ? top.amount <= 0 : top.amount >= 0)) return null;
  return { top, count: by.size };
}

/** "N% of the gains from T" / "Most of it from T" / "All of it from T", with the move and the weight after the name. */
function contributorParts(c: Contributor, count: number, total: number, withPct: boolean): LinePart[] {
  const up = total > 0;
  const share = Math.round((c.amount / total) * 100);
  const T: LinePart = { text: c.name, em: true };
  const after: LinePart[] = [];
  if (withPct && c.pct !== null) after.push({ text: ` (${pctText(c.pct, 1)})` });
  if (c.weight !== null) after.push({ text: ", " }, { text: `${Math.round(c.weight)}%`, em: true }, { text: " of your account" });
  after.push({ text: "." });
  if (count === 1) return [{ text: " All of it from " }, T, ...after];
  if (up) return share >= 100 ? [{ text: " Led by " }, T, ...after] : [{ text: " " }, { text: `${share}%`, em: true }, { text: " of the gains from " }, T, ...after];
  return share >= 50 ? [{ text: " Most of it from " }, T, ...after] : [{ text: " " }, { text: `${share}%`, em: true }, { text: " of it from " }, T, ...after];
}

/**
 * Since what the member paid: "Up $187,356.10 since you bought. 60% of the
 * gains from AMD, 25% of your account." Down is calm ("Most of it from T" at
 * half or more, else "N% of it from T"); "Even with what you paid." at zero.
 * The amount is green up, red down. Null without a cost basis.
 */
export function gainLine(
  rows: readonly Pick<PositionRow, "label" | "ticker" | "kind" | "dayChangePct" | "unrealized" | "value" | "currency">[],
  gain: number | null,
  currency: string,
  weightOf: (r: Pick<PositionRow, "value" | "currency">) => number | null = () => null,
): LinePart[] | null {
  if (gain === null || !rows.length) return null;
  if (Math.abs(gain) < 0.005) return [{ text: "Even with what you paid." }];
  const up = gain > 0;
  const lead: LinePart[] = [{ text: up ? "Up " : "Down " }, { text: money(Math.abs(gain), currency), em: true, tone: up ? "up" : "down" }, { text: " since you bought." }];
  const top = topContributor(rows, (r) => r.unrealized ?? 0, gain, weightOf);
  return top ? [...lead, ...contributorParts(top.top, top.count, gain, false)] : lead;
}

/**
 * Today: "Today: down $1,240. Most of it from CRM (-8.6%), 4% of your
 * account." The holding whose position moved the most in money, with its own
 * move and its weight; "Last session:" when the quotes are from an earlier
 * day; "Today: flat." at zero.
 */
export function todayLine(
  rows: readonly Pick<PositionRow, "label" | "ticker" | "kind" | "dayChangePct" | "dayChange" | "value" | "currency">[],
  day: number,
  currency: string,
  when: DayWord,
  weightOf: (r: Pick<PositionRow, "value" | "currency">) => number | null = () => null,
): LinePart[] {
  const head = when === "today" ? "Today: " : "Last session: ";
  if (Math.abs(day) < 0.5) return [{ text: `${head}flat.` }];
  const up = day > 0;
  const lead: LinePart[] = [{ text: `${head}${up ? "up" : "down"} ` }, { text: money(Math.abs(day), currency, { digits: 0 }), em: true, tone: up ? "up" : "down" }, { text: "." }];
  const top = topContributor(rows, (r) => r.dayChange ?? 0, day, weightOf);
  return top ? [...lead, ...contributorParts(top.top, top.count, day, true)] : lead;
}

/**
 * "4 of your 6 stocks are up today." Counted over the rows with a day change
 * (a ticker list without sizes); "holdings" once anything but stocks is in;
 * "in the last session" when the stock quotes are from an earlier New York
 * day (a weekend, before the open). Null when no row has a day change.
 */
export function dayLine(rows: readonly Pick<PositionRow, "label" | "group" | "dayChangePct" | "quoteSymbol">[], market: Readonly<Record<string, Quote>>, nowMs: number): LinePart[] | null {
  const counted = rows.filter((r) => r.dayChangePct !== null);
  if (!counted.length) return null;
  const when = dayWord(counted, market, nowMs) === "today" ? "today" : "in the last session";
  const n = counted.length;
  const ups = counted.filter((r) => r.dayChangePct! > 0).length;
  if (n === 1) {
    const r = counted[0]!;
    const pct = r.dayChangePct!;
    if (pct === 0) return [{ text: r.label, em: true }, { text: ` is flat ${when}.` }];
    return [{ text: r.label, em: true }, { text: ` is ${pct > 0 ? "up" : "down"} ` }, { text: `${Math.abs(pct).toFixed(1)}%`, em: true }, { text: ` ${when}.` }];
  }
  const noun = counted.every((r) => r.group === "stocks") ? "stocks" : "holdings";
  if (ups === n) return n === 2 ? [{ text: `Both of your ${noun} are up ${when}.` }] : [{ text: "All " }, { text: String(n), em: true }, { text: ` of your ${noun} are up ${when}.` }];
  if (ups === 0) return [{ text: "None of your " }, { text: String(n), em: true }, { text: ` ${noun} are up ${when}.` }];
  return [{ text: String(ups), em: true }, { text: " of your " }, { text: String(n), em: true }, { text: ` ${noun} ${ups === 1 ? "is" : "are"} up ${when}.` }];
}

/* ------------------------------------------------------------------ the table's columns */

/** Which columns show. Stock, Value, Weight and Change % always do (`market` false: the compact cash-only card, Stock and Amount only). */
export type Cols = { market: boolean; dollar: boolean; spark: boolean; price: boolean; cap: boolean; volume: boolean };

/** Card content widths (px) from which each optional column shows: Market Cap goes first as the card narrows, then Volume, Price, Last 7 Days, then the $ move. */
export const COLUMN_FROM = { cap: 860, volume: 770, price: 690, spark: 590, dollar: 500 } as const;

/** Pure: the columns for a card content width. */
export function overviewColumns(width: number): Cols {
  return { market: true, dollar: width >= COLUMN_FROM.dollar, spark: width >= COLUMN_FROM.spark, price: width >= COLUMN_FROM.price, cap: width >= COLUMN_FROM.cap, volume: width >= COLUMN_FROM.volume };
}

/* ------------------------------------------------------------------ the table's sorting */

export type SortKey = "stock" | "value" | "weight" | "change" | "price" | "cap" | "volume";
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir } | null;

/** A header click's next sort: first the column's natural direction (A–Z for Stock, largest first for numbers), then reversed, then back to the default (by value, largest first). */
export function nextSort(sort: Sort, key: SortKey): Sort {
  const first: SortDir = key === "stock" ? "asc" : "desc";
  if (!sort || sort.key !== key) return { key, dir: first };
  if (sort.dir === first) return { key, dir: first === "asc" ? "desc" : "asc" };
  return null;
}

const sortValue = (r: OverviewRow, key: Exclude<SortKey, "stock">): number | null =>
  key === "value" ? (r.value === null ? null : Math.abs(r.value)) : key === "weight" ? r.weight : key === "price" ? r.price : key === "change" ? r.changePct : key === "cap" ? r.marketCap : r.volume;

/**
 * Pure: a group's rows in the chosen order; with no sort, as they come (by
 * value, largest first, then symbol). A missing number ("—") is always last,
 * in either direction; ties keep their default order.
 */
export function sortRows(rows: readonly OverviewRow[], sort: Sort): OverviewRow[] {
  if (!sort) return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (sort.key === "stock") return sign * a.r.label.localeCompare(b.r.label) || a.i - b.i;
      const va = sortValue(a.r, sort.key);
      const vb = sortValue(b.r, sort.key);
      if (va === null || vb === null) return va === vb ? a.i - b.i : va === null ? 1 : -1;
      return sign * (va - vb) || a.i - b.i;
    })
    .map((x) => x.r);
}
