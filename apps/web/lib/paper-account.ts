import { PAPER_ACCOUNT_ID, type PortfolioAccount } from "./portfolio-holdings";

/**
 * The member's paper account: a USD cash balance they choose in Bring your
 * portfolio ("Look around first"), no positions yet. Stored as the account
 * with id and source "paper" in public.portfolio_accounts
 * (supabase/migrations/20261123_portfolio_holdings.sql) through
 * /api/portfolio/paper; in memory only in the preview, in funnel test mode or
 * while the table is missing. Pure: parsing, validation and the account row.
 * Kept apart from the imports so a fuller paper account (positions, trades)
 * can replace it in one place.
 */

export const PAPER_MIN = 1_000;
export const PAPER_MAX = 10_000_000;
export const PAPER_CURRENCY = "USD";
export const PAPER_DEFAULT_NAME = "Paper account";

/** "$100,000.50" or "100000" to a number; null when it is not a plain amount. */
export function parseBalance(text: string): number | null {
  const s = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** As typed, with thousand separators: "100000" -> "100,000", "1234.5" -> "1,234.5"; letters are dropped. */
export function formatBalanceInput(text: string): string {
  const cleaned = text.replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  const int = whole.replace(/^0+(?=\d)/, "");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rest.length ? `${grouped}.${rest.join("").slice(0, 2)}` : grouped;
}

/** The inline error for a balance, or null when it is fine. */
export function balanceError(text: string): string | null {
  if (!text.trim()) return "Enter a starting balance.";
  const n = parseBalance(text);
  if (n === null) return "Enter an amount in dollars, like 100,000.";
  if (n < PAPER_MIN) return "The starting balance is at least $1,000.";
  if (n > PAPER_MAX) return "The starting balance is at most $10,000,000.";
  return null;
}

/** A clean account name: trimmed, at most 40 characters; the default when empty. */
export function paperName(text: string | null | undefined): string {
  const s = (text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || PAPER_DEFAULT_NAME;
}

/** The paper account as stored: cash and total are the balance, no positions. Null when the balance is out of range. */
export function paperAccount(balance: number, name: string | null | undefined, now = Date.now()): PortfolioAccount | null {
  if (!Number.isFinite(balance) || balance < PAPER_MIN || balance > PAPER_MAX) return null;
  const amount = Math.round(balance * 100) / 100;
  return {
    id: PAPER_ACCOUNT_ID,
    source: "paper",
    name: paperName(name),
    institution: null,
    numberLast4: null,
    currency: PAPER_CURRENCY,
    totalValue: amount,
    cash: amount,
    buyingPower: amount,
    holdingsUnavailable: false,
    asOf: new Date(now).toISOString(),
  };
}

/** "Paper account created · $100,000". */
export function paperCreatedText(balance: number): string {
  return `Paper account created · $${Math.round(balance).toLocaleString("en-US")}`;
}

/** Pure: the accounts with the paper account put in (replacing any earlier one) or taken out (null). */
export function withPaper<T extends { id: string }>(accounts: readonly T[], paper: T | null): T[] {
  const rest = accounts.filter((a) => a.id !== PAPER_ACCOUNT_ID);
  return paper ? [...rest, paper] : rest;
}
