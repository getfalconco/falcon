import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import { getSupabase } from "./supabase";

/**
 * Google and Apple sign-in on the website's Supabase project.
 *
 * Google (and Apple outside iOS): Supabase's OAuth page in an auth session
 * browser, back to the app on REDIRECT_URL, then the PKCE code is exchanged
 * for a session. Apple on iOS: the native Sign in with Apple sheet, its
 * identity token handed to Supabase.
 *
 * Supabase > Authentication > URL Configuration > Redirect URLs must allow
 * `falcon://**` (the phone) and the web preview's origin.
 */

/** The app scheme from app.json ("scheme": "falcon"). */
const NATIVE_REDIRECT = "falcon://auth/callback";

export function oauthRedirectUrl(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") return `${window.location.origin}/auth/callback`;
  return NATIVE_REDIRECT;
}

export type OAuthResult = { ok: true } | { ok: false; canceled: boolean; message?: string };

/** Query and fragment parameters of the redirect URL, merged. */
export function readParams(url: string): URLSearchParams {
  const params = new URLSearchParams();
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const query = q === -1 ? "" : url.slice(q + 1, h > q ? h : undefined);
  const hash = h === -1 ? "" : url.slice(h + 1);
  for (const part of [query, hash]) new URLSearchParams(part).forEach((value, key) => params.set(key, value));
  return params;
}

async function browserOAuth(provider: "google" | "apple"): Promise<OAuthResult> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, canceled: false, message: "Supabase is not configured." };
  const redirectTo = oauthRedirectUrl();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data.url) return { ok: false, canceled: false, message: error?.message ?? "Sign in failed." };

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== "success") return { ok: false, canceled: true };

  const params = readParams(result.url);
  const failure = params.get("error_description") ?? params.get("error");
  if (failure) return { ok: false, canceled: false, message: failure };

  const code = params.get("code");
  if (code) {
    const exchanged = await supabase.auth.exchangeCodeForSession(code);
    if (exchanged.error) return { ok: false, canceled: false, message: exchanged.error.message };
    return { ok: true };
  }
  // Implicit flow fallback: tokens in the fragment.
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (access_token && refresh_token) {
    const set = await supabase.auth.setSession({ access_token, refresh_token });
    if (set.error) return { ok: false, canceled: false, message: set.error.message };
    return { ok: true };
  }
  return { ok: false, canceled: false, message: "Sign in didn't finish. Please try again." };
}

export function signInWithGoogle(): Promise<OAuthResult> {
  return browserOAuth("google");
}

export async function signInWithApple(): Promise<OAuthResult> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, canceled: false, message: "Supabase is not configured." };
  const native = Platform.OS === "ios" && (await AppleAuthentication.isAvailableAsync().catch(() => false));
  if (!native) return browserOAuth("apple");

  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) return { ok: false, canceled: false, message: "Apple didn't return a sign-in token." };
    const { error } = await supabase.auth.signInWithIdToken({ provider: "apple", token: credential.identityToken });
    if (error) return { ok: false, canceled: false, message: error.message };
    return { ok: true };
  } catch (err) {
    if ((err as { code?: string })?.code === "ERR_REQUEST_CANCELED") return { ok: false, canceled: true };
    return { ok: false, canceled: false, message: err instanceof Error ? err.message : "Sign in with Apple failed." };
  }
}
