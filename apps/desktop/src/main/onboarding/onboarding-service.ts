import { ensureOnboardingSchema } from "../db/ensure-onboarding-schema";
import { loadDesktopEnv } from "../load-desktop-env";
import { upsertLocalOnboardingResponse } from "./onboarding-local-store";
import type { OnboardingSurveyAnswers } from "../../shared/onboarding-survey";
import { isWorkerConfigured, workerSubmitOnboarding } from "../worker-api";

export type SubmitOnboardingSurveyResponse = { ok: true } | { ok: false; error: string };

const SUPABASE_HEADERS = {
  "User-Agent": "MeridianDesktop/1.0",
  "Content-Type": "application/json",
};

function supabaseConfig(): { url: string; serviceKey: string } | null {
  loadDesktopEnv(true);
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function supabaseAuthHeaders(serviceKey: string): Record<string, string> {
  return {
    ...SUPABASE_HEADERS,
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

function isMissingTableError(status: number, body: string): boolean {
  if (status === 404) return true;
  return /PGRST205|42P01|onboarding_responses|schema cache/i.test(body);
}

async function resolveUserId(accessToken: string): Promise<string> {
  loadDesktopEnv(true);
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured.");
  }

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error("Session expired. Sign in again.");
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error("Could not verify your account.");
  }

  return data.id;
}

function buildUpsertPayload(userId: string, answers: OnboardingSurveyAnswers) {
  return {
    user_id: userId,
    full_name: answers.fullName.trim() || null,
    investor_role: answers.investorRole,
    investor_role_other: answers.investorRoleOther,
    investing_tenure: answers.investingTenure,
    research_focus: answers.researchFocus,
    sectors: answers.sectors,
    country: answers.country,
    heard_about: answers.heardAbout,
    updated_at: new Date().toISOString(),
  };
}

async function upsertViaSupabase(
  userId: string,
  answers: OnboardingSurveyAnswers,
): Promise<"ok" | "missing_table"> {
  const config = supabaseConfig();
  if (!config) return "missing_table";

  const res = await fetch(`${config.url}/rest/v1/onboarding_responses?on_conflict=user_id`, {
    method: "POST",
    headers: {
      ...supabaseAuthHeaders(config.serviceKey),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(buildUpsertPayload(userId, answers)),
  });

  if (!res.ok) {
    const body = await res.text();
    if (isMissingTableError(res.status, body)) return "missing_table";
    throw new Error(body.slice(0, 240) || `Supabase upsert failed (${res.status})`);
  }

  return "ok";
}

export async function submitOnboardingSurvey(request: {
  answers: OnboardingSurveyAnswers;
  accessToken: string;
}): Promise<SubmitOnboardingSurveyResponse> {
  // No service-role key here (packaged build): the research-worker writes the
  // row on the user's behalf. Development with keys keeps the direct path.
  if (!supabaseConfig() && isWorkerConfigured()) {
    try {
      await workerSubmitOnboarding(request.answers, request.accessToken);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Could not save your answers.",
      };
    }
  }

  try {
    const userId = await resolveUserId(request.accessToken);
    await ensureOnboardingSchema();

    const result = await upsertViaSupabase(userId, request.answers);
    if (result === "missing_table") {
      await upsertLocalOnboardingResponse(userId, request.answers);
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not save your answers.",
    };
  }
}
