import type { User } from "@supabase/supabase-js";
import { isApproved } from "@/lib/auth";
import { needsOnboarding } from "@/lib/user-preferences";

export type PostAuthHref = "/dashboard" | "/onboarding" | "/status";

/**
 * Where an authenticated user should land. Matches desktop App.tsx:
 * waitlist → status, approved but unfinished questionnaire → onboarding,
 * otherwise the product. Completing on desktop sets the same
 * user_metadata.onboarding_complete flag, so this stays in sync.
 */
export function postAuthHref(user: User | null | undefined): PostAuthHref {
  if (!user || !isApproved(user)) return "/status";
  if (needsOnboarding(user)) return "/onboarding";
  return "/dashboard";
}
