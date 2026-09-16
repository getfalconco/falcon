import fs from "node:fs";
import path from "node:path";
import {
  BaseConfigStore,
  addDueAt,
  consumeBudget,
  earningsCalendarFromMessages,
  etDayOf,
  mergeCalendars,
  replayBase,
  withPreEarningsPreviewCap,
  type BaseConfig,
  type BudgetLedger,
  type EarningsCalendar,
  type VerdictLookup,
} from "../../base/index.js";
import { stableIncidentId } from "../../analyst/index.js";
import { fetchIntradaySeries, getTrackerEngine } from "../../tracker/index.js";
import type { TrackerMessage } from "../../tracker/types.js";
// Direct module imports, not the barrel: the barrel re-exports this host.
import { FileBackend, PropagationRunStore, type RunListOptions } from "./store.js";
import { PropagationConfigStore } from "./store.js";
import type { PropagationConfig } from "./config.js";
import { PropagationService, estimateSpendUsd, percentile } from "./service.js";
import { anthropicConfigured, anthropicModelCaller } from "./anthropic.js";
import { absorptionCurve, type AbsorptionPoint, type TargetQuantSnapshot } from "./pricing.js";
import {
  buildPropagationRequests,
  orderByPriority,
  propagationBudgetRemaining,
  type PropagationRequest,
} from "./requests.js";
import { loadGraphIndexSync, type GraphIndex } from "./graph.js";
import { repriceRun } from "./reprice.js";
import type { PropagationRun } from "./types.js";
import type { QuantSource } from "./stage1.js";
import { fastPathTrigger } from "./fast-path.js";
import { classifyLane, recordLane, summarizeLanes, type PropagationLane } from "./lane.js";
import { runPricedIn, targetPricedIn, targetProgress, runAbsorption } from "./progress.js";
import { isResolved, pairOutcome, type PairHistoryEvent, type PropagationPairHistory } from "./pair.js";
import type {
  PropagationRunCycleSummary,
  PropagationRunListItem,
  PropagationStatus,
} from "./host-types.js";

/** Same candidates graph-refresh.ts writes to, resolved synchronously. */
export function resolveGraphPath(): string {
  const fromEnv = process.env.FALCON_GRAPH_PATH?.trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    path.resolve(process.cwd(), "data", "graph.json"),
    path.resolve(process.cwd(), "..", "..", "data", "graph.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return graphPathFallback?.() ?? candidates[0];
}

/**
 * Where to look for the graph when neither FALCON_GRAPH_PATH nor a checked-in
 * copy is present. The desktop registers Electron’s userData dir here; the
 * engine service leaves it unset and relies on the env var its image sets.
 */
let graphPathFallback: (() => string) | null = null;
export function setGraphPathFallback(resolve: () => string): void {
  graphPathFallback = resolve;
}

/**
 * Propagation host — the main-process owner of the Propagation service.
 *
 * Phase A (spec §10): on a 15-minute cycle — or on demand from the Shift+P
 * panel — it replays Base over Tracker's recorded stream (as the Analyst and
 * Classifier hosts do), turns every qualifying incident into a propagation
 * request (routed rows always; Classifier candidates at P2+), runs stage-1
 * for all of them and stage-2 for as many as Base's daily budget allows, and
 * persists the runs. Runs are visible only in Shift+P while
 * `propagationSurfacingEnabled` is false.
 *
 * Stage-1 has no budget and no key requirement, so the loop can run without
 * an Anthropic key (runs ship `stage1_only`). It is OFF by default
 * (`PropagationConfig.enabled`) like the other engines.
 */
/**
 * Where a produced run goes besides the local store, and where runs other
 * installs produced come from. The desktop implements this over Supabase with
 * the signed-in user’s JWT; the engine service implements it with the
 * service-role key. The host itself knows neither.
 */
export type RemoteRuns = {
  pull(): Promise<PropagationRun[] | null>;
  push(runs: PropagationRun[], source: string): void;
};

/**
 * How the host tells whoever is watching that something changed. In the
 * desktop this fans out to the renderer over IPC; in the engine service it is
 * the SSE stream, or nothing at all.
 */
export type HostNotifier = {
  runProduced(item: PropagationRunListItem): void;
  runsChanged(): void;
};

/** Base’s verdict lookup, injected so the host does not reach for a singleton. */
export type VerdictLookupSource = { verdictLookup(config: BaseConfig): VerdictLookup };

export type PropagationHostDeps = {
  remote?: RemoteRuns | null;
  notify?: HostNotifier | null;
  classifier?: VerdictLookupSource | null;
};

/**
 * The loop switch, as an environment variable.
 *
 * On the desktop the Phase A loop is toggled from the Shift+P panel and the
 * answer is kept in the config file. A headless service has no panel, and its
 * config file arrives baked into an image — so whether the always-on engine
 * produces runs would be decided by whatever happened to be committed. This
 * lets the deployment say it: set at boot, it wins over the stored value.
 * Boot only. `setEnabled()` still works at runtime and still writes the file,
 * and nothing here reaches back to undo it — a loop turned on from the panel
 * stays on until the process restarts, when the deployment gets its say again.
 */
export function enabledFromEnv(): boolean | null {
  const raw = process.env.FALCON_PROPAGATION_ENABLED?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  console.warn(`[propagation] FALCON_PROPAGATION_ENABLED="${raw}" is not a boolean — ignoring`);
  return null;
}

export class PropagationHost {
  readonly configStore = new PropagationConfigStore();
  readonly baseConfigStore = new BaseConfigStore();
  config: PropagationConfig;
  readonly runStore: PropagationRunStore;
  readonly service: PropagationService;
  readonly cycleIntervalMs = 15 * 60_000;
  /**
   * Targets repriced per cycle. A snapshot is two live quote fetches (the
   * name and the benchmark) behind a 60s cache, sequential, with no backoff
   * on the upstream — so this is a real cost, not a loop over memory. The
   * cap is a ceiling on a bad day rather than a normal limit: only targets
   * inside the pricing horizon are ever asked, and a run leaves that window
   * for good after one pass, so the steady state is a handful per cycle.
   */
  readonly repriceLimit = 60;
  /** How often the sweep runs on its own, with the Phase A loop down. */
  readonly repriceIntervalMs = 5 * 60_000;
  private repriceTimer: NodeJS.Timeout | null = null;
  /** The fast lane: stage-1 the moment a deterministic trigger lands. */
  private readonly fastService: PropagationService;
  private readonly fastTimers = new Map<string, NodeJS.Timeout>();
  /** An 8-K lands with its exhibits; wait for the burst to settle. */
  readonly fastDebounceMs = 10_000;
  private watching = false;

  private budget: BudgetLedger | null;
  private timer: NodeJS.Timeout | null = null;
  private nextCycleAt: string | null = null;
  private running = false;
  private lastRun: PropagationRunCycleSummary | null = null;
  private graphCache: { index: GraphIndex; mtimeMs: number; path: string } | null = null;

  private readonly remote: RemoteRuns | null;
  private readonly notify: HostNotifier;
  private readonly classifierSource: VerdictLookupSource | null;

  constructor(deps: PropagationHostDeps = {}) {
    this.remote = deps.remote ?? null;
    this.notify = deps.notify ?? { runProduced: () => {}, runsChanged: () => {} };
    this.classifierSource = deps.classifier ?? null;
    this.config = this.configStore.load();
    const fromEnv = enabledFromEnv();
    if (fromEnv !== null && fromEnv !== this.config.enabled) {
      console.info(`[propagation] loop ${fromEnv ? "on" : "off"} by FALCON_PROPAGATION_ENABLED (stored: ${this.config.enabled})`);
      this.config = { ...this.config, enabled: fromEnv };
    }
    this.runStore = new PropagationRunStore(new FileBackend(this.configStore.dataDir));
    this.service = new PropagationService({
      config: this.config,
      store: this.runStore,
      graph: () => this.graph(),
      quant: this.quantSource(),
      callModel: anthropicConfigured() ? anthropicModelCaller : null,
      // Every run this install produces goes to the shared server copy, and
      // with it whatever it superseded — that flag is the one thing another
      // install must not learn late.
      onRun: (outcome) => {
        if (outcome.source === "cache" || outcome.source === "skipped" || outcome.source === "dropped") return;
        const changed = [outcome.run, ...outcome.superseded.map((id) => this.runStore.get(id))].filter(
          (r): r is PropagationRun => r != null,
        );
        this.remote?.push(changed, "host");
      },
    });
    // The fast lane shares the store (so the cache and supersession still
    // apply) but prices against the minute series and never calls the model:
    // a ripple in seconds beats a refined one in two minutes.
    this.fastService = new PropagationService({
      config: this.config,
      store: this.runStore,
      graph: () => this.graph(),
      quant: this.quantSource(true),
      callModel: null,
    });
    this.budget = this.readBudget();
  }

  /**
   * Record which lane produced a run (§S3b).
   *
   * Called at BOTH production sites, because the whole point is the comparison:
   * a run that qualified for the fast path and came out of the 15-minute cycle
   * is a missed lane, and until it is counted it looks exactly like a run that
   * was simply slow. Half of every eligible filing was taking the slow lane
   * with nothing recording it.
   */
  private recordLaneFor(run: PropagationRun, lane: PropagationLane): void {
    const verdict = classifyLane(run, lane);
    this.runStore.updateMetrics((m) => {
      Object.assign(m, recordLane(m, verdict));
    });
    if (verdict.missed) {
      console.warn(
        `[propagation] fast path MISSED for ${run.root_ticker} (${run.event.source}): ` +
          `${Math.round((verdict.event_to_run_ms ?? 0) / 60_000)} min from event to run — ` +
          "this trigger qualified for the fast lane and took the cycle.",
      );
    }
  }

  /** Subscribes the host to the Tracker's emit hook. Safe to call twice. */
  watchTracker(): void {
    if (this.watching) return;
    this.watching = true;
    getTrackerEngine().onMessage((message: TrackerMessage) => {
      try {
        this.onTrackerMessage(message);
      } catch (err) {
        console.error("[propagation] fast path dispatch failed:", err);
      }
    });
    console.info("[propagation] fast path armed (mapped 8-K + gap_event)");
  }

  /**
   * A trigger landed. Debounce per ticker — an 8-K arrives with its exhibits
   * and a gap is often followed by more of the same minute — then run stage-1
   * for that ticker alone.
   */
  private onTrackerMessage(message: TrackerMessage): void {
    const trigger = fastPathTrigger(message, this.baseConfig().routing.mapped8kItemCodes);
    if (!trigger) return;
    const ticker = message.ticker.toUpperCase();
    const pending = this.fastTimers.get(ticker);
    if (pending) clearTimeout(pending);
    this.fastTimers.set(
      ticker,
      setTimeout(() => {
        this.fastTimers.delete(ticker);
        void this.runFastPath(ticker, message).catch((err) => {
          console.error(`[propagation] fast path ${ticker} failed:`, err);
        });
      }, this.fastDebounceMs),
    );
  }

  /**
   * Stage-1 for one ticker, now. Reuses the normal replay so the incident id
   * and the deterministic request id are the ones the 15-minute cycle would
   * have produced — it will see `already_produced` and never duplicate, and
   * stage-2 refines the same run later with `update: true`.
   */
  async runFastPath(ticker: string, trigger?: TrackerMessage): Promise<PropagationRun | null> {
    const started = Date.now();
    const now = new Date().toISOString();
    const baseConfig = this.baseConfig();
    const engine = getTrackerEngine();
    const messages = engine.listMessages({ ticker, limit: 300 });
    if (messages.length === 0) return null;
    const rawLookup = this.verdictLookup(baseConfig);
    const calendar: EarningsCalendar = new Map();
    const state = engine.getTickerState(ticker);
    for (const e of state?.scheduledEarnings ?? []) if (e.confirmed) addDueAt(calendar, ticker, e.dueAt);
    const replay = replayBase(messages, {
      config: baseConfig,
      now,
      verdictLookup: rawLookup,
      earningsCalendar: calendar,
      makeIncidentId: stableIncidentId,
    });
    const verdictLookup = withPreEarningsPreviewCap(
      rawLookup,
      mergeCalendars(earningsCalendarFromMessages(messages), calendar),
      baseConfig,
    );
    const built = buildPropagationRequests(replay.incidents, {
      verdictLookup,
      latestRun: (id) => this.runStore.latestFor(id),
      now,
      baseConfig,
      config: this.config,
    });
    // The incident carrying the trigger, else the highest-priority one.
    const wanted = trigger
      ? built.requests.find((r) => r.incident.messages.some((m) => m.id === trigger.id))
      : null;
    const request = wanted ?? orderByPriority(built.requests)[0];
    if (!request) return null;

    const outcome = await this.fastService.run(request, {
      stage2: false,
      stage2SkipReason: "fast path — stage-1 only, refined on the next cycle",
    });
    if (outcome.source === "cache" || outcome.source === "dropped" || outcome.source === "skipped") return outcome.run;
    const run = outcome.run;
    const detectedAt = trigger?.timestamp ?? null;
    console.info(
      `[propagation] fast path ${ticker}: ${run.summary.targets} targets · ${run.summary.open} open · ` +
        `event ${run.event.event_ts} → run ${run.produced_at} (${Math.round((Date.now() - started) / 1000)}s of work` +
        (detectedAt ? `, ${Math.round((Date.parse(run.produced_at) - Date.parse(detectedAt)) / 1000)}s after the message)` : ")"),
    );
    this.recordLaneFor(run, "fast_path");
    this.notify.runProduced(toListItem(run));
    return run;
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  private get budgetFile(): string {
    return path.join(this.configStore.dataDir, "budget.json");
  }

  private readBudget(): BudgetLedger | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.budgetFile, "utf8")) as BudgetLedger;
      return parsed && typeof parsed.day === "string" && typeof parsed.used === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeBudget(): void {
    fs.mkdirSync(path.dirname(this.budgetFile), { recursive: true });
    fs.writeFileSync(this.budgetFile, JSON.stringify(this.budget, null, 1), "utf8");
  }

  private baseConfig(): BaseConfig {
    return this.baseConfigStore.load();
  }

  /** The Deep Research graph, re-read when the file changes on disk. */
  /**
   * Base’s verdict lookup. Injected rather than reached for: the desktop
   * passes its Classifier host, the engine service passes its own, and a
   * replay harness passes none — in which case nothing is classified, which
   * is exactly what Base sees when the Classifier has never run.
   */
  private verdictLookup(config: BaseConfig): VerdictLookup {
    return this.classifierSource?.verdictLookup(config) ?? (() => ({ state: "unclassified" }));
  }

  graph(): GraphIndex {
    const graphPath = resolveGraphPath();
    const stat = fs.statSync(graphPath);
    if (this.graphCache && this.graphCache.path === graphPath && this.graphCache.mtimeMs === stat.mtimeMs) {
      return this.graphCache.index;
    }
    const index = loadGraphIndexSync(graphPath);
    this.graphCache = { index, mtimeMs: stat.mtimeMs, path: graphPath };
    return index;
  }

  /**
   * Tracker-backed quant source (§6): persisted bars + beta/vol from the
   * close-run state, the live quote from the engine's quant context, and the
   * benchmark's same-instant price recovered from move_today / residual_move
   * (residual = move − β·bench → bench = (move − residual)/β).
   */
  /**
   * @param withIntraday fetch the minute series for each target so pricing can
   * anchor on the event instant. One extra Yahoo call per tracked target, so
   * it is reserved for the fast path (≤ 15 targets), not the 15-minute sweep.
   */
  private quantSource(withIntraday = false): QuantSource {
    return {
      isTracked: (ticker) => getTrackerEngine().getTickerState(ticker) !== null,
      snapshot: async (ticker): Promise<TargetQuantSnapshot | null> => {
        const engine = getTrackerEngine();
        const state = engine.getTickerState(ticker);
        if (!state) return null;
        const bench = engine.getBenchmarkBars();
        let quant = state.quant;
        try {
          quant = (await engine.getQuantContext(ticker)) ?? state.quant;
        } catch {
          /* live quote unavailable — the persisted close-run state stands */
        }
        const lastBar = state.bars[state.bars.length - 1] ?? null;
        const lastPrice = quant?.last_price ?? lastBar?.c ?? null;
        const lastPriceTs = quant?.price_asof ?? (lastBar ? `${lastBar.d}T20:00:00.000Z` : null);
        let benchLastPrice: number | null = null;
        const benchLastBar = bench.bars[bench.bars.length - 1] ?? null;
        const benchPrevBar = bench.bars[bench.bars.length - 2] ?? null;
        if (
          quant &&
          quant.move_today != null &&
          quant.residual_move != null &&
          quant.beta_90d != null &&
          quant.beta_90d !== 0 &&
          quant.session !== "closed" &&
          benchLastBar
        ) {
          const benchMoveToday = (quant.move_today - quant.residual_move) / quant.beta_90d;
          // The quote's baseline is the prior close; the benchmark's is the bar before its latest
          // when the latest bar is today's partial, else the latest bar.
          const baseline = quant.price_asof && benchLastBar.d === quant.price_asof.slice(0, 10) && benchPrevBar ? benchPrevBar.c : benchLastBar.c;
          if (Number.isFinite(benchMoveToday)) benchLastPrice = baseline * (1 + benchMoveToday);
        }
        let intraday: Array<{ t: number; c: number }> | null = null;
        let benchIntraday: Array<{ t: number; c: number }> | null = null;
        if (withIntraday) {
          // 5d so an after-close release is still reachable the next session.
          const [own, mkt] = await Promise.all([
            fetchIntradaySeries(state.ticker, { range: "5d" }).catch(() => null),
            fetchIntradaySeries(bench.symbol, { range: "5d" }).catch(() => null),
          ]);
          intraday = own?.prints ?? null;
          benchIntraday = mkt?.prints ?? null;
        }
        return {
          ticker: state.ticker,
          bars: state.bars,
          benchBars: bench.bars,
          beta: quant?.beta_90d ?? null,
          r2: quant?.r_squared ?? null,
          vol30: quant?.daily_vol_30d ?? null,
          lastPrice,
          lastPriceTs,
          benchLastPrice,
          intraday,
          benchIntraday,
        };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Pull the shared runs from the server and fold them into the local store,
   * then push anything local the server hasn't got. Independent of `enabled`:
   * an install whose engine is off still gets to see the network everyone
   * else's engines have built — that is most of the point of the mirror. The
   * anon key may arrive a beat after boot, so a failed first pull is retried
   * once, and again whenever the session changes.
   */
  async syncRemoteRuns(reason: string): Promise<number> {
    if (!this.remote) return 0;
    let remote = await this.remote.pull();
    if (!remote) {
      await new Promise((r) => setTimeout(r, 4_000));
      remote = await this.remote.pull();
    }
    if (!remote) return 0;

    const changed = this.runStore.merge(remote);
    if (changed.length) {
      console.info(`[propagation] runs server (${reason}): merged ${changed.length} run(s)`);
      this.notify.runsChanged();
    }

    // Anything this install has that the server lacks — a first install with a
    // populated local history seeds the mirror for everyone else.
    const remoteIds = new Set(remote.map((r) => r.run_id));
    const missing = this.runStore.list({ synthetic: "exclude" }).filter((r) => !remoteIds.has(r.run_id));
    if (missing.length) this.remote?.push(missing, "host");
    return changed.length;
  }

  start(): void {
    this.stop();
    // Before the enabled gate on purpose: the cards show stored runs whether
    // or not this install produces any, and a frozen number beside a live
    // quote is wrong either way. This sweep makes no model calls.
    this.scheduleReprice();
    if (!this.config.enabled) return;
    const schedule = () => {
      this.nextCycleAt = new Date(Date.now() + this.cycleIntervalMs).toISOString();
      this.timer = setTimeout(() => {
        void this.runCycle({}).finally(schedule);
      }, this.cycleIntervalMs);
    };
    this.nextCycleAt = new Date(Date.now() + 90_000).toISOString();
    this.timer = setTimeout(() => {
      void this.runCycle({}).finally(schedule);
    }, 90_000);
    console.info(
      `[propagation] Phase A loop started (every ${this.cycleIntervalMs / 60_000} min, stage-2 ${anthropicConfigured() ? this.config.model : "off — no key"})`,
    );
  }

  /**
   * Re-measure every stored run against the current tape.
   *
   * Deliberately NOT behind `config.enabled`. That flag gates the Phase A
   * pipeline, which costs model calls and budget; this costs neither — it is
   * arithmetic over quotes the tracker already fetches. And the cards show
   * these runs whether or not this install's engine is on (they arrive from
   * the shared mirror too), so with the flag down the numbers simply froze at
   * whatever they were when the run was made, next to a live quote.
   */
  async repriceStored(now: string, errors: string[] = []): Promise<{ targets: number; runs: number; misses: number }> {
    let targets = 0;
    let runs = 0;
    let budget = this.repriceLimit;
    const source = this.quantSource();
    // One snapshot per ticker for the whole sweep. The same name is a target
    // of many runs, and a snapshot is two live quote fetches plus a full
    // intraday payload to parse. It also keeps the sweep self-consistent: two
    // runs measuring the same name cannot land on different prices.
    const snapshots = new Map<string, Promise<TargetQuantSnapshot | null>>();
    let misses = 0;
    const quant: QuantSource = {
      isTracked: (ticker) => source.isTracked(ticker),
      snapshot: (ticker) => {
        const key = ticker.toUpperCase();
        let pending = snapshots.get(key);
        if (!pending) {
          // The quote path swallows its own failures, so count what came back
          // empty — otherwise a throttled sweep looks like a quiet one.
          pending = source.snapshot(ticker).then((snap) => {
            if (!snap) misses += 1;
            return snap;
          });
          snapshots.set(key, pending);
        }
        return pending;
      },
    };

    for (const run of this.runStore.list({ currentOnly: true, synthetic: "exclude" })) {
      if (budget <= 0) break;
      try {
        const result = await repriceRun({ run, config: this.config, quant, now });
        budget -= result.repriced;
        targets += result.repriced;
        if (result.changed > 0) {
          // put() is a plain upsert keyed by run_id — no supersession, no
          // metrics, and produced_at (retention clock, sort key, supersession
          // tiebreak) is untouched.
          this.runStore.put(result.run);
          runs += 1;
        }
      } catch (err) {
        errors.push(`reprice ${run.run_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (targets > 0 || misses > 0) {
      console.info(
        `[propagation] repriced ${targets} targets in ${runs} runs` +
          (misses > 0 ? ` · ${misses} snapshots unavailable` : ""),
      );
    }
    return { targets, runs, misses };
  }

  /** The sweep's own clock, for when the Phase A loop is not running. */
  private scheduleReprice(): void {
    if (this.repriceTimer) clearInterval(this.repriceTimer);
    const tick = () => {
      if (this.running) return; // a cycle is already doing it
      this.runStore.reload();
      void this.repriceStored(new Date().toISOString()).catch((err) =>
        console.error("[propagation] reprice sweep failed:", err),
      );
    };
    this.repriceTimer = setInterval(tick, this.repriceIntervalMs);
    // Not at boot: the tracker needs a moment to load its bars, and a sweep
    // against a cold engine just spends requests to learn nothing.
    setTimeout(tick, 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCycleAt = null;
    if (this.repriceTimer) clearInterval(this.repriceTimer);
    this.repriceTimer = null;
  }

  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled };
    this.configStore.save(this.config);
    this.service.setConfig(this.config);
    this.start();
  }

  /** Phase B: whether the dashboard may surface runs. No engine restart —
   *  this only changes what the UI is allowed to show. */
  setSurfacingEnabled(enabled: boolean): void {
    this.config = { ...this.config, propagationSurfacingEnabled: enabled };
    this.configStore.save(this.config);
    this.service.setConfig(this.config);
  }

  reloadConfig(): void {
    this.config = this.configStore.load();
    this.service.setConfig(this.config);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  listRuns(options: RunListOptions = {}): PropagationRunListItem[] {
    if (!this.running) this.runStore.reload();
    return this.runStore.list({ limit: 200, ...options }).map(toListItem);
  }

  getRun(runId: string): PropagationRun | null {
    if (!this.running) this.runStore.reload();
    return this.runStore.get(runId);
  }

  /**
   * How one target's reaction arrived, session by session. Computed live from
   * the Tracker's bars rather than stored on the run: the curve grows with
   * every session, and a snapshot would be wrong by the next close.
   */
  absorption(runId: string, targetKey: string): AbsorptionPoint[] {
    const run = this.getRun(runId);
    if (!run) return [];
    const target = run.targets.find((t) => `${t.target}|${t.relationship.role}` === targetKey);
    if (!target || !target.ticker) return [];
    const engine = getTrackerEngine();
    const state = engine.getTickerState(target.ticker);
    if (!state) return [];
    return absorptionCurve({
      bars: state.bars,
      benchBars: engine.getBenchmarkBars().bars,
      beta: target.pricing.beta ?? state.quant?.beta_90d ?? null,
      expectedPct: target.pricing.expected_pct,
      direction: target.stage2?.direction ?? target.transmission.direction,
      eventTs: run.event.event_ts,
      maxSessions: 5,
    });
  }

  runsForIncident(incidentId: string): PropagationRunListItem[] {
    return this.runStore.forIncident(incidentId).map(toListItem);
  }

  /**
   * Everything this root has ever propagated to one name, and how each call
   * turned out. Superseded runs are dropped (an updated run is the same call,
   * re-read) and so are vetoed targets — stage 2 already said that edge does
   * not carry. Newest first.
   */
  pairHistory(root: string, target: string): PropagationPairHistory {
    if (!this.running) this.runStore.reload();
    const rootTicker = root.trim().toUpperCase();
    const targetTicker = target.trim().toUpperCase();

    const events: PairHistoryEvent[] = [];
    let label: string | null = null;
    let role: PropagationPairHistory["role"] = null;
    let tier: PropagationPairHistory["tier"] = null;
    let mechanism: string | null = null;

    // No limit: the whole point of this view is the full record.
    for (const run of this.runStore.list({ currentOnly: true, synthetic: "exclude" })) {
      if (run.root_ticker.toUpperCase() !== rootTicker) continue;
      const hit = run.targets.find(
        (t) => (t.ticker ?? "").toUpperCase() === targetTicker && t.stage2?.verdict !== "vetoed",
      );
      if (!hit) continue;

      // The newest run that names it decides how the pair is described.
      if (label == null) {
        label = hit.label || null;
        role = hit.relationship.role;
        tier = hit.relationship.tier;
        mechanism = hit.mechanism || null;
      }

      const pricedIn = targetPricedIn(hit);
      const outcome = pairOutcome(pricedIn, hit.pricing.status);
      events.push({
        run_id: run.run_id,
        event_label: run.event.label,
        event_type: run.event.type,
        event_direction: run.event.direction,
        event_materiality: run.event.materiality,
        event_ts: run.event.event_ts,
        produced_at: run.produced_at,
        expected_direction: hit.stage2?.direction ?? hit.transmission.direction,
        transmission_tier: hit.transmission.tier,
        mechanism: hit.mechanism,
        pricing_status: hit.pricing.status,
        outcome,
        expected_pct: hit.pricing.expected_pct,
        realized_pct: hit.pricing.realized_resid_pct ?? hit.pricing.realized_raw_pct,
        ratio: hit.pricing.ratio,
        sessions_elapsed: hit.pricing.sessions_elapsed,
        progress: targetProgress(hit),
        priced_in: pricedIn,
      });
    }

    events.sort((a, b) => b.event_ts.localeCompare(a.event_ts) || b.run_id.localeCompare(a.run_id));

    const counts = { hit: 0, partial: 0, miss: 0, open: 0, expired: 0 };
    for (const e of events) counts[e.outcome] += 1;
    const resolved = events.filter((e) => isResolved(e.outcome));
    const mean = (xs: number[]): number | null =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

    return {
      root: rootTicker,
      target: targetTicker,
      label,
      role,
      tier,
      mechanism,
      events,
      hits: counts.hit,
      partials: counts.partial,
      misses: counts.miss,
      open: counts.open,
      expired: counts.expired,
      hit_rate: resolved.length === 0 ? null : (counts.hit + counts.partial) / resolved.length,
      avg_expected_pct: mean(
        resolved.map((e) => e.expected_pct).filter((x): x is number => x != null && Number.isFinite(x)),
      ),
      avg_realized_pct: mean(
        resolved
          .map((e) => (e.realized_pct == null ? null : Math.abs(e.realized_pct)))
          .filter((x): x is number => x != null && Number.isFinite(x)),
      ),
      avg_ratio: mean(
        resolved.map((e) => e.ratio).filter((x): x is number => x != null && Number.isFinite(x)),
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // One batch cycle
  // ---------------------------------------------------------------------------

  private replay(limit: number, now: string) {
    const baseConfig = this.baseConfig();
    const engine = getTrackerEngine();
    const messages = engine.listMessages({ limit });
    const rawLookup = this.verdictLookup(baseConfig);
    // Pre-earnings preview cap: the Tracker's scheduledEarnings ledger (T5) plus
    // the stream's own scheduled_event messages; the same capped lookup feeds
    // Base's replay and the request builder, so a preview never becomes a run.
    const calendar: EarningsCalendar = new Map();
    for (const t of engine.getStatus().tickers) {
      const state = engine.getTickerState(t.ticker);
      for (const s of state?.scheduledEarnings ?? []) if (s.confirmed) addDueAt(calendar, t.ticker, s.dueAt);
    }
    const replay = replayBase(messages, {
      config: baseConfig,
      now,
      verdictLookup: rawLookup,
      earningsCalendar: calendar,
      makeIncidentId: stableIncidentId,
    });
    const verdictLookup = withPreEarningsPreviewCap(
      rawLookup,
      mergeCalendars(earningsCalendarFromMessages(messages), calendar),
      baseConfig,
    );
    return { baseConfig, messages, verdictLookup, replay };
  }

  async runCycle(options: { limit?: number; dryRun?: boolean; maxRequests?: number; stage2?: boolean }): Promise<PropagationRunCycleSummary> {
    if (this.running) return this.lastRun ?? this.emptyRun("a cycle is already running");
    this.running = true;
    const started = new Date().toISOString();
    const errors: string[] = [];
    try {
      this.runStore.reload();
      const now = new Date().toISOString();
      const { baseConfig, messages, verdictLookup, replay } = this.replay(options.limit ?? 3000, now);
      const built = buildPropagationRequests(replay.incidents, {
        verdictLookup,
        latestRun: (id) => this.runStore.latestFor(id),
        now,
        baseConfig,
        config: this.config,
      });
      const eligible = orderByPriority(built.requests)
        .filter((r) => !this.runStore.attemptsFor(r.request_id)?.permanent_failed)
        .slice(0, options.maxRequests ?? Number.POSITIVE_INFINITY);

      const stage2Wanted = options.stage2 !== false && anthropicConfigured();
      const remaining = propagationBudgetRemaining(this.budget, now, baseConfig);
      let ok = 0;
      let stage1Only = 0;
      let failed = 0;
      let cacheHits = 0;
      let skipped = 0;
      let superseded = 0;
      let stage2Calls = 0;
      let deferred = 0;
      if (!options.dryRun && eligible.length > 0) {
        // Stage-2 for the first `remaining` by priority; stage-1 for all.
        const items = eligible.map((request: PropagationRequest, i) => {
          const stage2 = stage2Wanted && i < remaining;
          if (stage2Wanted && !stage2) deferred += 1;
          return {
            request,
            options: {
              stage2,
              stage2SkipReason: stage2 ? undefined : stage2Wanted ? "daily budget exhausted" : "stage-2 off (no key)",
            },
          };
        });
        const results = await this.service.runBatch(items);
        for (const r of results) {
          if (r.error) {
            errors.push(r.error);
            continue;
          }
          const o = r.outcome!;
          superseded += o.superseded.length;
          if (o.stage2_called) stage2Calls += 1;
          if (o.source === "cache") cacheHits += 1;
          else if (o.source === "skipped") skipped += 1;
          else if (o.source === "dropped") continue;
          else if (o.source === "failed") failed += 1;
          else if (o.source === "ok") ok += 1;
          else stage1Only += 1;
          if (o.run && (o.source === "ok" || o.source === "stage1_only")) {
            this.recordLaneFor(o.run, "cycle");
          }
        }
        if (stage2Calls > 0) {
          this.budget = consumeBudget(this.budget, now, stage2Calls);
          this.writeBudget();
        }
        this.runStore.prune(now, this.config.retentionDays);
      } else if (options.dryRun) {
        deferred = stage2Wanted ? Math.max(0, eligible.length - remaining) : 0;
      }

      // Re-measure what is already stored. The engine prices a run once, at
      // creation, and then serves it from cache forever.
      const sweep = options.dryRun
        ? { targets: 0, runs: 0, misses: 0 }
        : await this.repriceStored(now, errors);
      const repricedTargets = sweep.targets;
      const repricedRuns = sweep.runs;
      const repriceMisses = sweep.misses;

      this.lastRun = {
        started_at: started,
        finished_at: new Date().toISOString(),
        messages_scanned: messages.length,
        incidents_replayed: replay.incidents.length,
        requests_built: built.requests.length,
        already_produced: built.already_produced,
        updates: built.updates,
        no_event: built.no_event,
        below_band: built.below_band,
        dispatched: options.dryRun ? 0 : eligible.length,
        stage2_calls: stage2Calls,
        stage2_deferred_by_budget: deferred,
        ok,
        stage1_only: stage1Only,
        failed,
        cache_hits: cacheHits,
        skipped,
        superseded,
        errors: [...new Set(errors)].slice(0, 10),
        dry_run: Boolean(options.dryRun),
      };
      console.info(
        `[propagation] cycle: ${messages.length} msgs → ${replay.incidents.length} incidents · ${built.requests.length} req (${built.already_produced} produced, ${built.below_band} below band) · dispatched ${this.lastRun.dispatched} · ok ${ok} · stage1_only ${stage1Only} · failed ${failed} · stage-2 calls ${stage2Calls}` +
          (repricedTargets > 0 ? ` · repriced ${repricedTargets} targets in ${repricedRuns} runs` : "") +
          (repriceMisses > 0 ? ` · ${repriceMisses} snapshots unavailable` : "") +
          (errors.length ? ` · errors ${errors.length}` : ""),
      );
      return this.lastRun;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastRun = this.emptyRun(message, started);
      console.error("[propagation] cycle failed:", message);
      return this.lastRun;
    } finally {
      this.running = false;
    }
  }

  private emptyRun(error: string, started = new Date().toISOString()): PropagationRunCycleSummary {
    return {
      started_at: started,
      finished_at: new Date().toISOString(),
      messages_scanned: 0,
      incidents_replayed: 0,
      requests_built: 0,
      already_produced: 0,
      updates: 0,
      no_event: 0,
      below_band: 0,
      dispatched: 0,
      stage2_calls: 0,
      stage2_deferred_by_budget: 0,
      ok: 0,
      stage1_only: 0,
      failed: 0,
      cache_hits: 0,
      skipped: 0,
      superseded: 0,
      errors: [error],
      dry_run: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  status(): PropagationStatus {
    const baseConfig = this.baseConfig();
    if (!this.running) this.runStore.reload();
    const metrics = this.service.getMetrics();
    const now = new Date().toISOString();
    const day = etDayOf(now);
    const used = this.budget && this.budget.day === day ? this.budget.used : 0;
    let graph: PropagationStatus["graph"] = null;
    try {
      const g = this.graph();
      graph = { ...g.version, edges: g.edges.length, path: resolveGraphPath() };
    } catch {
      graph = null;
    }
    let tracked = 0;
    try {
      tracked = getTrackerEngine().getStatus().tickers.length;
    } catch {
      tracked = 0;
    }
    return {
      enabled: this.config.enabled,
      configured: anthropicConfigured(),
      running: this.running,
      surfacing_enabled: this.config.propagationSurfacingEnabled,
      model: this.config.model,
      prompt_version: this.config.promptVersion,
      effort: this.config.effort,
      timeout_ms: this.config.timeoutMs,
      concurrency: this.config.concurrency,
      cycle_interval_ms: this.cycleIntervalMs,
      next_cycle_at: this.nextCycleAt,
      breaker: this.service.getBreakerState(),
      metrics,
      latency_p50_ms: percentile(metrics.latencies_ms, 50),
      latency_p95_ms: percentile(metrics.latencies_ms, 95),
      // Event → signal, per lane. The model-call latencies above say how long
      // the engine thought; this says how late the reader heard.
      lanes: summarizeLanes(metrics),
      estimated_spend_usd: estimateSpendUsd(metrics),
      budget: { day, used, remaining: propagationBudgetRemaining(this.budget, now, baseConfig), daily: baseConfig.propagation.dailyBudget },
      dispatch_min_band: baseConfig.propagation.dispatchMinBand,
      max_targets: this.config.maxTargets,
      graph,
      tracked_tickers: tracked,
      run_count: this.runStore.size(),
      current_count: this.runStore.list({ currentOnly: true }).length,
      open_runs: this.runStore.list({ currentOnly: true, openOnly: true }).length,
      permanent_failures: this.runStore.permanentFailures().length,
      last_run: this.lastRun,
      data_dir: this.configStore.dataDir,
      config_file: this.configStore.configFile,
    };
  }
}

function toListItem(run: PropagationRun): PropagationRunListItem {
  return {
    run_id: run.run_id,
    incident_id: run.incident_id,
    root_ticker: run.root_ticker,
    event_label: run.event.label,
    event_type: run.event.type,
    event_direction: run.event.direction,
    event_materiality: run.event.materiality,
    produced_at: run.produced_at,
    event_ts: run.event.event_ts,
    status: run.status,
    summary: run.summary,
    superseded: run.superseded_by !== null,
    update: run.update,
    stage2_state: !run.stage2 ? "none" : run.stage2.failure_reason ? "failed" : run.stage2.skipped_reason ? "skipped" : "ok",
    synthetic: run.synthetic === true,
    absorption: runAbsorption(run.targets),
    priced_in: runPricedIn(run.targets),
  };
}

let host: PropagationHost | null = null;
let hostDeps: PropagationHostDeps = {};

/**
 * Register what the host is wired to before anything asks for it. Called once
 * at bootstrap — by the desktop main process with its Supabase mirror and IPC
 * notifier, by the engine service with its own. Later calls are ignored once
 * the host exists, so a stray call cannot swap the wiring mid-flight.
 */
export function configurePropagationHost(deps: PropagationHostDeps): void {
  if (host) {
    console.warn("[propagation] host already built; ignoring late configure");
    return;
  }
  hostDeps = deps;
}

export function getPropagationHost(): PropagationHost {
  if (!host) host = new PropagationHost(hostDeps);
  return host;
}
