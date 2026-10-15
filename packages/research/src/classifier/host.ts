import fs from "node:fs";
import path from "node:path";
import {
  BaseConfigStore,
  applyBudget,
  buildClassificationRequests,
  budgetRemaining,
  consumeBudget,
  etDayOf,
  lookupFromVerdicts,
  replayBase,
  type BaseConfig,
  type BudgetLedger,
  type VerdictLookup,
} from "../base/index.js";
// Direct module imports, not the barrel: the barrel re-exports this host, and
// a host that imports its own barrel is a cycle.
import { ClassifierConfigStore, FileBackend, VerdictStore } from "./store.js";
import { ClassifierService, estimateSpendUsd, percentile } from "./service.js";
import { CompanyMetadataStore } from "./metadata.js";
import { anthropicConfigured, anthropicModelCaller } from "./anthropic.js";
import { evaluateClassifier, loadLabeledSet, type EvalReport } from "./eval.js";
import type { ClassifierConfig } from "./config.js";
import type { ArticleInput, Verdict } from "./types.js";
import { ClassifierBreakerOpenError } from "./types.js";
import { cycleBudget, feedArticleInput, planFeedLane, planHeadlines, type FeedStory } from "./feed-lane.js";
import { headlineAttemptKey } from "./service.js";
import type { NewsItemPayload } from "../tracker/types.js";
import { getTrackerEngine } from "../tracker/index.js";
import type { ClassifierRunSummary, ClassifierStatus } from "./host-types.js";

/**
 * Classifier host — the main-process owner of the Classifier service.
 *
 * Phase A (log-only, spec §13): on a 15-minute cycle — or on demand from the
 * panel — it builds Base's classification requests from Tracker's recorded
 * stream (lead ticker set ≤ cap, addenda for uncovered followers), applies the
 * §9 daily budget with priority ordering, and runs them through the service.
 * Verdicts land in the verdict store and are displayed; whether they change
 * scoring is Base's Phase B switch (`classifier.rescoreEnabled`), read by the
 * Base replay through `verdictLookup()`.
 *
 * The loop is OFF by default (`ClassifierConfig.enabled`): it spends the
 * user's Anthropic quota, so it is opted into from the panel.
 */
/**
 * Deployment-level switch for the Phase A loop, same shape as
 * FALCON_PROPAGATION_ENABLED: a headless service has no panel and its config
 * file lives on a volume nobody can edit, so the deployment can say it. Read
 * at boot and it wins over the stored value; `setEnabled()` still works at
 * runtime until the next restart. Unset leaves the stored value alone.
 */
export function classifierEnabledFromEnv(): boolean | null {
  const raw = process.env.FALCON_CLASSIFIER_ENABLED?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  console.warn(`[classifier] FALCON_CLASSIFIER_ENABLED="${raw}" is not a boolean, ignoring`);
  return null;
}

export class ClassifierHost {
  readonly configStore = new ClassifierConfigStore();
  readonly baseConfigStore = new BaseConfigStore();
  config: ClassifierConfig;
  readonly verdictStore: VerdictStore;
  readonly metadata: CompanyMetadataStore;
  readonly service: ClassifierService;
  readonly cycleIntervalMs = 15 * 60_000;

  private budget: BudgetLedger | null;
  private timer: NodeJS.Timeout | null = null;
  private nextCycleAt: string | null = null;
  private running = false;
  private lastRun: ClassifierRunSummary | null = null;
  private metadataRefreshedAt = 0;
  private newsFeedSource: (() => Promise<FeedStory[]>) | null = null;

  constructor() {
    this.config = this.configStore.load();
    const fromEnv = classifierEnabledFromEnv();
    if (fromEnv !== null && fromEnv !== this.config.enabled) {
      console.info(`[classifier] loop ${fromEnv ? "on" : "off"} by FALCON_CLASSIFIER_ENABLED (stored: ${this.config.enabled})`);
      this.config = { ...this.config, enabled: fromEnv };
    }
    this.verdictStore = new VerdictStore(new FileBackend(this.configStore.dataDir));
    this.metadata = new CompanyMetadataStore(this.configStore.metadataFile);
    this.service = new ClassifierService({
      config: this.config,
      store: this.verdictStore,
      callModel: anthropicModelCaller,
    });
    this.budget = this.readBudget();
    // A credential outage leaves rows that would keep their articles skipped
    // long after the credential is fixed; on a mounted volume they outlive
    // every redeploy. Heal on boot.
    const pruned = this.verdictStore.pruneCredentialFailures();
    if (pruned.attempts || pruned.verdicts) {
      console.info(
        `[classifier] cleared ${pruned.attempts} attempt row(s) and ${pruned.verdicts} failed verdict(s) left by a rejected credential`,
      );
    }
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
      console.warn("[classifier] enabled but ANTHROPIC_API_KEY is not set — loop not started");
      return;
    }
    const schedule = () => {
      this.nextCycleAt = new Date(Date.now() + this.cycleIntervalMs).toISOString();
      this.timer = setTimeout(() => {
        void this.runCycle({}).finally(schedule);
      }, this.cycleIntervalMs);
    };
    // First cycle shortly after launch so the Tracker has had time to load.
    this.nextCycleAt = new Date(Date.now() + 60_000).toISOString();
    this.timer = setTimeout(() => {
      void this.runCycle({}).finally(schedule);
    }, 60_000);
    console.info(`[classifier] Phase A loop started (every ${this.cycleIntervalMs / 60_000} min, model ${this.config.model})`);
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

  setRescoreEnabled(enabled: boolean): void {
    const base = this.baseConfig();
    this.baseConfigStore.save({ ...base, classifier: { ...base.classifier, rescoreEnabled: enabled } });
  }

  /**
   * Where the News card's feed lives, so a cycle can classify the feed's
   * uncovered stories and write Falcon headlines for the material ones (see
   * feed-lane.ts). The engine points it at its article store; without it the
   * cycle classifies the Tracker's stream only, as before.
   */
  setNewsFeedSource(source: (() => Promise<FeedStory[]>) | null): void {
    this.newsFeedSource = source;
  }

  reloadConfig(): void {
    this.config = this.configStore.load();
    this.service.setConfig(this.config);
  }

  // ---------------------------------------------------------------------------
  // Verdict lookup for Base
  // ---------------------------------------------------------------------------

  verdictLookup(baseConfig: BaseConfig): VerdictLookup {
    return lookupFromVerdicts(this.verdictStore.list(), baseConfig);
  }

  listVerdicts(limit = 200): Verdict[] {
    return this.verdictStore.list({ limit });
  }

  // ---------------------------------------------------------------------------
  // One batch cycle
  // ---------------------------------------------------------------------------

  async runCycle(options: { limit?: number; dryRun?: boolean; maxRequests?: number }): Promise<ClassifierRunSummary> {
    if (this.running) {
      return this.lastRun ?? this.emptyRun("a cycle is already running");
    }
    this.running = true;
    const started = new Date().toISOString();
    const errors: string[] = [];
    try {
      const baseConfig = this.baseConfig();
      const engine = getTrackerEngine();
      const messages = engine.listMessages({ limit: options.limit ?? 3000 });

      // §2 metadata — seed/refresh the tracked universe weekly (best effort).
      const tickers = [...new Set(messages.map((m) => m.ticker))];
      if (!options.dryRun && Date.now() - this.metadataRefreshedAt > 60 * 60_000) {
        try {
          const r = await this.metadata.refresh(tickers, { config: this.config });
          if (r.failed.length) errors.push(`metadata: ${r.failed.length} ticker(s) failed (${r.failed[0].error})`);
          this.metadataRefreshedAt = Date.now();
        } catch (err) {
          errors.push(`metadata: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const now = new Date().toISOString();
      const built = buildClassificationRequests(messages, {
        config: baseConfig,
        tickerContext: (t) => this.metadata.context(t),
        existingVerdict: (key) =>
          this.verdictStore.get(key, this.config.promptVersion, this.config.model, now, this.config.verdictTtlDays),
        now,
      });

      // Drop permanent-failed articles before they consume budget (§9).
      const eligible = built.requests.filter((r) => {
        const key = r.article?.article_key ?? r.filing?.article_key ?? "";
        return !this.verdictStore.attemptsFor(key)?.permanent_failed;
      });

      // Priority ordering from the Base replay: an article's best incident priority.
      const replay = replayBase(messages, { config: baseConfig, now });
      const priorityByMessage = new Map<string, number>();
      for (const { incident } of replay.incidents) {
        for (const m of incident.messages) {
          priorityByMessage.set(m.id, Math.max(priorityByMessage.get(m.id) ?? 0, incident.priority));
        }
      }
      const keyPriority = new Map<string, number>();
      for (const m of messages) {
        const p = priorityByMessage.get(m.id);
        if (p === undefined) continue;
        const a = (m.payload as { article_id?: string; accession_number?: string });
        const keys = [a.article_id ? `id:${a.article_id}` : null, a.accession_number ? `8k:${a.accession_number}` : null];
        for (const k of keys) if (k) keyPriority.set(k, Math.max(keyPriority.get(k) ?? 0, p));
      }

      const remaining = Math.min(
        budgetRemaining(this.budget, now, baseConfig),
        options.maxRequests ?? Number.POSITIVE_INFINITY,
      );

      // The News card's feed: its uncovered stories go first (feed lane),
      // and a slice of the budget is held back for Falcon headlines.
      let feed: FeedStory[] = [];
      if (this.newsFeedSource) {
        try {
          feed = await this.newsFeedSource();
        } catch (err) {
          errors.push(`feed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const { lane, rest } = planFeedLane({
        feed,
        requests: eligible,
        covered: (key) => {
          const v = this.verdictStore.latestFor(key);
          return v?.status === "ok" || Boolean(this.verdictStore.attemptsFor(key)?.permanent_failed);
        },
        tickerContext: (t) => this.metadata.context(t),
        config: this.config,
        now,
        budget: remaining,
      });
      // Base's queue may not spend the day's last `feedDailyReserve` units:
      // they are kept for the card's lanes, so stories published late in the
      // day still get a verdict and a headline after a backlog has eaten the
      // rest of the budget in the first cycle after midnight.
      const { baseQueue } = cycleBudget({
        remaining,
        laneSize: lane.length,
        headlineBatchPerCycle: this.newsFeedSource ? this.config.headlineBatchPerCycle : 0,
        floor: this.newsFeedSource ? Math.min(this.config.feedDailyReserve, baseConfig.classifier.dailyBudget) : 0,
      });
      const queued = applyBudget(
        rest,
        (r) => keyPriority.get(r.article?.article_key ?? r.filing?.article_key ?? "") ?? 0,
        baseQueue,
      );
      const dispatch = [...lane, ...queued.dispatch];
      const deferred = queued.deferred;

      let ok = 0;
      let failed = 0;
      let cacheHits = 0;
      let merged = 0;
      let skipped = 0;
      if (!options.dryRun && dispatch.length > 0) {
        const results = await this.service.classifyBatch(dispatch);
        let consumed = 0;
        for (const r of results) {
          if (r.error) {
            errors.push(r.error);
            // Only what was actually paid for. A breaker-open refusal never
            // reached the provider, and charging it drains the day's cap the
            // instant the breaker trips — which is precisely when the chain
            // most needs the budget still to be there.
            if (!r.billable) continue;
            // A transport failure still cost a call. Skipping the budget here
            // meant a 429 storm spent money the daily cap never saw: 1,225
            // failures against 567 successes in one day, with `used` sitting at
            // 500/500 the whole time. The budget bounds SPEND, so anything we
            // paid for counts — otherwise the one number meant to stop a
            // runaway is blind to the most likely kind.
            consumed += 1;
            failed += 1;
            continue;
          }
          const o = r.outcome!;
          if (o.source === "cache") cacheHits += 1;
          else if (o.source === "skipped") skipped += 1;
          else {
            consumed += 1;
            if (o.source === "failed") failed += 1;
            else {
              ok += 1;
              if (o.source === "merged") merged += 1;
            }
          }
        }
        this.budget = consumeBudget(this.budget, now, consumed);
        this.writeBudget();
        this.verdictStore.prune(now, this.config.verdictTtlDays);
      }

      let headlines = { written: 0, failed: 0 };
      if (!options.dryRun) {
        const left = Math.min(
          budgetRemaining(this.budget, now, baseConfig),
          options.maxRequests === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.maxRequests - dispatch.length),
        );
        headlines = await this.writeHeadlines({ messages, feed, now, limit: Math.min(this.config.headlineBatchPerCycle, left), errors });
      }

      this.lastRun = {
        started_at: started,
        finished_at: new Date().toISOString(),
        messages_scanned: messages.length,
        requests_built: built.requests.length,
        covered: built.covered,
        overflows: built.overflows,
        dispatched: options.dryRun ? 0 : dispatch.length,
        deferred_by_budget: deferred.length + (options.dryRun ? dispatch.length : 0),
        ok,
        failed,
        cache_hits: cacheHits,
        merged,
        skipped,
        errors: [...new Set(errors)].slice(0, 10),
        dry_run: Boolean(options.dryRun),
        feed_requests: options.dryRun ? 0 : lane.length,
        headlines_written: headlines.written,
        headlines_failed: headlines.failed,
      };
      console.info(
        `[classifier] cycle: ${messages.length} msgs → ${built.requests.length} req (${built.covered} covered) · dispatched ${this.lastRun.dispatched} (feed ${this.lastRun.feed_requests}) · ok ${ok} · failed ${failed} · headlines ${headlines.written}/${headlines.written + headlines.failed}` +
          (errors.length ? ` · errors ${errors.length}` : ""),
      );
      // On the desktop a failed cycle is one click from the panel that shows
      // why. A headless service has only this line, and a cycle where nothing
      // succeeded is exactly when the reason matters — so say it here.
      if (ok === 0 && this.lastRun.dispatched > 0 && this.lastRun.errors.length) {
        for (const reason of this.lastRun.errors.slice(0, 3)) {
          console.warn(`[classifier]   ${reason}`);
        }
      }
      return this.lastRun;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastRun = this.emptyRun(message, started);
      console.error("[classifier] cycle failed:", message);
      return this.lastRun;
    } finally {
      this.running = false;
    }
  }

  /**
   * Falcon headlines for material stories that have none (feed-lane.ts
   * `planHeadlines`), newest first, at most `limit`, each one charged to the
   * daily budget like a classification. A breaker-open refusal stops the lane
   * and is not charged: nothing was sent.
   */
  private async writeHeadlines(input: {
    messages: Array<{ type: string; payload: unknown; timestamp: string }>;
    feed: FeedStory[];
    now: string;
    limit: number;
    errors: string[];
  }): Promise<{ written: number; failed: number }> {
    if (input.limit <= 0) return { written: 0, failed: 0 };
    const texts = new Map<string, ArticleInput>();
    for (const story of input.feed) texts.set(`id:${story.id}`, feedArticleInput(story));
    for (const m of input.messages) {
      if (m.type !== "news_item") continue;
      const p = m.payload as NewsItemPayload;
      const id = p.article_id?.trim();
      if (!id || texts.has(`id:${id}`)) continue;
      texts.set(`id:${id}`, {
        article_key: `id:${id}`,
        headline: p.headline ?? "",
        summary: p.summary ?? "",
        source: p.source ?? "",
        published_at: p.published_at ?? m.timestamp,
        article_id: id,
      });
    }
    const jobs = planHeadlines({
      verdicts: this.verdictStore.list({ status: "ok" }),
      articleText: (key) => texts.get(key) ?? null,
      givenUp: (key) => Boolean(this.verdictStore.attemptsFor(headlineAttemptKey(key))?.permanent_failed),
      config: this.config,
      now: input.now,
      limit: input.limit,
    });
    if (jobs.length === 0) return { written: 0, failed: 0 };

    let written = 0;
    let failed = 0;
    let charged = 0;
    let halted = false;
    await Promise.all(
      jobs.map(async (job) => {
        if (halted) return;
        try {
          const outcome = await this.service.writeHeadline({
            article: job.article,
            tickers: job.tickers.map((t) => this.metadata.context(t)),
          });
          charged += 1;
          if (outcome.ok) written += 1;
          else {
            failed += 1;
            input.errors.push(`headline: ${outcome.reason}`);
          }
        } catch (err) {
          if (err instanceof ClassifierBreakerOpenError) {
            halted = true;
            input.errors.push(err.message);
            return;
          }
          charged += 1;
          failed += 1;
          input.errors.push(`headline: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    if (charged > 0) {
      this.budget = consumeBudget(this.budget, input.now, charged);
      this.writeBudget();
    }
    return { written, failed };
  }

  private emptyRun(error: string, started = new Date().toISOString()): ClassifierRunSummary {
    return {
      started_at: started,
      finished_at: new Date().toISOString(),
      messages_scanned: 0,
      requests_built: 0,
      covered: 0,
      overflows: 0,
      dispatched: 0,
      deferred_by_budget: 0,
      ok: 0,
      failed: 0,
      cache_hits: 0,
      merged: 0,
      skipped: 0,
      errors: [error],
      dry_run: false,
      feed_requests: 0,
      headlines_written: 0,
      headlines_failed: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Status / eval
  // ---------------------------------------------------------------------------

  status(): ClassifierStatus {
    const baseConfig = this.baseConfig();
    const metrics = this.service.getMetrics();
    const now = new Date().toISOString();
    const day = etDayOf(now);
    const used = this.budget && this.budget.day === day ? this.budget.used : 0;
    return {
      enabled: this.config.enabled,
      configured: anthropicConfigured(),
      running: this.running,
      rescore_enabled: baseConfig.classifier.rescoreEnabled,
      model: this.config.model,
      prompt_version: this.config.promptVersion,
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
        remaining: budgetRemaining(this.budget, now, baseConfig),
        daily: baseConfig.classifier.dailyBudget,
      },
      verdict_count: this.verdictStore.size(),
      failure_reasons: this.verdictStore.failureReasons(),
      permanent_failures: this.verdictStore.permanentFailures().length,
      metadata_rows: this.metadata.list().length,
      last_run: this.lastRun,
      data_dir: this.configStore.dataDir,
    };
  }

  async refreshMetadata(force: boolean): Promise<{ refreshed: number; failed: number }> {
    const engine = getTrackerEngine();
    const tickers = engine.getStatus().tickers.map((t) => t.ticker);
    const r = await this.metadata.refresh(tickers, { config: this.config, force });
    this.metadataRefreshedAt = Date.now();
    return { refreshed: r.refreshed.length, failed: r.failed.length };
  }

  /** §13 gate: score the verdict store against a labeled set on disk. */
  async runEval(file: string): Promise<EvalReport> {
    const labeled = loadLabeledSet(file);
    return evaluateClassifier(labeled, (req) => this.verdictStore.latestFor(req.article?.article_key ?? req.filing?.article_key ?? ""), this.config);
  }
}

let host: ClassifierHost | null = null;

export function getClassifierHost(): ClassifierHost {
  if (!host) host = new ClassifierHost();
  return host;
}
