import type { ExperienceLevel, SectorId } from "./user-preferences";

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

export const UPDATE_FREQUENCIES = ["daily_brief", "real_time", "weekly_summary"] as const;
export type UpdateFrequency = (typeof UPDATE_FREQUENCIES)[number];

/** Full onboarding questionnaire response, persisted server-side for future admin-panel use. */
export type OnboardingSurveyAnswers = {
  fullName: string;
  investorRole: InvestorRole | null;
  /** Free text when investorRole === "other". */
  investorRoleOther: string | null;
  investingTenure: ExperienceLevel | null;
  researchFocus: ResearchFocus | null;
  sectors: SectorId[];
  country: string | null;
  heardAbout: string | null;
};
