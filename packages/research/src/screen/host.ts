import fs from "node:fs";
import path from "node:path";
import { getTrackerEngine } from "../tracker/index.js";
import {
  ScreenConfigStore,
  ScreenFindingsStore,
  ScreenMessageStore,
  activeFindings,
  computeHookKeys,
  decideScan,
  endedFindings,
  engineTrackerSource,
  gatherScreenInputs,
  runScreenScan,
  selectEmissions,
  type ScreenConfig,
  type ScreenHookKeys,
  type ScreenScan,
  type ScreenScanTrigger,
  type TapeStructureMessage,
} from "./index.js";
import { RiskAccountStore } from "../risk/index.js";
import type { ScreenFindingsPayload, ScreenStatus } from "./host-types.js";

/**
 * Screen host — the daily batch around the pure engine. Reads the live
 * Tracker engine (bars, detector state, messages, config), runs the scan for
 * the last completed session when the close-run fingerprint moves (same
 * polling hook as Risk — the Tracker emits no close-run event), persists the
 * findings and broadcasts the scan to the renderer. Read-only towards every
 * other engine; no LLM, no network, nothing into the pipeline.
 */
/**
 * Where a fresh screen result is pushed. The desktop sends it to open
 * windows over IPC; the engine service has nobody to tell, and the panel asks
 * for it instead. Injected so the host knows neither.
 */
export type ScreenNotifier = (channel: string, payload: unknown) => void;
let screenNotifier: ScreenNotifier | null = null;
export function setScreenNotifier(notify: ScreenNotifier): void {
  screenNotifier = notify;
}

export class ScreenHost {
  readonly configStore = new ScreenConfigStore();
  readonly findingsStore: ScreenFindingsStore;
  readonly messageStore: ScreenMessageStore;
  config: ScreenConfig;

  private pollTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private keys: ScreenHookKeys | null = null;
  private running: Promise<ScreenScan | null> | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private lastR2Floor: number | null = null;
  private lastEmit: { session: string; at: string; emitted: number; eligible: number; capped: number } | null = null;
  private started = false;

  constructor() {
    this.config = this.configStore.load();
    this.findingsStore = new ScreenFindingsStore(this.configStore.dataDir);
    this.messageStore = new ScreenMessageStore(this.configStore.dataDir);
    this.watchlist = this.readWatchlist();
  }

  /**
   * S1: the emit gate needs the user's proximity. Held comes from the paper
   * account in main; the watchlist lives in the renderer, so it is pushed and
   * persisted here — a close-run scan must know it without a panel open.
   */
  private watchlist: string[] = [];

  private get watchlistFile(): string {
    return path.join(this.configStore.dataDir, "watchlist.json");
  }

  private readWatchlist(): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.watchlistFile, "utf8")) as { tickers?: unknown };
      return Array.isArray(parsed.tickers) ? parsed.tickers.filter((t): t is string => typeof t === "string") : [];
    } catch {
      return [];
    }
  }

  setWatchlist(tickers: string[]): void {
    const next = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].sort();
    if (next.join(",") === this.watchlist.join(",")) return;
    this.watchlist = next;
    try {
      fs.mkdirSync(this.configStore.dataDir, { recursive: true });
      fs.writeFileSync(this.watchlistFile, JSON.stringify({ tickers: next }, null, 1), "utf8");
    } catch (err) {
      this.lastError = `watchlist: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Tickers the emit gate treats as proximate: paper positions + watchlist. */
  private proximity(): { held: string[]; watchlist: string[] } {
    let held: string[] = [];
    try {
      held = new RiskAccountStore().load()?.positions.filter((p) => Math.abs(p.shares) > 1e-9).map((p) => p.ticker.toUpperCase()) ?? [];
    } catch {
      held = [];
    }
    return { held, watchlist: this.watchlist };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** First poll once the Tracker has had a moment to load state, then poll the close-run fingerprint. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.poll("startup");
      this.pollTimer = setInterval(() => this.poll("close_run"), this.config.pollIntervalMs);
    }, 45_000);
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.startTimer = null;
    this.pollTimer = null;
    this.started = false;
  }

  // ---------------------------------------------------------------------------
  // Hook + scan
  // ---------------------------------------------------------------------------

  private poll(trigger: ScreenScanTrigger): void {
    const now = new Date();
    this.lastPollAt = now.toISOString();
    try {
      const gathered = gatherScreenInputs(engineTrackerSource(getTrackerEngine()));
      const next = computeHookKeys(now, gathered.closeDay);
      const decision = decideScan(this.keys, next, this.findingsStore.lastScan()?.session ?? null);
      this.keys = next;
      if (decision.scan) void this.scan(decision.session, trigger);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Run the scan for one completed session; concurrent requests share the in-flight run. */
  scan(session: string, trigger: ScreenScanTrigger): Promise<ScreenScan | null> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        this.config = this.configStore.load();
        const gathered = gatherScreenInputs(engineTrackerSource(getTrackerEngine()));
        this.lastR2Floor = gathered.r2Floor;
        const result = runScreenScan({
          session,
          now: new Date().toISOString(),
          trigger,
          inputs: gathered.inputs,
          benchBars: gathered.benchBars,
          r2Floor: gathered.r2Floor,
          config: this.config,
          state: this.findingsStore.load(),
          errors: gathered.errors,
        });
        // S1 emit gate: first sightings on proximate tickers leave the
        // building as tape_structure messages. Off by default; its failure
        // must never cost the scan, which is the product surface.
        let state = result.state;
        let emitted: TapeStructureMessage[] = [];
        try {
          const { held, watchlist } = this.proximity();
          const emit = selectEmissions({
            state,
            views: result.views,
            session,
            now: new Date().toISOString(),
            held,
            watchlist,
            config: this.config,
          });
          if (emit.messages.length > 0) {
            this.messageStore.append(emit.messages);
            state = emit.state;
            emitted = emit.messages;
            console.info(
              `[screen] emitted ${emit.messages.length} tape_structure message(s): ${emit.messages.map((m) => `${m.ticker}/${m.payload.pattern}`).join(", ")}` +
                (emit.capped > 0 ? ` · ${emit.capped} capped` : ""),
            );
          } else if (emit.eligible > 0) {
            console.info(`[screen] ${emit.eligible} eligible finding(s), ${emit.capped} capped by the daily cap`);
          }
          this.lastEmit = { session, at: new Date().toISOString(), emitted: emit.messages.length, eligible: emit.eligible, capped: emit.capped };
        } catch (err) {
          this.lastError = `emit: ${err instanceof Error ? err.message : String(err)}`;
          console.error("[screen] emit failed:", err);
        }
        void emitted;
        this.findingsStore.save(state);
        this.lastError = result.scan.errors.length > 0 ? result.scan.errors.join(" · ") : this.lastError;
        this.broadcast(result.scan);
        console.info(
          `[screen] ${trigger} scan ${session}: ${result.scan.tickers_scanned}/${result.scan.tickers_total} tickers · new ${result.scan.new} · continuing ${result.scan.continuing} · ended ${result.scan.ended} · active ${activeFindings(result.state, this.config).length} · degraded ${result.scan.degraded.length}${result.scan.errors.length ? ` · errors ${result.scan.errors.length}` : ""}`,
        );
        return result.scan;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error("[screen] scan failed:", err);
        return null;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Manual (panel button): re-run the last completed session now. */
  rescanNow(): Promise<ScreenScan | null> {
    const gathered = gatherScreenInputs(engineTrackerSource(getTrackerEngine()));
    const keys = computeHookKeys(new Date(), gathered.closeDay);
    this.keys = keys;
    return this.scan(keys.session, "manual");
  }

  private broadcast(scan: ScreenScan): void {
    screenNotifier?.("screen:scan", scan);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  findings(): ScreenFindingsPayload {
    this.config = this.configStore.load();
    const state = this.findingsStore.load();
    const priority = {
      quiet_accumulation: this.config.patterns.quiet_accumulation.priority,
      compression: this.config.patterns.compression.priority,
      independent_tape: this.config.patterns.independent_tape.priority,
      insider_divergence: this.config.patterns.insider_divergence.priority,
    };
    return {
      active: activeFindings(state, this.config),
      ended: endedFindings(state),
      last_scan: this.findingsStore.lastScan(),
      labels: { ...this.config.labels },
      priority,
    };
  }




  status(): ScreenStatus {
    this.config = this.configStore.load();
    const state = this.findingsStore.load();
    return {
      dataDir: this.configStore.dataDir,
      configFile: this.configStore.configFile,
      findingsFile: this.findingsStore.file,
      patterns: {
        quiet_accumulation: { ...this.config.patterns.quiet_accumulation },
        compression: { ...this.config.patterns.compression },
        independent_tape: { ...this.config.patterns.independent_tape },
        insider_divergence: { ...this.config.patterns.insider_divergence },
      },
      retentionDays: this.config.retentionDays,
      pollIntervalMs: this.config.pollIntervalMs,
      scanCount: state.scans.length,
      lastScan: this.findingsStore.lastScan(),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      keys: this.keys ? { session: this.keys.session, landed: this.keys.landed, total: this.keys.total } : null,
      r2Floor: this.lastR2Floor,
      emit: {
        enabled: this.config.emit.screenEmitEnabled,
        dailyEmitCap: this.config.emit.dailyEmitCap,
        emittedTotal: this.messageStore.count(),
        lastEmit: this.lastEmit,
        watchlistSize: this.watchlist.length,
      },
    };
  }
}

let host: ScreenHost | null = null;

export function getScreenHost(): ScreenHost {
  if (!host) host = new ScreenHost();
  return host;
}
