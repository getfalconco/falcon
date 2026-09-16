/**
 * Fire-and-forget Falcon error posts to the falcon-error-logs Discord channel.
 * Uses DISCORD_ERROR_LOG_WEBHOOK_URL — never DISCORD_WEBHOOK_URL (git logs).
 */

export type ErrorLogUser = {
  email?: string | null;
  displayName?: string | null;
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

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, "[webhook]")
    .replace(/\n+/g, " ")
    .trim();
}

function displayField(value: string | null | undefined, kind: "name" | "email"): string {
  const trimmed = value?.trim() || "";
  if (!trimmed || trimmed.startsWith("(")) return "(unknown)";
  if (kind === "email" && !trimmed.includes("@")) return "(unknown)";
  return trimmed;
}

export function formatErrorLogLine(payload: ErrorLogPayload): string {
  const name = displayField(payload.user?.displayName, "name");
  const email = displayField(payload.user?.email, "email");
  const ticker = payload.ticker?.trim();
  const message = redactSecrets(payload.message || "").slice(0, 400);
  const parts = [payload.code.trim(), `user: ${name}`, `email: ${email}`];
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
    body: JSON.stringify({ content }),
  }).catch((err) => {
    console.warn("[discord] error-log failed:", err instanceof Error ? err.message : err);
  });
}
