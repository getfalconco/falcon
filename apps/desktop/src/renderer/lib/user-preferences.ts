import type { User } from "@supabase/supabase-js";
import type {
  ExperienceLevel,
  SectorId,
  SignalFormat,
  UserPreferenceProfile,
} from "../../shared/user-preferences";
import { EXPERIENCE_LEVELS, SECTOR_IDS } from "../../shared/user-preferences";
import { requireSupabase } from "@/lib/supabase";
import {
  EXPERIENCE_OPTIONS,
  FORMAT_OPTIONS,
  SECTOR_LABELS,
} from "@/lib/onboarding-copy";

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
  const sectors = rawSectors.filter(isSectorId);

  return {
    fullName,
    experience: isExperienceLevel(meta.experience) ? meta.experience : null,
    sectors,
    signalFormat: isSignalFormat(meta.signal_format) ? meta.signal_format : null,
    onboardingComplete: meta.onboarding_complete === true,
  };
}

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

/**
 * The account pane's own fields, kept in the user's metadata beside the
 * onboarding answers. Metadata travels inside every access token, so the free
 * text is capped: a long note would make every request the app sends heavier.
 */
export const INSTRUCTIONS_MAX = 1000;

/** How the reader asked to be addressed; empty when they have not said. */
export function readCallName(user: User | null | undefined): string {
  const value = user?.user_metadata?.preferred_name;
  return typeof value === "string" ? value.trim() : "";
}

/** What the reader wants Falcon to keep in mind when it writes for them. */
export function readInstructions(user: User | null | undefined): string {
  const value = user?.user_metadata?.falcon_instructions;
  return typeof value === "string" ? value : "";
}

export type AccountFields = {
  full_name?: string;
  preferred_name?: string;
  falcon_instructions?: string;
};

export async function saveAccountFields(fields: AccountFields): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.auth.updateUser({ data: fields });
  if (error) throw error;
}

/**
 * Ends every session this account has, on every device, this one included.
 * The auth listener in App sees the sign-out and takes the app back to the
 * login screen, as a sign-out from the menu does.
 */
export async function signOutEverywhere(): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.auth.signOut({ scope: "global" });
  if (error) throw error;
}

export type OnboardingProfileInput = {
  fullName: string;
  experience: ExperienceLevel;
  sectors: SectorId[];
  signalFormat?: SignalFormat | null;
};

export async function saveOnboardingProfile(input: OnboardingProfileInput): Promise<void> {
  const client = requireSupabase();
  const data: Record<string, unknown> = {
    full_name: input.fullName.trim(),
    experience: input.experience,
    sectors: input.sectors,
    onboarding_complete: true,
  };
  if (input.signalFormat) {
    data.signal_format = input.signalFormat;
  }
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

export function experienceDepthLabel(level: ExperienceLevel): string {
  return EXPERIENCE_OPTIONS.find((o) => o.id === level)?.depthLabel ?? level;
}

export function formatLabel(format: SignalFormat): string {
  return FORMAT_OPTIONS.find((o) => o.id === format)?.label ?? format;
}

export function sectorsFollowingLabel(sectors: SectorId[]): string {
  if (sectors.length === 0) return "None selected";
  return sectors.map((id) => SECTOR_LABELS[id]).join(" · ");
}
