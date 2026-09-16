import type { User } from "@supabase/supabase-js";
import { requireSupabase } from "@/lib/supabase";

/** Mirrors apps/desktop/src/shared/user-preferences.ts — same values, same save path. */

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

export const SECTOR_LABELS: Record<SectorId, string> = {
  technology: "Technology",
  semiconductors: "Semiconductors",
  energy: "Energy",
  healthcare: "Healthcare",
  financials: "Financials",
  consumer: "Consumer",
  industrials: "Industrials",
  crypto: "Crypto",
};

export const EXPERIENCE_OPTIONS: { id: ExperienceLevel; label: string }[] = [
  { id: "new", label: "New to investing" },
  { id: "one_to_three_years", label: "1-3 years" },
  { id: "three_to_ten_years", label: "3-10 years" },
  { id: "ten_plus_pro", label: "10+ years / professional" },
];

export const FORMAT_OPTIONS: { id: SignalFormat; label: string }[] = [
  { id: "takeaway", label: "Just the takeaway" },
  { id: "full", label: "The full reasoning" },
];

export type UserPreferenceProfile = {
  fullName: string;
  experience: ExperienceLevel | null;
  sectors: SectorId[];
  signalFormat: SignalFormat | null;
  onboardingComplete: boolean;
};

function isExperienceLevel(value: unknown): value is ExperienceLevel {
  return typeof value === "string" && (EXPERIENCE_LEVELS as string[]).includes(value);
}

function isSignalFormat(value: unknown): value is SignalFormat {
  return value === "takeaway" || value === "full";
}

function isSectorId(value: unknown): value is SectorId {
  return typeof value === "string" && (SECTOR_IDS as string[]).includes(value);
}

export function readPreferences(user: User | null | undefined): UserPreferenceProfile {
  const meta = user?.user_metadata ?? {};
  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  const rawSectors = Array.isArray(meta.sectors) ? meta.sectors : [];

  return {
    fullName,
    experience: isExperienceLevel(meta.experience) ? meta.experience : null,
    sectors: rawSectors.filter(isSectorId),
    signalFormat: isSignalFormat(meta.signal_format) ? meta.signal_format : null,
    onboardingComplete: meta.onboarding_complete === true,
  };
}

/** Same gate as desktop: missing name or unfinished questionnaire. */
export function needsOnboarding(user: User | null | undefined): boolean {
  const prefs = readPreferences(user);
  return !prefs.fullName || !prefs.onboardingComplete;
}

export function hasFullName(user: User | null | undefined): boolean {
  return Boolean(readPreferences(user).fullName);
}

export async function saveFullName(fullName: string): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.auth.updateUser({
    data: { full_name: fullName.trim() },
  });
  if (error) throw error;
}

export async function saveOnboardingProfile(input: {
  fullName: string;
  experience: ExperienceLevel;
  sectors: SectorId[];
  signalFormat?: SignalFormat | null;
}): Promise<void> {
  const client = requireSupabase();
  const data: Record<string, unknown> = {
    full_name: input.fullName.trim(),
    experience: input.experience,
    sectors: input.sectors,
    onboarding_complete: true,
  };
  if (input.signalFormat) data.signal_format = input.signalFormat;
  const { error } = await client.auth.updateUser({ data });
  if (error) throw error;
}

export async function savePreferences(input: {
  fullName: string;
  experience: ExperienceLevel;
  sectors: SectorId[];
  signalFormat: SignalFormat;
}): Promise<void> {
  await saveOnboardingProfile(input);
}
