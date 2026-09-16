import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// supabase-js serialises auth calls behind a Web Lock (navigator.locks). This
// is a single-window app, so cross-tab locking buys nothing — and a stale lock
// held by another client instance makes every auth call wait on it. Run the
// callback directly instead of acquiring a lock.
const noopLock = async <R>(
  _name: string,
  _acquireTimeout: number,
  fn: () => Promise<R>,
): Promise<R> => fn();

// One client per window, surviving Vite HMR. Without this, every hot reload of
// this module created a fresh GoTrueClient while the old ones stayed alive on
// the same storage key ("Multiple GoTrueClient instances detected") — each new
// auth call then queued behind the orphans' locks, which is what made sign-in
// take 60+ seconds in dev after a session of edits.
const GLOBAL_KEY = "__falcon_supabase_client__";
type GlobalWithClient = typeof globalThis & { [GLOBAL_KEY]?: SupabaseClient | null };

function getOrCreateClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  const g = globalThis as GlobalWithClient;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY];
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      lock: noopLock,
    },
  });
  g[GLOBAL_KEY] = client;
  return client;
}

export const supabase: SupabaseClient | null = getOrCreateClient();

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to apps/desktop/.env",
    );
  }
  return supabase;
}
