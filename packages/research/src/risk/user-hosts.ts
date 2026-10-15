/**
 * Per-user Risk hosts for the engine service.
 *
 * The desktop runs one RiskHost for the one person signed in on that machine,
 * and its `account.json` / `snapshots.json` sit in the shared risk dir. The
 * engine service runs ONE process for every user, and it used the same single
 * host: whoever pushed `risk:account-update` last overwrote everyone else's
 * paper account, and every user's `risk:latest` / `risk:history` read back
 * snapshots computed from someone else's book.
 *
 * This registry gives every user their own host. Layout under the risk data
 * dir (`FALCON_RISK_DATA_DIR`, `/data/risk` on the engine):
 *
 *   config.json                       shared calibration + card flag (no user data)
 *   users/<userId>/account.json       that user's last paper-account push
 *   users/<userId>/snapshots.json     that user's snapshot history (retention as config)
 *   legacy-shared-archive/<stamp>/    the pre-split shared account/snapshots, moved
 *                                     aside once and never read again
 *
 * The user id is never taken from a request body: callers pass the id of the
 * user whose Supabase token the engine verified (see apps/falcon-engine).
 * It is still validated here, because it becomes a path segment.
 */

import fs from "node:fs";
import path from "node:path";
import { RiskHost } from "./host.js";
import type { RiskLatest, RiskStatus } from "./host-types.js";
import { RiskAccountStore, RiskConfigStore, resolveRiskDataDir } from "./store.js";
import type { RiskHistoryItem } from "./types.js";

/**
 * Supabase user ids are UUIDs. Anything else is refused rather than
 * sanitised: a value that is not an id must never become a directory name.
 */
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRiskUserId(userId: unknown): userId is string {
  return typeof userId === "string" && USER_ID_RE.test(userId);
}

function assertUserId(userId: string): string {
  if (!isValidRiskUserId(userId)) throw new Error("invalid user id");
  return userId.toLowerCase();
}

/** The files the pre-split single host kept for "the" user. */
const LEGACY_SHARED_FILES = ["account.json", "snapshots.json"] as const;

export type RiskUserDeletion = { deleted: boolean; dir: string };

export class RiskUserHosts {
  readonly configStore: RiskConfigStore;
  private readonly hosts = new Map<string, RiskHost>();
  private started = false;

  constructor(readonly rootDir: string = resolveRiskDataDir()) {
    this.configStore = new RiskConfigStore(rootDir);
  }

  get usersDir(): string {
    return path.join(this.rootDir, "users");
  }

  get archiveDir(): string {
    return path.join(this.rootDir, "legacy-shared-archive");
  }

  userDir(userId: string): string {
    return path.join(this.usersDir, assertUserId(userId));
  }

  private makeHost(id: string): RiskHost {
    return new RiskHost({
      stateDir: path.join(this.usersDir, id),
      configStore: this.configStore,
      // A short prefix is enough to tell hosts apart in the logs.
      label: id.slice(0, 8),
    });
  }

  /**
   * The user's live host, created (and started, once the registry is) on
   * first use. For the writes: an account push, a recompute.
   */
  get(userId: string): RiskHost {
    const id = assertUserId(userId);
    let host = this.hosts.get(id);
    if (!host) {
      host = this.makeHost(id);
      this.hosts.set(id, host);
      if (this.started) host.start();
    }
    return host;
  }

  /**
   * A host to answer a read from. A user with no live host gets a transient,
   * unstarted one over their (possibly empty) directory, so a read never
   * creates state, starts a loop, or falls back to anyone else's data.
   */
  private reader(userId: string): RiskHost {
    const id = assertUserId(userId);
    return this.hosts.get(id) ?? this.makeHost(id);
  }

  latest(userId: string): RiskLatest {
    return this.reader(userId).latest();
  }

  history(userId: string, limit = 200): RiskHistoryItem[] {
    return this.reader(userId).history(limit);
  }

  status(userId: string): RiskStatus {
    return this.reader(userId).status();
  }

  /** Tickers in the user's last pushed paper account (non-zero positions only). */
  heldTickers(userId: string): string[] {
    const id = assertUserId(userId);
    const account = new RiskAccountStore(path.join(this.usersDir, id)).load();
    return [
      ...new Set(account?.positions.filter((p) => Math.abs(p.shares) > 1e-9).map((p) => p.ticker.toUpperCase()) ?? []),
    ].sort();
  }

  /**
   * Every user's held tickers together, for a shared gate that must treat any
   * member's holding as proximate (Screen's emit gate on the engine). Never
   * served back to a caller as anyone's book.
   */
  allHeldTickers(): string[] {
    const all = new Set<string>();
    for (const id of this.listUsers()) for (const t of this.heldTickers(id)) all.add(t);
    return [...all].sort();
  }

  /** User ids with state on disk. */
  listUsers(): string[] {
    try {
      return fs
        .readdirSync(this.usersDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isValidRiskUserId(d.name))
        .map((d) => d.name.toLowerCase());
    } catch {
      return [];
    }
  }

  /**
   * Move the pre-split shared account/snapshot files out of the way. They
   * cannot be attributed to a user (the last pusher wrote them, and the
   * history mixes every pusher's book), so they are never served again. They
   * are archived rather than deleted so an operator can still inspect or
   * remove them deliberately. Idempotent: nothing to move, nothing done.
   */
  archiveLegacySharedState(now: Date = new Date()): string | null {
    const present = LEGACY_SHARED_FILES.filter((f) => fs.existsSync(path.join(this.rootDir, f)));
    if (present.length === 0) return null;
    const target = path.join(this.archiveDir, now.toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(target, { recursive: true });
    for (const file of present) {
      fs.renameSync(path.join(this.rootDir, file), path.join(target, file));
    }
    fs.writeFileSync(
      path.join(target, "README.txt"),
      "Shared risk state from before per-user isolation. It mixes whichever users\n" +
        "pushed a paper account last and cannot be attributed to any one of them,\n" +
        "so the engine no longer reads it. Safe to delete once no longer needed.\n",
      "utf8",
    );
    return target;
  }

  /** Archive the legacy shared state, then start a host for every user with state. */
  start(): { users: number; archived: string | null } {
    let archived: string | null = null;
    try {
      archived = this.archiveLegacySharedState();
      if (archived) console.info(`[risk] archived legacy shared risk state to ${archived}`);
    } catch (err) {
      console.error("[risk] could not archive legacy shared risk state:", err);
    }
    this.started = true;
    const users = this.listUsers();
    for (const id of users) this.get(id);
    return { users: users.length, archived };
  }

  stop(): void {
    for (const host of this.hosts.values()) host.stop();
    this.started = false;
  }

  /** Number of live hosts (for /health-style counters). */
  get liveCount(): number {
    return this.hosts.size;
  }

  /**
   * Erase everything the engine holds for one user's risk: stop their host
   * (so no timer re-creates the files) and remove their directory. Idempotent.
   */
  delete(userId: string): RiskUserDeletion {
    const id = assertUserId(userId);
    const host = this.hosts.get(id);
    if (host) {
      host.stop();
      this.hosts.delete(id);
    }
    const dir = path.join(this.usersDir, id);
    const existed = fs.existsSync(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: existed || Boolean(host), dir };
  }
}

let registry: RiskUserHosts | null = null;

export function getRiskUserHosts(): RiskUserHosts {
  if (!registry) registry = new RiskUserHosts();
  return registry;
}

/**
 * Account deletion hook: remove every piece of risk state the engine holds for
 * `userId` (their paper account copy and their snapshot history). Safe to call
 * for a user who never had any. Call it with a VERIFIED user id only.
 */
export function deleteUserRiskData(userId: string, hosts: RiskUserHosts = getRiskUserHosts()): RiskUserDeletion {
  return hosts.delete(userId);
}
