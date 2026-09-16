import { classifyEngineError, parseFalconError, type FalconError } from "../../shared/falcon-errors";
import type { Step1Result } from "../../shared/step1-research";

// Read per call, not at import: main/index.ts sets RESEARCH_WORKER_URL (from .env
// or the packaged default) after this module has already been evaluated.
function workerUrl(): string {
  return (process.env.RESEARCH_WORKER_URL ?? "").trim().replace(/\/+$/, "");
}

export function isResearchWorkerConfigured(): boolean {
  return workerUrl().length > 0;
}

export type WorkerJob = {
  id: string;
  kind: string;
  ticker: string | null;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress_current: number;
  progress_total: number;
  error: string | null;
  error_code: string | null;
  result: unknown;
};

class WorkerHttpError extends Error {
  readonly falcon: FalconError;
  constructor(falcon: FalconError) {
    super(falcon.message);
    this.name = "WorkerHttpError";
    this.falcon = falcon;
  }
}

async function workerFetch<T>(
  path: string,
  accessToken: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${workerUrl()}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new WorkerHttpError(classifyEngineError(raw));
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const fromBody =
      parsed && typeof parsed === "object" && "error" in parsed
        ? parseFalconError((parsed as { error: unknown }).error)
        : classifyEngineError(`Request failed (${res.status})`);
    throw new WorkerHttpError(fromBody);
  }

  return (parsed ?? {}) as T;
}

export async function workerStartStep1(
  accessToken: string,
  ticker: string,
  force?: boolean,
): Promise<{ jobId: string }> {
  const data = await workerFetch<{ jobId: string }>("/api/research/start", accessToken, {
    method: "POST",
    body: { ticker, force: force === true },
  });
  return { jobId: data.jobId };
}

export async function workerGetJob(accessToken: string, jobId: string): Promise<WorkerJob | null> {
  const data = await workerFetch<{ job: WorkerJob | null }>(
    `/api/research/status?jobId=${encodeURIComponent(jobId)}`,
    accessToken,
  );
  return data.job;
}

export async function workerGetResult(
  accessToken: string,
  ticker: string,
): Promise<Step1Result | null> {
  try {
    const data = await workerFetch<{ result: Step1Result }>(
      `/api/research/result?ticker=${encodeURIComponent(ticker)}`,
      accessToken,
    );
    return data.result ?? null;
  } catch (err) {
    if (err instanceof WorkerHttpError && err.falcon.code === "FAL-SEC-01") return null;
    throw err;
  }
}

export function isWorkerUnavailable(err: unknown): boolean {
  if (!(err instanceof WorkerHttpError)) return true;
  return err.falcon.code === "FAL-NET-01" || err.falcon.code === "FAL-JOB-03";
}

export function falconFromUnknown(err: unknown): FalconError {
  if (err instanceof WorkerHttpError) return err.falcon;
  if (err instanceof Error) return classifyEngineError(err.message);
  return classifyEngineError(String(err));
}

export type WorkerResearchQuota = {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  allowed: boolean;
};

/** The account's research standing, for the countdown beside the Begin button. */
export async function workerResearchQuota(
  accessToken: string,
): Promise<WorkerResearchQuota | null> {
  try {
    const data = await workerFetch<{ quota: WorkerResearchQuota }>(
      "/api/research/quota",
      accessToken,
    );
    return data.quota ?? null;
  } catch {
    // A quota the UI cannot read is not worth an error state: the pill hides
    // and the Begin button still tells the truth when it is actually refused.
    return null;
  }
}
