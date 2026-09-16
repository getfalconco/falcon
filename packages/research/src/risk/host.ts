import { BaseConfigStore } from "../base/index.js";
import { stableIncidentId } from "../analyst/index.js";
import { getTrackerEngine } from "../tracker/index.js";
import {
  RiskAccountStore,
  RiskConfigStore,
  RiskRecomputeScheduler,
  RiskSnapshotStore,
  computeRiskSnapshot,
  computeTriggerKeys,
  engineTrackerSource,
  gatherRiskInputs,
  heldTickersOf,
  type GatheredRisk,
  type RiskAccountInput,
  type RiskConfig,
  type RiskSnapshot,
  type RiskTriggerKeys,
  type RiskTriggerReason,
} from "./index.js";
import type { GraphIndex } from "../propagation/engine/graph.js";
import type { RiskAccountPush, RiskLatest, RiskStatus } from "./host-types.js";
import type { RiskHistoryItem } from "./types.js";
import { getClassifierHost } from "../classifier/host.js";
import { getPropagationHost } from "../propagation/engine/host.js";

/**
 * Risk Engine host — feeds `gatherRiskInputs` from the stores it is allowed
 * to read (the renderer's paper-account push, the live Tracker engine, the
 * Propagation host's graph index, Base config + Classifier verdicts for the
 * incident replay), runs `computeRiskSnapshot` on the §5 triggers, persists
 * every snapshot, and broadcasts the latest one to the renderer. Read-only
 * towards every other engine; no LLM, no network.
 */
/**
 * Where a fresh snapshot goes. The desktop pushes it to open windows over the
 * `risk:snapshot` IPC channel; the engine service has nobody to tell, and the
 * panel asks with `risk:latest` instead. Injected so the host knows neither.
 */
export type RiskNotifier = (payload: RiskLatest) => void;
let riskNotifier: RiskNotifier | null = null;
export function setRiskNotifier(notify: RiskNotifier): void {
  riskNotifier = notify;
}

export class RiskHost {
  readonly configStore = new RiskConfigStore();
  readonly accountStore: RiskAccountStore;
  readonly snapshotStore: RiskSnapshotStore;
  readonly baseConfigStore = new BaseConfigStore();
  config: RiskConfig;

  private account: RiskAccountInput | null;
  private scheduler: RiskRecomputeScheduler;
  private pollTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private started = false;

  constructor() {
    this.config = this.configStore.load();
    this.accountStore = new RiskAccountStore(this.configStore.dataDir);
    this.snapshotStore = new RiskSnapshotStore(this.configStore.dataDir, this.config.historyRetentionDays);
    this.account = this.accountStore.load();
    this.scheduler = new RiskRecomputeScheduler({
      debounceMs: this.config.debounceMs,
      recompute: (reasons) => this.recompute(reasons),
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** First compute once the Tracker has had a moment to load state, then poll the trigger keys. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.scheduler.request(["startup"]);
      this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    }, 30_000);
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.startTimer = null;
    this.pollTimer = null;
    this.scheduler.dispose();
    this.started = false;
  }

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------

  /**
   * The renderer's paper-account push (§5 position/cash change, debounced).
   * A `demo: true` push (Ctrl+P overlay) is computed at once, kept in memory
   * only and broadcast; it never touches account.json or the history. A
   * non-demo push clears the demo snapshot and re-broadcasts the real one.
   */
  setAccount(push: RiskAccountPush): void {
    if (push.demo) {
      this.computeDemo(this.toAccount(push));
      return;
    }
    const hadDemo = this.demoSnapshot !== null;
    this.demoSnapshot = null;
    const next = this.toAccount(push);
    const changed = accountFingerprint(this.account) !== accountFingerprint(next);
    this.account = next;
    this.accountStore.save(next);
    if (changed) this.scheduler.accountChanged();
    // Leaving demo: the real snapshot is unchanged — show it again right away.
    if (hadDemo) {
      const latest = this.snapshotStore.latest();
      if (latest) this.broadcast(latest);
    }
  }

  private demoSnapshot: RiskSnapshot | null = null;


  private computeDemo(account: RiskAccountInput): void {
    const now = new Date().toISOString();
    try {
      this.config = this.configStore.load();
      const baseConfig = this.baseConfigStore.load();
      const gathered = gatherRiskInputs(account, now, {
        tracker: engineTrackerSource(getTrackerEngine()),
        graph: this.graph(),
        baseConfig,
        verdictLookup: getClassifierHost().verdictLookup(baseConfig),
        makeIncidentId: stableIncidentId,
      });
      this.demoSnapshot = computeRiskSnapshot(gathered.inputs, this.config, { trigger: ["demo"] });
      this.broadcast(this.demoSnapshot, true);
      console.info(`[risk] demo: ${this.demoSnapshot.empty ? "empty" : `${this.demoSnapshot.score} ${this.demoSnapshot.band}`} · ${this.demoSnapshot.position_count} positions · degraded ${this.demoSnapshot.degraded.length}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error("[risk] demo compute failed:", err);
    }
  }

  private toAccount(push: RiskAccountPush): RiskAccountInput {
    return {
      account: "paper",
      cash: Number.isFinite(push.cash) ? push.cash : 0,
      positions: (push.positions ?? [])
        .filter((p) => p && typeof p.ticker === "string" && Number.isFinite(p.shares))
        .map((p) => ({
          ticker: p.ticker.trim().toUpperCase(),
          shares: p.shares,
          cost_usd: Number.isFinite(p.cost_usd) ? p.cost_usd : 0,
          market_value: typeof p.market_value === "number" && Number.isFinite(p.market_value) ? p.market_value : null,
        })),
      as_of: typeof push.as_of === "string" ? push.as_of : new Date().toISOString(),
    };
  }

  private graph(): GraphIndex | null {
    try {
      return getPropagationHost().graph();
    } catch {
      return null;
    }
  }

  private gather(nowIso: string): GatheredRisk {
    const baseConfig = this.baseConfigStore.load();
    const account = this.account ?? { account: "paper", cash: 0, positions: [], as_of: null };
    return gatherRiskInputs(account, nowIso, {
      tracker: engineTrackerSource(getTrackerEngine()),
      graph: this.graph(),
      baseConfig,
      verdictLookup: getClassifierHost().verdictLookup(baseConfig),
      makeIncidentId: stableIncidentId,
    });
  }

  private keysFrom(gathered: GatheredRisk): RiskTriggerKeys {
    return computeTriggerKeys({
      held: gathered.held,
      closeDay: gathered.closeDay,
      live: gathered.inputs.live,
      horizonSessions: this.config.event.earnings.horizonSessions,
    });
  }

  // ---------------------------------------------------------------------------
  // Recompute + triggers
  // ---------------------------------------------------------------------------

  private poll(): void {
    const now = new Date().toISOString();
    this.lastPollAt = now;
    try {
      this.scheduler.observe(this.keysFrom(this.gather(now)));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private recompute(reasons: RiskTriggerReason[]): void {
    const now = new Date().toISOString();
    try {
      this.config = this.configStore.load();
      const gathered = this.gather(now);
      const snapshot = computeRiskSnapshot(gathered.inputs, this.config, { trigger: reasons });
      this.snapshotStore.append(snapshot);
      this.scheduler.prime(this.keysFrom(gathered));
      this.lastError = gathered.errors.length > 0 ? gathered.errors.join(" · ") : null;
      this.broadcast(snapshot);
      console.info(
        `[risk] ${reasons.join("+")}: ${snapshot.empty ? "empty" : `${snapshot.score} ${snapshot.band} · driver ${snapshot.driver?.component}`} · ${snapshot.position_count} positions · degraded ${snapshot.degraded.length}${gathered.errors.length ? ` · errors ${gathered.errors.length}` : ""}`,
      );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error("[risk] recompute failed:", err);
    }
  }

  /** Manual (panel button). */
  recomputeNow(): Promise<void> {
    return this.scheduler.request(["manual"]);
  }

  private broadcast(snapshot: RiskSnapshot, demo = false): void {
    const payload: RiskLatest = { snapshot, riskCardEnabled: this.config.riskCardEnabled, demo };
    riskNotifier?.(payload);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  latest(): RiskLatest {
    // Re-read the flag from disk so a hand edit of config.json (the §9 flip)
    // reaches the card on its next fetch without a recompute or restart.
    this.config = this.configStore.load();
    if (this.demoSnapshot) return { snapshot: this.demoSnapshot, riskCardEnabled: this.config.riskCardEnabled, demo: true };
    return { snapshot: this.snapshotStore.latest(), riskCardEnabled: this.config.riskCardEnabled, demo: false };
  }

  history(limit = 200): RiskHistoryItem[] {
    return this.snapshotStore.history(limit);
  }

  setCardEnabled(enabled: boolean): void {
    this.config = { ...this.configStore.load(), riskCardEnabled: enabled };
    this.configStore.save(this.config);
    const latest = this.snapshotStore.latest();
    if (latest) this.broadcast(latest);
  }

  status(): RiskStatus {
    this.config = this.configStore.load();
    return {
      dataDir: this.configStore.dataDir,
      configFile: this.configStore.configFile,
      riskCardEnabled: this.config.riskCardEnabled,
      weights: { ...this.config.weights },
      debounceMs: this.config.debounceMs,
      pollIntervalMs: this.config.pollIntervalMs,
      historyRetentionDays: this.config.historyRetentionDays,
      snapshotCount: this.snapshotStore.count(),
      latestComputedAt: this.snapshotStore.latest()?.computed_at ?? null,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      account: {
        received: this.account !== null,
        as_of: this.account?.as_of ?? null,
        positions: heldTickersOf(this.account).length,
        cash: this.account?.cash ?? 0,
      },
      keys: this.scheduler.lastKeys,
    };
  }
}

function accountFingerprint(account: RiskAccountInput | null): string {
  if (!account) return "";
  const positions = [...account.positions]
    .filter((p) => Math.abs(p.shares) > 1e-9)
    .map((p) => `${p.ticker.toUpperCase()}:${p.shares}:${p.cost_usd}`)
    .sort()
    .join(",");
  return `${account.cash}|${positions}`;
}

let host: RiskHost | null = null;

export function getRiskHost(): RiskHost {
  if (!host) host = new RiskHost();
  return host;
}
