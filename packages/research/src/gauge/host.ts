import { BaseConfigStore } from "../base/index.js";
import { stableIncidentId } from "../analyst/index.js";
import { getTrackerEngine, nyYmd } from "../tracker/index.js";
import {
  GaugeConfigStore,
  GaugeCounters,
  GaugeMemo,
  GaugeSnapshotStore,
  engineTrackerSource,
  gatherGaugeInputs,
  gauge,
  memoKey,
  screenSourceFrom,
  type GaugeConfig,
  type GaugeContext,
  type GaugeReadout,
  type GaugeSurface,
} from "./index.js";
import { getScreenHost } from "../screen/host.js";
import type { GaugeReadoutRequest, GaugeReadoutResponse, GaugeStatusInfo } from "./host-types.js";
import { getClassifierHost } from "../classifier/host.js";

/**
 * Gauge host — compute-on-read (spec §7). No loop, no persistence beyond
 * config: a readout request gathers the ticker's inputs from the live Tracker
 * engine (quant, detectors, T5 ledger, r² floor from the Tracker config), the
 * Base replay for open incidents (context mode only) and computes the
 * checklist, and recognises the v2 setup on top of it (§2) using Screen's
 * active findings — read-only, one-way, Screen is never written to.
 *
 * A 60s memo per (ticker, context-hash) absorbs panel refreshes; a daily
 * counter by surface/state is kept in memory and logged on rollover. The one
 * thing the host persists is the §10 setup ledger: an append-only line per
 * (ticker, session, setup, state) so "what happened after we said COILED" has
 * data behind it in three months. Nothing reads it back into a readout.
 */
export class GaugeHost {
  readonly configStore = new GaugeConfigStore();
  readonly baseConfigStore = new BaseConfigStore();
  config: GaugeConfig;

  readonly snapshotStore: GaugeSnapshotStore;
  private readonly memo: GaugeMemo;
  private readonly counters: GaugeCounters;
  private lastError: string | null = null;
  private configLoadedAt = 0;
  private screenAvailable = false;
  private screenFindings = 0;

  constructor() {
    this.config = this.configStore.load();
    this.configLoadedAt = Date.now();
    this.memo = new GaugeMemo(this.config.memoTtlMs);
    this.counters = new GaugeCounters(nyYmd(new Date()));
    this.snapshotStore = new GaugeSnapshotStore(this.configStore.dataDir, this.config.snapshots.maxLines);
  }

  /** Config is re-read at most every 30s so threshold edits land without a restart. */
  private refreshConfig(force = false): void {
    const now = Date.now();
    if (!force && now - this.configLoadedAt < 30_000) return;
    try {
      this.config = this.configStore.load();
      this.memo.setTtl(this.config.memoTtlMs);
      this.configLoadedAt = now;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  reloadConfig(): void {
    this.refreshConfig(true);
    this.memo.clear();
  }

  readout(req: GaugeReadoutRequest): GaugeReadoutResponse {
    this.refreshConfig();
    const ticker = (req.ticker ?? "").trim().toUpperCase();
    if (!ticker) throw new Error("ticker required");
    const context: GaugeContext | null = req.context ?? null;
    const surface: GaugeSurface = req.surface ?? "other";
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const key = memoKey(ticker, context);

    if (!req.fresh) {
      const hit = this.memo.get(key, nowMs);
      if (hit) {
        this.count(surface, hit, true);
        return { readout: hit, errors: [], memo_hit: true };
      }
    }

    try {
      const engine = getTrackerEngine();
      const baseConfig = context ? this.baseConfigStore.load() : undefined;
      const gathered = gatherGaugeInputs(ticker, nowIso, {
        tracker: engineTrackerSource(engine),
        trackerConfig: engine.getConfig(),
        baseConfig,
        verdictLookup: baseConfig ? getClassifierHost().verdictLookup(baseConfig) : undefined,
        makeIncidentId: stableIncidentId,
        includeIncidents: context != null,
        screen: this.screenSource(),
        newsLookbackSessions: this.config.setups.newsLookbackSessions,
      });
      this.screenAvailable = gathered.inputs.screen_available;
      this.screenFindings = gathered.inputs.screen.length;
      const readout = gauge(gathered.inputs, this.config, context);
      this.memo.set(key, readout, nowMs);
      this.count(surface, readout, false);
      this.record(readout);
      this.lastError = null;
      return { readout, errors: gathered.errors, memo_hit: false };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.count(surface, null, false);
      throw err;
    }
  }

  /**
   * §4: Screen's active findings, structurally adapted so this host never
   * couples to the Screen engine's own types. A Screen that has never scanned
   * (or fails to load) simply narrows the setup pool.
   */
  private screenSource() {
    try {
      const host = getScreenHost();
      return screenSourceFrom(() => host.findings().active as never);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** §10 ledger. Standalone readouts only; the store dedupes per session. */
  private record(readout: GaugeReadout): void {
    if (!this.config.snapshots.enabled) return;
    try {
      const written = this.snapshotStore.record(readout);
      if (written) console.info(`[gauge] ${written.ticker} ${written.session}: ${written.setup} / ${written.state}${written.readable ? "" : " (residuals unreadable)"}`);
    } catch (err) {
      // The ledger is an observation, never a reason to fail a readout.
      console.warn("[gauge] snapshot failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private count(surface: GaugeSurface, readout: GaugeReadout | null, memoHit: boolean): void {
    const closed = this.counters.record(nyYmd(new Date()), surface, readout, memoHit);
    if (closed && closed.total > 0) {
      console.info(`[gauge] ${closed.day}: ${closed.total} readouts · by surface ${JSON.stringify(closed.by_surface)} · by state ${JSON.stringify(closed.by_state)} · memo hits ${closed.memo_hits}`);
    }
  }

  /** Tracked universe for the panel's ticker picker. */
  tickers(): string[] {
    try {
      return getTrackerEngine()
        .getStatus()
        .tickers.map((t) => t.ticker)
        .sort();
    } catch {
      return [];
    }
  }

  status(): GaugeStatusInfo {
    this.refreshConfig();
    let r2Floor = NaN;
    let tracked = 0;
    try {
      const engine = getTrackerEngine();
      r2Floor = engine.getConfig().thresholds.lowR2Fallback;
      tracked = engine.getStatus().tickers.length;
    } catch {
      /* tracker not up yet */
    }
    const th = this.config.thresholds;
    return {
      dataDir: this.configStore.dataDir,
      configFile: this.configStore.configFile,
      memoTtlMs: this.config.memoTtlMs,
      memoSize: this.memo.size,
      calibratingNaCount: this.config.calibratingNaCount,
      r2Floor,
      thresholds: {
        trend: { ...th.trend },
        regime: { ...th.regime },
        volume: { ...th.volume },
        stretch: { ...th.stretch },
        eventWall: { ...th.eventWall },
        freshness: { ...th.freshness },
      },
      trackedTickers: tracked,
      counters: this.counters.snapshot(),
      lastError: this.lastError,
      screenAvailable: this.screenAvailable,
      screenFindings: this.screenFindings,
      snapshots: {
        enabled: this.config.snapshots.enabled,
        file: this.snapshotStore.file,
        count: this.snapshotStore.count(),
        lastSession: this.snapshotStore.list(1)[0]?.session ?? null,
      },
      setupOrder: [...this.config.setups.order],
    };
  }
}

let host: GaugeHost | null = null;

export function getGaugeHost(): GaugeHost {
  if (!host) host = new GaugeHost();
  return host;
}
