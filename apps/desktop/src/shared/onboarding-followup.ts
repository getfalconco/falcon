/**
 * "How did you hear about Falcon?" left the setup flow: it is useful to us,
 * not to the reader. It is asked once instead, with one tap, after the
 * reader's first week, and never again whether it was answered or dismissed.
 *
 * Pure: the dashboard passes in what it knows (when setup finished, whether
 * the question was already put, the time now).
 */

export const HEARD_ABOUT_DELAY_DAYS = 7;
const DAY_MS = 86_400_000;

/** The one-tap answers. Stored as these ids in the same column the old free-text answer went to. */
export const HEARD_ABOUT_SOURCES = ["friend", "x", "reddit", "youtube", "search", "other"] as const;
export type HeardAboutSource = (typeof HEARD_ABOUT_SOURCES)[number];

export function isHeardAboutSource(value: unknown): value is HeardAboutSource {
  return typeof value === "string" && (HEARD_ABOUT_SOURCES as readonly string[]).includes(value);
}

export type HeardAboutPromptState = {
  /** When setup finished (ISO). Absent for accounts set up before the question moved, which answered it in setup. */
  completedAt: string | null | undefined;
  /** Already answered or dismissed. */
  done: boolean;
  now: number;
};

/** Whether to put the question now: once, from a week after setup on. */
export function shouldAskHeardAbout({ completedAt, done, now }: HeardAboutPromptState): boolean {
  if (done || !completedAt) return false;
  const at = Date.parse(completedAt);
  if (!Number.isFinite(at)) return false;
  return now - at >= HEARD_ABOUT_DELAY_DAYS * DAY_MS;
}
