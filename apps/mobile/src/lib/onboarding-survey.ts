import type { ExperienceLevel, SectorId } from "@/lib/user-preferences";

export const INVESTOR_ROLES = [
  "active_trader",
  "long_term_investor",
  "market_researcher",
  "getting_serious",
  "finance_professional",
  "other",
] as const;
export type InvestorRole = (typeof INVESTOR_ROLES)[number];

export const RESEARCH_FOCUSES = [
  "individual_stocks",
  "sectors_industries",
  "macro_trends",
  "companies_i_hold",
] as const;
export type ResearchFocus = (typeof RESEARCH_FOCUSES)[number];

/** Same payload desktop writes to public.onboarding_responses. */
export type OnboardingSurveyAnswers = {
  fullName: string;
  investorRole: InvestorRole | null;
  investorRoleOther: string | null;
  investingTenure: ExperienceLevel | null;
  researchFocus: ResearchFocus | null;
  sectors: SectorId[];
  country: string | null;
  heardAbout: string | null;
};
