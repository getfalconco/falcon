/**
 * Shared helpers for the Quant Lab harnesses.
 *
 * The series windows come from Screen's config rather than Quant Lab's,
 * deliberately: the snapshots ARE Screen's `buildSeriesView` output, so reading
 * the same stored config keeps the backtester's numbers identical to the ones
 * the Shift+S panel shows. Duplicating the windows here would let the two
 * drift apart silently.
 */

import { ScreenConfigStore } from "../src/screen/store.js";
import type { ScreenWindows } from "../src/screen/config.js";

export function cfgWindows(): ScreenWindows {
  return new ScreenConfigStore().load().windows;
}
