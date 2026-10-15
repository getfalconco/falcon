import fs from "node:fs";
import path from "node:path";

/**
 * The SnapTrade identity (user id + user secret) this machine keeps for an
 * account, when the main process talks to SnapTrade directly (development
 * builds that hold the SnapTrade keys; packaged builds go through the worker
 * and never store one).
 *
 * - One file per account, `<data root>/snaptrade/<account id>.bin` ("local"
 *   for a signed-out session), so two accounts on one machine never share or
 *   overwrite a brokerage identity.
 * - Encrypted with Electron's `safeStorage` (DPAPI on Windows, Keychain on
 *   macOS, the Secret Service keyring on Linux). The bytes on disk are
 *   useless without this OS user's login.
 * - When `safeStorage` is unavailable (a Linux session without a keyring),
 *   nothing is written: the identity is kept in memory for this run only.
 *   A signed-in account then re-reads it from the cloud copy on the next
 *   launch; a signed-out session registers a new SnapTrade user.
 * - The old per-machine plaintext `<userData>/snaptrade-user.json` is
 *   migrated on first use: re-written encrypted under the account it belongs
 *   to (its `falcon-<account id>` user id says which; anything else counts as
 *   the signed-out "local" identity), then deleted. Plaintext never stays on
 *   disk, even when it cannot be encrypted.
 * - Never part of "Export my data": the export reads named files only.
 *
 * Electron-free: `safeStorage`, the data root and the legacy path are
 * injected, so the tests drive it against a temp dir and a fake cipher.
 */

export type StoredUser = { userId: string; userSecret: string };

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type LocalSnaptradeStoreDeps = {
  root: () => string;
  /** The pre-migration plaintext file, or null when there is none to look for. */
  legacyFile: () => string | null;
  safeStorage: SafeStorageLike;
  log?: (message: string) => void;
};

const ACCOUNT_KEY = /^[a-z0-9-]{1,64}$/;

/** The file key for an account: its lower-cased id, or "local" when signed out. */
export function snaptradeAccountKey(supabaseUserId: string | null | undefined): string {
  const key = typeof supabaseUserId === "string" ? supabaseUserId.trim().toLowerCase() : "";
  return key && key !== "anon" && ACCOUNT_KEY.test(key) ? key : "local";
}

/** Which account a legacy identity belongs to, read from its `falcon-<account id>` user id. */
export function legacyOwnerKey(userId: string): string {
  const m = /^falcon-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(userId.trim());
  return m ? m[1]!.toLowerCase() : "local";
}

function parseUser(text: string): StoredUser | null {
  try {
    const parsed = JSON.parse(text) as Partial<StoredUser>;
    if (typeof parsed.userId === "string" && parsed.userId && typeof parsed.userSecret === "string" && parsed.userSecret) {
      return { userId: parsed.userId, userSecret: parsed.userSecret };
    }
  } catch {
    // fall through
  }
  return null;
}

function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function createLocalSnaptradeStore(deps: LocalSnaptradeStoreDeps) {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const memory = new Map<string, StoredUser>();
  let warnedUnavailable = false;
  let migrated = false;

  const available = (): boolean => {
    let ok = false;
    try {
      ok = deps.safeStorage.isEncryptionAvailable();
    } catch {
      ok = false;
    }
    if (!ok && !warnedUnavailable) {
      warnedUnavailable = true;
      log("[snaptrade] OS encryption (safeStorage) is unavailable: the brokerage identity is kept in memory only.");
    }
    return ok;
  };

  const dir = () => path.join(deps.root(), "snaptrade");
  const fileFor = (key: string) => {
    if (!ACCOUNT_KEY.test(key)) throw new Error("invalid account key");
    return path.join(dir(), `${key}.bin`);
  };

  const writeEncrypted = (key: string, user: StoredUser): void => {
    const target = fileFor(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = deps.safeStorage.encryptString(JSON.stringify(user));
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, target);
  };

  /** Moves the old plaintext per-machine file into the per-account store, once per run. */
  const migrateLegacy = (): void => {
    if (migrated) return;
    const legacy = deps.legacyFile();
    if (!legacy || !fs.existsSync(legacy)) {
      migrated = true;
      return;
    }
    const user = parseUser(fs.readFileSync(legacy, "utf8"));
    if (user) {
      const owner = legacyOwnerKey(user.userId);
      if (available()) {
        if (!fs.existsSync(fileFor(owner))) writeEncrypted(owner, user);
      } else if (!memory.has(owner)) {
        memory.set(owner, user);
      }
    }
    // Encrypted copy written (or held in memory): the plaintext goes.
    unlinkQuietly(legacy);
    migrated = true;
  };

  const safely = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      log(`[snaptrade] local identity ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  };

  return {
    read(key: string): StoredUser | null {
      safely("migration", migrateLegacy, undefined);
      const held = memory.get(key);
      if (held) return held;
      return safely(
        "read",
        () => {
          const file = fileFor(key);
          if (!fs.existsSync(file)) return null;
          if (!available()) return null;
          return parseUser(deps.safeStorage.decryptString(fs.readFileSync(file)));
        },
        null,
      );
    },

    write(key: string, user: StoredUser): void {
      safely("migration", migrateLegacy, undefined);
      if (!available()) {
        memory.set(key, user);
        return;
      }
      safely("write", () => writeEncrypted(key, user), undefined);
      memory.delete(key);
    },

    /** Forgets the account's identity on this machine. Throws when the file is there but cannot be removed. */
    remove(key: string): void {
      safely("migration", migrateLegacy, undefined);
      memory.delete(key);
      unlinkQuietly(fileFor(key));
    },

    /** Where an account's file lives, for account deletion and the Privacy pane. */
    fileFor,
  };
}

export type LocalSnaptradeStore = ReturnType<typeof createLocalSnaptradeStore>;
