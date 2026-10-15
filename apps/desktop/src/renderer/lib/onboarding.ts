import type { User } from "@supabase/supabase-js";
import type { OnboardingSurveyAnswers } from "../../shared/onboarding-survey";
import { countryFromLocales } from "../../shared/onboarding-country";
import { COUNTRIES } from "@/lib/countries";
import { requireSupabase } from "@/lib/supabase";
import { readPreferences } from "@/lib/user-preferences";

/**
 * Persists the onboarding answers to the privileged backend store
 * (separate from the auth user_metadata fields that gate app access). Best
 * effort: failures are logged, not surfaced, so a backend hiccup never blocks
 * the user from finishing onboarding.
 */
export async function submitOnboardingSurvey(answers: OnboardingSurveyAnswers): Promise<void> {
  const bridge = window.meridian?.submitOnboardingSurvey;
  if (!bridge) return;

  try {
    const client = requireSupabase();
    const {
      data: { session },
    } = await client.auth.getSession();
    if (!session) return;

    const result = await bridge({ answers, accessToken: session.access_token });
    if (!result.ok) {
      console.warn("[onboarding] could not save survey responses:", result.error);
    }
  } catch (err) {
    console.warn("[onboarding] could not save survey responses:", err);
  }
}

/**
 * The country, no longer asked: read from the machine's own locale list
 * ("tr-TR" is Türkiye), in the same English name the old picker stored.
 * Null when no locale names a region the list knows.
 */
export function inferCountry(): string | null {
  let locales: readonly string[] = [];
  try {
    locales = navigator.languages?.length ? navigator.languages : [navigator.language];
  } catch {
    locales = [];
  }
  const code = countryFromLocales(locales, COUNTRIES.map((c) => c.code));
  return COUNTRIES.find((c) => c.code === code)?.name ?? null;
}

/**
 * The survey row as the new setup fills it. Role and focus are no longer
 * asked (holding period replaced them), so they go as null; the explanation
 * depth keeps the old experience ids in `investingTenure`, so existing
 * analytics read it unchanged.
 */
export function surveyAnswersFor(user: User, heardAbout: string | null = null): OnboardingSurveyAnswers {
  const prefs = readPreferences(user);
  return {
    fullName: prefs.fullName,
    investorRole: null,
    investorRoleOther: null,
    investingTenure: prefs.experience,
    researchFocus: null,
    sectors: prefs.sectors,
    country: inferCountry(),
    heardAbout,
  };
}
