/**
 * TEMPORARY: a developer door into account setup. Remove together with the
 * "Account setup" row in Settings, Developer.
 *
 * Settings fires the event; App answers by showing the setup flow to the
 * signed-in user as a new account sees it (created, approved off the
 * waitlist, not yet set up). Nothing about the account is reset to get
 * there: finishing the flow saves its answers as onboarding always does,
 * and the app returns to the dashboard.
 */
export const ONBOARDING_REPLAY_EVENT = "falcon:replay-onboarding";

export function replayOnboarding(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ONBOARDING_REPLAY_EVENT));
}
