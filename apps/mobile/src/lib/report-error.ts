import type { User } from "@supabase/supabase-js";
import { resolveComputeApiUrl } from "@/lib/compute-url";
import type { FalconError } from "@/lib/errors";
import { requireSupabase } from "@/lib/supabase";

/**
 * Fire-and-forget client errors to getfalcon.co → #falcon-error-logs.
 * The research-worker never sees FAL-NET-01 (fetch never leaves the phone),
 * so this must not depend on it. Webhook secret stays server-side.
 */

const SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL ?? "https://getfalcon.co").replace(/\/$/, "");
const CONFIGURED_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");
const SKIP_PREFIXES = ["FAL-AUTH-", "FAL-REQ-"];

export type ClientErrorReportOpts = {
  ticker?: string | null;
  apiUrl?: string | null;
  accessToken?: string | null;
  email?: string | null;
  displayName?: string | null;
};

function looksLikeRealEmail(value: string | null | undefined): value is string {
  if (!value) return false;
  const email = value.trim();
  return email.includes("@") && !email.startsWith("(");
}

function sanitizeDisplayName(value: string | null | undefined): string | null {
  if (!value) return null;
  const name = value.trim();
  if (!name || name.startsWith("(")) return null;
  return name;
}

function emailFromUser(user: User | null | undefined): string | null {
  if (!user) return null;
  if (looksLikeRealEmail(user.email)) return user.email.trim();
  for (const identity of user.identities ?? []) {
    const nested = identity.identity_data?.email;
    if (typeof nested === "string" && looksLikeRealEmail(nested)) return nested.trim();
  }
  return null;
}

/** full_name → name → display_name, then email local-part (never a source tag). */
export function displayNameFromMetadata(
  meta: Record<string, unknown> | undefined,
  email: string | null,
): string | null {
  if (meta) {
    for (const key of ["full_name", "name", "display_name"]) {
      const value = meta[key];
      if (typeof value === "string" && value.trim() && !value.trim().startsWith("(")) {
        return value.trim();
      }
    }
  }
  const local = email?.split("@")[0]?.trim();
  return sanitizeDisplayName(local);
}

export function identityOptsFromSession(session: {
  access_token: string;
  user: User;
} | null | undefined): Pick<ClientErrorReportOpts, "accessToken" | "email" | "displayName"> {
  if (!session) return {};
  const email = emailFromUser(session.user);
  return {
    accessToken: session.access_token,
    email,
    displayName: displayNameFromMetadata(
      session.user.user_metadata as Record<string, unknown> | undefined,
      email,
    ),
  };
}

export function shouldReportClientError(code: string): boolean {
  return !SKIP_PREFIXES.some((prefix) => code.startsWith(prefix));
}

const recentlyPosted = new Map<string, number>();
const DEDUPE_MS = 8_000;

async function resolveReporterIdentity(opts?: ClientErrorReportOpts): Promise<{
  accessToken: string | null;
  email: string | null;
  displayName: string | null;
}> {
  let accessToken = opts?.accessToken?.trim() || null;
  let email = looksLikeRealEmail(opts?.email) ? opts!.email!.trim() : null;
  let displayName = sanitizeDisplayName(opts?.displayName);
  let metadata: Record<string, unknown> | undefined;

  try {
    const client = requireSupabase();
    const { data: userData } = await client.auth.getUser();
    if (userData.user) {
      const fromUser = emailFromUser(userData.user);
      if (fromUser) email = fromUser;
      metadata = userData.user.user_metadata as Record<string, unknown> | undefined;
    }
    if (!accessToken || !email || !metadata) {
      const { data: sessionData } = await client.auth.getSession();
      accessToken = accessToken ?? sessionData.session?.access_token ?? null;
      if (sessionData.session?.user) {
        if (!email) email = emailFromUser(sessionData.session.user);
        metadata =
          metadata ??
          (sessionData.session.user.user_metadata as Record<string, unknown> | undefined);
      }
    }
  } catch {
    // Unsigned-in is fine — still log the code.
  }

  displayName = displayNameFromMetadata(metadata, email) ?? displayName;
  return { accessToken, email, displayName };
}

export function reportClientFalconError(
  error: FalconError,
  opts?: ClientErrorReportOpts,
): void {
  if (!shouldReportClientError(error.code)) return;

  const key = `${error.code}:${opts?.ticker ?? ""}:${error.message}`;
  const now = Date.now();
  const prev = recentlyPosted.get(key) ?? 0;
  if (now - prev < DEDUPE_MS) return;
  recentlyPosted.set(key, now);

  const apiUrl = opts?.apiUrl ?? resolveComputeApiUrl(CONFIGURED_API_URL) ?? null;

  void (async () => {
    try {
      const { accessToken, email, displayName } = await resolveReporterIdentity(opts);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      await fetch(`${SITE_URL}/api/falcon-error`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          code: error.code,
          message: error.message,
          ticker: opts?.ticker ?? null,
          user: { email, displayName, name: displayName },
          client: "mobile",
          apiUrl: apiUrl || null,
        }),
      });
    } catch {
      // Never block the error UI.
    }
  })();
}
