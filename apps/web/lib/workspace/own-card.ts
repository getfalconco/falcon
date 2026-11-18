import { FUNNEL_TEST_MODE } from "../funnel-test-mode";
import { parseStored, sessionsKey } from "../desk/session-storage";
import type { PortfolioItem } from "./focus";

/**
 * The Dashboard's "Start with what you own" setup card and the demo
 * portfolio it can add.
 *
 * Tasks, each read from real state (nothing is counted that did not happen):
 *   1. holdings  Add your holdings: set, per person, only by a successful
 *                import through Falcon (a SnapTrade broker import that returned
 *                holdings, a screenshot read that added tickers) or by adding
 *                the demo portfolio. A non-empty portfolio does not count (the
 *                preview's sample list, tickers kept from the old hand-edited
 *                focus list). The flag keeps
 *                which sources added holdings, so "Clear demo" takes it away
 *                when the demo was the only one. There is no standing broker
 *                connection to check, because a SnapTrade import reads the
 *                holdings and revokes the grant at once
 *                (app/api/portfolio/broker/holdings).
 *   2. sighting  Open a Sighting: set once a Sighting is on screen in any
 *                workspace (Workspace marks it, per person, in this browser).
 *   3. ask       Ask Falcon AI a question: this workspace's stored Falcon AI
 *                sessions hold a message from the member. Sessions kept only
 *                on the account and not yet in this browser are not seen.
 *
 * The card shows on every visit to the Dashboard once the portfolio has loaded,
 * until every task is done. Closing it hides it for that visit only.
 *
 * "Look around first" now creates a paper account (a cash balance, no
 * positions; lib/paper-account.ts, OwnCard.tsx). The tickers-only demo below
 * is no longer offered; its marks are still read so an earlier demo can be
 * cleared with "Clear paper portfolio".
 *
 * The old demo portfolio is tickers only (no amounts, no account values) written
 * through the normal portfolio store, so it syncs like an import. Which tickers
 * came from the demo is remembered in this browser per workspace scope; the
 * Dashboard reads "Demo portfolio" while any of them is still in it, and
 * "Clear demo" removes those (tickers imported since stay). "Clear portfolio"
 * in Settings empties it and resets the holdings task (clearHoldingsAdded).
 *
 * In the development preview nothing here touches storage (the preview's
 * sample portfolio resets on every load, so a stored mark would label the sample
 * list wrongly); the marks live for the page visit only.
 */

/** Liquid, well-covered names that are all in the filing graph and the Sightings universe. */
export const DEMO_PORTFOLIO: readonly PortfolioItem[] = [
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corp" },
  { ticker: "NVDA", name: "NVIDIA Corp" },
  { ticker: "AMD", name: "Advanced Micro Devices" },
  { ticker: "TSM", name: "Taiwan Semiconductor Manufacturing" },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "GOOGL", name: "Alphabet Inc." },
];

/* -------------------------------------------------------------- tasks */

export type SetupTaskId = "holdings" | "sighting" | "ask";
export type SetupState = Record<SetupTaskId, boolean>;

export const SETUP_TASKS: readonly { id: SetupTaskId; label: string }[] = [
  { id: "holdings", label: "Add your holdings" },
  { id: "sighting", label: "Open a Sighting" },
  { id: "ask", label: "Ask Falcon AI a question" },
];

/** Pure: how many tasks are done and the first one that is not (null when all are). */
export function setupProgress(state: SetupState): { done: number; total: number; next: SetupTaskId | null } {
  // Steps count in order: a later step done early does not count until the ones before it are,
  // so the card never reads "2 of 3" while its first task is still open.
  const first = SETUP_TASKS.findIndex((t) => !state[t.id]);
  const done = first === -1 ? SETUP_TASKS.length : first;
  return { done, total: SETUP_TASKS.length, next: first === -1 ? null : SETUP_TASKS[first].id };
}

export type OwnCardInput = {
  /** False until the portfolio has come from memory, this browser or the account. */
  portfolioLoaded: boolean;
  dismissed: boolean;
  state: SetupState;
};

/** Pure: whether the setup card shows. */
export function ownCardVisible({ portfolioLoaded, dismissed, state }: OwnCardInput): boolean {
  // Back on every visit to the Dashboard until every task is done; "×" only hides it for this visit.
  return portfolioLoaded && !dismissed && setupProgress(state).next !== null;
}

/** Pure: whether stored Falcon AI sessions (the raw localStorage JSON) hold a message from the member. */
export function askedFalcon(raw: string | null | undefined): boolean {
  // A cheap test first: the list can be large, and most reads find nothing new.
  if (!raw || !raw.includes('"user"')) return false;
  return (parseStored(raw) ?? []).some((s) => s.messages.some((m) => m.role === "user"));
}

/* --------------------------------------------------------------- demo */

/** Pure: the demo tickers still in the portfolio; empty when the demo is gone (or never was). */
export function demoOnList(portfolio: readonly PortfolioItem[], demo: readonly string[] | null): string[] {
  if (!demo?.length) return [];
  const marked = new Set(demo);
  return portfolio.filter((f) => marked.has(f.ticker)).map((f) => f.ticker);
}

/** Pure: the portfolio with the demo added after what is there (no duplicates). */
export function withDemo(portfolio: readonly PortfolioItem[]): { items: PortfolioItem[]; added: string[] } {
  const have = new Set(portfolio.map((f) => f.ticker));
  const extra = DEMO_PORTFOLIO.filter((d) => !have.has(d.ticker));
  return { items: [...portfolio, ...extra], added: extra.map((d) => d.ticker) };
}

/** Pure: the portfolio without the demo's tickers. */
export function withoutDemo(portfolio: readonly PortfolioItem[], demo: readonly string[] | null): PortfolioItem[] {
  const marked = new Set(demo ?? []);
  return portfolio.filter((f) => !marked.has(f.ticker));
}

/** Pure: imported holdings merged after the current portfolio, tickers only, deduplicated. */
export function mergeHoldings(portfolio: readonly PortfolioItem[], holdings: readonly { ticker: string; name?: string | null }[]): PortfolioItem[] {
  const have = new Set(portfolio.map((f) => f.ticker));
  const out = [...portfolio];
  for (const h of holdings) {
    if (have.has(h.ticker)) continue;
    have.add(h.ticker);
    out.push({ ticker: h.ticker, name: h.name ?? "" });
  }
  return out;
}

/* ------------------------------------------------------------ storage */

const DISMISS_PREFIX = "falcon.own-card.v1";
const SIGHTING_PREFIX = "falcon.setup.sighting-opened.v1";
const DEMO_PREFIX = "falcon.demo-focus.v1";
const HOLDINGS_PREFIX = "falcon.setup.holdings-added.v1";

/** Values for the preview and funnel test mode, and the fallback when storage is blocked. */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

/** Called after any write here, so open views re-read (useSyncExternalStore). */
export function subscribeOwnCard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function canStore(scope: string): boolean {
  return !FUNNEL_TEST_MODE && typeof window !== "undefined" && scopeUser(scope) !== "preview";
}

function read(key: string, scope: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  if (!canStore(scope)) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, scope: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  if (canStore(scope)) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Blocked storage: this page visit still remembers it.
    }
  }
  for (const l of listeners) l();
}

/** The person behind a workspace scope (`<userId>` or `<userId>:<workspaceId>`). */
export function scopeUser(scope: string): string {
  return scope.split(":")[0];
}

/** Dismissal is per person, across their workspaces. */
export function readOwnCardDismissed(scope: string): boolean {
  const user = scopeUser(scope);
  return read(`${DISMISS_PREFIX}:${user}`, user) === "1";
}

export function writeOwnCardDismissed(scope: string, dismissed: boolean): void {
  const user = scopeUser(scope);
  write(`${DISMISS_PREFIX}:${user}`, user, dismissed ? "1" : null);
}

/** Per person: a Sighting has been on screen. */
export function readSightingOpened(scope: string): boolean {
  const user = scopeUser(scope);
  return read(`${SIGHTING_PREFIX}:${user}`, user) === "1";
}

export function markSightingOpened(scope: string): void {
  const user = scopeUser(scope);
  if (!readSightingOpened(user)) write(`${SIGHTING_PREFIX}:${user}`, user, "1");
}

/**
 * What added holdings through Falcon: an import that returned holdings, the
 * paper account the person created ("paper", lib/paper-account.ts), or the
 * old tickers-only demo ("demo", kept so earlier marks still read).
 */
export type HoldingsSource = "broker" | "screenshot" | "paper" | "demo";
const HOLDINGS_SOURCES: readonly HoldingsSource[] = ["broker", "screenshot", "paper", "demo"];

/** Pure: the sources in a stored holdings flag (comma-separated), known ones only, in a fixed order. */
export function parseHoldingsSources(raw: string | null | undefined): HoldingsSource[] {
  const have = new Set((raw ?? "").split(","));
  return HOLDINGS_SOURCES.filter((s) => have.has(s));
}

function writeHoldingsSources(user: string, sources: readonly HoldingsSource[]): void {
  const value = parseHoldingsSources(sources.join(",")).join(",");
  if (value === (read(`${HOLDINGS_PREFIX}:${user}`, user) ?? "")) return;
  write(`${HOLDINGS_PREFIX}:${user}`, user, value || null);
}

/** Per person: the sources that added holdings through Falcon. */
export function readHoldingsSources(scope: string): HoldingsSource[] {
  const user = scopeUser(scope);
  return parseHoldingsSources(read(`${HOLDINGS_PREFIX}:${user}`, user));
}

/** Per person: the "Add your holdings" task is done. */
export function readHoldingsAdded(scope: string): boolean {
  return readHoldingsSources(scope).length > 0;
}

/** Called where an import put holdings in the portfolio, or where the person added the demo. */
export function markHoldingsAdded(scope: string, source: HoldingsSource): void {
  writeHoldingsSources(scopeUser(scope), [...readHoldingsSources(scope), source]);
}

/** The demo went: the task stays done only if an import added holdings too. */
export function clearDemoHoldings(scope: string): void {
  writeHoldingsSources(
    scopeUser(scope),
    readHoldingsSources(scope).filter((s) => s !== "demo"),
  );
}

/** "Clear paper portfolio": the task stays done only if an import added holdings too (the old demo mark goes with it). */
export function clearPaperHoldings(scope: string): void {
  writeHoldingsSources(
    scopeUser(scope),
    readHoldingsSources(scope).filter((s) => s !== "paper" && s !== "demo"),
  );
}

/** The portfolio was cleared (Settings): the holdings task is open again, whatever added them. */
export function clearHoldingsAdded(scope: string): void {
  writeHoldingsSources(scopeUser(scope), []);
}

/** This workspace's stored Falcon AI sessions hold a question (lab/session-store.ts keeps them in localStorage). */
export function readAskedFalcon(scope: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return askedFalcon(localStorage.getItem(sessionsKey(scope)));
  } catch {
    return false;
  }
}

/** The tickers the demo added in this workspace, or null. */
export function readDemoTickers(scope: string): string[] | null {
  const raw = read(`${DEMO_PREFIX}:${scope}`, scope);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : null;
  } catch {
    return null;
  }
}

export function writeDemoTickers(scope: string, tickers: readonly string[] | null): void {
  write(`${DEMO_PREFIX}:${scope}`, scope, tickers?.length ? JSON.stringify(tickers) : null);
}
