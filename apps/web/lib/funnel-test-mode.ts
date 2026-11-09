/**
 * Funnel test mode: lets the login -> /welcome funnel be run again and again.
 * While on, nothing about it is remembered:
 *   - the Supabase session lives in memory only (a reload shows the login)
 *   - the login screen always starts at the form (no stored waitlist state)
 *   - /welcome always starts at step 1, even for members who finished it
 *   - welcome answers are not sent to Supabase (onboarding_responses)
 *
 * On by default for now. Set NEXT_PUBLIC_FUNNEL_TEST_MODE=0 (build time) to
 * turn it off and get the normal behaviour back.
 */
export const FUNNEL_TEST_MODE = (process.env.NEXT_PUBLIC_FUNNEL_TEST_MODE ?? "1").trim() !== "0";
