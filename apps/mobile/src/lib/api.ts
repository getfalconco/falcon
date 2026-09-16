import { describeComputeApiUrl } from "@/lib/compute-url";
import { FalconClientError, falconError, parseFalconError, type FalconError } from "@/lib/errors";
import {
  identityOptsFromSession,
  reportClientFalconError,
} from "@/lib/report-error";
import { requireSupabase } from "@/lib/supabase";

/**
 * Client for the compute API (apps/research-worker).
 * Analyze is always shown; if the URL is missing the call fails with FAL-JOB-03.
 * Fetch failures (worker down, ATS, firewall) are FAL-NET-01.
 */

const CONFIGURED_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export function isComputeEnabled(): boolean {
  return CONFIGURED_API_URL.length > 0;
}

function apiUrl(): string {
  const resolved = describeComputeApiUrl(CONFIGURED_API_URL);
  if (__DEV__) {
    console.warn(
      "[falcon] compute url",
      resolved.url || "(empty)",
      resolved.rewritten ? `rewritten from ${resolved.configured} via ${resolved.lanHost}` : "",
    );
  }
  return resolved.url;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sessionOrNull() {
  try {
    const { data } = await requireSupabase().auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

async function authedFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  if (!isComputeEnabled()) {
    const error = falconError("FAL-JOB-03");
    reportClientFalconError(error, identityOptsFromSession(await sessionOrNull()));
    throw new FalconClientError(error);
  }

  const base = apiUrl();
  if (!base) {
    const error = falconError("FAL-JOB-03");
    reportClientFalconError(error, identityOptsFromSession(await sessionOrNull()));
    throw new FalconClientError(error);
  }

  const client = requireSupabase();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) throw new FalconClientError(falconError("FAL-AUTH-01"));

  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: init?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.warn("[falcon] compute fetch failed", url, raw);
    const error = falconError("FAL-NET-01");
    reportClientFalconError(error, {
      apiUrl: url,
      ...identityOptsFromSession(session),
    });
    throw new FalconClientError(error);
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
        : falconError("FAL-INT-01");
    throw new FalconClientError(fromBody);
  }

  return (parsed ?? {}) as T;
}

/* ------------------------------ brokerage -------------------------------- */

export type BrokerageCatalogItem = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  url?: string | null;
};

export type LiveBrokerageAccount = {
  id: string;
  name: string;
  institution: string;
  totalValue: number | null;
  authorizationId?: string | null;
};

export type BrokerageNetWorth = {
  connected: boolean;
  total: number;
  accounts: LiveBrokerageAccount[];
};

export async function listBrokerages(): Promise<{
  configured: boolean;
  brokerages: BrokerageCatalogItem[];
  error?: FalconError;
}> {
  const data = await authedFetch<{
    configured?: boolean;
    brokerages?: BrokerageCatalogItem[];
    error?: unknown;
  }>("/api/brokerage/list");
  const error = data.error != null ? parseFalconError(data.error) : undefined;
  return {
    /** Only an explicit false from a reachable worker means SnapTrade isn't configured. */
    configured: data.configured !== false,
    brokerages: Array.isArray(data.brokerages) ? data.brokerages : [],
    error,
  };
}

export async function connectBrokerage(input: {
  broker?: string;
  redirectUrl?: string;
}): Promise<{ url: string }> {
  return authedFetch<{ url: string }>("/api/brokerage/connect", {
    method: "POST",
    body: input,
  });
}

export async function refreshBrokerageStatus(): Promise<BrokerageNetWorth> {
  const data = await authedFetch<{ networth: BrokerageNetWorth }>("/api/brokerage/status");
  return data.networth;
}

export async function disconnectBrokerage(authorizationId: string): Promise<BrokerageNetWorth> {
  const data = await authedFetch<{ networth: BrokerageNetWorth }>("/api/brokerage/disconnect", {
    method: "POST",
    body: { authorizationId },
  });
  return data.networth;
}

export function errorFromUnknown(err: unknown): FalconError {
  if (err instanceof FalconClientError) return err.falcon;
  if (err instanceof Error) return parseFalconError(err.message);
  return parseFalconError(err);
}

/* ------------------------------ capabilities ----------------------------- */

export type AnalysisCapability = {
  id: string;
  name: string;
  description: string;
  available: boolean;
  model?: string;
};

export async function fetchCapabilities(): Promise<AnalysisCapability[]> {
  if (!isComputeEnabled()) return [];
  const base = apiUrl();
  if (!base) return [];
  try {
    const res = await fetchWithTimeout(`${base}/api/capabilities`, { method: "GET" });
    if (!res.ok) return [];
    const data = (await res.json()) as { analyses?: AnalysisCapability[] };
    return data.analyses ?? [];
  } catch {
    return [];
  }
}

export type ComputeHealth = {
  ok: boolean;
  /** Why the engine isn't usable — null when healthy. */
  reason: "not_configured" | "unreachable" | "error" | null;
  message: string | null;
};

/** Unauthenticated ping — used by Analyze to warn before the user spends a tap. */
export async function checkComputeHealth(): Promise<ComputeHealth> {
  if (!isComputeEnabled()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Research engine isn't configured on this build.",
    };
  }
  const base = apiUrl();
  if (!base) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Research engine isn't configured on this build.",
    };
  }
  try {
    const res = await fetchWithTimeout(`${base}/health`, { method: "GET" }, 8000);
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message: "The research engine returned an error. Try again in a moment.",
      };
    }
    return { ok: true, reason: null, message: null };
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: "Can't reach the research engine. Check your connection and try again.",
    };
  }
}

/* --------------------------------- jobs ---------------------------------- */

export type ComputeJob = {
  id: string;
  kind: "step1" | "propagation" | "daily_signal";
  ticker: string | null;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress_current: number;
  progress_total: number;
  error: string | null;
  error_code: string | null;
  result: unknown;
};

export type Step1ResultLite = {
  ticker: string;
  companyName: string;
  form: string;
  filingDate: string;
  validated: Array<{
    counterparty_name: string;
    counterparty_ticker: string | null;
    category: string;
    strength_tier?: string;
    confidence: number;
    evidence: Array<{ quote: string }>;
  }>;
  rejected?: unknown[];
  merged?: unknown[];
};

export function isStep1Result(value: unknown): value is Step1ResultLite {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.ticker === "string" && Array.isArray(row.validated);
}

export async function startStep1Research(
  ticker: string,
  force = false,
): Promise<string> {
  const data = await authedFetch<{ jobId: string | null }>("/api/research/start", {
    method: "POST",
    body: { ticker, force },
  });
  if (!data.jobId) throw new FalconClientError(falconError("FAL-JOB-03"));
  return data.jobId;
}

export async function runPropagation(): Promise<string | null> {
  const data = await authedFetch<{ jobId: string | null }>("/api/propagation/run", {
    method: "POST",
  });
  return data.jobId;
}

export async function getJob(jobId: string): Promise<ComputeJob | null> {
  const data = await authedFetch<{ job: ComputeJob | null }>(
    `/api/research/status?jobId=${encodeURIComponent(jobId)}`,
  );
  return data.job;
}

export async function listStep1Jobs(ticker?: string): Promise<ComputeJob[]> {
  const q = ticker ? `?ticker=${encodeURIComponent(ticker)}` : "";
  const data = await authedFetch<{ jobs: ComputeJob[] }>(`/api/research/jobs${q}`);
  return data.jobs ?? [];
}

export async function getLatestStep1(ticker: string): Promise<ComputeJob | null> {
  const data = await authedFetch<{ job: ComputeJob | null }>(
    `/api/research/latest?ticker=${encodeURIComponent(ticker)}`,
  );
  return data.job;
}

export async function getStep1Result(ticker: string): Promise<Step1ResultLite | null> {
  const data = await authedFetch<{ result: Step1ResultLite }>(
    `/api/research/result?ticker=${encodeURIComponent(ticker)}`,
  );
  return data.result ?? null;
}

/** Polls a job to completion. Resolves with the terminal state. */
export async function waitForJob(
  jobId: string,
  onProgress?: (job: ComputeJob) => void,
  intervalMs = 2500,
): Promise<ComputeJob | null> {
  for (;;) {
    const job = await getJob(jobId);
    if (!job) return null;
    onProgress?.(job);
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
