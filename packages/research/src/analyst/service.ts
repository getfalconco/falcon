/**
 * Analyst service layer (§2, §5, §8).
 *
 * Wraps the single LLM call with: output-store lookup (an already-produced
 * request is not re-called), per-incident serialization with supersession
 * (§2), the §5 validation retry loop with the grounding downgrade, per-call
 * timeout, transport retry with backoff, a concurrency cap, the circuit
 * breaker, the §8 attempt ledger and the §11 metrics. The model call itself
 * is injected (`ModelCaller`) so every test runs against recorded fixtures,
 * never live calls. Same structure as the Classifier service.
 *
 * An output is never fabricated: persistent failure yields `status: "failed"`
 * and the incident is unaffected.
 */

import { assembleInput, type AssembledInput } from "./assemble.js";
import { promptVersionFor, type AnalystConfig } from "./config.js";
import { buildAnalystPrompt } from "./prompt.js";
import {
  MODEL_OUTPUT_JSON_SCHEMA,
  assembleOutput,
  failedOutput,
  validateModelOutput,
  type ValidationContext,
} from "./schema.js";
import { AnalystOutputStore } from "./store.js";
import {
  AnalystBreakerOpenError,
  AnalystTransportError,
  type AnalystMetrics,
  type AnalystOutput,
  type AnalystRequest,
  type BreakerState,
  type ModelCaller,
  type ModelOutput,
} from "./types.js";

export type AnalyzeOutcome = {
  output: AnalystOutput;
  /**
   * cache      — already in the store for this (incident, request), no call made
   * model      — fresh output from the model
   * downgraded — grounding failed persistently; accepted as unidentified (§5)
   * failed     — persistent failure; fallback output
   * skipped    — permanent-failed request, no further attempts (§8)
   * dropped    — queued request replaced by a newer one for the incident (§2)
   */
  source: "cache" | "model" | "downgraded" | "failed" | "skipped" | "dropped";
  attempts: number;
  latency_ms: number;
  /** Request ids this output superseded (§2). */
  superseded: string[];
};

export type AnalystServiceOptions = {
  config: AnalystConfig;
  store?: AnalystOutputStore;
  callModel: ModelCaller;
  /** Clock injection (determinism in tests). */
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onOutput?: (outcome: AnalyzeOutcome, request: AnalystRequest) => void;
};

function isNonRetryableStatus(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number") return false;
  // 408 (timeout) and 429 (rate limit) are retryable; other 4xx are not.
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
  request: AnalystRequest;
  resolve: (outcome: AnalyzeOutcome) => void;
  reject: (err: unknown) => void;
};

/** §2 per-incident lane: one in flight, at most one queued (the latest). */
type Lane = { queued: Waiter | null };

export class AnalystService {
  readonly store: AnalystOutputStore;
  private readonly callModel: ModelCaller;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onOutput?: AnalystServiceOptions["onOutput"];
  private semaphore: Semaphore;
  private lanes = new Map<string, Lane>();
  private breaker: BreakerState = { status: "closed", consecutive_failures: 0, open_until: null, trips: 0 };
  config: AnalystConfig;

  constructor(options: AnalystServiceOptions) {
    this.config = options.config;
    this.store = options.store ?? new AnalystOutputStore();
    this.callModel = options.callModel;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onOutput = options.onOutput;
    this.semaphore = new Semaphore(Math.max(1, options.config.concurrency));
    // Persisted breaker trips are informational; a fresh process starts closed.
    this.breaker.trips = this.store.getMetrics().breaker_trips;
  }

  /** Swap config at runtime (panel edits). Concurrency changes apply to new acquisitions. */
  setConfig(config: AnalystConfig): void {
    this.config = config;
    this.semaphore = new Semaphore(Math.max(1, config.concurrency));
  }

  // ---------------------------------------------------------------------------
  // Breaker (§8)
  // ---------------------------------------------------------------------------

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
    if (
      this.breaker.status === "closed" &&
      this.breaker.consecutive_failures >= this.config.breaker.consecutiveFailures
    ) {
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

  // ---------------------------------------------------------------------------
  // Analyze
  // ---------------------------------------------------------------------------

  getMetrics(): AnalystMetrics {
    return this.store.getMetrics();
  }

  get inFlight(): number {
    return this.semaphore.inFlight;
  }

  /** Incidents with a request in flight or queued. */
  get activeIncidents(): number {
    return this.lanes.size;
  }

  /**
   * Analyze one request. Requests for one incident are processed serially;
   * if a newer request arrives while one is queued, only the latest queued
   * survives (the older resolves `dropped`). An in-flight call completes and
   * its output is marked superseded when the newer one lands (§2).
   *
   * Throws `AnalystBreakerOpenError` when the breaker is open — the host's
   * queue holds the request; nothing is fabricated.
   */
  analyze(request: AnalystRequest): Promise<AnalyzeOutcome> {
    const lane = this.lanes.get(request.incident_id);
    if (!lane) {
      const fresh: Lane = { queued: null };
      this.lanes.set(request.incident_id, fresh);
      return this.runLane(request.incident_id, request);
    }
    return new Promise<AnalyzeOutcome>((resolve, reject) => {
      if (lane.queued) {
        // Only the latest queued request survives.
        const dropped = lane.queued;
        dropped.resolve({
          output: this.placeholderOutput(dropped.request, "dropped: superseded in queue"),
          source: "dropped",
          attempts: 0,
          latency_ms: 0,
          superseded: [],
        });
      }
      lane.queued = { request, resolve, reject };
    });
  }

  private async runLane(incidentId: string, request: AnalystRequest): Promise<AnalyzeOutcome> {
    try {
      return await this.process(request);
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
    void this.process(next.request)
      .then(next.resolve, next.reject)
      .finally(() => this.drain(incidentId));
  }

  private placeholderOutput(request: AnalystRequest, reason: string): AnalystOutput {
    const reaction = assembleInput(request.incident, request.verdicts, request.kind, this.config).reaction_state;
    return failedOutput(request, reason, reaction, {
      prompt_version: promptVersionFor(request.kind, this.config),
      model: this.config.model,
      produced_at: this.now(),
      attempts: 0,
      latency_ms: 0,
      retry_errors: [],
    });
  }

  private async process(request: AnalystRequest): Promise<AnalyzeOutcome> {
    const cfg = this.config;
    const existing = this.store.get(request.incident_id, request.request_id);

    // §8: permanent-failed requests are not retried.
    const ledger = this.store.attemptsFor(request.request_id);
    if (existing?.status === "failed" && ledger?.permanent_failed) {
      return { output: existing, source: "skipped", attempts: 0, latency_ms: 0, superseded: [] };
    }
    if (existing?.status === "ok") {
      this.store.updateMetrics((m) => {
        m.cache_hits += 1;
      });
      const outcome: AnalyzeOutcome = { output: existing, source: "cache", attempts: 0, latency_ms: 0, superseded: [] };
      this.onOutput?.(outcome, request);
      return outcome;
    }

    this.tickBreaker();
    if (this.breaker.status === "open" && this.breaker.open_until) {
      throw new AnalystBreakerOpenError(this.breaker.open_until);
    }

    const release = await this.semaphore.acquire();
    // Re-check after waiting on the semaphore: the breaker may have opened
    // while this request waited.
    this.tickBreaker();
    if (this.breaker.status === "open" && this.breaker.open_until) {
      release();
      throw new AnalystBreakerOpenError(this.breaker.open_until);
    }

    const started = Date.now();
    try {
      const input = assembleInput(request.incident, request.verdicts, request.kind, cfg);
      const result = await this.callLoop(input);
      const producedAt = this.now();
      const envelope = {
        prompt_version: promptVersionFor(request.kind, cfg),
        model: cfg.model,
        produced_at: producedAt,
        attempts: result.attempts,
        latency_ms: Date.now() - started,
        retry_errors: result.retry_errors,
      };

      if (result.ok) {
        const output = assembleOutput(request, result.output, input.reaction_state, envelope, {
          grounding_failed: result.grounding_failed,
          edge_deviation: result.edge_deviation,
        });
        this.store.put(output);
        const superseded = this.store.markSuperseded(request.incident_id, request.request_id);
        this.store.recordAttempt(request.request_id, request.incident_id, null, producedAt, cfg.maxAttemptsPerRequest);
        this.store.updateMetrics((m) => {
          m.outputs_ok += 1;
          if (result.grounding_failed) m.grounding_failed += 1;
          if (result.edge_deviation) m.edge_deviations += 1;
          m.superseded += superseded.length;
          const cell = `${output.kind}|${output.cause}|${output.edge_status}`;
          m.by_cell[cell] = (m.by_cell[cell] ?? 0) + 1;
        });
        const outcome: AnalyzeOutcome = {
          output,
          source: result.grounding_failed ? "downgraded" : "model",
          attempts: result.attempts,
          latency_ms: Date.now() - started,
          superseded,
        };
        this.onOutput?.(outcome, request);
        return outcome;
      }

      // Persistent failure: fallback output, attempt ledger, never fabricate.
      const output = failedOutput(request, result.reason, input.reaction_state, envelope);
      this.store.put(output);
      this.store.recordAttempt(request.request_id, request.incident_id, result.reason, producedAt, cfg.maxAttemptsPerRequest);
      this.store.updateMetrics((m) => {
        m.outputs_failed += 1;
      });
      const outcome: AnalyzeOutcome = {
        output,
        source: "failed",
        attempts: result.attempts,
        latency_ms: Date.now() - started,
        superseded: [],
      };
      this.onOutput?.(outcome, request);
      return outcome;
    } finally {
      release();
    }
  }

  /**
   * Analyze many requests under the concurrency cap. A breaker-open error
   * stops the batch (remaining requests are reported, not attempted); other
   * per-request errors are captured per item.
   */
  async analyzeBatch(
    requests: AnalystRequest[],
  ): Promise<Array<{ request: AnalystRequest; outcome: AnalyzeOutcome | null; error: string | null }>> {
    const results: Array<{ request: AnalystRequest; outcome: AnalyzeOutcome | null; error: string | null }> = [];
    let halted: string | null = null;
    await Promise.all(
      requests.map(async (request, i) => {
        if (halted) {
          results[i] = { request, outcome: null, error: halted };
          return;
        }
        try {
          results[i] = { request, outcome: await this.analyze(request), error: null };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof AnalystBreakerOpenError) halted = message;
          results[i] = { request, outcome: null, error: message };
        }
      }),
    );
    return results;
  }

  // ---------------------------------------------------------------------------
  // Call loop: validation retries × transport retries (§5, §8)
  // ---------------------------------------------------------------------------

  private async callLoop(
    input: AssembledInput,
  ): Promise<
    | { ok: true; output: ModelOutput; attempts: number; grounding_failed: boolean; edge_deviation: boolean; retry_errors: string[] }
    | { ok: false; reason: string; attempts: number; retry_errors: string[] }
  > {
    const cfg = this.config;
    const ctx: ValidationContext = {
      refs: input.refs,
      evidence_ids: input.evidence_ids,
      reaction_state: input.reaction_state,
      config: cfg,
    };
    const prompt = buildAnalystPrompt(input, promptVersionFor(input.kind, cfg));
    let attempts = 0;
    let lastErrors: string[] = [];
    const retryErrors: string[] = [];
    let lastDowngrade: { output: ModelOutput; edge_deviation: boolean } | null = null;

    for (let v = 0; v <= cfg.validationRetries; v++) {
      // §5: retries carry the validator error appended.
      const user =
        v >= 1 && lastErrors.length
          ? `${prompt.user}\n\nYour previous response failed validation: ${lastErrors.join("; ")}. Return a corrected JSON object that satisfies every rule.`
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
          const res = await this.callModel({
            system: prompt.system,
            user,
            model: cfg.model,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens,
            timeout_ms: cfg.timeoutMs,
            output_schema: MODEL_OUTPUT_JSON_SCHEMA,
            effort: cfg.effort,
            signal: controller.signal,
          });
          const latency = Date.now() - callStart;
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
          const message = aborted
            ? `timeout after ${cfg.timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err);
          this.store.updateMetrics((m) => {
            m.transport_failures += 1;
          });
          this.noteTransportFailure();
          lastErrors = [`transport: ${message}`];
          if (isNonRetryableStatus(err) || this.breaker.status === "open") {
            return { ok: false, reason: lastErrors[0], attempts, retry_errors: retryErrors };
          }
          if (t < cfg.transportRetries) {
            retryErrors.push(lastErrors[0]);
            await this.sleep(cfg.retryBackoffMs * 2 ** t);
            continue;
          }
          return { ok: false, reason: lastErrors[0], attempts, retry_errors: retryErrors };
        } finally {
          clearTimeout(timer);
        }
      }
      if (text === null) {
        // Unreachable: the transport loop either breaks with text or returns.
        return { ok: false, reason: new AnalystTransportError("no response").message, attempts, retry_errors: retryErrors };
      }

      const validated = validateModelOutput(text, ctx);
      if (validated.ok) {
        return { ok: true, output: validated.output, attempts, grounding_failed: false, edge_deviation: validated.edge_deviation, retry_errors: retryErrors };
      }
      lastErrors = validated.errors;
      if (v < cfg.validationRetries) retryErrors.push(`validation: ${validated.errors.join("; ")}`);
      lastDowngrade = validated.grounding_only && validated.downgraded ? { output: validated.downgraded, edge_deviation: validated.edge_deviation } : null;
      this.store.updateMetrics((m) => {
        m.validation_failures += 1;
      });
    }

    // §5: grounding failed on every attempt → downgrade to unidentified with
    // the grounding_failed flag, never silently accepted, never fabricated.
    if (lastDowngrade) {
      return { ok: true, output: lastDowngrade.output, attempts, grounding_failed: true, edge_deviation: lastDowngrade.edge_deviation, retry_errors: retryErrors };
    }
    return { ok: false, reason: `validation: ${lastErrors.join("; ")}`, attempts, retry_errors: retryErrors };
  }
}

// ---------------------------------------------------------------------------
// Metrics helpers (§11)
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Fable 5 list price: $10/M input, $50/M output (thinking bills as output). Estimate only. */
export function estimateSpendUsd(metrics: Pick<AnalystMetrics, "input_tokens" | "output_tokens">): number {
  return metrics.input_tokens * 1e-6 * 10 + metrics.output_tokens * 1e-6 * 50;
}
