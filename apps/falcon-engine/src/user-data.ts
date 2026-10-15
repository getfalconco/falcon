/**
 * Everything the engine keeps on disk for one user, and the one function that
 * erases it. Account deletion (POST /me/delete-data, the worker's
 * POST /service/delete-user-data retry, and the `risk:delete-user-data`
 * channel the desktop calls) goes through here, so a new kind of per-user
 * file only has to be added once.
 *
 * Today that is:
 *   * risk    risk/users/<userId>/   paper-account copy + snapshot history
 *   * screen  screen/users/<userId>/ the Screen watchlist
 *
 * The id must be a VERIFIED user id (the token's, or the worker's after it
 * verified the user); both registries also refuse anything that is not a UUID.
 */

import { deleteUserRiskData, getRiskUserHosts } from "@meridian/research/risk";
import {
  deleteUserScreenData,
  getScreenUserWatchlists,
  setScreenProximitySource,
} from "@meridian/research/screen";

export type UserDataDeletion = { risk: boolean; screen: boolean };

export function deleteUserEngineData(userId: string): UserDataDeletion {
  const risk = deleteUserRiskData(userId).deleted;
  const screen = deleteUserScreenData(userId).deleted;
  return { risk, screen };
}

/**
 * Screen on the engine serves every user. Move the pre-split shared watchlist
 * aside (archived, never deleted) and point the emit gate at every user's own
 * watchlist and paper book instead of one shared file. Call once at boot,
 * before any channel can touch the Screen host.
 */
export function configureScreenForUsers(): { archived: string | null } {
  const watchlists = getScreenUserWatchlists();
  let archived: string | null = null;
  try {
    archived = watchlists.archiveLegacySharedWatchlist();
    if (archived) console.info(`[screen] archived legacy shared watchlist to ${archived}`);
  } catch (err) {
    console.error("[screen] could not archive the legacy shared watchlist:", err);
  }
  setScreenProximitySource(() => ({
    held: getRiskUserHosts().allHeldTickers(),
    watchlist: watchlists.union(),
  }));
  return { archived };
}
