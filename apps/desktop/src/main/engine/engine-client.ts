/**
 * The desktop's link to the always-on engine service (apps/falcon-engine).
 *
 * The deterministic chain — Tracker, Classifier, Base, Propagation — used to
 * run inside this process, which meant it only advanced while the app was
 * open. It runs on the server now. What is left here is a client: the panels
 * ask for the same channels they always did, and those questions are answered
 * over HTTP instead of by a local host.
 *
 * Two modes:
 *   * remote — this process produces nothing. Always the case for a packaged
 *     build: it reads no `.env`, so without a baked-in default every shipped
 *     install would quietly run its own chain, polling Finnhub and spending the
 *     Anthropic budget on a stream nobody reads — the same reasoning, and the
 *     same shape, as DEFAULT_RESEARCH_WORKER_URL in provider-routing.ts.
 *   * local — only a dev checkout that sets `FALCON_ENGINE_URL` to empty.
 *     There is no falling back to local when the service is unreachable: a
 *     second chain doubles the provider spend and gives the same event two
 *     incident ids, and this install keeps no history to run one from.
 *
 * Auth is the user's own Supabase JWT, handed over by the renderer through the
 * session bridge — the same token the research worker takes. No privileged key
 * is ever on this side.
 */

import { getRendererSession } from "../session-bridge";

const TIMEOUT_MS = 30_000;

export const DEFAULT_ENGINE_URL = "https://falcon-engine-production.up.railway.app";

export function engineUrl(): string | null {
  const raw = process.env.FALCON_ENGINE_URL?.trim();
  // An explicit empty value is how a dev checkout opts out and runs its own
  // chain; merely unset in a packaged build means nobody supplied one, and the
  // answer there is the service, never this process.
  if (raw === "") return null;
  // Unset means the service — in a dev checkout too.
  //
  // This used to return null for an unset dev build, on the reasoning that a
  // developer had not asked for anything. But once the chain stopped running
  // in-process by default, "nothing asked for" became "nothing at all": the app
  // opened, the Tracker header read the engine and said "running · 429 today",
  // and the message list underneath read the empty local store and showed the
  // previous day. No error, two sources, one of them dead.
  //
  // Reading the service is what a dev checkout almost always wants, so it is
  // the default and opting out is the deliberate act. A fresh clone with no
  // .env works.
  if (!raw) return DEFAULT_ENGINE_URL;
  return raw.replace(/\/$/, "");
}

/** True when this install reads the server rather than running its own chain. */
export function engineRemote(): boolean {
  return engineUrl() !== null;
}

function accessToken(): string | null {
  const session = getRendererSession();
  const token = session?.accessToken?.trim();
  return token && token.length > 0 ? token : null;
}

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<EngineResult<T>> {
  const base = engineUrl();
  if (!base) return { ok: false, error: "engine not configured" };
  const token = accessToken();
  if (!token) return { ok: false, error: "not signed in yet" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
    const body = (await res.json().catch(() => null)) as T | { error?: string } | null;
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
      return { ok: false, error: message };
    }
    return { ok: true, value: body as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: /abort/i.test(message) ? "engine timed out" : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call one engine channel. The reply is the handler's own payload — the same
 * `{ ok, … }` shape the local host returns — so a caller cannot tell from the
 * result whether the work happened here or there.
 */
export async function callEngine<T>(channel: string, args: unknown[] = []): Promise<T | { ok: false; error: string }> {
  const result = await request<T>("/channel", {
    method: "POST",
    body: JSON.stringify({ channel, args }),
  });
  return result.ok ? result.value : { ok: false, error: result.error };
}

export type EngineHealth = {
  ok: boolean;
  version: string;
  uptime_s: number;
  tracker: number;
  propagation_runs: number;
  loop: boolean;
};

export async function engineHealth(): Promise<EngineResult<EngineHealth>> {
  const base = engineUrl();
  if (!base) return { ok: false, error: "engine not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    // /health is deliberately unauthenticated, so this works before sign-in —
    // which is exactly when the app most needs to know whether it has a chain.
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, value: (await res.json()) as EngineHealth };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
