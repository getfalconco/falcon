import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { cancelMorningAlert, requestAlertPermission, scheduleMorningAlert } from "./notifications";

/**
 * The morning alert choice (You tab, and the funnel's notification step).
 * On the phone it is a local notification at 8:00 every day; the choice is
 * kept on the device so the switch shows it.
 */

const STORAGE_KEY = "falcon.morning-alert.v1";

let on: boolean | undefined;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function store(value: boolean) {
  on = value;
  emit();
  void (value ? AsyncStorage.setItem(STORAGE_KEY, "1") : AsyncStorage.removeItem(STORAGE_KEY)).catch(() => {});
}

void AsyncStorage.getItem(STORAGE_KEY)
  .then((saved) => {
    if (on === undefined) {
      on = saved === "1";
      emit();
    }
  })
  .catch(() => {
    if (on === undefined) {
      on = false;
      emit();
    }
  });

/** Asks for permission when needed, then schedules the alert. Resolves to whether it is on. */
export async function enableMorningAlert(): Promise<boolean> {
  const answer = await requestAlertPermission();
  if (answer !== "granted") return false;
  await scheduleMorningAlert();
  store(true);
  return true;
}

export async function disableMorningAlert(): Promise<void> {
  store(false);
  await cancelMorningAlert();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the morning alert is on; undefined until the saved choice is read. */
export function useMorningAlert(): boolean | undefined {
  return useSyncExternalStore(subscribe, () => on, () => on);
}
