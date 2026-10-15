import { getRendererSession } from "../session-bridge";

/**
 * POST /api/waitlist from the main process (the renderer would hit CORS).
 *
 * The site creates an account only for a new email. An existing account is
 * updated only when the request carries that account's own access token, so
 * the signed-in user's token from the session bridge goes along when there is
 * one. Without a token the site answers the same `{ ok: true }` whether or not
 * the email was taken and returns no member number; with one it answers for
 * the token's own account, including its member number.
 */

export type ApplyPayload = {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  application?: Record<string, string>;
};

export type ApplyResult =
  | { ok: true; memberNumber: number | null }
  | { ok: false; error: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function submitApplication(
  bases: readonly string[],
  payload: ApplyPayload,
  accessToken: string | null = getRendererSession().accessToken,
  fetchImpl: FetchLike = fetch,
): Promise<ApplyResult> {
  const body = JSON.stringify({ ...payload, email: payload.email.trim().toLowerCase() });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "MeridianDesktop/1.0",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let lastError = "Failed to submit your application.";
  for (const base of bases) {
    try {
      const res = await fetchImpl(`${base}/api/waitlist`, { method: "POST", headers, body });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        memberNumber?: unknown;
        error?: string;
      };
      if (res.ok && data.ok) {
        return {
          ok: true,
          // Only a signed-in answer carries it; otherwise read it later from
          // GET /api/waitlist/me with a session (membership.ts).
          memberNumber: typeof data.memberNumber === "number" ? data.memberNumber : null,
        };
      }
      lastError = data.error ?? lastError;
    } catch {
      // try next base
    }
  }
  return { ok: false, error: lastError };
}
