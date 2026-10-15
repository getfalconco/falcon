/**
 * Per-user Screen watchlists for the engine service.
 *
 * The desktop's Screen host keeps one `watchlist.json` for the one person
 * signed in on that machine. The engine service runs ONE process for every
 * user and answered `screen:set-watchlist` from that same single file: the
 * last user to push a watchlist overwrote everyone else's, and the emit gate
 * read whichever list happened to be there. Same class of bug as the shared
 * risk account (see ../risk/user-hosts.ts), same fix.
 *
 * Layout under the screen data dir (`FALCON_SCREEN_DATA_DIR`):
 *
 *   users/<userId>/watchlist.json      that user's watchlist
 *   legacy-shared-archive/<stamp>/     the pre-split shared watchlist.json,
 *                                      moved aside once and never read again
 *
 * The user id is never taken from a request body: callers pass the id of the
 * user whose Supabase token the engine verified. It is still validated here,
 * because it becomes a path segment.
 */

import fs from "node:fs";
import path from "node:path";
import { isValidRiskUserId } from "../risk/user-hosts.js";
import { resolveScreenDataDir } from "./store.js";

/** Same rule as risk: a Supabase user id (UUID), or refused. */
export const isValidScreenUserId = isValidRiskUserId;

function assertUserId(userId: string): string {
  if (!isValidScreenUserId(userId)) throw new Error("invalid user id");
  return userId.toLowerCase();
}

/** Upper-cased, trimmed, deduped and sorted: the one form a watchlist is stored in. */
export function normalizeWatchlist(tickers: readonly unknown[]): string[] {
  const clean = tickers
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0 && t.length <= 15);
  return [...new Set(clean)].sort().slice(0, 500);
}

export type ScreenUserDeletion = { deleted: boolean; dir: string };

export class ScreenUserWatchlists {
  constructor(readonly rootDir: string = resolveScreenDataDir()) {}

  get usersDir(): string {
    return path.join(this.rootDir, "users");
  }

  get archiveDir(): string {
    return path.join(this.rootDir, "legacy-shared-archive");
  }

  private file(userId: string): string {
    return path.join(this.usersDir, assertUserId(userId), "watchlist.json");
  }

  /** The user's own watchlist; empty when they never pushed one. */
  get(userId: string): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(userId), "utf8")) as { tickers?: unknown };
      return Array.isArray(parsed.tickers) ? normalizeWatchlist(parsed.tickers) : [];
    } catch (err) {
      if (err instanceof Error && err.message === "invalid user id") throw err;
      return [];
    }
  }

  /** Replace the user's watchlist. Only ever their own file is written. */
  set(userId: string, tickers: readonly unknown[]): string[] {
    const file = this.file(userId);
    const next = normalizeWatchlist(tickers);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tickers: next }, null, 1), "utf8");
    fs.renameSync(tmp, file);
    return next;
  }

  /** User ids with a watchlist on disk. */
  listUsers(): string[] {
    try {
      return fs
        .readdirSync(this.usersDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isValidScreenUserId(d.name))
        .map((d) => d.name.toLowerCase());
    } catch {
      return [];
    }
  }

  /**
   * Every user's watchlist together: what the engine's shared emit gate
   * treats as proximate. The gate decides which first sightings enter the
   * one shared pipeline, so it has to see every user's names; no single
   * user's list is ever served back to anyone else.
   */
  union(): string[] {
    const all = new Set<string>();
    for (const id of this.listUsers()) for (const t of this.get(id)) all.add(t);
    return [...all].sort();
  }

  /**
   * Move the pre-split shared `watchlist.json` out of the way. It is whichever
   * user pushed last and cannot be attributed, so it is never read again.
   * Archived rather than deleted so an operator can inspect it. Idempotent.
   */
  archiveLegacySharedWatchlist(now: Date = new Date()): string | null {
    const legacy = path.join(this.rootDir, "watchlist.json");
    if (!fs.existsSync(legacy)) return null;
    const target = path.join(this.archiveDir, now.toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(target, { recursive: true });
    fs.renameSync(legacy, path.join(target, "watchlist.json"));
    fs.writeFileSync(
      path.join(target, "README.txt"),
      "The Screen watchlist from before per-user isolation. It is whichever user\n" +
        "pushed a watchlist last and cannot be attributed to any one account, so the\n" +
        "engine no longer reads it. Safe to delete once no longer needed.\n",
      "utf8",
    );
    return target;
  }

  /** Erase everything Screen holds for one user. Idempotent. */
  delete(userId: string): ScreenUserDeletion {
    const dir = path.join(this.usersDir, assertUserId(userId));
    const existed = fs.existsSync(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: existed, dir };
  }
}

let registry: ScreenUserWatchlists | null = null;

export function getScreenUserWatchlists(): ScreenUserWatchlists {
  if (!registry) registry = new ScreenUserWatchlists();
  return registry;
}

/**
 * Account deletion hook: remove the Screen watchlist the engine holds for
 * `userId`. Safe for a user who never had one. Call it with a VERIFIED id only.
 */
export function deleteUserScreenData(
  userId: string,
  watchlists: ScreenUserWatchlists = getScreenUserWatchlists(),
): ScreenUserDeletion {
  return watchlists.delete(userId);
}
