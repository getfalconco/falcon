import { Platform } from "react-native";

/** Same Supabase project as the website (apps/web NEXT_PUBLIC_SUPABASE_*). */
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** The website that serves the API routes (tickers, filings, portfolio). */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || "https://getfalcon.co").replace(/\/$/, "");

/**
 * Funnel test mode, as on the website (NEXT_PUBLIC_FUNNEL_TEST_MODE). While on:
 *   - the Supabase session lives in memory only (a restart shows the login)
 *   - the welcome funnel always starts at step 1
 *   - welcome answers are not sent to the server
 * Off by default: the session is kept and returning members skip the
 * landing. Set EXPO_PUBLIC_FUNNEL_TEST_MODE=1 to turn it on again.
 */
export const FUNNEL_TEST_MODE = (process.env.EXPO_PUBLIC_FUNNEL_TEST_MODE ?? "0").trim() === "1";

/**
 * Absolute URL for a website API route. In the browser preview the routes go
 * through the Metro dev server's proxy (metro.config.js), because the site
 * sends no CORS headers; the phone calls the site directly.
 */
export function apiUrl(path: string): string {
  if (Platform.OS === "web" && __DEV__) return path;
  return `${API_URL}${path}`;
}
