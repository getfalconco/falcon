import type { StockCatalogEntry } from "./stock-catalog";

/**
 * The tickers a reader types during onboarding: "nvda, tsm  $aapl" becomes
 * NVDA, TSM, AAPL. Parsing is pure and checks the shape only; whether a
 * symbol is a listed stock is the catalog's answer (`catalogMatch`), asked by
 * the renderer through the same search the top bar uses.
 */

/** How many names onboarding takes. Each one outside the tracked set is a backfill and a filing read. */
export const ONBOARDING_TICKER_CAP = 10;

/** A US ticker: 1 to 5 letters, an optional class suffix written with a dot or a dash (BRK.B, BRK-B). */
const TICKER_SHAPE = /^[A-Z]{1,5}(?:[.-][A-Z])?$/;

export type ParsedTickers = {
  /** Well-formed symbols, upper-cased, in the order typed, without repeats. */
  tickers: string[];
  /** Pieces that are not shaped like a ticker, as typed. */
  rejected: string[];
};

/** Normalises one typed piece: trims, drops a leading "$", upper-cases. Null when it is not shaped like a ticker. */
export function normalizeTicker(raw: string): string | null {
  const piece = raw.trim().replace(/^\$+/, "").toUpperCase();
  return TICKER_SHAPE.test(piece) ? piece : null;
}

/** Splits on commas, semicolons and whitespace. */
export function parseTickerInput(text: string): ParsedTickers {
  const tickers: string[] = [];
  const rejected: string[] = [];
  for (const piece of text.split(/[\s,;]+/)) {
    if (!piece) continue;
    const ticker = normalizeTicker(piece);
    if (!ticker) {
      rejected.push(piece);
      continue;
    }
    if (!tickers.includes(ticker)) tickers.push(ticker);
  }
  return { tickers, rejected };
}

/** The same symbol in the catalog's spelling: the directory writes class shares with a dot, readers often use a dash. */
function sameSymbol(a: string, b: string): boolean {
  return a.toUpperCase().replace("-", ".") === b.toUpperCase().replace("-", ".");
}

/**
 * The catalog entry for this exact symbol among search results, or null. A
 * search matches substrings of symbols and names, so "NVD" finds NVDA; only
 * an exact symbol counts as the stock the reader meant. Indices (^GSPC) never
 * match, since they cannot be held.
 */
export function catalogMatch(ticker: string, results: readonly StockCatalogEntry[]): StockCatalogEntry | null {
  return results.find((entry) => !entry.symbol.startsWith("^") && sameSymbol(entry.symbol, ticker)) ?? null;
}

/** Adds tickers to a list, keeping order, skipping repeats, and stopping at the cap. */
export function addTickers(current: readonly string[], incoming: readonly string[], cap = ONBOARDING_TICKER_CAP): string[] {
  const next = [...current];
  for (const ticker of incoming) {
    if (next.length >= cap) break;
    if (!next.some((t) => sameSymbol(t, ticker))) next.push(ticker);
  }
  return next;
}
