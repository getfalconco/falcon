import * as Notifications from "expo-notifications";
import type { NotificationAnswer } from "./onboarding";

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
