import { requireSupabase } from "@/lib/supabase";
import type { OnboardingSurveyAnswers } from "@/lib/onboarding-survey";

/**
 * Persist the questionnaire to public.onboarding_responses (same table desktop
 * uses). Best effort: a missing table or RLS hiccup must not block finishing.
 */
export async function submitOnboardingSurvey(answers: OnboardingSurveyAnswers): Promise<void> {
  try {
    const client = requireSupabase();
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) return;

    const { error } = await client.from("onboarding_responses").upsert(
      {
        user_id: user.id,
        full_name: answers.fullName.trim() || null,
        investor_role: answers.investorRole,
        investor_role_other: answers.investorRoleOther,
        investing_tenure: answers.investingTenure,
        research_focus: answers.researchFocus,
        sectors: answers.sectors,
        country: answers.country,
        heard_about: answers.heardAbout,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      console.warn("[onboarding] could not save survey responses:", error.message);
    }
  } catch (err) {
    console.warn("[onboarding] could not save survey responses:", err);
  }
}
