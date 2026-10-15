import { app } from "electron";
import { OPENROUTER_BASE_URL, finnhubApiBase, loadConfig } from "@meridian/research";
import { BRIEFING_NARRATIVE_MODEL_DEFAULT } from "@meridian/research/briefing";
import { resolveGlossConfig } from "@meridian/research/gloss";
import { registerIpcHandler } from "../ipc-register";
import { DEFAULT_ENGINE_URL, engineHealth } from "../engine/engine-client";
import { DEFAULT_RESEARCH_WORKER_URL, isProviderProxyActive } from "../provider-routing";
import { getRendererSession } from "../session-bridge";
import { insightModel } from "../insight/insight-explanation-service";
import { agentsModel } from "../agents/anthropic";
import { buildEnginesOverview } from "./engines-overview";
import type { EngineConnectionCheck, EnginesCheckResult } from "../../shared/engines-settings";

/**
 * Settings → Engines IPC.
 *
 *   engines:overview — where the chain and the worker are, which providers
 *                      have what they need (presence only), and the models
 *                      this process calls. Instant; no network.
 *   engines:check    — a live ping of the engine service's /health and of
 *                      Yahoo's chart endpoint, timed. The other providers are
 *                      pinged by the existing `diagnostics:providers` check,
 *                      which the pane runs alongside this one.
 *
 * Neither call is an engine channel, so both always answer from this process.
 */

const YAHOO_TIMEOUT_MS = 8_000;
const YAHOO_PING =
  "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d";

async function checkEngine(): Promise<EngineConnectionCheck> {
  const started = Date.now();
  const health = await engineHealth();
  const latencyMs = Date.now() - started;
  if (health.ok) return { status: "ok", latencyMs, version: health.value.version };
  if (health.error === "engine not configured") return { status: "skipped", detail: "No engine service is set" };
  return { status: "fail", latencyMs, detail: health.error };
}

async function checkYahoo(): Promise<EngineConnectionCheck> {
  const started = Date.now();
  try {
    const res = await fetch(YAHOO_PING, {
      // Yahoo turns away requests with no browser user agent, as market-data-service knows.
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" },
      signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    await res.arrayBuffer().catch(() => undefined);
    return res.ok ? { status: "ok", latencyMs } : { status: "fail", latencyMs, detail: `HTTP ${res.status}` };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      status: "fail",
      latencyMs: Date.now() - started,
      detail: timedOut ? `timed out after ${YAHOO_TIMEOUT_MS / 1000}s` : err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerEnginesHandlers(): void {
  registerIpcHandler("engines:overview", () => {
    try {
      const session = getRendererSession();
      const config = loadConfig();
      const overview = buildEnginesOverview(process.env, {
        packaged: app.isPackaged,
        providerProxy: isProviderProxyActive(),
        signedIn: Boolean(session.accessToken),
        sessionSupabaseUrl: session.supabaseUrl,
        defaults: {
          engineUrl: DEFAULT_ENGINE_URL,
          workerUrl: DEFAULT_RESEARCH_WORKER_URL,
          openRouterBaseUrl: OPENROUTER_BASE_URL,
          // finnhubApiBase() already honours FINNHUB_BASE_URL; the overview re-reads it, so either works.
          finnhubBaseUrl: finnhubApiBase(),
        },
        models: {
          gloss: resolveGlossConfig().model,
          insight: insightModel(),
          briefing: BRIEFING_NARRATIVE_MODEL_DEFAULT,
          agents: agentsModel(),
          step1: [config.step1ExtractModel, config.step1AuditModel, config.step1StrengthModel],
        },
      });
      return { ok: true as const, overview };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("engines:check", async () => {
    try {
      const [engine, yahoo] = await Promise.all([checkEngine(), checkYahoo()]);
      const result: EnginesCheckResult = { engine, yahoo };
      return { ok: true as const, result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
