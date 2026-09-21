import fs from "node:fs";
import path from "node:path";
import { getTrackerEngine } from "@meridian/research/tracker";
import { resolveDataRoot } from "../data-root";
import { callEngine, engineRemote } from "../engine/engine-client";
import { registerIpcHandler } from "../ipc-register";
import { ensureStep1Coverage } from "../research/register-step1-handlers";
import type {
  PortfolioCoverageEntry,
  PortfolioCoverageSnapshot,
  PortfolioSyncResult,
} from "../../shared/portfolio-coverage";

/**
 * Portfolio coverage service.
 *
 * Whenever the renderer reports the user's holdings, any symbol the system
 * does not yet know is brought into coverage automatically:
 *   1. Tracker — added to the universe and backfilled (price, news, filings,
 *      earnings), so detectors run on it from the next cycle.
 *   2. Relationship graph — a step1 extraction job is started if no cached
 *      result exists; on completion the shared graph (graph.json + Supabase)
 *      is refreshed, which is what propagation and the network map read.
 *
 * Work runs in the background; the IPC call returns immediately with what was
 * queued. A small ledger on disk makes it idempotent across restarts and keeps
 * a failed step1 job from being retried in a tight loop.
 */

const STEP1_RETRY_COOLDOWN_MS = 6 * 60 * 60_000;
const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;

function ledgerPath(): string {
  return path.join(resolveDataRoot(), "portfolio-coverage.json");
}

function loadLedger(): Record<string, PortfolioCoverageEntry> {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(), "utf8")) as Record<string, PortfolioCoverageEntry>;
  } catch {
    return {};
  }
}

function saveLedger(ledger: Record<string, PortfolioCoverageEntry>): void {
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

let ledger = loadLedger();
let lastSyncAt: string | null = null;
const inFlight = new Set<string>();
const pending = new Set<string>();
let draining = false;

function normalize(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) return [];
  const out = new Set<string>();
  for (const raw of symbols) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().toUpperCase();
    if (TICKER_RE.test(s) && s !== "SPY") out.add(s);
  }
  return [...out];
}

/**
 * Whether the tracker that actually answers the dashboard knows this name.
 * With an engine service configured, that tracker is the remote one: the
 * local engine is idle then, and adding a holding to it gave the card
 * nothing, because every quant it shows is fetched from the service. The
 * ledger stands in for a remote round trip here; coverOne asks the service
 * itself before adding.
 */
function needsTracker(symbol: string): boolean {
  if (engineRemote()) return ledger[symbol]?.trackerAddedAt == null;
  return getTrackerEngine().getTickerState(symbol) == null;
}

/** Add a name to whichever tracker the dashboard reads from. */
async function addToTracker(symbol: string): Promise<void> {
  if (!engineRemote()) {
    await getTrackerEngine().addTicker(symbol);
    return;
  }
  const known = await callEngine<{ ok: boolean }>("tracker:ticker-state", [symbol]);
  if (known.ok) return;
  const added = await callEngine<{ ok: boolean; error?: string }>("tracker:add-ticker", [symbol]);
  if (!added.ok) throw new Error(added.error ?? "engine refused the ticker");
}

function needsStep1(symbol: string, nowMs: number): boolean {
  const entry = ledger[symbol];
  const s = entry?.step1;
  if (!s) return true;
  if (s.status === "cached" || s.status === "done") return false;
  if (s.status === "started") return false; // in progress (or was, before a restart — re-checked below)
  // error: retry after the cooldown
  return nowMs - Date.parse(s.at) > STEP1_RETRY_COOLDOWN_MS;
}

async function coverOne(symbol: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const entry: PortfolioCoverageEntry = ledger[symbol] ?? {
    symbol,
    trackerAddedAt: null,
    step1: null,
    lastSeenAt: nowIso,
  };
  entry.lastSeenAt = nowIso;
  ledger[symbol] = entry;

  // 1. Tracker universe + backfill.
  if (needsTracker(symbol)) {
    try {
      entry.trackerAddedAt = nowIso;
      saveLedger(ledger);
      await addToTracker(symbol);
      console.info(
        `[portfolio] ${symbol} added to the ${engineRemote() ? "engine service's" : "local"} tracker (portfolio holding)`,
      );
    } catch (err) {
      console.warn(`[portfolio] ${symbol} tracker add failed:`, err instanceof Error ? err.message : err);
    }
  } else if (!entry.trackerAddedAt) {
    entry.trackerAddedAt = nowIso; // already tracked before we started keeping a ledger
  }

  // 2. Relationship graph (step1). A "started" entry left over from a previous
  //    process is stale — the job died with it — so re-check the cache.
  const stale = entry.step1?.status === "started" && !inFlight.has(symbol);
  if (needsStep1(symbol, Date.now()) || stale) {
    const outcome = await ensureStep1Coverage(symbol);
    entry.step1 = {
      status: outcome.status,
      at: new Date().toISOString(),
      jobId: outcome.status === "started" ? outcome.jobId : null,
      error: outcome.status === "error" ? outcome.error : null,
    };
    if (outcome.status === "started") {
      console.info(`[portfolio] ${symbol} step1 extraction started (job ${outcome.jobId})`);
    } else if (outcome.status === "error") {
      console.warn(`[portfolio] ${symbol} step1 failed: ${outcome.error}`);
    }
  }
  saveLedger(ledger);
}

/** Drain the pending set one symbol at a time (backfill + step1 are heavy). */
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.size > 0) {
      const symbol = [...pending][0];
      pending.delete(symbol);
      inFlight.add(symbol);
      try {
        await coverOne(symbol);
      } finally {
        inFlight.delete(symbol);
      }
    }
  } finally {
    draining = false;
  }
}

/** Entry point: reconcile the reported holdings against what is covered. */
export function syncPortfolioHoldings(symbolsRaw: unknown): PortfolioSyncResult {
  const symbols = normalize(symbolsRaw);
  lastSyncAt = new Date().toISOString();
  const queued: string[] = [];
  const covered: string[] = [];
  const nowMs = Date.now();

  for (const symbol of symbols) {
    const stale = ledger[symbol]?.step1?.status === "started" && !inFlight.has(symbol);
    if (needsTracker(symbol) || needsStep1(symbol, nowMs) || stale) {
      if (!inFlight.has(symbol)) pending.add(symbol);
      queued.push(symbol);
    } else {
      const entry = ledger[symbol];
      if (entry) entry.lastSeenAt = lastSyncAt;
      covered.push(symbol);
    }
  }
  if (covered.length > 0) saveLedger(ledger);
  if (pending.size > 0) {
    void drain().catch((err) => console.error("[portfolio] coverage drain failed:", err));
  }
  return { ok: true, queued, covered };
}

export function getPortfolioCoverage(): PortfolioCoverageSnapshot {
  return { entries: ledger, lastSyncAt, inFlight: [...inFlight, ...pending] };
}

export function registerPortfolioHandlers(): void {
  registerIpcHandler("portfolio:sync-holdings", (_event, symbols: unknown) => {
    try {
      return syncPortfolioHoldings(symbols);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("portfolio:coverage", () => {
    return { ok: true as const, coverage: getPortfolioCoverage() };
  });
}
