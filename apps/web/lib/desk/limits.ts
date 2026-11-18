/**
 * Falcon AI's per-member daily budget (POST /api/desk/chat): dollars spent on
 * the model and requests made in one New York day. Defaults, overridable by env:
 *   DESK_DAILY_USD       5     dollars per member per day (0 = no cap)
 *   DESK_DAILY_REQUESTS  300   requests per member per day, resumes included (0 = no cap)
 *   DESK_UNLIMITED_USERS       comma-separated member ids with no daily cap
 * The founder is never capped: the admin cookie, and his member account
 * (FOUNDER_USERS) even without the env. Under `next dev` (localhost) there are
 * no Falcon AI limits at all and nothing is counted (limitsOff).
 *
 * Usage lives in Supabase public.desk_usage (migration
 * supabase/migrations/20261120_desk_usage.sql, read and written with the
 * service role over PostgREST). Until that table exists, or when Supabase is
 * not configured or does not answer, it falls back to an in-memory counter
 * per warm instance (logged once); a check never blocks a member because the
 * store failed. Server-only.
 */

export type Usage = { usd: number; requests: number };
export type Budget = { dailyUsd: number; dailyRequests: number };

export const DAILY_LIMIT_MESSAGE = "You've reached today's Falcon AI limit. It resets at midnight New York time.";

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function budgetFromEnv(env: Record<string, string | undefined> = process.env): Budget {
  return { dailyUsd: num(env.DESK_DAILY_USD, 5), dailyRequests: num(env.DESK_DAILY_REQUESTS, 300) };
}

/** The founder's member account (kovalak.kuzey@gmail.com): never capped, with or without DESK_UNLIMITED_USERS. */
export const FOUNDER_USERS: readonly string[] = ["56b7a75c-ac79-4e42-8286-26596d02622d"];

export function unlimitedUser(userId: string | null, env: Record<string, string | undefined> = process.env): boolean {
  if (!userId) return false;
  if (FOUNDER_USERS.includes(userId)) return true;
  return (env.DESK_UNLIMITED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(userId);
}

/**
 * Local development (`next dev`, the server's own NODE_ENV; nothing in a
 * request can set it): no rate limits, no daily budget, no usage counted.
 * A production build always applies them.
 */
export function limitsOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development";
}

/** The New York calendar day, "YYYY-MM-DD". */
export function nyDay(nowMs = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(nowMs);
}

/** Which cap a member is over, if any (a cap of 0 is off). */
export function overBudget(used: Usage, b: Budget): "usd" | "requests" | null {
  if (b.dailyUsd > 0 && used.usd >= b.dailyUsd) return "usd";
  if (b.dailyRequests > 0 && used.requests >= b.dailyRequests) return "requests";
  return null;
}

/** In-memory usage per key and day (this warm instance only). */
export class MemoryUsage {
  private rows = new Map<string, Usage>();
  get(key: string, day: string): Usage {
    return this.rows.get(`${day}|${key}`) ?? { usd: 0, requests: 0 };
  }
  add(key: string, day: string, usd: number, requests: number): void {
    // Keeps only today's rows.
    for (const k of Array.from(this.rows.keys())) if (!k.startsWith(`${day}|`)) this.rows.delete(k);
    const u = this.get(key, day);
    this.rows.set(`${day}|${key}`, { usd: u.usd + usd, requests: u.requests + requests });
  }
}

const memory = new MemoryUsage();
/** The Supabase table is missing or unreachable for good on this instance: memory only. */
let tableOff = false;
let warned = false;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function config(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key } : null;
}

function offline(reason: string, permanent: boolean) {
  if (permanent) tableOff = true;
  if (!warned) {
    warned = true;
    console.warn("[desk/limits] daily usage kept in memory on this instance:", reason);
  }
}

/** Missing table / function (PostgREST PGRST202/PGRST205, Postgres 42P01/42883) means the migration is not applied. */
async function missing(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  const body = await res.text().catch(() => "");
  return /PGRST20[25]|42P01|42883/.test(body);
}

async function remote(path: string, init: RequestInit): Promise<Response | null> {
  const c = config();
  if (!c || tableOff) return null;
  try {
    return await fetch(`${c.url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
      cache: "no-store",
    });
  } catch (error) {
    offline(error instanceof Error ? error.message : "fetch failed", false);
    return null;
  }
}

/** Today's usage for `key` (a member id, or "ip:..." in the dev preview). */
export async function readUsage(key: string, day = nyDay()): Promise<Usage> {
  const local = memory.get(key, day);
  if (!UUID.test(key)) return local;
  const res = await remote(`desk_usage?select=usd,requests&user_id=eq.${encodeURIComponent(key)}&day=eq.${day}`, { method: "GET" });
  if (!res) return local;
  if (!res.ok) {
    offline(`read ${res.status}`, await missing(res));
    return local;
  }
  const rows = (await res.json().catch(() => [])) as { usd?: unknown; requests?: unknown }[];
  const row = rows[0];
  // The larger of the two, so usage recorded here before the table answered still counts.
  return row ? { usd: Math.max(Number(row.usd) || 0, local.usd), requests: Math.max(Number(row.requests) || 0, local.requests) } : local;
}

/** Adds one request's spend (atomic increment in the desk_usage_add function). */
export async function recordUsage(key: string, usd: number, requests = 1, day = nyDay()): Promise<void> {
  memory.add(key, day, usd, requests);
  if (!UUID.test(key)) return;
  const res = await remote("rpc/desk_usage_add", { method: "POST", body: JSON.stringify({ p_user: key, p_day: day, p_usd: Number(usd.toFixed(6)), p_requests: requests }) });
  if (res && !res.ok) offline(`write ${res.status}`, await missing(res));
}

/**
 * Whether this member may ask now. `unlimited` (admin) always may. Never
 * throws: a store failure lets the request through.
 */
export async function checkBudget(key: string, unlimited: boolean, budget = budgetFromEnv()): Promise<{ ok: true } | { ok: false; reason: "usd" | "requests"; error: string }> {
  if (unlimited) return { ok: true };
  try {
    const over = overBudget(await readUsage(key), budget);
    return over ? { ok: false, reason: over, error: DAILY_LIMIT_MESSAGE } : { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Tests only. */
export function _resetLimitsForTests() {
  tableOff = false;
  warned = false;
}
