import { Linking } from "react-native";

/**
 * Open an external link only when it is http(s).
 *
 * Source URLs on events / signals / graph edges come from backend data (the
 * news feed, SEC filings, propagation rows). A poisoned or malformed row must
 * not be able to fire a `javascript:`, `file:`, or custom-scheme URL through
 * `Linking.openURL`, so anything that isn't http(s) is ignored.
 */
export async function openExternalUrl(url: string | null | undefined): Promise<void> {
  const value = url?.trim();
  if (!value || !/^https?:\/\//i.test(value)) return;
  try {
    await Linking.openURL(value);
  } catch {
    // Nothing actionable if the OS refuses to open it.
  }
}
