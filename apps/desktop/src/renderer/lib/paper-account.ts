/**
 * Falcon paper-trading account — the app's own simulated brokerage, created
 * from the dashboard's "Add asset" flow. Cash and positions live in
 * localStorage; there is no server side to this yet.
 */

import { getDemoSnapshot, isDemoMode } from "@/lib/demo-mode";

// Legacy (pre-multi-account) global keys — migrated to per-user keys on login.
const LEGACY_CASH_KEY = "falcon.paperBalance";
const LEGACY_POSITIONS_KEY = "falcon.paperPositions";
const LEGACY_SCOPED_SUFFIXES = ["networthHistory", "networthIntraday"] as const;
/**
 * Below this the position is float residue, not a holding: selling the whole
 * of something rarely divides exactly, and what is left is worth less than a
 * cent. Closing snaps to flat here, and a stored crumb is dropped on read.
 */
const DUST_USD = 0.01;

/** Fired on the window whenever cash or positions change in this renderer. */
const CHANGE_EVENT = "falcon:paper-account-changed";

/**
 * Paper data is namespaced per Supabase user so switching accounts never
 * shows (or overwrites) someone else's portfolio. Set from App.tsx whenever
 * the session changes, BEFORE the workspace mounts.
 */
let activeUserId: string | null = null;

/** Storage key scoped to the active user (legacy global key when signed out). */
export function paperScopeKey(suffix: string): string {
  return activeUserId ? `falcon.${activeUserId}.${suffix}` : `falcon.${suffix}`;
}

function cashKey(): string {
  return activeUserId ? `falcon.${activeUserId}.paperBalance` : LEGACY_CASH_KEY;
}

function positionsKey(): string {
  return activeUserId
    ? `falcon.${activeUserId}.paperPositions`
    : LEGACY_POSITIONS_KEY;
}

/**
 * Switches the active user. One-time migration: the first account to sign in
 * adopts any legacy (pre-multi-account) data, then the legacy keys are
 * removed so later accounts start clean.
 */
export function setActivePaperUser(userId: string | null): void {
  if (activeUserId === userId) return;
  activeUserId = userId;

  if (userId) {
    try {
      const legacyCash = localStorage.getItem(LEGACY_CASH_KEY);
      if (legacyCash != null && localStorage.getItem(cashKey()) == null) {
        localStorage.setItem(cashKey(), legacyCash);
        const legacyPositions = localStorage.getItem(LEGACY_POSITIONS_KEY);
        if (legacyPositions != null) {
          localStorage.setItem(positionsKey(), legacyPositions);
        }
        for (const suffix of LEGACY_SCOPED_SUFFIXES) {
          const value = localStorage.getItem(`falcon.${suffix}`);
          if (value != null) localStorage.setItem(paperScopeKey(suffix), value);
        }
      }
      // Always drop legacy keys once a real user is active — they are the
      // cross-account leak.
      localStorage.removeItem(LEGACY_CASH_KEY);
      localStorage.removeItem(LEGACY_POSITIONS_KEY);
      for (const suffix of LEGACY_SCOPED_SUFFIXES) {
        localStorage.removeItem(`falcon.${suffix}`);
      }
    } catch {
      /* non-fatal */
    }
  }

  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Seeds this user's local account from the cloud copy (no-op overwrite guard
 * is the caller's job — see portfolio-sync). */
export function seedPaperAccount(account: PaperAccount): void {
  persist(account);
}

export type PaperPosition = {
  symbol: string;
  /** Signed: positive is a long position, negative is a short. */
  shares: number;
  /**
   * Signed cash basis: positive is cash paid for a long, negative is the
   * proceeds credited when a short was opened. Keeping it signed means
   * `cash + Σ costUsd` is unchanged by opening a position, and
   * `Σ shares × price` marks both directions to market with no special cases.
   */
  costUsd: number;
};

export type PaperAccount = {
  cash: number;
  positions: Record<string, PaperPosition>;
};

/**
 * `buy` / `sell` open and close longs; `short` / `cover` open and close shorts.
 * An account holds one direction per symbol at a time.
 */
export type PaperTradeSide = "buy" | "sell" | "short" | "cover";

export type PaperTradeResult =
  | { ok: true; account: PaperAccount; side: PaperTradeSide; shares: number; amountUsd: number }
  | { ok: false; error: string };

function readCash(): number {
  try {
    const raw = localStorage.getItem(cashKey());
    if (raw == null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function readPositions(): Record<string, PaperPosition> {
  try {
    const raw = localStorage.getItem(positionsKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};

    const positions: Record<string, PaperPosition> = {};
    for (const [symbol, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<PaperPosition> | null;
      const shares = Number(entry?.shares);
      const costUsd = Number(entry?.costUsd);
      // Negative share counts are shorts; only a flat position is dropped.
      // Crumbs left by an older close are dropped too: no live price here, so
      // the test is the cost basis — a holding that cost under a cent is none.
      if (!Number.isFinite(shares) || Math.abs(shares) <= 1e-9) continue;
      if (Number.isFinite(costUsd) && Math.abs(costUsd) < DUST_USD) continue;
      positions[symbol] = {
        symbol,
        shares,
        costUsd: Number.isFinite(costUsd) ? costUsd : 0,
      };
    }
    return positions;
  } catch {
    return {};
  }
}

/** True once the user has created a Falcon paper account (ignores demo mode). */
export function hasRealPaperAccount(): boolean {
  try {
    return localStorage.getItem(cashKey()) != null;
  } catch {
    return false;
  }
}

/** True once the user has created a Falcon paper account — or demo mode is on. */
export function hasPaperAccount(): boolean {
  return isDemoMode() || hasRealPaperAccount();
}

/** The persisted account, never the demo overlay — for cloud sync only. */
export function readRealPaperAccount(): PaperAccount {
  return { cash: readCash(), positions: readPositions() };
}

/** What the UI should show: the demo portfolio while Ctrl+P is on, else real. */
export function readPaperAccount(): PaperAccount {
  const demo = getDemoSnapshot();
  return demo ? demo.account : readRealPaperAccount();
}

export function positionFor(account: PaperAccount, symbol: string): PaperPosition | null {
  return account.positions[symbol.trim().toUpperCase()] ?? null;
}

function persist(account: PaperAccount): void {
  try {
    localStorage.setItem(cashKey(), String(account.cash));
    localStorage.setItem(positionsKey(), JSON.stringify(account.positions));
    // Stamp every local write so cloud sync can tell which copy is fresher.
    localStorage.setItem(paperScopeKey("paperUpdatedAt"), String(Date.now()));
  } catch {
    /* non-fatal — the account just won't survive a restart */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** When this device last wrote the account, or null if it never has. */
export function readPaperUpdatedAt(): number | null {
  try {
    const raw = Number(localStorage.getItem(paperScopeKey("paperUpdatedAt")));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Creates (or resets) the paper account with a starting cash balance.
 * A new account starts a fresh trajectory: the recorded net-worth history
 * and today's intraday buffer are wiped along with the positions.
 */
export function createPaperAccount(startingCash: number): PaperAccount {
  try {
    localStorage.removeItem(paperScopeKey("networthHistory"));
    localStorage.removeItem(paperScopeKey("networthIntraday"));
  } catch {
    /* non-fatal */
  }
  const account: PaperAccount = { cash: Math.max(0, startingCash), positions: {} };
  persist(account);
  return account;
}

/** Direction of an open position — `flat` when there isn't one. */
export type PaperPositionSide = "flat" | "long" | "short";

export function positionSide(position: PaperPosition | null): PaperPositionSide {
  if (!position || Math.abs(position.shares) <= 1e-9) return "flat";
  return position.shares > 0 ? "long" : "short";
}

/**
 * Cash that isn't already pledged against an open short. Shorting credits the
 * proceeds to cash, so those dollars are locked as collateral instead of
 * counting as buying power — otherwise a short could fund itself forever.
 * Collateral is held at the entry notional (no margin calls in paper trading).
 */
export function paperBuyingPower(account: PaperAccount): number {
  const locked = Object.values(account.positions).reduce(
    (sum, position) => (position.shares < 0 ? sum + Math.abs(position.costUsd) : sum),
    0,
  );
  return account.cash - locked;
}

/**
 * Trades `amountUsd` worth of `symbol` at `price`. Fractional shares are
 * allowed, so a dollar amount always maps cleanly onto a position.
 *
 * `buy`/`short` open or add to a position; `sell`/`cover` close one and are
 * capped at the position's current market value, so "sell everything" is just
 * an amount larger than the position.
 */
export function executePaperTrade(input: {
  side: PaperTradeSide;
  symbol: string;
  amountUsd: number;
  price: number;
}): PaperTradeResult {
  const { side, amountUsd, price } = input;
  const symbol = input.symbol.trim().toUpperCase();

  if (isDemoMode()) {
    return { ok: false, error: "Demo mode is on — press Ctrl+P to leave it before trading." };
  }
  if (!hasPaperAccount()) return { ok: false, error: "No Falcon paper account yet." };
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "No live price — try again in a moment." };
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, error: "Enter an amount first." };
  }

  const account = readPaperAccount();
  const existing = account.positions[symbol] ?? null;
  const held = existing?.shares ?? 0;
  const openSide = positionSide(existing);

  // One direction per symbol — flipping means closing what's open first.
  if (side === "buy" && openSide === "short") {
    return { ok: false, error: `Cover your ${symbol} short before going long.` };
  }
  if (side === "short" && openSide === "long") {
    return { ok: false, error: `Sell your ${symbol} position before shorting it.` };
  }
  if (side === "sell" && openSide !== "long") {
    return { ok: false, error: `No ${symbol} position to sell.` };
  }
  if (side === "cover" && openSide !== "short") {
    return { ok: false, error: `No ${symbol} short to cover.` };
  }

  // ---- opening / adding -------------------------------------------------
  if (side === "buy" || side === "short") {
    const buyingPower = paperBuyingPower(account);
    if (amountUsd > buyingPower) {
      return {
        ok: false,
        error: `Not enough buying power — $${Math.max(0, buyingPower).toFixed(2)} available.`,
      };
    }

    const direction = side === "buy" ? 1 : -1;
    const shares = amountUsd / price;
    const next: PaperAccount = {
      // A short credits the proceeds; a buy debits the cost.
      cash: account.cash - direction * amountUsd,
      positions: {
        ...account.positions,
        [symbol]: {
          symbol,
          shares: held + direction * shares,
          costUsd: (existing?.costUsd ?? 0) + direction * amountUsd,
        },
      },
    };
    persist(next);
    return { ok: true, account: next, side, shares, amountUsd };
  }

  // ---- closing ----------------------------------------------------------
  const openShares = Math.abs(held);
  const positionValue = openShares * price;
  // Closing slightly more than the position is worth just closes it out,
  // rather than failing on a cent of rounding.
  let traded = Math.min(amountUsd, positionValue);
  let closedShares = Math.min(traded / price, openShares);
  // A remainder worth less than a cent is closed with the rest, or the book
  // keeps a $0.00 row for ever.
  if ((openShares - closedShares) * price < DUST_USD) {
    closedShares = openShares;
    traded = positionValue;
  }
  const closedFraction = openShares > 0 ? closedShares / openShares : 1;
  const remaining = held - Math.sign(held) * closedShares;

  // Covering costs cash; a short that moved against you can cost more than the
  // proceeds it was opened with.
  if (side === "cover" && traded > account.cash) {
    return {
      ok: false,
      error: `Not enough cash to cover — $${account.cash.toFixed(2)} available.`,
    };
  }

  const positions = { ...account.positions };
  if (Math.abs(remaining) <= 1e-9) {
    delete positions[symbol];
  } else {
    positions[symbol] = {
      symbol,
      shares: remaining,
      costUsd: (existing?.costUsd ?? 0) * (1 - closedFraction),
    };
  }

  const next: PaperAccount = {
    cash: side === "sell" ? account.cash + traded : account.cash - traded,
    positions,
  };
  persist(next);
  return { ok: true, account: next, side, shares: closedShares, amountUsd: traded };
}

/** Subscribes to account changes from this window and from other renderers. */
export function subscribePaperAccount(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === cashKey() || event.key === positionsKey()) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
