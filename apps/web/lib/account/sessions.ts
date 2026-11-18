/**
 * "Where you're logged in": the shapes GET /api/account/sessions returns and
 * the pure helpers behind it. Runs on the server and in tests; nothing here
 * touches the network.
 */

export type SessionView = {
  id: string;
  /** "Chrome (macOS)" (lib/account/user-agent.ts). */
  device: string;
  /** Coarse "City, Country" when known, else null (shown as a dash). Never an IP. */
  location: string | null;
  /** ISO times; null when unknown (the current device when sessions cannot be listed). */
  signedInAt: string | null;
  lastActiveAt: string | null;
  current: boolean;
};

export type SessionsResponse =
  /** `listed` false: the server cannot read auth.sessions; only this device is shown. */
  { listed: true; sessions: SessionView[] } | { listed: false; current: SessionView | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * The `session_id` claim of a Supabase access token, or null. Only call this
 * on a token the server has already verified (auth.getUser); it does not
 * check the signature.
 */
export function sessionIdFromToken(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { session_id?: unknown };
    return isUuid(json.session_id) ? json.session_id : null;
  } catch {
    return null;
  }
}

/**
 * A coarse "City, Country" from the hosting platform's geo headers (Netlify
 * `x-nf-geo`, base64 JSON; or a bare `x-country` code). No IP is read or sent
 * anywhere: the platform resolved it before the request reached us.
 */
export function coarseLocation(headers: Headers): string | null {
  const raw = headers.get("x-nf-geo");
  if (raw) {
    try {
      const geo = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { city?: unknown; country?: { name?: unknown; code?: unknown } };
      const city = typeof geo.city === "string" ? geo.city.trim() : "";
      const country = typeof geo.country?.name === "string" ? geo.country.name.trim() : typeof geo.country?.code === "string" ? geo.country.code.trim() : "";
      const out = [city, country].filter(Boolean).join(", ");
      if (out) return out.slice(0, 80);
    } catch {
      // Unreadable header: fall through.
    }
  }
  const code = headers.get("x-country")?.trim();
  return code && /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null;
}

/** Current session first, then the most recently active. */
export function sortSessions(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) => (a.current === b.current ? (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") : a.current ? -1 : 1));
}
