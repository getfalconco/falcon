import {
  startResearchJob,
  getJobStatus,
  getResearchResult,
  resolveResearchDataDir,
  type Step1Result,
} from "@meridian/research/step1";
import { persistGraphToSupabase } from "@meridian/research/propagation";
import { classifyEngineError, parseFalconError } from "../../shared/falcon-errors";
import { registerIpcHandler } from "../ipc-register";
import { refreshGraphFile } from "./graph-refresh";
import { resolveStep1DataDir } from "./research-paths";
import { edgesFromStep1Result } from "./step1-graph";
import {
  falconFromUnknown,
  isResearchWorkerConfigured,
  isWorkerUnavailable,
  workerGetJob,
  workerGetResult,
  workerStartStep1,
  workerResearchQuota,
} from "./worker-client";

function step1DataDir(): string {
  return resolveStep1DataDir();
}

async function persistShared(result: Step1Result): Promise<void> {
  try {
    await persistGraphToSupabase(edgesFromStep1Result(result));
  } catch (err) {
    console.warn("[step1] graph persist failed:", err instanceof Error ? err.message : err);
  }
}

export type Step1CoverageOutcome =
  | { status: "cached" }
  | { status: "started"; jobId: string }
  | { status: "error"; error: string };

/**
 * Make sure a ticker has a relationship graph: return immediately if a step1
 * result is already cached, otherwise start the local extraction job with the
 * same completion hooks the UI path uses (Supabase persist + graph.json
 * refresh). Used by portfolio coverage, which has no user access token, so it
 * always runs the local engine.
 */
export async function ensureStep1Coverage(ticker: string): Promise<Step1CoverageOutcome> {
  const trimmed = ticker.trim().toUpperCase();
  if (!trimmed) return { status: "error", error: "ticker is required" };
  try {
    const existing = await getResearchResult(trimmed, { dataDir: step1DataDir() });
    if (existing) return { status: "cached" };
    const { jobId, fromCache } = await startResearchJob(trimmed, {
      dataDir: step1DataDir(),
      onComplete: (result) => {
        void persistShared(result);
        void refreshGraphFile(step1DataDir()).catch((err) => {
          console.warn("[graph] refresh after step1 failed:", err);
        });
      },
    });
    return fromCache ? { status: "cached" } : { status: "started", jobId };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerStep1ResearchHandlers(): void {
  registerIpcHandler(
    "research-step1:start",
    async (
      _event,
      ticker: string,
      options?: { force?: boolean; accessToken?: string },
    ) => {
      const trimmed = typeof ticker === "string" ? ticker.trim() : "";
      if (!trimmed) {
        const mapped = classifyEngineError("ticker is required");
        return { ok: false as const, error: mapped.message, code: mapped.code };
      }

      const token = options?.accessToken?.trim();
      if (isResearchWorkerConfigured() && token) {
        try {
          const started = await workerStartStep1(token, trimmed, options?.force);
          return { ok: true as const, jobId: started.jobId, fromCache: false, via: "worker" as const };
        } catch (err) {
          if (!isWorkerUnavailable(err)) {
            const mapped = falconFromUnknown(err);
            return { ok: false as const, error: mapped.message, code: mapped.code };
          }
          console.warn("[step1] worker unavailable — falling back to local engine");
        }
      }

      try {
        const { jobId, fromCache } = await startResearchJob(trimmed, {
          dataDir: step1DataDir(),
          force: options?.force === true,
          onComplete: (result) => {
            void persistShared(result);
            void refreshGraphFile(step1DataDir()).catch((err) => {
              console.warn("[graph] refresh after step1 failed:", err);
            });
          },
        });
        if (fromCache) {
          const cached = await getResearchResult(trimmed, { dataDir: step1DataDir() });
          if (cached) void persistShared(cached);
        }
        return { ok: true as const, jobId, fromCache: fromCache === true, via: "local" as const };
      } catch (err) {
        const mapped = falconFromUnknown(err);
        return { ok: false as const, error: mapped.message, code: mapped.code };
      }
    },
  );

  registerIpcHandler("research-step1:quota", async (_event, accessToken?: string) => {
    const token = accessToken?.trim();
    if (!isResearchWorkerConfigured() || !token) return { ok: false as const };
    const quota = await workerResearchQuota(token);
    return quota ? { ok: true as const, quota } : { ok: false as const };
  });

  registerIpcHandler(
    "research-step1:status",
    async (_event, jobId: string, accessToken?: string) => {
      if (!jobId?.trim()) {
        const mapped = parseFalconError("job not found");
        return { ok: false as const, error: mapped.message, code: mapped.code };
      }

      const token = accessToken?.trim();
      if (isResearchWorkerConfigured() && token) {
        try {
          const job = await workerGetJob(token, jobId.trim());
          if (job) {
            const error = job.status === "error" ? job.error : null;
            const code = job.error_code ?? (error ? classifyEngineError(error).code : null);
            return {
              ok: true as const,
              jobId: job.id,
              stage: job.stage,
              progress:
                job.progress_total > 0
                  ? { current: job.progress_current, total: job.progress_total }
                  : null,
              done: job.status === "done" || job.status === "error",
              error,
              code,
            };
          }
        } catch (err) {
          if (!isWorkerUnavailable(err)) {
            const mapped = falconFromUnknown(err);
            return { ok: false as const, error: mapped.message, code: mapped.code };
          }
        }
      }

      const status = getJobStatus(jobId.trim());
      if (!status) {
        const mapped = parseFalconError("job not found");
        return { ok: false as const, error: mapped.message, code: mapped.code };
      }
      const code = status.error ? classifyEngineError(status.error).code : null;
      const error = status.error ? classifyEngineError(status.error).message : null;
      return { ok: true as const, ...status, error, code };
    },
  );

  registerIpcHandler(
    "research-step1:result",
    async (_event, ticker: string, accessToken?: string) => {
      const trimmed = typeof ticker === "string" ? ticker.trim() : "";
      if (!trimmed) {
        const mapped = classifyEngineError("ticker is required");
        return { ok: false as const, error: mapped.message, code: mapped.code };
      }

      const token = accessToken?.trim();
      if (isResearchWorkerConfigured() && token) {
        try {
          const remote = await workerGetResult(token, trimmed);
          if (remote) return { ok: true as const, result: remote };
        } catch (err) {
          if (!isWorkerUnavailable(err)) {
            const mapped = falconFromUnknown(err);
            return { ok: false as const, error: mapped.message, code: mapped.code };
          }
        }
      }

      try {
        const result = await getResearchResult(trimmed, { dataDir: step1DataDir() });
        if (!result) {
          const mapped = parseFalconError("no result for ticker");
          return { ok: false as const, error: mapped.message, code: mapped.code };
        }
        return { ok: true as const, result };
      } catch (err) {
        const mapped = falconFromUnknown(err);
        return { ok: false as const, error: mapped.message, code: mapped.code };
      }
    },
  );

  console.info("[step1] research handlers registered", {
    dataDir: resolveResearchDataDir(step1DataDir()),
    worker: isResearchWorkerConfigured() ? "enabled" : "local-only",
  });
}
