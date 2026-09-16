/**
 * Supabase access for the engine service.
 *
 * The desktop reads the shared tables with the public anon key and writes with
 * the signed-in user's JWT, because no privileged key may ever sit next to a
 * renderer. This process has no renderer and no user: it holds the
 * service-role key, so it reads and writes directly.
 */

const TIMEOUT_MS = 15_000;

export type SupabaseEndpoint = { url: string; key: string };

export function supabaseEndpoint(): SupabaseEndpoint | null {
  const url = process.env.SUPABASE_URL?.trim() ?? process.env.VITE_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

export function supabaseHeaders(ep: SupabaseEndpoint, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: ep.key,
    Authorization: `Bearer ${ep.key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function supabaseFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const ep = supabaseEndpoint();
  if (!ep) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${ep.url}/rest/v1/${path}`, {
      ...init,
      signal: controller.signal,
      headers: supabaseHeaders(ep, (init.headers as Record<string, string>) ?? {}),
    });
  } finally {
    clearTimeout(timer);
  }
}
