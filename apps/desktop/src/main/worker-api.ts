import type { BrokerageNetWorth, SnaptradeBrokerage } from "../shared/snaptrade";
import type { OnboardingSurveyAnswers } from "../shared/onboarding-survey";
import { getRendererSession } from "./session-bridge";

/**
 * Thin client for the research-worker routes a packaged desktop leans on for
 * anything that needs a privileged key: brokerage (SnapTrade) and onboarding.
 * Step-1 research has its own client in research/worker-client.ts.
 *
 * Every call carries the user's Supabase JWT; the worker verifies it and acts
 * on the user's behalf. No privileged key ever lives in the desktop.
 */

function workerUrl(): string {
  return (process.env.RESEARCH_WORKER_URL ?? "").trim().replace(/\/+$/, "");
}

export function isWorkerConfigured(): boolean {
  return workerUrl().length > 0;
}

function token(explicit?: string | null): string | null {
  return explicit?.trim() || getRendererSession().accessToken || null;
}

type WorkerErrorBody = { error?: { code?: string; message?: string } | string };

async function call<T>(
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; accessToken?: string | null },
): Promise<T> {
  const base = workerUrl();
  if (!base) throw new Error("Falcon's server isn't configured.");
  const jwt = token(opts.accessToken);
  if (!jwt) throw new Error("Sign in to continue.");

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new Error("Check your connection and try again.");
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = (data as WorkerErrorBody | null)?.error;
    const message =
      typeof err === "string" ? err : err?.message || `Falcon's server replied ${res.status}.`;
    throw new Error(message);
  }
  return data as T;
}

/* ------------------------------ brokerage -------------------------------- */

export async function workerListBrokerages(
  accessToken?: string | null,
): Promise<{ configured: boolean; brokerages: SnaptradeBrokerage[] }> {
  const data = await call<{ configured?: boolean; brokerages?: SnaptradeBrokerage[] }>(
    "/api/brokerage/list",
    { accessToken },
  );
  return { configured: data.configured !== false, brokerages: data.brokerages ?? [] };
}

export async function workerBrokerageConnectUrl(
  broker: string | undefined,
  accessToken?: string | null,
): Promise<string> {
  const data = await call<{ url?: string }>("/api/brokerage/connect", {
    method: "POST",
    body: { broker: broker?.trim() || undefined },
    accessToken,
  });
  if (!data.url) throw new Error("SnapTrade did not return a connection URL.");
  return data.url;
}

export async function workerBrokerageNetWorth(
  accessToken?: string | null,
): Promise<BrokerageNetWorth> {
  const data = await call<{ networth?: BrokerageNetWorth }>("/api/brokerage/status", {
    accessToken,
  });
  return data.networth ?? { connected: false, total: 0, accounts: [] };
}

/* ------------------------------ onboarding ------------------------------- */

export async function workerSubmitOnboarding(
  answers: OnboardingSurveyAnswers,
  accessToken?: string | null,
): Promise<void> {
  await call<{ ok: true }>("/api/onboarding/submit", {
    method: "POST",
    body: { answers },
    accessToken,
  });
}
