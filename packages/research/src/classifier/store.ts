/**
 * Classifier persistence (§8): the verdict store keyed
 * (article_key, prompt_version, model) with a TTL, the attempt ledger for
 * failed articles (§9), the metrics snapshot and the config file.
 *
 * Everything is JSON under the classifier data dir so it survives restarts.
 * Writes are atomic (tmp + rename). Tests use an in-memory instance.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../tracker/store.js";
import { DEFAULT_CLASSIFIER_CONFIG, mergeClassifierConfig, type ClassifierConfig } from "./config.js";
import { coerceStoredVerdict } from "./schema.js";
import type { ClassifierMetrics, Verdict } from "./types.js";

export function resolveClassifierDataDir(): string {
  const fromEnv = process.env.FALCON_CLASSIFIER_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "classifier");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

export function verdictKey(articleKey: string, promptVersion: string, model: string): string {
  return `${articleKey}|${promptVersion}|${model}`;
}

export function emptyMetrics(): ClassifierMetrics {
  return {
    verdicts_ok: 0,
    verdicts_failed: 0,
    validation_failures: 0,
    transport_failures: 0,
    retries: 0,
    breaker_trips: 0,
    addenda: 0,
    verdict_disagreements: 0,
    overflows: 0,
    cache_hits: 0,
    latencies_ms: [],
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    by_cell: {},
  };
}

export type AttemptRecord = {
  article_key: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string;
  /** §9: after maxAttemptsPerArticle total attempts. */
  permanent_failed: boolean;
};

type VerdictFile = { schema_version: 1; verdicts: Record<string, Verdict> };
type AttemptsFile = { schema_version: 1; attempts: Record<string, AttemptRecord> };
type MetricsFile = { schema_version: 1; metrics: ClassifierMetrics };

/**
 * Persistence backend. `FileBackend` writes JSON files; `MemoryBackend` is
 * for tests and the eval harness.
 */
export interface ClassifierBackend {
  readVerdicts(): Record<string, Verdict>;
  writeVerdicts(v: Record<string, Verdict>): void;
  readAttempts(): Record<string, AttemptRecord>;
  writeAttempts(a: Record<string, AttemptRecord>): void;
  readMetrics(): ClassifierMetrics | null;
  writeMetrics(m: ClassifierMetrics): void;
}

export class MemoryBackend implements ClassifierBackend {
  private verdicts: Record<string, Verdict> = {};
  private attempts: Record<string, AttemptRecord> = {};
  private metrics: ClassifierMetrics | null = null;
  readVerdicts() {
    return structuredClone(this.verdicts);
  }
  writeVerdicts(v: Record<string, Verdict>) {
    this.verdicts = structuredClone(v);
  }
  readAttempts() {
    return structuredClone(this.attempts);
  }
  writeAttempts(a: Record<string, AttemptRecord>) {
    this.attempts = structuredClone(a);
  }
  readMetrics() {
    return this.metrics ? structuredClone(this.metrics) : null;
  }
  writeMetrics(m: ClassifierMetrics) {
    this.metrics = structuredClone(m);
  }
}

export class FileBackend implements ClassifierBackend {
  constructor(readonly dir: string = resolveClassifierDataDir()) {}
  get verdictsFile() {
    return path.join(this.dir, "verdicts.json");
  }
  get attemptsFile() {
    return path.join(this.dir, "attempts.json");
  }
  get metricsFile() {
    return path.join(this.dir, "metrics.json");
  }
  readVerdicts() {
    const parsed = readJson<VerdictFile>(this.verdictsFile);
    const out: Record<string, Verdict> = {};
    if (parsed?.verdicts && typeof parsed.verdicts === "object") {
      for (const [key, raw] of Object.entries(parsed.verdicts)) {
        const v = coerceStoredVerdict(raw);
        if (v) out[key] = v;
      }
    }
    return out;
  }
  writeVerdicts(verdicts: Record<string, Verdict>) {
    writeJsonAtomic(this.verdictsFile, { schema_version: 1, verdicts } satisfies VerdictFile);
  }
  readAttempts() {
    return readJson<AttemptsFile>(this.attemptsFile)?.attempts ?? {};
  }
  writeAttempts(attempts: Record<string, AttemptRecord>) {
    writeJsonAtomic(this.attemptsFile, { schema_version: 1, attempts } satisfies AttemptsFile);
  }
  readMetrics() {
    return readJson<MetricsFile>(this.metricsFile)?.metrics ?? null;
  }
  writeMetrics(metrics: ClassifierMetrics) {
    writeJsonAtomic(this.metricsFile, { schema_version: 1, metrics } satisfies MetricsFile);
  }
}

/**
 * The verdict store (§8). Owned by Classifier; Base owns request dedupe and
 * the in-flight set. Expiry is evaluated on read against the caller's `now`
 * so replay and tests are deterministic.
 */
/**
 * How much of a failure's text is kept, per row.
 *
 * A provider error is a whole response body — an HTML page from a gateway
 * runs to a hundred kilobytes — and both ledgers stored it verbatim, one row
 * per article, and rewrote the entire file on every attempt. On the engine
 * service that grew the classifier's dir to 194 MB in a week of failed
 * calls: parsing it at boot cost 250 MB of heap, and each rewrite briefly
 * doubled that, which is what was killing the container ninety seconds
 * after every start. The grouping on /health reads the first 200
 * characters; 600 keeps the message and drops the boilerplate.
 */
export const MAX_REASON_CHARS = 600;
/** Attempt rows older than this are dead weight — the article is gone from every window. */
export const ATTEMPT_TTL_DAYS = 14;

export function clipReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
}

export class VerdictStore {
  private verdicts: Record<string, Verdict>;
  private attempts: Record<string, AttemptRecord>;
  private metrics: ClassifierMetrics;

  constructor(private readonly backend: ClassifierBackend = new MemoryBackend()) {
    this.verdicts = backend.readVerdicts();
    this.attempts = backend.readAttempts();
    this.metrics = { ...emptyMetrics(), ...(backend.readMetrics() ?? {}) };
    this.heal();
  }

  /**
   * Bring what was loaded within the caps above and write it back once, so a
   * volume filled before the caps existed shrinks on the next boot instead of
   * needing to be edited by hand.
   */
  private heal(): void {
    let verdictsChanged = 0;
    for (const v of Object.values(this.verdicts)) {
      const clipped = clipReason(v.failure_reason);
      if (clipped !== v.failure_reason) {
        v.failure_reason = clipped;
        verdictsChanged += 1;
      }
    }
    let attemptsChanged = 0;
    const cutoff = Date.now() - ATTEMPT_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const [key, rec] of Object.entries(this.attempts)) {
      const at = Date.parse(rec.last_attempt_at);
      if (Number.isFinite(at) && at < cutoff) {
        delete this.attempts[key];
        attemptsChanged += 1;
        continue;
      }
      const clipped = clipReason(rec.last_error);
      if (clipped !== rec.last_error) {
        rec.last_error = clipped;
        attemptsChanged += 1;
      }
    }
    if (verdictsChanged) this.backend.writeVerdicts(this.verdicts);
    if (attemptsChanged) this.backend.writeAttempts(this.attempts);
    if (verdictsChanged || attemptsChanged) {
      console.info(`[classifier] store healed: ${verdictsChanged} verdict(s), ${attemptsChanged} attempt row(s)`);
    }
  }

  // --- verdicts ------------------------------------------------------------

  get(articleKey: string, promptVersion: string, model: string, now: string, ttlDays: number): Verdict | null {
    const v = this.verdicts[verdictKey(articleKey, promptVersion, model)];
    if (!v) return null;
    if (isExpired(v, now, ttlDays)) return null;
    return v;
  }

  /** Any verdict for an article regardless of version (panel/replay lookups). */
  latestFor(articleKey: string): Verdict | null {
    let best: Verdict | null = null;
    for (const v of Object.values(this.verdicts)) {
      if (v.article_key !== articleKey) continue;
      if (!best || v.classified_at > best.classified_at) best = v;
    }
    return best;
  }

  put(verdict: Verdict): void {
    if (verdict.failure_reason != null) verdict = { ...verdict, failure_reason: clipReason(verdict.failure_reason) };
    this.verdicts[verdictKey(verdict.article_key, verdict.prompt_version, verdict.model)] = verdict;
    this.backend.writeVerdicts(this.verdicts);
  }

  list(options?: { limit?: number; status?: Verdict["status"] }): Verdict[] {
    const all = Object.values(this.verdicts)
      .filter((v) => !options?.status || v.status === options.status)
      .sort((a, b) => (a.classified_at < b.classified_at ? 1 : a.classified_at > b.classified_at ? -1 : 0));
    return options?.limit ? all.slice(0, options.limit) : all;
  }

  /** Drop rows past their TTL. Returns the number removed. */
  prune(now: string, ttlDays: number): number {
    let removed = 0;
    for (const [key, v] of Object.entries(this.verdicts)) {
      if (isExpired(v, now, ttlDays)) {
        delete this.verdicts[key];
        removed += 1;
      }
    }
    if (removed) this.backend.writeVerdicts(this.verdicts);
    return removed;
  }

  size(): number {
    return Object.keys(this.verdicts).length;
  }

  // --- attempts (§9) -------------------------------------------------------

  attemptsFor(articleKey: string): AttemptRecord | null {
    return this.attempts[articleKey] ?? null;
  }

  /**
   * Recorded errors, grouped and counted.
   *
   * 40% of classification attempts were failing and the metrics only said how
   * many, not why — so the choice was between guessing at a cause and shipping
   * a fix that might address nothing. The errors were already stored per
   * article; this just counts them.
   */
  failureReasons(limit = 8): Array<{ reason: string; count: number }> {
    const counts = new Map<string, number>();
    for (const rec of Object.values(this.attempts)) {
      const err = rec.last_error;
      if (!err) continue;
      // Group by shape, not by instance: article ids and timestamps in the
      // message would otherwise make every failure look unique.
      // Normalise only what genuinely varies per instance — ids, hashes,
      // timestamps — and keep the prose. An earlier version collapsed every
      // quoted run of 8+ characters, which in a JSON error body is the message
      // itself: eight identical `{"error":{"message":…}}` lines that said
      // nothing about what actually went wrong.
      const key = err
        .replace(/\b[0-9a-f]{8,}\b/gi, "ID")
        .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "TS")
        .replace(/\b\d{5,}\b/g, "N")
        .slice(0, 200);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  recordAttempt(articleKey: string, error: string | null, at: string, maxAttempts: number): AttemptRecord {
    const prior = this.attempts[articleKey];
    const attempts = (prior?.attempts ?? 0) + 1;
    const record: AttemptRecord = {
      article_key: articleKey,
      attempts,
      last_error: clipReason(error),
      last_attempt_at: at,
      permanent_failed: error !== null && attempts >= maxAttempts,
    };
    if (error === null) {
      // Success clears the ledger row.
      delete this.attempts[articleKey];
    } else {
      this.attempts[articleKey] = record;
    }
    this.backend.writeAttempts(this.attempts);
    return record;
  }

  permanentFailures(): AttemptRecord[] {
    return Object.values(this.attempts).filter((a) => a.permanent_failed);
  }

  /**
   * Clear ledger rows and failed verdicts left by a rejected credential.
   *
   * The service no longer charges an auth failure to an article's ledger, but
   * a credential outage that predates that rule leaves rows behind — on a
   * mounted volume they survive every redeploy, and their articles stay
   * skipped for good once the credential is fixed. Called on startup so the
   * store heals itself rather than needing the volume edited by hand.
   */
  pruneCredentialFailures(): { attempts: number; verdicts: number } {
    const isAuth = (reason: string | null | undefined): boolean =>
      typeof reason === "string" && /(^|\W)(401|403)(\W|$)|api key is invalid|authentication_error|^auth:/i.test(reason);

    let attempts = 0;
    for (const [key, record] of Object.entries(this.attempts)) {
      if (!isAuth(record.last_error)) continue;
      delete this.attempts[key];
      attempts += 1;
    }
    let verdicts = 0;
    for (const [key, verdict] of Object.entries(this.verdicts)) {
      if (verdict.status !== "failed" || !isAuth(verdict.failure_reason)) continue;
      delete this.verdicts[key];
      verdicts += 1;
    }
    if (attempts) this.backend.writeAttempts(this.attempts);
    if (verdicts) this.backend.writeVerdicts(this.verdicts);
    return { attempts, verdicts };
  }

  // --- metrics -------------------------------------------------------------

  getMetrics(): ClassifierMetrics {
    return structuredClone(this.metrics);
  }

  updateMetrics(fn: (m: ClassifierMetrics) => void): void {
    fn(this.metrics);
    this.backend.writeMetrics(this.metrics);
  }

  resetMetrics(): void {
    this.metrics = emptyMetrics();
    this.backend.writeMetrics(this.metrics);
  }
}

export function isExpired(verdict: Verdict, now: string, ttlDays: number): boolean {
  const age = Date.parse(now) - Date.parse(verdict.classified_at);
  return Number.isFinite(age) && age > ttlDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

export class ClassifierConfigStore {
  constructor(private readonly dir: string = resolveClassifierDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  get metadataFile(): string {
    return path.join(this.dir, "company-metadata.json");
  }

  /** Reads config.json, writing the defaults out on first run. */
  load(): ClassifierConfig {
    const stored = readJson<Partial<ClassifierConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_CLASSIFIER_CONFIG);
      return mergeClassifierConfig(null);
    }
    return mergeClassifierConfig(stored);
  }

  save(config: ClassifierConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

export function loadClassifierConfig(dir?: string): ClassifierConfig {
  return new ClassifierConfigStore(dir).load();
}
