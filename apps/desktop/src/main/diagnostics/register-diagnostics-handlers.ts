import { app } from "electron";
import { registerIpcHandler } from "../ipc-register";
import { resolveDataRoot } from "../data-root";
import { isProviderProxyActive } from "../provider-routing";
import { getRendererSession } from "../session-bridge";
import type {
  DiagnosticsEnvInfo,
  DiagnosticsKeyInfo,
  ProviderCheckResult,
} from "../../shared/diagnostics-types";

/**
 * Shift+H diagnostics IPC. Two calls:
 *
 *   diagnostics:env        — instant snapshot of routing mode, base URLs and
 *                            key presence (never values), so a packaged build
 *                            can be compared against dev at a glance.
 *   diagnostics:providers  — live pings against every provider the engines
 *                            use, THROUGH the same env-var routing the engines
 *                            use (ANTHROPIC_BASE_URL / FINNHUB_BASE_URL), so a
 *                            green row here means the proxy path works too.
 *
 * Cost note: every check is free — Anthropic uses /v1/messages/count_tokens,
 * which is on the proxy allow-list too. Keep it that way: a panel that costs
 * money to open is a panel nobody opens.
 */

const CHECK_TIMEOUT_MS = 12_000;

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function keyInfo(name: string, note?: string): DiagnosticsKeyInfo {
  const value = env(name);
  return { name, present: value.length > 0, length: value.length, note };
}

function anthropicBase(): string {
  return (env("ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/+$/, "");
}

function finnhubBase(): string {
  return (env("FINNHUB_BASE_URL") || "https://finnhub.io/api/v1").replace(/\/+$/, "");
}

function buildEnvInfo(): DiagnosticsEnvInfo {
  const proxy = isProviderProxyActive();
  const session = getRendererSession();
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? "?",
    node: process.versions.node ?? "?",
    packaged: app.isPackaged,
    providerMode: proxy ? "proxy" : "direct",
    workerUrl: env("RESEARCH_WORKER_URL") || null,
    anthropicBaseUrl: anthropicBase(),
    finnhubBaseUrl: finnhubBase(),
    dataRoot: resolveDataRoot(),
    session: {
      hasToken: Boolean(session.accessToken),
      hasSupabaseUrl: Boolean(session.supabaseUrl || env("SUPABASE_URL") || env("VITE_SUPABASE_URL")),
      updatedAt: session.accessToken ? session.updatedAt : null,
    },
    keys: [
      keyInfo("ANTHROPIC_API_KEY", proxy ? "holds the Supabase JWT (proxy mode)" : undefined),
      keyInfo("FINNHUB_API_KEY", proxy ? "holds the Supabase JWT (proxy mode)" : undefined),
      keyInfo("SUPABASE_SERVICE_ROLE_KEY"),
      keyInfo("RESEARCH_WORKER_URL"),
    ],
  };
}

/* ------------------------------ live checks ------------------------------ */

type FetchOutcome = { res: Response; body: string; latencyMs: number };

async function timedFetch(url: string, init: RequestInit = {}): Promise<FetchOutcome> {
  const started = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  const body = await res.text();
  return { res, body, latencyMs: Date.now() - started };
}

function snippet(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function runCheck(
  id: string,
  label: string,
  fn: () => Promise<ProviderCheckResult>,
): Promise<ProviderCheckResult> {
  try {
    return await fn();
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${CHECK_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    return { id, label, status: "fail", detail: message };
  }
}

function checkAnthropic(): Promise<ProviderCheckResult> {
  const id = "anthropic";
  const label = "Anthropic (step1, classifier, analyst, gloss…)";
  return runCheck(id, label, async () => {
    const key = env("ANTHROPIC_API_KEY");
    if (!key) return { id, label, status: "missing-key" };
    const { res, body, latencyMs } = await timedFetch(`${anthropicBase()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    return res.ok
      ? { id, label, status: "ok", httpStatus: res.status, latencyMs, detail: `via ${anthropicBase()}` }
      : { id, label, status: "fail", httpStatus: res.status, latencyMs, detail: snippet(body) };
  });
}

function checkFinnhub(): Promise<ProviderCheckResult> {
  const id = "finnhub";
  const label = "Finnhub (tracker news/quotes, calendar)";
  return runCheck(id, label, async () => {
    const key = env("FINNHUB_API_KEY");
    if (!key) return { id, label, status: "missing-key" };
    const url = `${finnhubBase()}/quote?symbol=AAPL&token=${encodeURIComponent(key)}`;
    const { res, body, latencyMs } = await timedFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { id, label, status: "fail", httpStatus: res.status, latencyMs, detail: snippet(body) };
    let price: unknown;
    try {
      price = (JSON.parse(body) as { c?: unknown }).c;
    } catch {
      /* fall through */
    }
    return typeof price === "number" && price > 0
      ? { id, label, status: "ok", httpStatus: res.status, latencyMs, detail: `AAPL quote ${price} via ${finnhubBase()}` }
      : { id, label, status: "fail", httpStatus: res.status, latencyMs, detail: `unexpected body: ${snippet(body)}` };
  });
}

function checkEdgar(): Promise<ProviderCheckResult> {
  const id = "edgar";
  const label = "SEC EDGAR (step1 filings)";
  return runCheck(id, label, async () => {
    const ua = env("SEC_USER_AGENT") || "Falcon Research dev@joinfalcon.ai";
    const url =
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K&count=1&output=atom";
    const { res, body, latencyMs } = await timedFetch(url, { headers: { "User-Agent": ua } });
    return res.ok
      ? { id, label, status: "ok", httpStatus: res.status, latencyMs }
      : { id, label, status: "fail", httpStatus: res.status, latencyMs, detail: snippet(body) };
  });
}

function checkWorker(): Promise<ProviderCheckResult> {
  const id = "worker";
  const label = "Research worker (Railway proxy + step1 jobs)";
  return runCheck(id, label, async () => {
    const base = env("RESEARCH_WORKER_URL").replace(/\/+$/, "");
    if (!base) return { id, label, status: "skipped", detail: "RESEARCH_WORKER_URL not set (direct mode)" };
    // Plain liveness, NOT /api/research/health — that route probes Perplexity,
    // which Falcon no longer uses, and answers 200 either way.
    const { res, body, latencyMs } = await timedFetch(`${base}/health`);
    return res.ok
      ? { id, label, status: "ok", httpStatus: res.status, latencyMs, detail: base }
      : { id, label, status: "fail", httpStatus: res.status, latencyMs, detail: snippet(body) };
  });
}

function checkSupabase(): Promise<ProviderCheckResult> {
  const id = "supabase";
  const label = "Supabase (auth + shared signal cache)";
  return runCheck(id, label, async () => {
    const session = getRendererSession();
    const url = (session.supabaseUrl || env("SUPABASE_URL") || env("VITE_SUPABASE_URL")).replace(/\/+$/, "");
    const apikey = session.anonKey || env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url) return { id, label, status: "missing-key", detail: "no Supabase URL (renderer session not pushed yet?)" };
    const { res, body, latencyMs } = await timedFetch(`${url}/auth/v1/health`, {
      headers: apikey ? { apikey } : undefined,
    });
    return res.ok
      ? { id, label, status: "ok", httpStatus: res.status, latencyMs }
      : { id, label, status: "fail", httpStatus: res.status, latencyMs, detail: snippet(body) };
  });
}

export function registerDiagnosticsHandlers(): void {
  registerIpcHandler("diagnostics:env", () => {
    try {
      return { ok: true as const, env: buildEnvInfo() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("diagnostics:providers", async () => {
    try {
      const results = await Promise.all([
        checkAnthropic(),
        checkFinnhub(),
        checkEdgar(),
        checkWorker(),
        checkSupabase(),
      ]);
      return { ok: true as const, results };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
