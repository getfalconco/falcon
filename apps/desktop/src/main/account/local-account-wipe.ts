import fs from "node:fs";
import path from "node:path";
import { accountBriefingFiles } from "../privacy/local-data";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { removeProfilePhoto } from "../profile/profile-photo-store";

/**
 * After an account is deleted, what this machine kept for it goes too:
 *
 *   - its agents, reports, timelines and chats  `<root>/agents/<id>/`
 *   - its calendar events                       its partition of `<root>/calendar/user-events.json`
 *   - its saved briefing reports                `<root>/briefing/report.<id>.*.json` (and `_dev/`)
 *   - its briefing narratives                   its sessions in `<root>/briefing/narratives.json`
 *   - its profile photo                         `<root>/profile/avatars/<id>.*`
 *   - its SnapTrade identity                    `<root>/snaptrade/<id>.bin` (passed in, see below)
 *
 * Shared caches of public data (filings, graphs, news) and device settings
 * are not the account's and stay. Engine working files that are not keyed by
 * account (`risk/`, `screen/`, `portfolio-coverage.json`) are not touched
 * here: the engines hold them in memory and rewrite them, and they describe
 * whoever uses this device next.
 *
 * Every step runs even if an earlier one fails; the result lists what could
 * not be removed so the caller can say so and retry on the next launch.
 *
 * Electron-free: the root and the SnapTrade remover are passed in.
 */

export type WipeResult = { removed: string[]; failed: string[] };

const ACCOUNT_KEY = /^[a-z0-9-]{1,64}$/;

export async function wipeLocalAccountData(
  root: string,
  accountId: string,
  extra: { removeSnaptradeIdentity?: () => void } = {},
): Promise<WipeResult> {
  const key = accountId.trim().toLowerCase();
  // "local" and "anon" are the signed-out pool, shared by no one in particular.
  if (!ACCOUNT_KEY.test(key) || key === "local" || key === "anon") throw new Error("Not an account id");

  const result: WipeResult = { removed: [], failed: [] };
  const step = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      result.removed.push(name);
    } catch {
      result.failed.push(name);
    }
  };

  await step("agents", () => {
    fs.rmSync(path.join(root, "agents", key), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  await step("calendar", () => {
    const file = path.join(root, "calendar", "user-events.json");
    const data = readJson<{ users?: Record<string, unknown> }>(file);
    if (data?.users && typeof data.users === "object" && key in data.users) {
      delete data.users[key];
      writeJsonAtomic(file, data);
    }
  });

  await step("briefings", () => {
    let failed = false;
    for (const file of accountBriefingFiles(root, key)) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
    }
    const narratives = path.join(root, "briefing", "narratives.json");
    const data = readJson<{ sessions?: Record<string, unknown> }>(narratives);
    if (data?.sessions && typeof data.sessions === "object") {
      const mine = Object.keys(data.sessions).filter((k) => k.startsWith(`${key}:`));
      if (mine.length > 0) {
        for (const k of mine) delete data.sessions[k];
        writeJsonAtomic(narratives, data);
      }
    }
    if (failed) throw new Error("some briefing reports could not be removed");
  });

  await step("profile-photo", () => removeProfilePhoto(root, key));

  if (extra.removeSnaptradeIdentity) await step("snaptrade", extra.removeSnaptradeIdentity);

  return result;
}

/**
 * Accounts whose local wipe did not finish, kept in `<root>/account-cleanup.json`
 * so the next launch can finish it. Holds account ids, for direct-mode builds
 * the SnapTrade user id still to delete, and whether the local risk files
 * still need clearing: no secrets.
 */
export type PendingCleanup = {
  accountId: string;
  snaptradeUserId?: string | null;
  /** This machine's risk engine files still have to be cleared (local engine only). */
  clearRisk?: boolean;
  since: string;
};

type PendingFile = { version: 1; pending: PendingCleanup[] };

export function pendingCleanupFile(root: string): string {
  return path.join(root, "account-cleanup.json");
}

export function readPendingCleanups(root: string): PendingCleanup[] {
  const data = readJson<PendingFile>(pendingCleanupFile(root));
  return Array.isArray(data?.pending)
    ? data.pending.filter((p) => p && typeof p.accountId === "string" && ACCOUNT_KEY.test(p.accountId))
    : [];
}

export function writePendingCleanups(root: string, pending: PendingCleanup[]): void {
  const file = pendingCleanupFile(root);
  if (pending.length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
    return;
  }
  writeJsonAtomic(file, { version: 1, pending } satisfies PendingFile);
}
