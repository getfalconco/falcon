import type { NotificationAnswer } from "./onboarding";
import type { AlertPermission } from "./notifications";

/** The browser preview can't schedule a daily alert; only the choice is kept. */
export const MORNING_ALERT_SUPPORTED = false;
export const MORNING_HOUR = 8;

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Browser preview: the web Notification permission. */
export async function alertPermission(): Promise<AlertPermission> {
  if (!supported()) return { status: "unsupported", canAsk: false };
  const status = window.Notification.permission;
  return { status, canAsk: status === "default" };
}

/** Browser preview: the web Notification prompt, as on the website. */
export async function requestAlertPermission(): Promise<NotificationAnswer> {
  if (!supported()) return "unsupported";
  try {
    return (await window.Notification.requestPermission()) as NotificationAnswer;
  } catch {
    return "default";
  }
}

export async function scheduleMorningAlert(): Promise<boolean> {
  return false;
}

export async function cancelMorningAlert(): Promise<void> {}
