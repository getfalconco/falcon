/** The Dashboard greeting: "Morning, Kuzey", by the viewer's local hour. */

export type DayPart = "Morning" | "Afternoon" | "Evening";

/** 05:00-11:59 Morning, 12:00-17:59 Afternoon, 18:00-04:59 Evening. */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 18) return "Afternoon";
  return "Evening";
}

/** The first word of a full name, or null when there is none. */
export function firstName(fullName: unknown): string | null {
  if (typeof fullName !== "string") return null;
  return fullName.trim().split(/\s+/)[0] || null;
}

/**
 * The name the greeting uses: the one the member asked to be called
 * (Settings > Account, user_metadata.preferred_name) as written, else the
 * first word of their full name, else null.
 */
export function greetingName(preferredName: unknown, fullName: unknown): string | null {
  const preferred = typeof preferredName === "string" ? preferredName.replace(/\s+/g, " ").trim() : "";
  return preferred || firstName(fullName);
}

/** "Morning, Kuzey", or just "Morning" without a name. */
export function greeting(hour: number, fullName?: unknown, preferredName?: unknown): string {
  const name = greetingName(preferredName, fullName);
  const part = dayPart(hour);
  return name ? `${part}, ${name}` : part;
}
