/**
 * The phone's link to the always-on engine service (apps/falcon-engine on
 * Railway) — the same box the desktop reads through
 * `main/engine/engine-client.ts`, asking the same questions.
 *
 * The deterministic chain (Tracker → Classifier → Base → Propagation) runs
 * there 24/7. Nothing is recomputed here: the phone reads runs, it does not
 * produce them, which is the parity rule for the engine (docs/PLATFORM_PARITY.md
 * §5).
 *
 * Auth is the user's own Supabase JWT — the service verifies it against
 * Supabase and requires an approved account, exactly as the research worker
 * does. No provider key is ever on this side.
 */

import { describeComputeApiUrl } from "@/lib/compute-url";
import { requireSupabase } from "@/lib/supabase";
import type { PropagationRun, PropagationRunListItem } from "@/lib/propagation-runs";

/** The engine's `insight_explanations` row — see apps/falcon-engine/src/insight-explanation.ts. */
export type InsightExplanation = {
  run_id: string;
  headline: string;
  /** 2\u20133 sentences: the event, in the reader's language. */
  summary: string;
  /** Short lines: how it travels the graph, what to watch. */
  points: string[];
  model: string;
  generated_at: string;
};

/**
 * Baked in for the same reason the desktop bakes its own: a shipped build has
 * no `.env` to read, and an install that quietly reads no engine shows a card
 * that is empty rather than one that says so.
 */
export const DEFAULT_ENGINE_URL = "https://falcon-engine-production.up.railway.app";

const CONFIGURED_ENGINE_URL = (
  process.env.EXPO_PUBLIC_ENGINE_URL ?? DEFAULT_ENGINE_URL
).replace(/\/$/, "");

const TIMEOUT_MS = 15_000;

export function isEngineEnabled(): boolean {
  return CONFIGURED_ENGINE_URL.length > 0;
}

/** Loopback is rewritten to the Mac's LAN IP, keeping the engine's port. */
function engineUrl(): string {
  return describeComputeApiUrl(CONFIGURED_ENGINE_URL).url;
}

async function accessToken(): Promise<string | null> {
  try {
    const { data } = await requireSupabase().auth.getSession();
    const token = data.session?.access_token?.trim();
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function engineFetch<T>(path: string): Promise<T> {
  const base = engineUrl();
  if (!base) throw new Error("engine not configured");
  const token = await accessToken();
  if (!token) throw new Error("not signed in yet");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !body) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The propagation runs, newest first. Synthetic (fixture) runs are excluded by
 * the service; superseded ones are dropped by `orderRuns`/`buildCalendar`,
 * which is what the desktop's `currentOnly` filter does before those same
 * functions see the list.
 */
export async function listPropagationRuns(limit = 200): Promise<PropagationRunListItem[]> {
  const body = await engineFetch<{ ok: boolean; runs?: PropagationRunListItem[] }>(
    `/runs?limit=${encodeURIComponent(String(limit))}`,
  );
  return Array.isArray(body.runs) ? body.runs : [];
}

/** One run in full — the event's own words and the names it reached. */
export async function getPropagationRun(runId: string): Promise<PropagationRun | null> {
  const body = await engineFetch<{ ok: boolean; run?: PropagationRun }>(
    `/run?id=${encodeURIComponent(runId)}`,
  );
  return body.run ?? null;
}

/**
 * The write-up under an Insight headline: what the event is, how it travels
 * and what would confirm or kill the read.
 *
 * The service generates it once per run and shares it through Supabase, so the
 * first client to open an event pays for it and every other one reads that
 * row. `null` means this build of the service predates the route — the page
 * says so rather than spinning.
 */
export async function getInsightExplanation(runId: string): Promise<InsightExplanation | null> {
  try {
    const body = await engineFetch<{ ok: boolean; explanation?: InsightExplanation }>(
      `/insight?run=${encodeURIComponent(runId)}`,
    );
    return body.explanation ?? null;
  } catch (err) {
    // A service running a build older than this app answers "no route" rather
    // than failing — which is a missing brief, not an error worth showing.
    if (err instanceof Error && /no route/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * Whether the engine is allowed to put propagation content in front of a user
 * yet. Fail closed: a status outage reads as off, because latching it on would
 * surface exactly what the flag exists to hold back.
 */
export async function isPropagationSurfacing(): Promise<boolean> {
  try {
    const body = await engineFetch<{ ok: boolean; propagation?: { surfacing_enabled?: boolean } }>(
      "/status",
    );
    return body.propagation?.surfacing_enabled === true;
  } catch {
    return false;
  }
}
