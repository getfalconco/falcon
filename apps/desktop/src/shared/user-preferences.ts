import type { DashboardCard, HoldingPeriod, PositionsMode } from "./onboarding-desk";

export type ExperienceLevel = "new" | "one_to_three_years" | "three_to_ten_years" | "ten_plus_pro";

export type SectorId =
  | "technology"
  | "semiconductors"
  | "energy"
  | "healthcare"
  | "financials"
  | "consumer"
  | "industrials"
  | "crypto";

export type SignalFormat = "takeaway" | "full";

export type UserPreferenceProfile = {
  fullName: string;
  experience: ExperienceLevel | null;
  sectors: SectorId[];
  signalFormat: SignalFormat | null;
  onboardingComplete: boolean;
  /** "How long do you usually hold?"; null for accounts set up before it was asked. */
  holdingPeriod: HoldingPeriod | null;
  /** The cards the reader left on at the desk screen. */
  deskCards: DashboardCard[];
  /** How "What do you hold?" was answered. */
  positionsMode: PositionsMode | null;
  /** When setup finished (ISO); null for accounts set up before it was kept. */
  onboardingCompletedAt: string | null;
  /** The one-time "how did you hear about Falcon" question was answered or dismissed. */
  heardPromptDone: boolean;
};

export const SECTOR_IDS: SectorId[] = [
  "technology",
  "semiconductors",
  "energy",
  "healthcare",
  "financials",
  "consumer",
  "industrials",
  "crypto",
];

export const EXPERIENCE_LEVELS: ExperienceLevel[] = [
  "new",
  "one_to_three_years",
  "three_to_ten_years",
  "ten_plus_pro",
];

export const SIGNAL_FORMATS: SignalFormat[] = ["takeaway", "full"];
