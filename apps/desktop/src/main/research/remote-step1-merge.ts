/**
 * Filing research that ran on the research worker, brought into the local graph.
 *
 * A local step1 job writes its result files (data/research/<T>.json and
 * friends) and rebuilds graph.json when it finishes. A job the worker ran
 * writes nothing here, so its links used to appear only after some later local
 * job happened to rebuild the graph. This module closes that gap: when a remote
 * job is done, its result is written through the same `saveStep1Result` and
 * the graph rebuilt through the same `refreshGraphFile` a local job uses, so
 * every graph reader (graph-edges.ts, the propagation host) picks the change up
 * by the file's mtime.
 *
 * Two ways in, both idempotent:
 *   - `noteJob`: the status handler saw the job (the renderer polls it);
 *   - `watch`: started with the job, polls the worker itself until the job
 *     ends, so the merge happens even if the screen that started it closes.
 * A job merges once; a result the disk already has (same generatedAt and
 * edge count) or one older than the local result is not written again.
 *
 * Electron-free (everything it touches comes in through `RemoteMergeDeps`) so
 * the tests run it against a temp directory and a fake worker.
 */

import type { Step1Result } from "@meridian/research/step1";

/** The worker's job row, as much of it as the merge reads. */
export type RemoteJobLike = {
  id: string;
  ticker: string | null;
  status: "queued" | "running" | "done" | "error";
  result: unknown;
};

export type RemoteMergeDeps = {
  /** The local step1 research dir. */
  dataDir: () => string;
  /** What the disk holds for `ticker` (from the meta file), or null. */
  localStamp: (ticker: string, dataDir: string) => Promise<{ generatedAt: string | null; validatedCount: number } | null>;
  /** Write the result files, as a local job does (`saveStep1Result`). */
  save: (result: Step1Result, dataDir: string) => Promise<unknown>;
  /** Rebuild graph.json from the research dir, as a local job does (`refreshGraphFile`). */
  rebuildGraph: (dataDir: string) => Promise<unknown>;
  /** After a merge: drop caches keyed by ticker rather than file mtime. */
  afterMerge?: (result: Step1Result) => void;
  /** Worker calls, for `watch` and for a done job whose row carries no result. */
  getJob?: (accessToken: string, jobId: string) => Promise<RemoteJobLike | null>;
  getResult?: (accessToken: string, ticker: string) => Promise<unknown>;
  log?: (message: string) => void;
};

export type MergeOutcome = "merged" | "unchanged" | "older" | "invalid";

const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const FORMS = new Set(["10-K", "20-F"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isEdge(v: unknown, ticker: string): boolean {
  if (!isObject(v)) return false;
  return (
    typeof v.root_ticker === "string" &&
    v.root_ticker.trim().toUpperCase() === ticker &&
    typeof v.counterparty_name === "string" &&
    v.counterparty_name.trim().length > 0 &&
    typeof v.category === "string" &&
    Array.isArray(v.evidence)
  );
}

/**
 * A worker result shaped like a step1 result, or null. The ticker becomes a
 * file name, so it must look like one; edges that belong to another root are
 * dropped (the graph build reads `root_ticker` from each edge).
 */
export function parseRemoteResult(raw: unknown, expectedTicker?: string | null): Step1Result | null {
  if (!isObject(raw) || "errorCode" in raw) return null;
  const ticker = typeof raw.ticker === "string" ? raw.ticker.trim().toUpperCase() : "";
  if (!TICKER.test(ticker)) return null;
  if (expectedTicker && expectedTicker.trim().toUpperCase() !== ticker) return null;
  if (!Array.isArray(raw.validated)) return null;
  const validated = raw.validated.filter((e) => isEdge(e, ticker)) as Step1Result["validated"];
  const form = typeof raw.form === "string" && FORMS.has(raw.form) ? (raw.form as Step1Result["form"]) : "10-K";
  const filingDate = typeof raw.filingDate === "string" ? raw.filingDate : "";
  const stats = isObject(raw.stats)
    ? (raw.stats as Step1Result["stats"])
    : ({
        form_type: form,
        filing_date: filingDate,
        section_chars: 0,
        section_method: "fallback_60pct",
        section_extraction_failed: false,
        chunks: 0,
        api_errors: 0,
        parse_errors: 0,
        candidates_extracted: 0,
        candidates_per_chunk: [],
        dropped_low_confidence: 0,
        deduped: 0,
        rejected_quote_not_found: 0,
        rejected_by_auditor: 0,
        validated: validated.length,
      } satisfies Step1Result["stats"]);
  return {
    ticker,
    companyName: typeof raw.companyName === "string" && raw.companyName.trim() ? raw.companyName : ticker,
    form,
    filingDate,
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
    validated,
    rejected: Array.isArray(raw.rejected) ? (raw.rejected as Step1Result["rejected"]) : [],
    merged: Array.isArray(raw.merged) ? (raw.merged as Step1Result["merged"]) : [],
    stats,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date().toISOString(),
    ...(typeof raw.cacheKey === "string" ? { cacheKey: raw.cacheKey } : {}),
    ...(typeof raw.accessionNumber === "string" ? { accessionNumber: raw.accessionNumber } : {}),
  };
}

export type RemoteStep1Merger = {
  /** Merge one worker result into the local research dir and graph. */
  mergeResult: (raw: unknown, expectedTicker?: string | null) => Promise<MergeOutcome>;
  /** The status handler saw `job`; merges it once when it is done. */
  noteJob: (job: RemoteJobLike, accessToken?: string | null) => Promise<MergeOutcome | null>;
  /** Poll the worker for `jobId` until it ends, then merge it. */
  watch: (jobId: string, ticker: string, accessToken: string) => void;
  /** Stop every watch (app quit, tests). */
  stopAll: () => void;
};

export type WatchOptions = { intervalMs?: number; maxMs?: number };

export function createRemoteStep1Merger(deps: RemoteMergeDeps, opts: WatchOptions = {}): RemoteStep1Merger {
  const intervalMs = opts.intervalMs ?? 5_000;
  const maxMs = opts.maxMs ?? 45 * 60_000;
  const log = deps.log ?? ((m: string) => console.info(m));
  /** Jobs already merged (or found to have nothing to merge). */
  const settled = new Set<string>();
  const watches = new Map<string, { token: string; timer: ReturnType<typeof setTimeout> | null }>();
  /** Merges run one at a time: two graph rebuilds must not write the file at once. */
  let queue: Promise<unknown> = Promise.resolve();

  const mergeResult = (raw: unknown, expectedTicker?: string | null): Promise<MergeOutcome> => {
    const run = async (): Promise<MergeOutcome> => {
      const result = parseRemoteResult(raw, expectedTicker);
      if (!result) return "invalid";
      const dir = deps.dataDir();
      const local = await deps.localStamp(result.ticker, dir).catch(() => null);
      if (local?.generatedAt) {
        if (local.generatedAt === result.generatedAt && local.validatedCount === result.validated.length) return "unchanged";
        if (local.generatedAt > result.generatedAt) return "older";
      }
      await deps.save(result, dir);
      await deps.rebuildGraph(dir);
      deps.afterMerge?.(result);
      log(`[step1] merged remote result for ${result.ticker} (${result.validated.length} edges) into the local graph`);
      return "merged";
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  const settle = async (job: RemoteJobLike, token: string | null | undefined): Promise<MergeOutcome | null> => {
    if (settled.has(job.id)) return null;
    if (job.status === "error") {
      settled.add(job.id);
      return null;
    }
    if (job.status !== "done") return null;
    settled.add(job.id);
    try {
      let outcome = await mergeResult(job.result, job.ticker);
      if (outcome === "invalid" && token && job.ticker && deps.getResult) {
        outcome = await mergeResult(await deps.getResult(token, job.ticker), job.ticker);
      }
      return outcome;
    } catch (err) {
      // Let a later sighting try again.
      settled.delete(job.id);
      log(`[step1] merging remote job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const stopWatch = (jobId: string) => {
    const w = watches.get(jobId);
    if (w?.timer) clearTimeout(w.timer);
    watches.delete(jobId);
  };

  const noteJob = async (job: RemoteJobLike, accessToken?: string | null): Promise<MergeOutcome | null> => {
    const w = watches.get(job.id);
    if (w && accessToken) w.token = accessToken;
    if (job.status === "done" || job.status === "error") stopWatch(job.id);
    return settle(job, accessToken ?? w?.token);
  };

  const watch = (jobId: string, ticker: string, accessToken: string) => {
    if (!deps.getJob || settled.has(jobId) || watches.has(jobId)) return;
    const getJob = deps.getJob;
    const deadline = Date.now() + maxMs;
    const entry: { token: string; timer: ReturnType<typeof setTimeout> | null } = { token: accessToken, timer: null };
    watches.set(jobId, entry);
    const tick = async () => {
      entry.timer = null;
      if (!watches.has(jobId)) return;
      try {
        const job = await getJob(entry.token, jobId);
        if (job && (job.status === "done" || job.status === "error")) {
          stopWatch(jobId);
          await settle({ ...job, ticker: job.ticker ?? ticker }, entry.token);
          return;
        }
      } catch {
        // The worker can blink; keep trying until the deadline.
      }
      if (!watches.has(jobId)) return;
      if (Date.now() >= deadline) {
        stopWatch(jobId);
        return;
      }
      entry.timer = setTimeout(() => void tick(), intervalMs);
      entry.timer.unref?.();
    };
    entry.timer = setTimeout(() => void tick(), intervalMs);
    entry.timer.unref?.();
  };

  const stopAll = () => {
    for (const id of [...watches.keys()]) stopWatch(id);
  };

  return { mergeResult, noteJob, watch, stopAll };
}
