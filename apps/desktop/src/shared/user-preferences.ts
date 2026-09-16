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
