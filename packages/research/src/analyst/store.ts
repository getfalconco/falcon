/**
 * Analyst persistence (§9): the output store keyed (incident_id, request_id),
 * the attempt ledger for failed requests (§8), the metrics snapshot and the
 * config file. Retention is aligned with incidents (90d); superseded outputs
 * are kept and marked.
 *
 * Everything is JSON under the analyst data dir so it survives restarts.
 * Writes are atomic (tmp + rename). Tests use an in-memory instance. Same
 * shape as the Classifier's store — nothing invented.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDesktopDataDir } from "../tracker/store.js";
import { DEFAULT_ANALYST_CONFIG, mergeAnalystConfig, type AnalystConfig } from "./config.js";
import { coerceStoredOutput } from "./schema.js";
import type { AnalystMetrics, AnalystOutput } from "./types.js";

export function resolveAnalystDataDir(): string {
  const fromEnv = process.env.FALCON_ANALYST_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveDesktopDataDir(), "analyst");
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

export function outputKey(incidentId: string, requestId: string): string {
  return `${incidentId}|${requestId}`;
}

export function emptyMetrics(): AnalystMetrics {
  return {
    outputs_ok: 0,
    outputs_failed: 0,
    validation_failures: 0,
    transport_failures: 0,
    retries: 0,
    breaker_trips: 0,
    grounding_failed: 0,
    edge_deviations: 0,
    superseded: 0,
    cache_hits: 0,
    latencies_ms: [],
    input_tokens: 0,
    output_tokens: 0,
    by_cell: {},
  };
}

export type AttemptRecord = {
  request_id: string;
  incident_id: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string;
  /** §8: after maxAttemptsPerRequest total attempts. */
  permanent_failed: boolean;
};

type OutputsFile = { schema_version: 1; outputs: Record<string, AnalystOutput> };
type AttemptsFile = { schema_version: 1; attempts: Record<string, AttemptRecord> };
type MetricsFile = { schema_version: 1; metrics: AnalystMetrics };

export interface AnalystBackend {
  readOutputs(): Record<string, AnalystOutput>;
  writeOutputs(o: Record<string, AnalystOutput>): void;
  readAttempts(): Record<string, AttemptRecord>;
  writeAttempts(a: Record<string, AttemptRecord>): void;
  readMetrics(): AnalystMetrics | null;
  writeMetrics(m: AnalystMetrics): void;
}

export class MemoryBackend implements AnalystBackend {
  private outputs: Record<string, AnalystOutput> = {};
  private attempts: Record<string, AttemptRecord> = {};
  private metrics: AnalystMetrics | null = null;
  readOutputs() {
    return structuredClone(this.outputs);
  }
  writeOutputs(o: Record<string, AnalystOutput>) {
    this.outputs = structuredClone(o);
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
  writeMetrics(m: AnalystMetrics) {
    this.metrics = structuredClone(m);
  }
}

export class FileBackend implements AnalystBackend {
  constructor(readonly dir: string = resolveAnalystDataDir()) {}
  get outputsFile() {
    return path.join(this.dir, "outputs.json");
  }
  get attemptsFile() {
    return path.join(this.dir, "attempts.json");
  }
  get metricsFile() {
    return path.join(this.dir, "metrics.json");
  }
  readOutputs() {
    const parsed = readJson<OutputsFile>(this.outputsFile);
    const out: Record<string, AnalystOutput> = {};
    if (parsed?.outputs && typeof parsed.outputs === "object") {
      for (const [key, raw] of Object.entries(parsed.outputs)) {
        const o = coerceStoredOutput(raw);
        if (o) out[key] = o;
      }
    }
    return out;
  }
  writeOutputs(outputs: Record<string, AnalystOutput>) {
    writeJsonAtomic(this.outputsFile, { schema_version: 1, outputs } satisfies OutputsFile);
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
  writeMetrics(metrics: AnalystMetrics) {
    writeJsonAtomic(this.metricsFile, { schema_version: 1, metrics } satisfies MetricsFile);
  }
}

export type OutputListOptions = {
  limit?: number;
  status?: AnalystOutput["status"];
  kind?: AnalystOutput["kind"];
  cause?: AnalystOutput["cause"];
  edge_status?: AnalystOutput["edge_status"];
  ticker?: string;
  /** Exclude superseded outputs. */
  currentOnly?: boolean;
};

/** The output store (§9). Owned by Analyst. */
export class AnalystOutputStore {
  private outputs: Record<string, AnalystOutput>;
  private attempts: Record<string, AttemptRecord>;
  private metrics: AnalystMetrics;

  constructor(private readonly backend: AnalystBackend = new MemoryBackend()) {
    this.outputs = backend.readOutputs();
    this.attempts = backend.readAttempts();
    this.metrics = { ...emptyMetrics(), ...(backend.readMetrics() ?? {}) };
  }

  /**
   * Re-read everything from the backend. The store can have a second writer
   * (the replay script generating the rubric batch while the app runs), so
   * the host reloads before a cycle and before serving the panel.
   */
  reload(): void {
    this.outputs = this.backend.readOutputs();
    this.attempts = this.backend.readAttempts();
    this.metrics = { ...emptyMetrics(), ...(this.backend.readMetrics() ?? {}) };
  }

  // --- outputs -------------------------------------------------------------

  get(incidentId: string, requestId: string): AnalystOutput | null {
    return this.outputs[outputKey(incidentId, requestId)] ?? null;
  }

  /**
   * Newest output for an incident. A current (non-superseded) output beats a
   * superseded one at the same instant; ties beyond that break on request id
   * so the answer is deterministic.
   */
  latestFor(incidentId: string): AnalystOutput | null {
    let best: AnalystOutput | null = null;
    for (const o of Object.values(this.outputs)) {
      if (o.incident_id !== incidentId) continue;
      if (!best) {
        best = o;
        continue;
      }
      if (o.produced_at !== best.produced_at) {
        if (o.produced_at > best.produced_at) best = o;
        continue;
      }
      const oCurrent = o.superseded_by === null;
      const bCurrent = best.superseded_by === null;
      if (oCurrent !== bCurrent) {
        if (oCurrent) best = o;
        continue;
      }
      if (o.request_id > best.request_id) best = o;
    }
    return best;
  }

  /** All outputs for an incident, oldest first. */
  forIncident(incidentId: string): AnalystOutput[] {
    return Object.values(this.outputs)
      .filter((o) => o.incident_id === incidentId)
      .sort((a, b) => a.produced_at.localeCompare(b.produced_at) || a.request_id.localeCompare(b.request_id));
  }

  put(output: AnalystOutput): void {
    this.outputs[outputKey(output.incident_id, output.request_id)] = output;
    this.backend.writeOutputs(this.outputs);
  }

  /**
   * §2 supersession: mark every other current output of the incident as
   * superseded by `byRequestId`. Returns the request ids marked.
   */
  markSuperseded(incidentId: string, byRequestId: string): string[] {
    const marked: string[] = [];
    for (const o of Object.values(this.outputs)) {
      if (o.incident_id !== incidentId || o.request_id === byRequestId) continue;
      if (o.superseded_by !== null) continue;
      o.superseded_by = byRequestId;
      marked.push(o.request_id);
    }
    if (marked.length) this.backend.writeOutputs(this.outputs);
    return marked;
  }

  list(options?: OutputListOptions): AnalystOutput[] {
    const all = Object.values(this.outputs)
      .filter((o) => !options?.status || o.status === options.status)
      .filter((o) => !options?.kind || o.kind === options.kind)
      .filter((o) => !options?.cause || o.cause === options.cause)
      .filter((o) => !options?.edge_status || o.edge_status === options.edge_status)
      .filter((o) => !options?.ticker || o.ticker.toUpperCase() === options.ticker.toUpperCase())
      .filter((o) => !options?.currentOnly || o.superseded_by === null)
      .sort((a, b) => (a.produced_at < b.produced_at ? 1 : a.produced_at > b.produced_at ? -1 : 0));
    return options?.limit ? all.slice(0, options.limit) : all;
  }

  /** Drop rows past retention. Returns the number removed. */
  prune(now: string, retentionDays: number): number {
    let removed = 0;
    for (const [key, o] of Object.entries(this.outputs)) {
      if (isExpired(o, now, retentionDays)) {
        delete this.outputs[key];
        removed += 1;
      }
    }
    if (removed) this.backend.writeOutputs(this.outputs);
    return removed;
  }

  size(): number {
    return Object.keys(this.outputs).length;
  }

  // --- attempts (§8) -------------------------------------------------------

  attemptsFor(requestId: string): AttemptRecord | null {
    return this.attempts[requestId] ?? null;
  }

  recordAttempt(
    requestId: string,
    incidentId: string,
    error: string | null,
    at: string,
    maxAttempts: number,
  ): AttemptRecord {
    const prior = this.attempts[requestId];
    const attempts = (prior?.attempts ?? 0) + 1;
    const record: AttemptRecord = {
      request_id: requestId,
      incident_id: incidentId,
      attempts,
      last_error: error,
      last_attempt_at: at,
      permanent_failed: error !== null && attempts >= maxAttempts,
    };
    if (error === null) {
      // Success clears the ledger row.
      delete this.attempts[requestId];
    } else {
      this.attempts[requestId] = record;
    }
    this.backend.writeAttempts(this.attempts);
    return record;
  }

  permanentFailures(): AttemptRecord[] {
    return Object.values(this.attempts).filter((a) => a.permanent_failed);
  }

  // --- metrics -------------------------------------------------------------

  getMetrics(): AnalystMetrics {
    return structuredClone(this.metrics);
  }

  updateMetrics(fn: (m: AnalystMetrics) => void): void {
    fn(this.metrics);
    this.backend.writeMetrics(this.metrics);
  }

  resetMetrics(): void {
    this.metrics = emptyMetrics();
    this.backend.writeMetrics(this.metrics);
  }
}

export function isExpired(output: AnalystOutput, now: string, retentionDays: number): boolean {
  const age = Date.parse(now) - Date.parse(output.produced_at);
  return Number.isFinite(age) && age > retentionDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

export class AnalystConfigStore {
  constructor(private readonly dir: string = resolveAnalystDataDir()) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return path.join(this.dir, "config.json");
  }

  /** Reads config.json, writing the defaults out on first run. */
  load(): AnalystConfig {
    const stored = readJson<Partial<AnalystConfig>>(this.configFile);
    if (!stored) {
      writeJsonAtomic(this.configFile, DEFAULT_ANALYST_CONFIG);
      return mergeAnalystConfig(null);
    }
    return mergeAnalystConfig(stored);
  }

  save(config: AnalystConfig): void {
    writeJsonAtomic(this.configFile, config);
  }
}

export function loadAnalystConfig(dir?: string): AnalystConfig {
  return new AnalystConfigStore(dir).load();
}
