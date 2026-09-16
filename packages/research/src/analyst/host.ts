import fs from "node:fs";
import path from "node:path";
import {
  BaseConfigStore,
  consumeBudget,
  etDayOf,
  replayBase,
  structureBudgetRemaining,
  type BaseConfig,
  type BudgetLedger,
  type Incident,
} from "../base/index.js";
import {
  AnalystConfigStore,
  AnalystOutputStore,
  AnalystService,
  FileBackend,
  analystBudgetRemaining,
  anthropicConfigured,
  anthropicModelCaller,
  applyAnalystBudget,
  assembleInput,
  buildAnalystPrompt,
  buildAnalystRequests,
  estimateSpendUsd,
  excludedCount,
  percentile,
  stableIncidentId,
  type AnalystConfig,
  type AnalystOutput,
  type AnalystRequest,
  type OutputListOptions,
} from "./index.js";
import { getTrackerEngine } from "../tracker/index.js";
import { ScreenMessageStore } from "../screen/index.js";
import type { BaseMessage } from "../base/index.js";
import type {
  AnalystEvidenceLine,
  AnalystOutputDetail,
  AnalystRequestPreview,
  AnalystRunSummary,
  AnalystStatus,
} from "./host-types.js";
import { getClassifierHost } from "../classifier/host.js";

/**
 * Analyst host — the main-process owner of the Analyst service.
 *
 * Phase A (log-only, spec §12): on a 15-minute cycle — or on demand from the
 * panel — it replays Base over Tracker's recorded stream (exactly as the
 * Classifier host does), turns every incident routed to `destination:
 * analyst` into an Analyst request (per-incident ids; `update` when the
 * incident grew), applies Base's §8 daily budget in priority order, and runs
 * them through the service. Outputs land in the output store and the Shift+A
 * panel only — `analystSurfacingEnabled` stays false until the rubric gate.
 *
 * The loop is OFF by default (`AnalystConfig.enabled`): it spends the user's
 * Anthropic quota, so it is opted into from the panel. A "run cycle" on the
 * panel is the replay-driven generation the spec's build step 5 calls for.
 */
export class AnalystHost {
  readonly configStore = new AnalystConfigStore();
  readonly baseConfigStore = new BaseConfigStore();
  config: AnalystConfig;
  readonly outputStore: AnalystOutputStore;
  readonly service: AnalystService;
  readonly cycleIntervalMs = 15 * 60_000;

  private budget: BudgetLedger | null;
  private timer: NodeJS.Timeout | null = null;
  private nextCycleAt: string | null = null;
  private running = false;
  private lastRun: AnalystRunSummary | null = null;
  /** Incidents from the last replay, so outputs can be resolved back to messages. */
  private incidents = new Map<string, Incident>();

  constructor() {
    this.config = this.configStore.load();
    this.outputStore = new AnalystOutputStore(new FileBackend(this.configStore.dataDir));
    this.service = new AnalystService({
      config: this.config,
      store: this.outputStore,
      callModel: anthropicModelCaller,
    });
    this.budget = this.readBudget();
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

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start the Phase A loop if enabled and a key is present. Safe to call repeatedly. */
  start(): void {
    this.stop();
    if (!this.config.enabled) return;
    if (!anthropicConfigured()) {
      console.warn("[analyst] enabled but ANTHROPIC_API_KEY is not set — loop not started");
      return;
    }
    const schedule = () => {
      this.nextCycleAt = new Date(Date.now() + this.cycleIntervalMs).toISOString();
      this.timer = setTimeout(() => {
        void this.runCycle({}).finally(schedule);
      }, this.cycleIntervalMs);
    };
    // First cycle shortly after launch so the Tracker and Classifier have had time to load.
    this.nextCycleAt = new Date(Date.now() + 90_000).toISOString();
    this.timer = setTimeout(() => {
      void this.runCycle({}).finally(schedule);
    }, 90_000);
    console.info(`[analyst] Phase A loop started (every ${this.cycleIntervalMs / 60_000} min, model ${this.config.model})`);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCycleAt = null;
  }

  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled };
    this.configStore.save(this.config);
    this.service.setConfig(this.config);
    this.start();
  }

  reloadConfig(): void {
    this.config = this.configStore.load();
    this.service.setConfig(this.config);
  }

  // ---------------------------------------------------------------------------
  // Outputs
  // ---------------------------------------------------------------------------

  listOutputs(options: OutputListOptions = {}): AnalystOutput[] {
    if (!this.running) this.outputStore.reload();
    return this.outputStore.list({ limit: 200, ...options });
  }

  private incidentFor(incidentId: string): Incident | null {
    const cached = this.incidents.get(incidentId);
    if (cached) return cached;
    // Not in the last replay (or no cycle yet): replay once to resolve it.
    try {
      this.replay(3000, new Date().toISOString());
    } catch {
      /* best effort */
    }
    return this.incidents.get(incidentId) ?? null;
  }

  outputDetail(incidentId: string, requestId: string): AnalystOutputDetail | null {
    if (!this.running) this.outputStore.reload();
    const output = this.outputStore.get(incidentId, requestId);
    if (!output) return null;
    const incident = this.incidentFor(incidentId);
    const byId = new Map<string, BaseMessage>((incident?.messages ?? []).map((m) => [m.id, m]));
    const evidence: AnalystEvidenceLine[] = output.evidence.map((id) => {
      const m = byId.get(id);
      return m
        ? { message_id: id, type: m.type, timestamp: m.timestamp, line: messageLine(m) }
        : { message_id: id, type: "unknown", timestamp: "", line: "(message not in the current replay)" };
    });
    const chain = this.outputStore.forIncident(incidentId).map((o) => ({
      request_id: o.request_id,
      produced_at: o.produced_at,
      status: o.status,
      superseded_by: o.superseded_by,
    }));
    return { output, evidence, chain, incident_found: incident !== null };
  }

  // ---------------------------------------------------------------------------
  // One batch cycle
  // ---------------------------------------------------------------------------

  private replay(limit: number, now: string) {
    const baseConfig = this.baseConfig();
    const engine = getTrackerEngine();
    // S2: Screen's tape_structure messages join the Tracker stream. They are
    // merged by timestamp so the incident windows see them in order; with
    // `screenToAnalystEnabled` off they still land in incidents but the
    // routing table stores them only.
    const screenMessages = this.screenMessages();
    const messages = [...engine.listMessages({ limit }), ...screenMessages].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
    );
    const verdictLookup = getClassifierHost().verdictLookup(baseConfig);
    // Deterministic ids: outputs are keyed by incident across cycles (§9).
    const replay = replayBase(messages, { config: baseConfig, now, verdictLookup, makeIncidentId: stableIncidentId });
    this.incidents = new Map(replay.incidents.map((r) => [r.incident.incident_id, r.incident]));
    return { baseConfig, messages, verdictLookup, replay };
  }

  /** Screen's emitted structures, best-effort: their absence must not stop a cycle. */
  private screenMessages(): ReturnType<ScreenMessageStore["read"]> {
    try {
      return new ScreenMessageStore().read({ limit: 500 });
    } catch (err) {
      console.error("[analyst] reading Screen emits failed:", err);
      return [];
    }
  }

  private preview(request: AnalystRequest): AnalystRequestPreview {
    const input = assembleInput(request.incident, request.verdicts, request.kind, this.config);
    const prompt = buildAnalystPrompt(input, this.config.promptVersion);
    return {
      request_id: request.request_id,
      incident_id: request.incident_id,
      ticker: request.incident.ticker,
      kind: request.kind,
      update: request.update,
      priority_band: request.incident.priority_band,
      message_count: request.incident.messages.length,
      anomaly_types: input.anomalies.map((a) => a.type),
      news_lines: input.news.length,
      news_excluded: excludedCount(input),
      reaction_state: input.reaction_state,
      prompt_chars: prompt.system.length + prompt.user.length,
    };
  }

  async runCycle(options: { limit?: number; dryRun?: boolean; maxRequests?: number }): Promise<AnalystRunSummary> {
    if (this.running) {
      return this.lastRun ?? this.emptyRun("a cycle is already running");
    }
    this.running = true;
    const started = new Date().toISOString();
    const errors: string[] = [];
    try {
      // Pick up outputs written by the replay script since the last cycle.
      this.outputStore.reload();
      const now = new Date().toISOString();
      const { baseConfig, messages, verdictLookup, replay } = this.replay(options.limit ?? 3000, now);
      const analystIncidents = replay.incidents.filter((r) =>
        r.routing.destinations.some((d) => d.destination === "analyst"),
      ).length;

      const built = buildAnalystRequests(replay.incidents, {
        verdictLookup,
        latestOutput: (id) => this.outputStore.latestFor(id),
        now,
      });

      // Drop permanent-failed requests before they consume budget (§8).
      const eligible = built.requests.filter((r) => !this.outputStore.attemptsFor(r.request_id)?.permanent_failed);

      const remaining = Math.min(
        analystBudgetRemaining(this.budget, now, baseConfig),
        options.maxRequests ?? Number.POSITIVE_INFINITY,
      );
      const { dispatch, deferred } = applyAnalystBudget(
        eligible,
        remaining,
        structureBudgetRemaining(this.budget, now, baseConfig),
      );
      const preview = dispatch.map((r) => this.preview(r));

      let ok = 0;
      let consumedStructure = 0;
      let downgraded = 0;
      let failed = 0;
      let cacheHits = 0;
      let skipped = 0;
      let superseded = 0;
      if (!options.dryRun && dispatch.length > 0) {
        const results = await this.service.analyzeBatch(dispatch);
        let consumed = 0;
        for (const r of results) {
          if (r.error) {
            errors.push(r.error);
            continue;
          }
          const o = r.outcome!;
          superseded += o.superseded.length;
          if (o.source === "cache") cacheHits += 1;
          else if (o.source === "skipped") skipped += 1;
          else if (o.source === "dropped") continue;
          else {
            consumed += 1;
            if (r.request.kind === "structure_review") consumedStructure += 1;
            if (o.source === "failed") failed += 1;
            else if (o.source === "downgraded") {
              ok += 1;
              downgraded += 1;
            } else ok += 1;
          }
        }
        this.budget = consumeBudget(this.budget, now, consumed, consumedStructure);
        this.writeBudget();
        this.outputStore.prune(now, this.config.retentionDays);
      }

      this.lastRun = {
        started_at: started,
        finished_at: new Date().toISOString(),
        messages_scanned: messages.length,
        incidents_replayed: replay.incidents.length,
        analyst_incidents: analystIncidents,
        requests_built: built.requests.length,
        already_produced: built.already_produced,
        updates: built.updates,
        dispatched: options.dryRun ? 0 : dispatch.length,
        deferred_by_budget: deferred.length + (options.dryRun ? dispatch.length : 0),
        ok,
        downgraded,
        failed,
        cache_hits: cacheHits,
        skipped,
        superseded,
        errors: [...new Set(errors)].slice(0, 10),
        dry_run: Boolean(options.dryRun),
        preview,
      };
      console.info(
        `[analyst] cycle: ${messages.length} msgs → ${replay.incidents.length} incidents · ${analystIncidents} analyst · ${built.requests.length} req (${built.already_produced} produced) · dispatched ${this.lastRun.dispatched} · ok ${ok} · downgraded ${downgraded} · failed ${failed}` +
          (errors.length ? ` · errors ${errors.length}` : ""),
      );
      return this.lastRun;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastRun = this.emptyRun(message, started);
      console.error("[analyst] cycle failed:", message);
      return this.lastRun;
    } finally {
      this.running = false;
    }
  }

  private emptyRun(error: string, started = new Date().toISOString()): AnalystRunSummary {
    return {
      started_at: started,
      finished_at: new Date().toISOString(),
      messages_scanned: 0,
      incidents_replayed: 0,
      analyst_incidents: 0,
      requests_built: 0,
      already_produced: 0,
      updates: 0,
      dispatched: 0,
      deferred_by_budget: 0,
      ok: 0,
      downgraded: 0,
      failed: 0,
      cache_hits: 0,
      skipped: 0,
      superseded: 0,
      errors: [error],
      dry_run: false,
      preview: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  status(): AnalystStatus {
    const baseConfig = this.baseConfig();
    if (!this.running) this.outputStore.reload();
    const metrics = this.service.getMetrics();
    const now = new Date().toISOString();
    const day = etDayOf(now);
    const used = this.budget && this.budget.day === day ? this.budget.used : 0;
    return {
      enabled: this.config.enabled,
      configured: anthropicConfigured(),
      running: this.running,
      surfacing_enabled: this.config.analystSurfacingEnabled,
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
      estimated_spend_usd: estimateSpendUsd(metrics),
      budget: {
        day,
        used,
        remaining: analystBudgetRemaining(this.budget, now, baseConfig),
        daily: baseConfig.analyst.dailyBudget,
        structure_used: this.budget && this.budget.day === day ? (this.budget.structure_used ?? 0) : 0,
        structure_remaining: structureBudgetRemaining(this.budget, now, baseConfig),
        structure_cap: baseConfig.analyst.tapeStructureDailySubCap,
      },
      output_count: this.outputStore.size(),
      current_count: this.outputStore.list({ currentOnly: true }).length,
      permanent_failures: this.outputStore.permanentFailures().length,
      active_incidents: this.service.activeIncidents,
      last_run: this.lastRun,
      data_dir: this.configStore.dataDir,
      config_file: this.configStore.configFile,
    };
  }
}

/** One-line summary of a constituent message (mirrors the Base panel's). */
function messageLine(message: BaseMessage): string {
  const p = message.payload as Record<string, unknown>;
  switch (message.type) {
    case "news_item":
      return String(p.headline ?? "");
    case "filing_item": {
      const items = Array.isArray(p.item_codes) && p.item_codes.length > 0 ? ` items ${(p.item_codes as string[]).join(", ")}` : "";
      return `${String(p.form_type ?? "")}${items} · filed ${String(p.filed_at ?? "").slice(0, 10)}`;
    }
    case "insider_filing":
      return `${String(p.insider_name ?? "")} (${String(p.role ?? "")}) code ${String(p.transaction_code ?? "?")}`;
    case "scheduled_event":
      return `${String(p.fiscal_period ?? "")} due ${String(p.due_at ?? "").slice(0, 10)}`;
    case "gap_event":
      return `gap z ${Number(p.gap_z).toFixed(2)} ${String(p.direction ?? "")}`;
    case "volume_anomaly":
      return `${Number(p.volume_ratio).toFixed(1)}× baseline volume`;
    case "unexplained_move":
      return `${String(p.measure_used ?? "")} ${Number(p.residual_zscore).toFixed(2)} ${String(p.direction ?? "")}`;
    case "drift_event":
      return `drift z ${Number(p.drift_z).toFixed(2)} ${String(p.direction ?? "")}`;
    case "news_burst":
      return `${String(p.articles_last_24h ?? "")} articles / 24h`;
    case "silence_anomaly":
      return `${String(p.trading_days_silent ?? "")} silent trading days`;
    case "filing_overdue":
      return `${String(p.expected_form ?? "")} overdue ${String(p.business_days_overdue ?? "")}bd`;
    case "insider_cluster":
      return `${String(p.insider_count ?? "")} insiders ${String(p.direction ?? "")}`;
    default:
      return message.type;
  }
}

let host: AnalystHost | null = null;

export function getAnalystHost(): AnalystHost {
  if (!host) host = new AnalystHost();
  return host;
}
