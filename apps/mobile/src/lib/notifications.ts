import * as Notifications from "expo-notifications";
import type { NotificationAnswer } from "./onboarding";

/** Whether this platform can schedule the morning alert on the device. */
export const MORNING_ALERT_SUPPORTED = true;

/** The morning alert's id, so it is scheduled once and can be cancelled. */
const MORNING_ID = "falcon-morning";
export const MORNING_HOUR = 8;

export type AlertPermission = {
  status: "granted" | "denied" | "default" | "unsupported";
  /** False once iOS won't show the prompt again (only Settings can turn it on). */
  canAsk: boolean;
};

/** The current notification permission, without asking. */
export async function alertPermission(): Promise<AlertPermission> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return { status: "granted", canAsk: false };
    return { status: current.status === "denied" ? "denied" : "default", canAsk: current.canAskAgain };
  } catch {
    return { status: "unsupported", canAsk: false };
  }
}

/** Asks iOS for alert permission (the system prompt); never throws. */
export async function requestAlertPermission(): Promise<NotificationAnswer> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return "granted";
    if (!current.canAskAgain) return "denied";
    const result = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    if (result.granted) return "granted";
    return result.status === "denied" ? "denied" : "default";
  } catch {
    return "unsupported";
  }
}

/** A local notification every day at 8:00 on the phone's clock. */
export async function scheduleMorningAlert(): Promise<boolean> {
  try {
    await Notifications.cancelScheduledNotificationAsync(MORNING_ID).catch(() => {});
    await Notifications.scheduleNotificationAsync({
      identifier: MORNING_ID,
      content: { title: "Falcon", body: "Today is ready." },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: MORNING_HOUR, minute: 0 },
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelMorningAlert(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(MORNING_ID);
  } catch {
    // Nothing scheduled.
  }
}
