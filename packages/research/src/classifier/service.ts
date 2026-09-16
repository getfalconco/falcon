/**
 * Classifier service layer (§8–§9).
 *
 * Wraps the single LLM call with: verdict-store lookup (cache), the §7
 * validation retry loop, per-call timeout, transport retry with backoff, a
 * concurrency cap, the circuit breaker, addendum merging with
 * first-writer-wins + disagreement counting, the §9 attempt ledger and the
 * §12 metrics. The model call itself is injected (`ModelCaller`) so every
 * test runs against recorded fixtures, never live calls.
 *
 * A verdict is never fabricated: persistent failure yields `status: "failed"`
 * and Base keeps the base severity contribution for that message.
 */

import { buildClassifierPrompt } from "./prompt.js";
import {
  MODEL_OUTPUT_JSON_SCHEMA,
  articleKeyOf,
  assembleVerdict,
  failedVerdict,
  validateModelOutput,
} from "./schema.js";
import { VerdictStore } from "./store.js";
import type { ClassifierConfig } from "./config.js";
import {
  ClassifierBreakerOpenError,
  ClassifierTransportError,
  type BreakerState,
  type ClassificationRequest,
  type ClassifierMetrics,
  type ModelCaller,
  type ModelOutput,
  type TickerVerdict,
  type Verdict,
} from "./types.js";

export type ClassifyOutcome = {
  verdict: Verdict;
  /**
   * cache   — served from the verdict store, no call made
   * model   — fresh lead verdict from the model
   * merged  — addendum entries merged into an existing verdict
   * failed  — persistent failure; fallback verdict
   * skipped — permanent-failed article, no further attempts (§9)
   */
  source: "cache" | "model" | "merged" | "failed" | "skipped";
  attempts: number;
  latency_ms: number;
};

export type ClassifierServiceOptions = {
  config: ClassifierConfig;
  store?: VerdictStore;
  callModel: ModelCaller;
  /** Clock injection (§8 determinism in tests). */
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onVerdict?: (outcome: ClassifyOutcome, request: ClassificationRequest) => void;
};

type MergeResult = { verdict: Verdict; disagreement: boolean; added: string[] };

/**
 * §3/§8 addendum merge: per-ticker entries are added for tickers the existing
 * verdict does not cover; article-level fields (event_type, event_label) are
 * first-writer-wins. A differing event_type is reported as a disagreement so
 * the metric — not the merge — decides later whether it matters.
 */
export function mergeAddendum(existing: Verdict, addendum: ModelOutput, classifiedAt: string): MergeResult {
  const covered = new Set(existing.tickers.map((t) => t.ticker));
  const added: string[] = [];
  const tickers: TickerVerdict[] = [...existing.tickers];
  for (const entry of addendum.tickers) {
    if (covered.has(entry.ticker)) continue;
    tickers.push(entry);
    covered.add(entry.ticker);
    added.push(entry.ticker);
  }
  const unassessed = existing.unassessed_tickers.filter((t) => !covered.has(t));
  const disagreement = existing.status === "ok" && addendum.event_type !== existing.event_type;
  const verdict: Verdict = {
    ...existing,
    // A failed lead has no article-level fields worth keeping: the addendum's are the first writer.
    event_type: existing.status === "ok" ? existing.event_type : addendum.event_type,
    event_label: existing.status === "ok" ? existing.event_label : addendum.event_label,
    status: "ok",
    failure_reason: null,
    tickers,
    unassessed_tickers: unassessed,
    // classified_at stays the lead's (first-writer); the merge instant is not a field of the wire verdict.
    classified_at: existing.status === "ok" ? existing.classified_at : classifiedAt,
  };
  return { verdict, disagreement, added };
}

/** Tickers in the request that the verdict does not already carry. */
export function uncoveredTickers(verdict: Verdict | null, request: ClassificationRequest): string[] {
  if (!verdict || verdict.status !== "ok") return request.tickers.map((t) => t.ticker.toUpperCase());
  const covered = new Set(verdict.tickers.map((t) => t.ticker.toUpperCase()));
  return request.tickers.map((t) => t.ticker.toUpperCase()).filter((t) => !covered.has(t));
}

function isNonRetryableStatus(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number") return false;
  // 408 (timeout) and 429 (rate limit) are retryable; other 4xx are not.
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * A rejected credential is a configuration error, not a bad minute: every
 * subsequent call fails identically. Waiting for `k` consecutive failures to
 * open the breaker spends `k` requests and `k` slices of the daily budget on a
 * verdict that cannot arrive, so an auth failure opens it on the first one.
 */
function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 401 || status === 403;
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

export class ClassifierService {
  readonly store: VerdictStore;
  private readonly callModel: ModelCaller;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onVerdict?: ClassifierServiceOptions["onVerdict"];
  private semaphore: Semaphore;
  private breaker: BreakerState = { status: "closed", consecutive_failures: 0, open_until: null, trips: 0 };
  config: ClassifierConfig;

  constructor(options: ClassifierServiceOptions) {
    this.config = options.config;
    this.store = options.store ?? new VerdictStore();
    this.callModel = options.callModel;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onVerdict = options.onVerdict;
    this.semaphore = new Semaphore(Math.max(1, options.config.concurrency));
    // Persisted breaker trips are informational; a fresh process starts closed.
    this.breaker.trips = this.store.getMetrics().breaker_trips;
  }

  /** Swap config at runtime (panel edits). Concurrency changes apply to new acquisitions. */
  setConfig(config: ClassifierConfig): void {
    this.config = config;
    this.semaphore = new Semaphore(Math.max(1, config.concurrency));
  }

  // ---------------------------------------------------------------------------
  // Breaker (§9)
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

  private noteTransportFailure(options?: { immediate?: boolean }): void {
    this.breaker.consecutive_failures += 1;
    if (
      this.breaker.status === "closed" &&
      (options?.immediate === true ||
        this.breaker.consecutive_failures >= this.config.breaker.consecutiveFailures)
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
  // Classify
  // ---------------------------------------------------------------------------

  getMetrics(): ClassifierMetrics {
    return this.store.getMetrics();
  }

  get inFlight(): number {
    return this.semaphore.inFlight;
  }

  /**
   * Classify one request. Resolves the cache first, then runs the call loop.
   * Throws `ClassifierBreakerOpenError` when the breaker is open — Base's
   * queue holds the request; nothing is fabricated.
   */
  async classify(request: ClassificationRequest): Promise<ClassifyOutcome> {
    const cfg = this.config;
    const key = articleKeyOf(request);
    const now = this.now();
    const cached = this.store.get(key, cfg.promptVersion, cfg.model, now, cfg.verdictTtlDays);

    // §9: permanent-failed articles are not retried.
    const ledger = this.store.attemptsFor(key);
    if (cached?.status === "failed" && ledger?.permanent_failed) {
      const outcome: ClassifyOutcome = { verdict: cached, source: "skipped", attempts: 0, latency_ms: 0 };
      return outcome;
    }

    const missing = uncoveredTickers(cached, request);
    if (cached?.status === "ok" && missing.length === 0) {
      this.store.updateMetrics((m) => {
        m.cache_hits += 1;
      });
      const outcome: ClassifyOutcome = { verdict: cached, source: "cache", attempts: 0, latency_ms: 0 };
      this.onVerdict?.(outcome, request);
      return outcome;
    }

    // An addendum (explicit, or implied by a partially-covered lead) carries
    // only the uncovered tickers to the model.
    const effective: ClassificationRequest =
      cached?.status === "ok"
        ? {
            ...request,
            mode: "addendum",
            tickers: request.tickers.filter((t) => missing.includes(t.ticker.toUpperCase())),
          }
        : request;

    this.tickBreaker();
    if (this.breaker.status === "open" && this.breaker.open_until) {
      throw new ClassifierBreakerOpenError(this.breaker.open_until);
    }

    if (effective.mode === "lead" && effective.unassessed_tickers.length > 0) {
      this.store.updateMetrics((m) => {
        m.overflows += 1;
      });
    }

    const release = await this.semaphore.acquire();
    // Re-check after waiting on the semaphore: a batch queues many requests
    // past the first check, and the breaker may have opened while this one
    // waited. Without this every queued request still makes one call.
    this.tickBreaker();
    if (this.breaker.status === "open" && this.breaker.open_until) {
      release();
      throw new ClassifierBreakerOpenError(this.breaker.open_until);
    }
    const started = Date.now();
    try {
      const result = await this.callLoop(effective);
      const classifiedAt = this.now();
      const envelope = { prompt_version: cfg.promptVersion, model: cfg.model, classified_at: classifiedAt };

      if (result.ok) {
        let verdict: Verdict;
        let source: ClassifyOutcome["source"];
        if (cached?.status === "ok") {
          const merged = mergeAddendum(cached, result.output, classifiedAt);
          verdict = merged.verdict;
          source = "merged";
          this.store.updateMetrics((m) => {
            m.addenda += 1;
            if (merged.disagreement) m.verdict_disagreements += 1;
          });
        } else {
          verdict = assembleVerdict(effective, result.output, envelope);
          source = "model";
          if (effective.mode === "addendum") {
            this.store.updateMetrics((m) => {
              m.addenda += 1;
            });
          }
        }
        this.store.put(verdict);
        this.store.recordAttempt(key, null, classifiedAt, cfg.maxAttemptsPerArticle);
        this.store.updateMetrics((m) => {
          m.verdicts_ok += 1;
          for (const t of result.output.tickers) {
            const cell = `${verdict.event_type}|${t.relevance}|${t.relevance === "none" ? "-" : t.materiality}`;
            m.by_cell[cell] = (m.by_cell[cell] ?? 0) + 1;
          }
        });
        const outcome: ClassifyOutcome = {
          verdict,
          source,
          attempts: result.attempts,
          latency_ms: Date.now() - started,
        };
        this.onVerdict?.(outcome, request);
        return outcome;
      }

      // Persistent failure: fallback verdict, attempt ledger, never fabricate.
      const verdict = cached?.status === "ok" ? cached : failedVerdict(effective, result.reason, envelope);
      if (cached?.status !== "ok") this.store.put(verdict);
      // A rejected credential is not a fact about this article — it never got a
      // real attempt. Charging it to the ledger would mark articles
      // permanent-failed for a config outage, and they would stay skipped long
      // after the credential was fixed.
      if (!result.reason.startsWith("auth:")) {
        this.store.recordAttempt(key, result.reason, classifiedAt, cfg.maxAttemptsPerArticle);
      }
      this.store.updateMetrics((m) => {
        m.verdicts_failed += 1;
      });
      const outcome: ClassifyOutcome = {
        verdict,
        source: "failed",
        attempts: result.attempts,
        latency_ms: Date.now() - started,
      };
      this.onVerdict?.(outcome, request);
      return outcome;
    } finally {
      release();
    }
  }

  /**
   * Classify many requests under the concurrency cap. A breaker-open error
   * stops the batch (remaining requests are reported, not attempted); other
   * per-request errors are captured per item.
   */
  /**
   * `billable` distinguishes a call that was PAID FOR from one that never left.
   *
   * A transport failure spent money and must count against the daily cap. A
   * breaker-open refusal did not: nothing was sent. Conflating them drains the
   * whole remaining budget the moment the breaker trips — 8 real failures
   * consumed 531 units of budget once, because `Promise.all` starts every
   * request before the first one can set `halted`, so the rest arrive at a
   * breaker that is already open and fail without ever making a call.
   */
  async classifyBatch(
    requests: ClassificationRequest[],
  ): Promise<
    Array<{
      request: ClassificationRequest;
      outcome: ClassifyOutcome | null;
      error: string | null;
      billable: boolean;
    }>
  > {
    const results: Array<{
      request: ClassificationRequest;
      outcome: ClassifyOutcome | null;
      error: string | null;
      billable: boolean;
    }> = [];
    let halted: string | null = null;
    await Promise.all(
      requests.map(async (request, i) => {
        if (halted) {
          results[i] = { request, outcome: null, error: halted, billable: false };
          return;
        }
        try {
          results[i] = { request, outcome: await this.classify(request), error: null, billable: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const breakerOpen = err instanceof ClassifierBreakerOpenError;
          if (breakerOpen) halted = message;
          results[i] = { request, outcome: null, error: message, billable: !breakerOpen };
        }
      }),
    );
    return results;
  }

  // ---------------------------------------------------------------------------
  // Call loop: validation retries × transport retries
  // ---------------------------------------------------------------------------

  private async callLoop(
    request: ClassificationRequest,
  ): Promise<{ ok: true; output: ModelOutput; attempts: number } | { ok: false; reason: string; attempts: number }> {
    const cfg = this.config;
    let attempts = 0;
    let lastErrors: string[] = [];

    for (let v = 0; v <= cfg.validationRetries; v++) {
      const prompt = buildClassifierPrompt(request, cfg.promptVersion);
      // §7: the second retry appends the validator error to the request.
      const user =
        v >= 2 && lastErrors.length
          ? `${prompt.user}\n\nYour previous response failed validation: ${lastErrors.join("; ")}. Return a corrected JSON verdict.`
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
            signal: controller.signal,
          });
          const latency = Date.now() - callStart;
          this.store.updateMetrics((m) => {
            m.input_tokens += res.input_tokens;
            m.cache_creation_tokens += res.cache_creation_tokens ?? 0;
            m.cache_read_tokens += res.cache_read_tokens ?? 0;
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
          const auth = isAuthFailure(err);
          this.noteTransportFailure({ immediate: auth });
          lastErrors = [
            auth
              ? `auth: the provider rejected the credential (${message}). Check ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in this process.`
              : `transport: ${message}`,
          ];
          if (isNonRetryableStatus(err) || this.breaker.status === "open") {
            return { ok: false, reason: lastErrors[0], attempts };
          }
          if (t < cfg.transportRetries) {
            await this.sleep(cfg.retryBackoffMs * 2 ** t);
            continue;
          }
          return { ok: false, reason: lastErrors[0], attempts };
        } finally {
          clearTimeout(timer);
        }
      }
      if (text === null) {
        // Unreachable: the transport loop either breaks with text or returns.
        return { ok: false, reason: new ClassifierTransportError("no response").message, attempts };
      }

      const validated = validateModelOutput(text, request);
      if (validated.ok) return { ok: true, output: validated.output, attempts };
      lastErrors = validated.errors;
      this.store.updateMetrics((m) => {
        m.validation_failures += 1;
      });
    }
    return { ok: false, reason: `validation: ${lastErrors.join("; ")}`, attempts };
  }
}

// ---------------------------------------------------------------------------
// Metrics helpers (§12)
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Rough Haiku 4.5 list price: $1/M input, $5/M output. Estimate only. */
export function estimateSpendUsd(metrics: Pick<ClassifierMetrics, "input_tokens" | "output_tokens">): number {
  return metrics.input_tokens * 1e-6 * 1 + metrics.output_tokens * 1e-6 * 5;
}
