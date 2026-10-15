/**
 * The clock: whether times of day read 12-hour or 24-hour. Settings, General.
 *
 * "auto" leaves every screen as it was drawn — the stock screen's live
 * timestamp in 12-hour, the dashboard chart's axis in 24-hour, the engine
 * panels in the system locale's habit. "12" and "24" put every time of day in
 * the app on the one clock.
 *
 * Read at the moment a time is formatted, so a change shows the next time a
 * view redraws; nothing has to subscribe. Safe to import from node-side
 * tests: storage is reached only inside try/catch.
 */
export type ClockChoice = "auto" | "12" | "24";

export const CLOCK_KEY = "falcon.ui.clock";

type Reader = Pick<Storage, "getItem">;

function defaultStorage(): Reader | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readClockChoice(storage: Reader | null = defaultStorage()): ClockChoice {
  try {
    const raw = storage?.getItem(CLOCK_KEY);
    if (raw === "auto" || raw === "12" || raw === "24") return raw;
  } catch {
    /* storage is not always there */
  }
  return "auto";
}

export function writeClockChoice(choice: ClockChoice): void {
  try {
    localStorage.setItem(CLOCK_KEY, choice);
  } catch {
    /* not kept; every screen stays as it is */
  }
}

/**
 * The caller's Intl options with the reader's clock laid over them. On "auto"
 * they come back as they went in; otherwise any hour12/hourCycle the caller
 * set is replaced, since `hour12` would beat `hourCycle` if both were left.
 */
export function withClock(
  options: Intl.DateTimeFormatOptions = {},
  choice: ClockChoice = readClockChoice(),
): Intl.DateTimeFormatOptions {
  if (choice === "auto") return options;
  const { hour12: _hour12, hourCycle: _hourCycle, ...rest } = options;
  return choice === "12" ? { ...rest, hour12: true } : { ...rest, hourCycle: "h23" };
}

/**
 * A hand-built time of day, for labels that do not go through Intl (chart
 * axes). `auto` is the clock the label was drawn in before this setting.
 */
export function clockLabel(
  hours: number,
  minutes: number,
  auto: "12" | "24" = "24",
  choice: ClockChoice = readClockChoice(),
): string {
  const clock = choice === "auto" ? auto : choice;
  const mm = String(minutes).padStart(2, "0");
  if (clock === "24") return `${String(hours).padStart(2, "0")}:${mm}`;
  return `${hours % 12 || 12}:${mm} ${hours < 12 ? "AM" : "PM"}`;
}
