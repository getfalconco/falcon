/**
 * "07:16": the New York wall-clock time of an instant, for the two places the
 * panel prints a bare time of its own (the masthead's "as of" and the "now"
 * line on the calendar rail).
 *
 * Every other string in the panel comes out of `shared/briefing-view.ts`, and
 * so should this one: the view already has this exact formatter, but keeps it
 * private. Until it exports it, this is the single formatter in the folder,
 * kept in its own file so no component carries an Intl call.
 */

const NY_HM = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

export function etClock(at: Date | string): string | null {
  const date = typeof at === "string" ? new Date(at) : at;
  if (!Number.isFinite(date.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const part of NY_HM.formatToParts(date)) parts[part.type] = part.value;
  // Some engines print midnight as hour 24 even under h23.
  return `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}
