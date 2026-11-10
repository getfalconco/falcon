import type { NotificationAnswer } from "./onboarding";

/** Browser preview: the web Notification prompt, as on the website. */
export async function requestAlertPermission(): Promise<NotificationAnswer> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    return (await window.Notification.requestPermission()) as NotificationAnswer;
  } catch {
    return "default";
  }
}
