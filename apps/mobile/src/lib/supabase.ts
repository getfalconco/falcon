import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { FUNNEL_TEST_MODE, SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./env";

if (Platform.OS !== "web") {
  // supabase-js needs a full URL implementation on React Native.
  require("react-native-url-polyfill/auto");
}

let client: SupabaseClient | null = null;

/** The app's Supabase client, or null when the env vars are missing. */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // Funnel test mode keeps the session in memory only: a restart signs out.
        storage: FUNNEL_TEST_MODE ? undefined : AsyncStorage,
        persistSession: !FUNNEL_TEST_MODE,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        // Google and Apple come back with a code (lib/oauth.ts).
        flowType: "pkce",
      },
    });
    if (Platform.OS !== "web") {
      // Refresh tokens only while the app is in the foreground.
      AppState.addEventListener("change", (state) => {
        if (!client) return;
        if (state === "active") void client.auth.startAutoRefresh();
        else void client.auth.stopAutoRefresh();
      });
    }
  }
  return client;
}

/** The signed-in member's access token for the website's API routes, or null. */
export async function accessToken(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    return (await supabase.auth.getSession()).data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
