/**
 * The reader's thesis for a stock: a few lines, in their own words, on why
 * they hold or watch it. Kept by the main process per account and per ticker
 * (main/stock-tab/thesis-store.ts) and read by the Stock tab's sections.
 *
 *   stock:thesis:get  ticker          -> StockThesisResult
 *   stock:thesis:set  ticker, text    -> StockThesisResult  (empty text clears it)
 *
 * Pure: the shapes and the checks both sides run.
 */

/** Longest thesis kept, in characters. The field stops there; main refuses longer. */
export const THESIS_MAX_CHARS = 2000;
/** Most tickers one account keeps a thesis for. */
export const THESIS_MAX_PER_USER = 500;

export type StockThesis = {
  ticker: string;
  text: string;
  /** ISO time of the last save. */
  updated_at: string;
};

export type StockThesisFailure = { ok: false; error: "invalid_ticker" | "too_long" | "full" | "signed_out" | "unavailable" };
export type StockThesisResult = { ok: true; thesis: StockThesis | null } | StockThesisFailure;

/** Letters, digits, a dot or a hyphen (BRK.B, RDS-A); what the search catalog lists. */
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

/** The ticker as stored (upper case), or null when it is not one. */
export function thesisTicker(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  return TICKER.test(t) ? t : null;
}

/**
 * The text as stored: line endings made plain, trailing space trimmed, null
 * for one that is not text or is longer than the cap. An empty result means
 * "no thesis" and clears it.
 */
export function thesisText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n?/g, "\n").replace(/\s+$/u, "").replace(/^\s*\n/u, "");
  return text.length > THESIS_MAX_CHARS ? null : text;
}

/** A stored row read back, or null when it does not hold up. */
export function readStoredThesis(ticker: string, row: unknown): StockThesis | null {
  if (!row || typeof row !== "object") return null;
  const r = row as { text?: unknown; updated_at?: unknown };
  const t = thesisTicker(ticker);
  const text = thesisText(r.text);
  if (!t || !text) return null;
  const at = typeof r.updated_at === "string" && Number.isFinite(Date.parse(r.updated_at)) ? r.updated_at : new Date(0).toISOString();
  return { ticker: t, text, updated_at: at };
}
