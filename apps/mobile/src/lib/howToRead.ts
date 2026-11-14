import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The "How to read a Sighting" guide opens by itself once, the first time
 * Today shows after sign-in; the "?" buttons open it any time. The choice is
 * kept on the device.
 */

const STORAGE_KEY = "falcon.how-to-read-seen.v1";

let checked = false;

/** True the first time on this device (and marks it seen); false after, or when storage fails. */
export async function firstHowToRead(): Promise<boolean> {
  if (checked) return false;
  checked = true;
  try {
    if ((await AsyncStorage.getItem(STORAGE_KEY)) === "1") return false;
    await AsyncStorage.setItem(STORAGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
