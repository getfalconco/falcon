import { isEtfTicker } from "../../lib/etf-tickers";

/**
 * The Allocation card's arithmetic: what kind of thing each holding is, how
 * the book splits across those kinds, and the whole percentages the card
 * prints. Pure on purpose (no React, no storage, no window) so the tests read
 * it directly.
 *
 * The book is the same one Net worth adds up: the paper account's cash, its
 * positions at their live value (at cost until a print lands), and the
 * totals of linked brokerage accounts. A linked account arrives as one
 * number with nothing inside it, so it is a class of its own rather than a
 * guess at stocks.
 */

export type AssetClass = "stocks" | "funds" | "crypto" | "options" | "linked" | "other" | "cash";

/** The order classes take on the gauge and in the legend: cash last, at the right end of the arc. */
export const CLASS_ORDER: readonly AssetClass[] = ["stocks", "funds", "crypto", "options", "linked", "other", "cash"];

/** A share under this is folded into Other when there is more than one such class. */
export const TINY_SHARE = 0.02;

const COINS = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "DOT", "LTC", "LINK", "MATIC", "POL", "BNB",
  "SHIB", "TRX", "XLM", "BCH", "ATOM", "UNI", "ETC", "NEAR", "APT", "ARB", "OP", "SUI", "PEPE", "TON",
  "USDT", "USDC", "DAI", "HBAR", "FIL", "ICP", "AAVE", "XMR", "ALGO",
];
const COIN_SET = new Set(COINS);
const QUOTE_CCY = "(?:USD|USDT|USDC|EUR|GBP|BTC|ETH)";
/** "BTC-USD", "ETH/USDT", "SOL USD". */
const PAIR = new RegExp(`^([A-Z0-9]{2,10})[-/ ]${QUOTE_CCY}$`);
/** "BTCUSD", "ETHUSDT": only for a known coin, since "ABCUSD" could be anything. */
const JOINED = new RegExp(`^(${COINS.join("|")})${QUOTE_CCY}$`);
/** OCC option symbols ("AAPL  250117C00150000", "AAPL250117C00150000"). */
const OCC = /^[A-Z.]{1,6}\s*\d{6}[CP]\d{8}$/;

/**
 * What a held symbol is. A bare coin name ("BTC") is left as a security:
 * several are also exchange tickers, and the paper account trades those.
 */
export function classifySymbol(symbol: string): Exclude<AssetClass, "linked" | "other" | "cash"> {
  const s = symbol.trim().toUpperCase();
  if (s.startsWith("X:")) return "crypto";
  if (s.startsWith("O:") || OCC.test(s)) return "options";
  if (JOINED.test(s)) return "crypto";
  const pair = PAIR.exec(s);
  if (pair && COIN_SET.has(pair[1]!)) return "crypto";
  if (isEtfTicker(s)) return "funds";
  return "stocks";
}

export type AllocationInput = {
  /** Paper account cash, in dollars. */
  cash: number;
  /** Every position at its market value in dollars (signed: a short is negative). */
  holdings: ReadonlyArray<{ symbol: string; value: number }>;
  /** The totals of linked brokerage accounts, in dollars. */
  linked?: number;
};

export type AllocationSlice = {
  key: AssetClass;
  /** Dollars. */
  value: number;
  /** 0 to 1, of the positive classes' total. */
  share: number;
  /** Whole percent; the slices' percents add up to exactly 100. */
  percent: number;
};

export type Allocation = {
  /** The sum of the classes drawn. */
  total: number;
  slices: AllocationSlice[];
  /** Everything that is not cash, 0 to 1. */
  investedShare: number;
  /** 100 minus cash's printed percent, so the headline agrees with the legend. */
  investedPercent: number;
};

/**
 * Whole percentages that add up to exactly 100 (largest remainder), so a
 * legend of 47, 22 and 31 never prints 101. Zero total gives zeros.
 */
export function roundedPercents(values: readonly number[]): number[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (!(total > 0)) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, v) / total) * 100);
  const floors = raw.map((r) => Math.floor(r));
  let left = 100 - floors.reduce((s, f) => s + f, 0);
  const order = raw
    .map((r, i) => ({ i, rest: r - Math.floor(r) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

/**
 * The book by class. Each class is the sum of its holdings; a class that nets
 * to zero or below (a short larger than the longs beside it, an overdrawn
 * cash line) is not drawn, since an arc cannot hold a negative share. Two or
 * more classes under TINY_SHARE fold into Other. Null when nothing is left.
 */
export function buildAllocation(input: AllocationInput, tiny: number = TINY_SHARE): Allocation | null {
  const sums = new Map<AssetClass, number>();
  const put = (key: AssetClass, v: number) => {
    if (Number.isFinite(v)) sums.set(key, (sums.get(key) ?? 0) + v);
  };
  put("cash", input.cash);
  for (const h of input.holdings) put(classifySymbol(h.symbol), h.value);
  if (input.linked != null) put("linked", input.linked);

  let classes = CLASS_ORDER.map((key) => ({ key, value: sums.get(key) ?? 0 })).filter((c) => c.value >= 0.005);
  const total = classes.reduce((s, c) => s + c.value, 0);
  if (!(total > 0)) return null;

  const small = classes.filter((c) => c.key !== "cash" && c.key !== "other" && c.value / total < tiny);
  const hasOther = classes.some((c) => c.key === "other");
  if (small.length >= 2 || (small.length === 1 && hasOther)) {
    const folded = small.reduce((s, c) => s + c.value, 0);
    const smallKeys = new Set(small.map((c) => c.key));
    classes = classes.filter((c) => !smallKeys.has(c.key));
    const other = classes.find((c) => c.key === "other");
    if (other) other.value += folded;
    else classes.push({ key: "other", value: folded });
    classes.sort((a, b) => CLASS_ORDER.indexOf(a.key) - CLASS_ORDER.indexOf(b.key));
  }

  const percents = roundedPercents(classes.map((c) => c.value));
  const slices = classes.map((c, i) => ({ key: c.key, value: c.value, share: c.value / total, percent: percents[i]! }));
  const cash = slices.find((s) => s.key === "cash");
  return {
    total,
    slices,
    investedShare: 1 - (cash?.share ?? 0),
    investedPercent: 100 - (cash?.percent ?? 0),
  };
}

/** The class a fraction of the arc (0 at the left end, 1 at the right) falls in. */
export function classAt(slices: ReadonlyArray<{ key: AssetClass; share: number }>, at: number): AssetClass | null {
  let edge = 0;
  for (const s of slices) {
    edge += s.share;
    if (at < edge - 1e-9) return s.key;
  }
  return slices.length ? slices[slices.length - 1]!.key : null;
}

/** The reader's planned invested share, as stored: a whole number from 0 to 100, or null. */
export function parsePlan(raw: unknown): number | null {
  if (raw == null) return null;
  const text = String(raw).trim().replace(/%$/, "");
  if (text === "") return null;
  // "60/40" reads as its first half.
  const head = text.split("/")[0]!.trim();
  if (!/^\d{1,3}(?:\.\d+)?$/.test(head)) return null;
  const n = Math.round(Number(head));
  return n >= 0 && n <= 100 ? n : null;
}
