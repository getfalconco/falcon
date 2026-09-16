import { randomUUID } from "node:crypto";
import { loadStep1Result, tryLoadCachedResult } from "./persist.js";
import { runStep1Pipeline } from "./runPipeline.js";
import type { Step1Progress, Step1Result } from "./types.js";

export type ResearchJob = {
  jobId: string;
  ticker: string;
  stage: string;
  progress: { current: number; total: number } | null;
  done: boolean;
  error: string | null;
  result: Step1Result | null;
  fromCache: boolean;
  finishedAt: number | null;
};

const jobs = new Map<string, ResearchJob>();

export function getJob(jobId: string): ResearchJob | undefined {
  return jobs.get(jobId);
}

export function getJobStatus(
  jobId: string,
): (Step1Progress & { jobId: string; fromCache?: boolean }) | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    jobId: job.jobId,
    stage: job.stage,
    progress: job.progress,
    done: job.done,
    error: job.error,
    fromCache: job.fromCache,
  };
}

export async function startResearchJob(
  ticker: string,
  options?: {
    dataDir?: string;
    cacheDir?: string;
    force?: boolean;
    onComplete?: (result: Step1Result) => void;
  },
): Promise<{ jobId: string; fromCache?: boolean }> {
  const trimmed = ticker.trim().toUpperCase();
  if (!trimmed) throw new Error("ticker is required");

  const jobId = randomUUID();
  const job: ResearchJob = {
    jobId,
    ticker: trimmed,
    stage: "Starting…",
    progress: null,
    done: false,
    error: null,
    result: null,
    fromCache: false,
    finishedAt: null,
  };
  jobs.set(jobId, job);

  if (!options?.force) {
    const cached = await tryLoadCachedResult(trimmed, options?.dataDir);
    if (cached) {
      job.result = cached;
      job.done = true;
      job.fromCache = true;
      job.finishedAt = Date.now();
      job.stage = "Cached result";
      job.error = null;
      return { jobId, fromCache: true };
    }
  }

  void (async () => {
    try {
      const result = await runStep1Pipeline(trimmed, {
        dataDir: options?.dataDir,
        cacheDir: options?.cacheDir,
        force: options?.force,
        onProgress: (p) => {
          job.stage = p.stage;
          job.progress = p.progress;
          job.done = p.done;
          job.error = p.error;
        },
      });
      job.result = result;
      job.done = true;
      job.fromCache = result.fromCache ?? false;
      job.finishedAt = Date.now();
      job.stage = result.fromCache ? "Cached result" : "done";
      job.error = null;
      options?.onComplete?.(result);
    } catch (err) {
      job.done = true;
      job.error = err instanceof Error ? err.message : String(err);
      job.stage = "error";
    }
  })();

  return { jobId };
}

export async function getResearchResult(
  ticker: string,
  options?: { dataDir?: string },
): Promise<Step1Result | null> {
  const upper = ticker.trim().toUpperCase();
  let newest: ResearchJob | null = null;
  for (const job of jobs.values()) {
    if (job.ticker !== upper || !job.done || !job.result || job.error) continue;
    if (!newest || (job.finishedAt ?? 0) > (newest.finishedAt ?? 0)) {
      newest = job;
    }
  }
  if (newest?.result) return newest.result;
  const disk = await loadStep1Result(upper, options?.dataDir);
  if (disk) return { ...disk, fromCache: true };
  return null;
}
