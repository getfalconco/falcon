import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveUserFromReq } from "./auth.js";
import { falconError } from "./errors.js";
import { rateLimit } from "./rate-limit.js";

/**
 * Onboarding survey persistence. The desktop used to write this row itself
 * with the service-role key; a packaged build carries no such key, so the
 * write lives here. Any signed-in user may submit — onboarding happens before
 * approval — and the row is keyed on the verified user id, never on the body.
 */

type SurveyBody = {
  fullName?: unknown;
  investorRole?: unknown;
  investorRoleOther?: unknown;
  investingTenure?: unknown;
  researchFocus?: unknown;
  sectors?: unknown;
  country?: unknown;
  heardAbout?: unknown;
};

const MAX_TEXT = 200;

function str(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function strList(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().slice(0, 64))
    .slice(0, max);
}

function supabase(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleOnboardingSubmit(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const user = await resolveUserFromReq(req);
  if (!user) {
    sendJson(res, 401, { error: falconError("FAL-AUTH-02") });
    return;
  }
  const rl = rateLimit(`onboarding:${user.id}`, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    sendJson(res, 429, { error: falconError("FAL-REQ-01", "Please wait a moment and try again.") });
    return;
  }

  let body: SurveyBody;
  try {
    const raw = JSON.parse(await readBody(req)) as { answers?: SurveyBody } | SurveyBody;
    body = (raw && typeof raw === "object" && "answers" in raw ? raw.answers : raw) as SurveyBody;
    if (!body || typeof body !== "object") throw new Error("no answers");
  } catch {
    sendJson(res, 400, { error: falconError("FAL-REQ-01") });
    return;
  }

  const db = supabase();
  if (!db) {
    sendJson(res, 503, { error: falconError("FAL-INT-01", "Onboarding storage isn't configured.") });
    return;
  }

  const row = {
    user_id: user.id,
    full_name: str(body.fullName),
    investor_role: str(body.investorRole, 64),
    investor_role_other: str(body.investorRoleOther),
    investing_tenure: str(body.investingTenure, 64),
    research_focus: str(body.researchFocus, 64),
    sectors: strList(body.sectors),
    country: str(body.country, 8),
    heard_about: str(body.heardAbout),
    updated_at: new Date().toISOString(),
  };

  try {
    const upstream = await fetch(`${db.url}/rest/v1/onboarding_responses?on_conflict=user_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: db.serviceKey,
        Authorization: `Bearer ${db.serviceKey}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      console.error("[onboarding] upsert failed:", upstream.status, text.slice(0, 240));
      sendJson(res, 502, { error: falconError("FAL-INT-01", "We couldn't save your answers.") });
      return;
    }
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error("[onboarding] upsert threw:", err instanceof Error ? err.message : err);
    sendJson(res, 502, { error: falconError("FAL-NET-01") });
  }
}
