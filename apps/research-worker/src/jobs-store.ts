/**
 * Durable job state in `public.research_jobs`.
 *
 * The step1 engine tracks jobs in an in-process Map, which dies with the
 * process and can't be read by a second instance. This mirrors each job to
 * Supabase with the service-role key so a client can poll across restarts and
 * the service can scale horizontally.
 */

export type JobKind = "step1" | "propagation" | "daily_signal";
export type JobStatus = "queued" | "running" | "done" | "error";

export type JobRow = {
  id: string;
  user_id: string;
  kind: JobKind;
  ticker: string | null;
  status: JobStatus;
  stage: string;
  progress_current: number;
  progress_total: number;
  error: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
};

function config(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function headers(serviceKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

export function isJobStoreConfigured(): boolean {
  return config() !== null;
}

export async function createJob(input: {
  userId: string;
  kind: JobKind;
  ticker?: string | null;
}): Promise<JobRow | null> {
  const c = config();
  if (!c) return null;

  try {
    const res = await fetch(`${c.url}/rest/v1/research_jobs`, {
      method: "POST",
      headers: { ...headers(c.serviceKey), Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: input.userId,
        kind: input.kind,
        ticker: input.ticker ?? null,
        status: "queued",
      }),
    });
    if (!res.ok) {
      console.warn("[jobs] create failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const rows = (await res.json()) as JobRow[];
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[jobs] create failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function updateJob(
  id: string,
  patch: Partial<
    Pick<
      JobRow,
      "status" | "stage" | "progress_current" | "progress_total" | "error" | "result"
    >
  >,
): Promise<void> {
  const c = config();
  if (!c) return;

  try {
    await fetch(`${c.url}/rest/v1/research_jobs?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...headers(c.serviceKey), Prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.warn("[jobs] update failed:", err instanceof Error ? err.message : err);
  }
}

/** Fetch a job, scoped to its owner so one user can't poll another's work. */
export async function getJob(id: string, userId: string): Promise<JobRow | null> {
  const c = config();
  if (!c) return null;

  try {
    const params = new URLSearchParams({
      id: `eq.${id}`,
      user_id: `eq.${userId}`,
      select: "*",
    });
    const res = await fetch(`${c.url}/rest/v1/research_jobs?${params}`, {
      headers: headers(c.serviceKey),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as JobRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function listJobs(
  userId: string,
  options?: { kind?: JobKind; ticker?: string; limit?: number },
): Promise<JobRow[]> {
  const c = config();
  if (!c) return [];

  try {
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      select: "*",
      order: "created_at.desc",
      limit: String(options?.limit ?? 40),
    });
    if (options?.kind) params.set("kind", `eq.${options.kind}`);
    if (options?.ticker) params.set("ticker", `eq.${options.ticker.toUpperCase()}`);
    const res = await fetch(`${c.url}/rest/v1/research_jobs?${params}`, {
      headers: headers(c.serviceKey),
    });
    if (!res.ok) return [];
    return ((await res.json()) as JobRow[]) ?? [];
  } catch {
    return [];
  }
}

export async function getLatestJobForTicker(
  userId: string,
  ticker: string,
): Promise<JobRow | null> {
  const rows = await listJobs(userId, { kind: "step1", ticker, limit: 1 });
  return rows[0] ?? null;
}
