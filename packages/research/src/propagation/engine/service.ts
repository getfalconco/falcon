/**
 * Propagation service layer (§2, §7, §11).
 *
 * One request → one run: stage-1 always (deterministic, no budget), then
 * stage-2 when the budget allows and the breaker is closed — under the
 * subtract-only validator, the validation retry loop, per-call timeout,
 * transport retry with backoff, a concurrency cap and the circuit breaker.
 * Persistent stage-2 failure ships the run as `stage1_only` (`stage2.failure_reason`
 * set) — never blocked, never fabricated. Requests for one incident are
 * serialized with supersession (§2), the Analyst's lane pattern.
 */

import type { PropagationConfig } from "./config.js";
import type { GraphIndex } from "./graph.js";
import { buildStage2Prompt } from "./prompt.js";
import type { PropagationRequest } from "./requests.js";
import {
  STAGE2_OUTPUT_JSON_SCHEMA,
  candidateRefs,
  mergeStage2,
  validateStage2Output,
  type CandidateRef,
  type Stage2Item,
} from "./schema.js";
import { runStage1, summarize, type QuantSource } from "./stage1.js";
import { PropagationRunStore } from "./store.js";
import {
  PropagationBreakerOpenError,
  type BreakerState,
  type ModelCaller,
  type PropagationMetrics,
  type PropagationRun,
  type Stage2Envelope,
} from "./types.js";

export type RunOutcome = {
  run: PropagationRun;
  /**
   * cache       — the request already has a run in the store, no work done
   * ok          — stage-1 + stage-2
   * stage1_only — stage-2 skipped (budget/breaker/unconfigured) or failed
   * failed      — stage-1 itself threw (graph unreadable, etc.)
   * skipped     — permanent-failed request, no further attempts
   * dropped     — queued request replaced by a newer one for the incident
   */
  source: "cache" | "ok" | "stage1_only" | "failed" | "skipped" | "dropped";
  /** Whether a stage-2 model call was made (consumes budget). */
  stage2_called: boolean;
  latency_ms: number;
  superseded: string[];
};

export type PropagationServiceOptions = {
  config: PropagationConfig;
  store?: PropagationRunStore;
  graph: () => GraphIndex;
  quant: QuantSource;
  callModel: ModelCaller | null;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onRun?: (outcome: RunOutcome, request: PropagationRequest) => void;
};

export type ProcessOptions = {
  /** False → stage-1 only (budget exhausted, dry run…). */
  stage2: boolean;
  /** Why stage-2 is not attempted when `stage2: false`. */
  stage2SkipReason?: string;
};

function isNonRetryableStatus(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number") return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }
  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
  get inFlight(): number {
    return this.active;
  }
}

type Waiter = {
  request: PropagationRequest;
  options: ProcessOptions;
  resolve: (outcome: RunOutcome) => void;
  reject: (err: unknown) => void;
};
type Lane = { queued: Waiter | null };

export class PropagationService {
  readonly store: PropagationRunStore;
  private readonly graph: () => GraphIndex;
  private readonly quant: QuantSource;
  private readonly callModel: ModelCaller | null;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRun?: PropagationServiceOptions["onRun"];
  private semaphore: Semaphore;
  private lanes = new Map<string, Lane>();
  private breaker: BreakerState = { status: "closed", consecutive_failures: 0, open_until: null, trips: 0 };
  config: PropagationConfig;

  constructor(options: PropagationServiceOptions) {
    this.config = options.config;
    this.store = options.store ?? new PropagationRunStore();
    this.graph = options.graph;
    this.quant = options.quant;
    this.callModel = options.callModel;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onRun = options.onRun;
    this.semaphore = new Semaphore(Math.max(1, options.config.concurrency));
    this.breaker.trips = this.store.getMetrics().breaker_trips;
  }

  setConfig(config: PropagationConfig): void {
    this.config = config;
    this.semaphore = new Semaphore(Math.max(1, config.concurrency));
  }

  // --- breaker ---------------------------------------------------------------

  getBreakerState(): BreakerState {
    this.tickBreaker();
    return { ...this.breaker };
  }

  private tickBreaker(): void {
    if (this.breaker.status === "open" && this.breaker.open_until && this.now() >= this.breaker.open_until) {
      this.breaker = { ...this.breaker, status: "closed", consecutive_failures: 0, open_until: null };
    }
  }

  private noteTransportFailure(): void {
    this.breaker.consecutive_failures += 1;
    if (this.breaker.status === "closed" && this.breaker.consecutive_failures >= this.config.breaker.consecutiveFailures) {
      const until = new Date(Date.parse(this.now()) + this.config.breaker.cooldownMs).toISOString();
      this.breaker = { ...this.breaker, status: "open", open_until: until, trips: this.breaker.trips + 1 };
      this.store.updateMetrics((m) => {
        m.breaker_trips += 1;
      });
    }
  }

  private noteTransportSuccess(): void {
    this.breaker.consecutive_failures = 0;
  }

  getMetrics(): PropagationMetrics {
    return this.store.getMetrics();
  }

  get inFlight(): number {
    return this.semaphore.inFlight;
  }

  get activeIncidents(): number {
    return this.lanes.size;
  }

  // --- lanes (§2 per-incident serialization) ------------------------------

  run(request: PropagationRequest, options: ProcessOptions): Promise<RunOutcome> {
    const lane = this.lanes.get(request.incident_id);
    if (!lane) {
      this.lanes.set(request.incident_id, { queued: null });
      return this.runLane(request.incident_id, request, options);
    }
    return new Promise<RunOutcome>((resolve, reject) => {
      if (lane.queued) {
        const dropped = lane.queued;
        dropped.resolve({
          run: this.placeholderRun(dropped.request, "dropped: superseded in queue"),
          source: "dropped",
          stage2_called: false,
          latency_ms: 0,
          superseded: [],
        });
      }
      lane.queued = { request, options, resolve, reject };
    });
  }

  private async runLane(incidentId: string, request: PropagationRequest, options: ProcessOptions): Promise<RunOutcome> {
    try {
      return await this.process(request, options);
    } finally {
      this.drain(incidentId);
    }
  }

  private drain(incidentId: string): void {
    const lane = this.lanes.get(incidentId);
    if (!lane) return;
    const next = lane.queued;
    if (!next) {
      this.lanes.delete(incidentId);
      return;
    }
    lane.queued = null;
    void this.process(next.request, next.options)
      .then(next.resolve, next.reject)
      .finally(() => this.drain(incidentId));
  }

  private placeholderRun(request: PropagationRequest, reason: string): PropagationRun {
    let version = { generatedAt: "unknown", pipelineVersion: 0 };
    try {
      version = this.graph().version;
    } catch {
      /* graph unreadable — the placeholder carries the unknown stamp */
    }
    return {
      schema_version: 1,
      run_id: `run-${request.request_id.slice(3)}`,
      incident_id: request.incident_id,
      request_id: request.request_id,
      update_of: request.prior_run_id,
      graph_version: version,
      root_ticker: request.root_ticker,
      event: request.event,
      targets: [],
      summary: summarize([]),
      status: "failed",
      stage2: null,
      overflow: 0,
      non_transmitting: 0,
      reachable: 0,
      trigger: { rules: request.trigger_rules, priority_band: request.incident.priority_band },
      produced_at: this.now(),
      superseded_by: null,
      update: request.update,
      failure_reason: reason,
      synthetic: Boolean(request.synthetic),
    };
  }

  // --- one request -----------------------------------------------------------

  private async process(request: PropagationRequest, options: ProcessOptions): Promise<RunOutcome> {
    const cfg = this.config;
    const existing = this.store.byRequest(request.request_id);
    const ledger = this.store.attemptsFor(request.request_id);
    if (existing?.status === "failed" && ledger?.permanent_failed) {
      return { run: existing, source: "skipped", stage2_called: false, latency_ms: 0, superseded: [] };
    }
    if (existing && existing.status !== "failed") {
      this.store.updateMetrics((m) => {
        m.cache_hits += 1;
      });
      const outcome: RunOutcome = { run: existing, source: "cache", stage2_called: false, latency_ms: 0, superseded: [] };
      this.onRun?.(outcome, request);
      return outcome;
    }

    const started = Date.now();
    const now = this.now();

    // Stage-1: deterministic, never blocked.
    let run: PropagationRun;
    try {
      run = await runStage1({ graph: this.graph(), request, config: cfg, quant: this.quant, now });
    } catch (err) {
      const reason = `stage1: ${err instanceof Error ? err.message : String(err)}`;
      const failed = this.placeholderRun(request, reason);
      this.store.put(failed);
      this.store.recordAttempt(request.request_id, request.incident_id, reason, now, cfg.maxAttemptsPerRequest);
      this.store.updateMetrics((m) => {
        m.runs_failed += 1;
      });
      const outcome: RunOutcome = { run: failed, source: "failed", stage2_called: false, latency_ms: Date.now() - started, superseded: [] };
      this.onRun?.(outcome, request);
      return outcome;
    }

    // Stage-2: subtract-only refinement when allowed.
    let stage2Called = false;
    let envelope: Stage2Envelope | null = null;
    let merged = run.targets;
    let unclearResolved = 0;
    if (run.targets.length === 0) {
      envelope = null; // nothing to refine — no-edge run ships as is
    } else if (!options.stage2) {
      envelope = this.skippedEnvelope(options.stage2SkipReason ?? "stage-2 not requested");
    } else if (!this.callModel) {
      envelope = this.skippedEnvelope("model caller unavailable (ANTHROPIC_API_KEY not set)");
    } else {
      this.tickBreaker();
      if (this.breaker.status === "open" && this.breaker.open_until) {
        envelope = this.skippedEnvelope(`breaker open until ${this.breaker.open_until}`);
      } else {
        const release = await this.semaphore.acquire();
        try {
          this.tickBreaker();
          if (this.breaker.status === "open" && this.breaker.open_until) {
            envelope = this.skippedEnvelope(`breaker open until ${this.breaker.open_until}`);
          } else {
            stage2Called = true;
            const refs = candidateRefs(run.targets);
            const result = await this.callLoop(run, refs);
            envelope = {
              model: cfg.model,
              prompt_version: cfg.promptVersion,
              attempts: result.attempts,
              latency_ms: result.latency_ms,
              retry_errors: result.retry_errors,
              failure_reason: result.ok ? null : result.reason,
              skipped_reason: null,
              input_tokens: result.input_tokens,
              output_tokens: result.output_tokens,
            };
            if (result.ok) {
              const m = mergeStage2(run.targets, result.items, refs);
              merged = m.targets;
              unclearResolved = m.unclear_resolved;
            }
          }
        } finally {
          release();
        }
      }
    }

    const stage2Ok = envelope !== null && envelope.failure_reason === null && envelope.skipped_reason === null;
    const status: PropagationRun["status"] = run.targets.length === 0 ? "ok" : stage2Ok ? "ok" : "stage1_only";
    const final: PropagationRun = {
      ...run,
      targets: merged,
      summary: summarize(merged),
      status,
      stage2: envelope,
      produced_at: this.now(),
    };

    this.store.put(final);
    const superseded = this.store.markSuperseded(request.incident_id, final.run_id);
    this.store.recordAttempt(
      request.request_id,
      request.incident_id,
      envelope?.failure_reason ? `stage2: ${envelope.failure_reason}` : null,
      final.produced_at,
      cfg.maxAttemptsPerRequest,
    );
    this.store.updateMetrics((m) => {
      if (final.status === "ok") m.runs_ok += 1;
      else m.runs_stage1_only += 1;
      m.targets_total += final.summary.targets;
      m.open_total += final.summary.open;
      m.partial_total += final.summary.partial;
      m.priced_total += final.summary.priced;
      m.contradicted_total += final.summary.contradicted;
      m.untracked_total += final.summary.untracked;
      m.vetoes += final.summary.vetoed;
      if (final.summary.no_edge) m.no_edge_runs += 1;
      m.unclear_resolved += unclearResolved;
      m.unclear_total += run.targets.filter((t) => t.transmission.direction === "unclear").length;
      m.superseded += superseded.length;
      for (const t of final.targets) {
        const cell = `${final.event.type}|${t.relationship.role}|${t.transmission.transmits}`;
        m.by_cell[cell] = (m.by_cell[cell] ?? 0) + 1;
      }
    });

    const outcome: RunOutcome = {
      run: final,
      source: final.status === "ok" ? "ok" : "stage1_only",
      stage2_called: stage2Called,
      latency_ms: Date.now() - started,
      superseded,
    };
    this.onRun?.(outcome, request);
    return outcome;
  }

  private skippedEnvelope(reason: string): Stage2Envelope {
    return {
      model: this.config.model,
      prompt_version: this.config.promptVersion,
      attempts: 0,
      latency_ms: 0,
      retry_errors: [],
      failure_reason: null,
      skipped_reason: reason,
      input_tokens: 0,
      output_tokens: 0,
    };
  }

  /** Run many requests; a breaker-open error is reported per item, never thrown. */
  async runBatch(
    items: Array<{ request: PropagationRequest; options: ProcessOptions }>,
  ): Promise<Array<{ request: PropagationRequest; outcome: RunOutcome | null; error: string | null }>> {
    const results: Array<{ request: PropagationRequest; outcome: RunOutcome | null; error: string | null }> = [];
    await Promise.all(
      items.map(async ({ request, options }, i) => {
        try {
          results[i] = { request, outcome: await this.run(request, options), error: null };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results[i] = { request, outcome: null, error: message };
        }
      }),
    );
    return results;
  }

  // --- call loop: validation retries × transport retries (§7) ------------------

  private async callLoop(
    run: PropagationRun,
    refs: CandidateRef[],
  ): Promise<
    | { ok: true; items: Stage2Item[]; attempts: number; latency_ms: number; retry_errors: string[]; input_tokens: number; output_tokens: number }
    | { ok: false; reason: string; attempts: number; latency_ms: number; retry_errors: string[]; input_tokens: number; output_tokens: number }
  > {
    const cfg = this.config;
    const callModel = this.callModel;
    if (!callModel) {
      return { ok: false, reason: "no model caller", attempts: 0, latency_ms: 0, retry_errors: [], input_tokens: 0, output_tokens: 0 };
    }
    const prompt = buildStage2Prompt(run, refs, cfg.promptVersion);
    const ctx = { candidates: refs, config: cfg };
    const started = Date.now();
    let attempts = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastErrors: string[] = [];
    const retryErrors: string[] = [];

    for (let v = 0; v <= cfg.validationRetries; v++) {
      const user =
        v >= 1 && lastErrors.length
          ? `${prompt.user}\n\nYour previous response failed validation: ${lastErrors.join("; ")}. Return a corrected JSON object that satisfies every rule — and remember: only the refs shown are valid, targets cannot be added.`
          : prompt.user;

      let text: string | null = null;
      for (let t = 0; t <= cfg.transportRetries; t++) {
        attempts += 1;
        if (t > 0 || v > 0) {
          this.store.updateMetrics((m) => {
            m.retries += 1;
          });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        const callStart = Date.now();
        try {
          const res = await callModel({
            system: prompt.system,
            user,
            model: cfg.model,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens,
            timeout_ms: cfg.timeoutMs,
            output_schema: STAGE2_OUTPUT_JSON_SCHEMA,
            effort: cfg.effort,
            signal: controller.signal,
          });
          const latency = Date.now() - callStart;
          inputTokens += res.input_tokens;
          outputTokens += res.output_tokens;
          this.store.updateMetrics((m) => {
            m.input_tokens += res.input_tokens;
            m.output_tokens += res.output_tokens;
            m.latencies_ms.push(latency);
            if (m.latencies_ms.length > cfg.latencyWindow) {
              m.latencies_ms.splice(0, m.latencies_ms.length - cfg.latencyWindow);
            }
          });
          this.noteTransportSuccess();
          text = res.text;
          break;
        } catch (err) {
          const aborted = controller.signal.aborted;
          const message = aborted ? `timeout after ${cfg.timeoutMs}ms` : err instanceof Error ? err.message : String(err);
          this.store.updateMetrics((m) => {
            m.transport_failures += 1;
          });
          this.noteTransportFailure();
          lastErrors = [`transport: ${message}`];
          if (isNonRetryableStatus(err) || this.breaker.status === "open") {
            return { ok: false, reason: lastErrors[0], attempts, latency_ms: Date.now() - started, retry_errors: retryErrors, input_tokens: inputTokens, output_tokens: outputTokens };
          }
          if (t < cfg.transportRetries) {
            retryErrors.push(lastErrors[0]);
            await this.sleep(cfg.retryBackoffMs * 2 ** t);
            continue;
          }
          return { ok: false, reason: lastErrors[0], attempts, latency_ms: Date.now() - started, retry_errors: retryErrors, input_tokens: inputTokens, output_tokens: outputTokens };
        } finally {
          clearTimeout(timer);
        }
      }
      if (text === null) {
        return { ok: false, reason: "no response", attempts, latency_ms: Date.now() - started, retry_errors: retryErrors, input_tokens: inputTokens, output_tokens: outputTokens };
      }

      const validated = validateStage2Output(text, ctx);
      if (validated.ok) {
        return { ok: true, items: validated.items, attempts, latency_ms: Date.now() - started, retry_errors: retryErrors, input_tokens: inputTokens, output_tokens: outputTokens };
      }
      lastErrors = validated.errors;
      if (v < cfg.validationRetries) retryErrors.push(`validation: ${validated.errors.join("; ")}`);
      this.store.updateMetrics((m) => {
        m.validation_failures += 1;
        if (validated.added_target) m.added_target_rejections += 1;
      });
    }
    return { ok: false, reason: `validation: ${lastErrors.join("; ")}`, attempts, latency_ms: Date.now() - started, retry_errors: retryErrors, input_tokens: inputTokens, output_tokens: outputTokens };
  }
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Fable 5 list price: $10/M input, $50/M output (thinking bills as output). Estimate only. */
export function estimateSpendUsd(metrics: Pick<PropagationMetrics, "input_tokens" | "output_tokens">): number {
  return metrics.input_tokens * 1e-6 * 10 + metrics.output_tokens * 1e-6 * 50;
}

export { PropagationBreakerOpenError };
