import { app } from "electron";
import { getRendererSession, onRendererSession } from "./session-bridge";

/**
 * How a packaged Falcon reaches paid providers without carrying their keys.
 *
 * In development `.env` supplies ANTHROPIC_API_KEY / FINNHUB_API_KEY and the
 * engines call the providers directly. A packaged build ships no `.env`, so
 * instead everything is routed through the research-worker on Railway:
 *
 *   ANTHROPIC_BASE_URL → <worker>/api/anthropic   (the SDK honours this env)
 *   FINNHUB_BASE_URL   → <worker>/api/finnhub     (packages/research/src/finnhub.ts)
 *   ANTHROPIC_API_KEY = FINNHUB_API_KEY = the user's Supabase JWT
 *
 * The worker verifies the JWT, swaps in the real key, and forwards. The JWT
 * rotates (~hourly); the renderer pushes every refresh through the session
 * bridge and we re-stamp the env here. Engines read these vars per call (the
 * Anthropic wrappers re-create their client when the key changes), so nothing
 * needs restarting.
 *
 * Opt-in from a dev build with FALCON_PROVIDER_PROXY=1 to test the same path;
 * a packaged build with real provider keys in its env keeps direct calls.
 */

export const DEFAULT_RESEARCH_WORKER_URL = "https://research-worker-production-c17d.up.railway.app";

function trimmed(key: string): string {
  return process.env[key]?.trim() ?? "";
}

export function shouldProxyProviders(): boolean {
  const flag = trimmed("FALCON_PROVIDER_PROXY");
  if (flag === "1" || flag.toLowerCase() === "true") return true;
  if (flag === "0" || flag.toLowerCase() === "false") return false;
  // Packaged, and nobody supplied real keys: proxy.
  return app.isPackaged && !trimmed("ANTHROPIC_API_KEY") && !trimmed("FINNHUB_API_KEY");
}

/** Ensures RESEARCH_WORKER_URL is set (packaged builds default to Railway). */
export function resolveWorkerUrl(): string {
  let url = trimmed("RESEARCH_WORKER_URL");
  if (!url && (app.isPackaged || shouldProxyProviders())) url = DEFAULT_RESEARCH_WORKER_URL;
  url = url.replace(/\/+$/, "");
  if (url) process.env.RESEARCH_WORKER_URL = url;
  return url;
}

let active = false;

/** Call once at startup, before any engine bootstraps. */
export function configureProviderRouting(): { mode: "direct" | "proxy"; workerUrl: string } {
  const workerUrl = resolveWorkerUrl();
  if (!shouldProxyProviders() || !workerUrl) {
    return { mode: "direct", workerUrl };
  }

  active = true;
  process.env.ANTHROPIC_BASE_URL = `${workerUrl}/api/anthropic`;
  process.env.FINNHUB_BASE_URL = `${workerUrl}/api/finnhub`;
  applyToken(getRendererSession().accessToken);
  onRendererSession((session) => applyToken(session.accessToken));
  console.info(`[providers] routing Anthropic + Finnhub through ${workerUrl}`);
  return { mode: "proxy", workerUrl };
}

function applyToken(token: string | null): void {
  if (!active) return;
  if (token) {
    process.env.ANTHROPIC_API_KEY = token;
    process.env.FINNHUB_API_KEY = token;
  } else {
    // Signed out: engines see "not configured" and idle until the next sign-in.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FINNHUB_API_KEY;
  }
}

export function isProviderProxyActive(): boolean {
  return active;
}
