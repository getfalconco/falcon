import { createHmac } from "node:crypto";

/**
 * Pure helpers that keep personal data out of the Discord error log.
 *
 * COPY of apps/web/lib/log-identity.ts, kept verbatim below this comment:
 * the website posts to the same channel, and neither app depends on the
 * other, so there is no shared package both already import. Keep the two
 * copies in step: same salt env var (ERROR_LOG_ID_SALT), same output shapes,
 * so one person's reports read the same from either side. Worker-only extra
 * scrubbing lives in discord-error-log.ts, not here.
 *
 * Nothing here reads the environment or the network; callers pass the salt.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// IPv6: all eight groups, or a compressed form with "::". Requiring one of
// the two keeps clock times like 12:30:45 out of it.
const IPV6_RE = new RegExp(
  "(?<![0-9a-z:])(?:" +
    "(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}" +
    "|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5}" +
    "|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}" +
    "|(?:[0-9a-f]{1,4}:){1,7}:" +
    ")(?![0-9a-z:])",
  "gi",
);
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const SECRET_PARAM_RE =
  /\b(access_token|refresh_token|id_token|token|apikey|api_key|key|secret|password|signature)=([^&\s"']+)/gi;

/**
 * `kuzey@yahoo.com` -> `k***@yahoo.com`. The domain stays (it says which
 * provider, not who); the local part keeps only its first character.
 * Returns null for anything that is not an email address.
 */
export function maskEmail(value: string | null | undefined): string | null {
  const email = value?.trim() ?? "";
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain.includes(".") || /\s/.test(email)) return null;
  return `${local[0]}***@${domain}`;
}

/**
 * Stable pseudonym for a user id: the same person always gets the same tag,
 * and the tag cannot be turned back into the id without the server-side salt.
 * Returns null without a salt (an unsalted hash of a UUID is guessable from
 * the user table) or without an id.
 */
export function hashedUserId(
  userId: string | null | undefined,
  salt: string | null | undefined,
): string | null {
  const id = userId?.trim();
  const key = salt?.trim();
  if (!id || !key) return null;
  return `u_${createHmac("sha256", key).update(id).digest("hex").slice(0, 12)}`;
}

/**
 * Who a report is about, as it may appear in the log: the salted id tag when
 * possible, otherwise the masked email, otherwise "(unknown)". Never a name,
 * never a full email.
 */
export function logIdentity(
  input: { userId?: string | null; email?: string | null },
  salt: string | null | undefined,
): string {
  return hashedUserId(input.userId, salt) ?? maskEmail(input.email) ?? "(unknown)";
}

/**
 * Free text forwarded into the log (error messages, URLs): drops bearer
 * tokens, JWTs, API keys, secret query parameters, webhook URLs and IP
 * addresses, masks any email address, and folds it onto one line.
 */
export function scrubLogText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, "[webhook]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(JWT_RE, "[token]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(SECRET_PARAM_RE, (_m, name: string) => `${name}=[redacted]`)
    .replace(EMAIL_RE, (email) => maskEmail(email) ?? "[email]")
    .replace(IPV6_RE, "[ip]")
    .replace(IPV4_RE, "[ip]")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/**
 * An API URL for the log: origin and path only, no query or fragment (where
 * tokens travel), then scrubbed (a bare IP host becomes [ip]). Null when it
 * does not parse.
 */
export function scrubLogUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return scrubLogText(`${url.origin}${url.pathname}`).slice(0, 180) || null;
  } catch {
    return null;
  }
}
