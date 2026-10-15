/**
 * Fire-and-forget Falcon error posts to the falcon-error-logs Discord channel.
 * Uses DISCORD_ERROR_LOG_WEBHOOK_URL — never DISCORD_WEBHOOK_URL (git logs).
 *
 * A line names the account only by a salted hash of its id, `u_` + the first
 * 12 hex of HMAC-SHA256 (or a masked email like k***@yahoo.com when
 * ERROR_LOG_ID_SALT is not set): never a name, never a full address. The same
 * salt and format as the website's /api/falcon-error, so one account's reports
 * match across both. The ticker and the error code and text stay, with
 * credentials, IP addresses and email addresses scrubbed out of the text.
 * See log-identity.ts (a copy of apps/web/lib/log-identity.ts).
 */

import { logIdentity, scrubLogText } from "./log-identity.js";

export type ErrorLogUser = {
  /** Supabase user id; hashed with ERROR_LOG_ID_SALT before it is posted. */
  id?: string | null;
  /** Only used, masked, when there is no salt to hash the id with. */
  email?: string | null;
};

export type ErrorLogPayload = {
  code: string;
  message: string;
  user?: ErrorLogUser | null;
  ticker?: string | null;
};

const SKIP_PREFIXES = ["FAL-AUTH-", "FAL-REQ-"];

export function shouldForwardError(code: string): boolean {
  return !SKIP_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/** The salt for user references, read per call so tests and a redeploy see the current value. */
export function errorLogSalt(): string | null {
  return process.env.ERROR_LOG_ID_SALT?.trim() || null;
}

/**
 * Worker-only scrubbing on top of the shared helper: SnapTrade and Supabase
 * error bodies quote credentials as JSON fields (`"userSecret": "..."`), which
 * the shared `name=value` rule does not cover.
 */
const JSON_SECRET_FIELD =
  /(["']?(?:user_?secret|consumer_?key|client_?secret|api_?key|access_?token|refresh_?token|password|signature|secret|token)["']?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;

export function scrubWorkerText(text: string): string {
  return scrubLogText(text.replace(JSON_SECRET_FIELD, (_m, name: string) => `${name}[redacted]`));
}

export function formatErrorLogLine(payload: ErrorLogPayload, salt: string | null = errorLogSalt()): string {
  const ticker = payload.ticker?.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 16);
  const message = scrubWorkerText(payload.message || "").slice(0, 400);
  const parts = [payload.code.trim(), `user: ${logIdentity({ userId: payload.user?.id, email: payload.user?.email }, salt)}`];
  if (ticker) parts.push(`ticker: ${ticker}`);
  if (message) parts.push(message);
  return parts.join(" · ").slice(0, 1800);
}

export function reportFalconError(payload: ErrorLogPayload): void {
  if (!shouldForwardError(payload.code)) return;

  const webhookUrl = process.env.DISCORD_ERROR_LOG_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  const content = formatErrorLogLine(payload);
  if (!content) return;

  void fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  }).catch((err) => {
    console.warn("[discord] error-log failed:", err instanceof Error ? err.message : err);
  });
}
