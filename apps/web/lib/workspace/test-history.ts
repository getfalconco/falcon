import type { PortfolioAccount, PortfolioPosition } from "../portfolio-holdings";
import { snapshotOf, type HoldingsSnapshot } from "./equity";
import { seededRandom } from "./test-portfolio";

/**
 * Development only: an in-memory holdings history for the preview, so the
 * Equity chart has real-looking snapshots without a database. Pure; nothing
 * stored. Prices come from the market like any member's.
 *
 *   ⌘P portfolio  connected 30 days before `createdAt`; about 12 days before,
 *                 a position was added (cash paid for it at its cost); about
 *                 5 days before, part of another was trimmed, when the cash
 *                 allows. The last snapshot is the portfolio as it is now.
 *   &sizes=1      the dev fixture, connected 2 days before `createdAt`.
 */

const DAY = 86_400_000;

type State = { accounts: PortfolioAccount[]; positions: PortfolioPosition[] };

/** Pure: the ⌘P portfolio's snapshots for a seed, oldest first, ending with `accounts` / `positions` as they are. */
export function testHistory(seed: number, accounts: readonly PortfolioAccount[], positions: readonly PortfolioPosition[], createdAt: number): HoldingsSnapshot[] {
  const rng = seededRandom(seed ^ 0x5eed);
  const now: State = { accounts: accounts.map((a) => ({ ...a })), positions: positions.map((p) => ({ ...p })) };
  const cost = (p: PortfolioPosition, qty: number) => qty * (p.avgCost ?? p.price ?? 0);
  const withCash = (st: State, accountId: string, delta: number): State => ({ ...st, accounts: st.accounts.map((a) => (a.id === accountId && a.cash !== null ? { ...a, cash: a.cash + delta } : a)) });
  const stocks = now.positions.filter((p) => p.kind === "stock" && p.quantity !== null && p.quantity > 0);
  const start = createdAt - 30 * DAY;
  const addAt = createdAt - Math.round((11 + rng() * 2) * DAY);
  const trimAt = createdAt - Math.round((4 + rng() * 2) * DAY);

  // Before the trim: one stock 30% larger, and the cash its sale brought not yet there (only when the cash covers it).
  const trimmed = stocks.length > 1 ? stocks[Math.floor(rng() * stocks.length)]! : null;
  let beforeTrim: State | null = null;
  if (trimmed) {
    const extra = Math.max(1, Math.round(trimmed.quantity! * 0.3));
    const proceeds = cost(trimmed, extra);
    const cashNow = now.accounts.find((a) => a.id === trimmed.accountId)?.cash ?? null;
    if (cashNow !== null && cashNow - proceeds >= 0) {
      const st = withCash(now, trimmed.accountId, -proceeds);
      beforeTrim = { ...st, positions: st.positions.map((p) => (p.symbol === trimmed.symbol && p.kind === trimmed.kind ? { ...p, quantity: p.quantity! + extra } : p)) };
    }
  }
  const midway = beforeTrim ?? now;

  // Before the add: that stock not held, and the cash paid for it still there.
  const added = stocks.find((p) => p.symbol !== trimmed?.symbol) ?? null;
  const out: HoldingsSnapshot[] = [];
  if (added) {
    const st = withCash(midway, added.accountId, cost(added, added.quantity!));
    out.push({ at: start, source: "broker", ...snapshotOf(st.accounts, st.positions.filter((p) => !(p.symbol === added.symbol && p.kind === added.kind))) });
    out.push({ at: addAt, source: "broker", ...snapshotOf(midway.accounts, midway.positions) });
  } else out.push({ at: start, source: "broker", ...snapshotOf(midway.accounts, midway.positions) });
  if (beforeTrim) out.push({ at: trimAt, source: "broker", ...snapshotOf(now.accounts, now.positions) });
  return out;
}

/** Pure: the dev fixture's history: one snapshot, connected 2 days before `createdAt`. */
export function fixtureHistory(accounts: readonly PortfolioAccount[], positions: readonly PortfolioPosition[], createdAt: number): HoldingsSnapshot[] {
  return [{ at: createdAt - 2 * DAY, source: "broker", ...snapshotOf(accounts, positions) }];
}
