/**
 * How often one account may start a new company research.
 *
 * Every other paid path here has a daily cap — the classifier's 500, the
 * propagation judge's 30 — and step1 had none, because it is user-triggered and
 * nobody triggers eighty of them. But "nobody would" is not a limit: a filing
 * costs about $1.30 to extract, so a single account clicking through the ticker
 * list can spend a month's budget in an afternoon, and the first sign would be
 * the bill.
 *
 * Derived from the jobs table rather than a counter in memory. An in-process
 * bucket resets on every deploy, and with a five-hour window that is not a
 * rounding error — it is a quota anyone can clear by waiting for the next
 * release. The jobs row is already written, already durable, and is the actual
 * truth about when this account last researched something.
 */

import { listJobs } from "./jobs-store.js";

/** One research per this window, per account. */
export const RESEARCH_WINDOW_MS = 5 * 60 * 60_000;
export const RESEARCH_LIMIT = 1;

export type ResearchQuota = {
  limit: number;
  windowMs: number;
  /** Starts used inside the current window. */
  used: number;
  remaining: number;
  /** When the oldest start in the window ages out, or null when nothing is used. */
  resetAt: string | null;
  /** Seconds until `resetAt`, floored at 0. Null when nothing is used. */
  retryAfterSeconds: number | null;
  allowed: boolean;
};

const EMPTY: ResearchQuota = {
  limit: RESEARCH_LIMIT,
  windowMs: RESEARCH_WINDOW_MS,
  used: 0,
  remaining: RESEARCH_LIMIT,
  resetAt: null,
  retryAfterSeconds: null,
  allowed: true,
};

/**
 * Pure scoring, so the window arithmetic is testable without Supabase.
 *
 * `startedAt` values are the created_at of this account's step1 jobs, newest
 * first. Only starts inside the window count: a job that failed still consumed
 * the extraction, so it counts too — refunding failures would make a retry loop
 * free, which is the one case a spend cap exists for.
 */
export function scoreResearchQuota(
  startedAt: string[],
  now: number,
  limit = RESEARCH_LIMIT,
  windowMs = RESEARCH_WINDOW_MS,
): ResearchQuota {
  const cutoff = now - windowMs;
  const inWindow = startedAt
    .map((iso) => Date.parse(iso))
    .filter((t) => Number.isFinite(t) && t > cutoff)
    .sort((a, b) => a - b);

  const used = inWindow.length;
  if (used === 0) return { ...EMPTY, limit, windowMs, remaining: limit };

  // The window frees a slot when its OLDEST start ages out, not when the
  // newest does — otherwise one start would lock the account for a full window
  // every time it made another.
  const resetMs = inWindow[0]! + windowMs;
  const allowed = used < limit;
  return {
    limit,
    windowMs,
    used,
    remaining: Math.max(0, limit - used),
    resetAt: new Date(resetMs).toISOString(),
    retryAfterSeconds: Math.max(0, Math.ceil((resetMs - now) / 1000)),
    allowed,
  };
}

/**
 * This account's current standing. Never throws: if the store cannot be read
 * the request is allowed, because failing closed would make a Supabase blip
 * look like a quota to every user at once.
 */
export async function researchQuotaFor(userId: string, now = Date.now()): Promise<ResearchQuota> {
  try {
    // A small page is enough — the window can only hold `limit` starts before
    // it refuses, and a handful of extras cover retries and clock skew.
    const jobs = await listJobs(userId, { kind: "step1", limit: 10 });
    return scoreResearchQuota(
      jobs.map((j) => j.created_at),
      now,
    );
  } catch {
    return { ...EMPTY };
  }
}

/** Human-readable time remaining, for the message the client shows. */
export function formatRetryAfter(seconds: number): string {
  if (seconds <= 60) return "under a minute";
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (rem === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${rem}m`;
}
