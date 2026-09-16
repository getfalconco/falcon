import type { OnboardingSurveyAnswers } from "../../shared/onboarding-survey";
import { requireSupabase } from "@/lib/supabase";

/**
 * Persists the full onboarding questionnaire to the privileged backend store
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
