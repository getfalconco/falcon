import type { PendingCleanup, WipeResult } from "./local-account-wipe";

/**
 * Deleting an account from the desktop, in order:
 *
 *   0. While the session still works, the engine erases the account's risk
 *      data (`risk:delete-user-data`: on the engine service, scoped by the
 *      session token; with no engine service, this machine's risk files).
 *   1. The server deletes the account (research-worker, or the site as a
 *      fallback): SnapTrade user, stored secret and engine data first, then
 *      the auth user. It answers per item whether that cleanup is done,
 *      queued for retry, or not possible yet.
 *   2. Only once the server says the account is gone, this machine records a
 *      pending local cleanup (`account-cleanup.json`), then
 *   3. in direct-mode builds (SnapTrade keys in this process), deletes the
 *      SnapTrade user this machine registered, and
 *   4. removes the account's files under the data root, including its
 *      encrypted SnapTrade identity.
 *   5. The pending record is cleared when everything went through; otherwise
 *      it stays and the next launch retries (`retryPendingCleanups`).
 *
 * The outcome lists what still has to happen, so the reader is told
 * "deleted, but SnapTrade could not be reached and Falcon will retry"
 * instead of a plain "deleted".
 *
 * Electron-free: everything is injected, so the tests drive it with fakes.
 */

export type CleanupStatus = "done" | "none" | "queued" | "unavailable";

export type ServerDeleteResult =
  | { ok: true; cleanup: { snaptrade: CleanupStatus; engine: CleanupStatus } | null }
  | { ok: false; error: string };

/** What the reader is told is not finished yet. */
export type DeletionNotice = "snaptrade-retry" | "engine-retry" | "engine-manual" | "local-retry";

export type DesktopDeletionOutcome =
  | { ok: true; accountId: string; notices: DeletionNotice[] }
  | { ok: false; error: string };

export type DesktopDeletionDeps = {
  accountIdFromToken(token: string): string | null;
  deleteOnServer(token: string): Promise<ServerDeleteResult>;
  /** Step 0. Never throws: says whether it worked and whether the engine is remote. */
  clearEngineRiskData(): Promise<{ ok: boolean; remote: boolean }>;
  /** The SnapTrade identity this machine holds for the account (direct mode only). */
  localSnaptradeUserId(accountId: string): string | null;
  /** Deletes a SnapTrade user directly; null when this process holds no SnapTrade keys. */
  deleteSnaptradeUser: ((snaptradeUserId: string) => Promise<unknown>) | null;
  wipe(accountId: string): Promise<WipeResult>;
  pending: { read(): PendingCleanup[]; write(list: PendingCleanup[]): void };
  now?: () => Date;
  log?: (message: string) => void;
};

function upsert(list: PendingCleanup[], entry: PendingCleanup): PendingCleanup[] {
  return [...list.filter((p) => p.accountId !== entry.accountId), entry];
}

/** Runs the local part for one account; returns the entry still pending, or null when finished. */
async function runLocalCleanup(entry: PendingCleanup, deps: DesktopDeletionDeps): Promise<{ left: PendingCleanup | null; snaptradeFailed: boolean; localFailed: boolean }> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  let riskFailed = false;
  if (entry.clearRisk) {
    const risk = await deps.clearEngineRiskData();
    riskFailed = !risk.ok;
  }
  let snaptradeFailed = false;
  if (entry.snaptradeUserId && deps.deleteSnaptradeUser) {
    try {
      await deps.deleteSnaptradeUser(entry.snaptradeUserId);
    } catch (err) {
      snaptradeFailed = true;
      log(`[account-delete] SnapTrade delete failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let localFailed = false;
  try {
    const wipe = await deps.wipe(entry.accountId);
    localFailed = wipe.failed.length > 0;
    if (localFailed) log(`[account-delete] could not remove: ${wipe.failed.join(", ")}`);
  } catch (err) {
    localFailed = true;
    log(`[account-delete] local cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const left =
    snaptradeFailed || localFailed || riskFailed
      ? { ...entry, snaptradeUserId: snaptradeFailed ? entry.snaptradeUserId : null, clearRisk: riskFailed }
      : null;
  return { left, snaptradeFailed, localFailed: localFailed || riskFailed };
}

export async function deleteAccountFromDesktop(token: string, deps: DesktopDeletionDeps): Promise<DesktopDeletionOutcome> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const now = deps.now ?? (() => new Date());
  const accountId = typeof token === "string" && token.trim() ? deps.accountIdFromToken(token.trim()) : null;
  if (!accountId) return { ok: false, error: "Sign in to continue." };

  // Read before the server call: the identity file is this machine's only record of it.
  const snaptradeUserId = deps.deleteSnaptradeUser ? deps.localSnaptradeUserId(accountId) : null;

  // Step 0, while the token still identifies the account to the engine.
  const risk = await deps.clearEngineRiskData();
  if (!risk.ok) log("[account-delete] engine risk data could not be erased now");

  const server = await deps.deleteOnServer(token.trim());
  if (!server.ok) return server;

  // A local engine that could not clear is retried with the rest of the local
  // cleanup; a remote one is retried by the server's queue.
  const entry: PendingCleanup = {
    accountId,
    snaptradeUserId,
    clearRisk: !risk.ok && !risk.remote,
    since: now().toISOString(),
  };
  try {
    deps.pending.write(upsert(deps.pending.read(), entry));
  } catch (err) {
    log(`[account-delete] could not record the local cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }

  const notices: DeletionNotice[] = [];
  const cleanup = server.cleanup;
  if (cleanup?.snaptrade === "queued") notices.push("snaptrade-retry");
  // Erased on the engine with the session already: what the server could not
  // do there does not matter any more.
  const engineGone = risk.ok && risk.remote;
  if (!engineGone && cleanup?.engine === "queued") notices.push("engine-retry");
  if (!engineGone && cleanup?.engine === "unavailable") notices.push("engine-manual");

  const { left, snaptradeFailed, localFailed } = await runLocalCleanup(entry, deps);
  if (snaptradeFailed && !notices.includes("snaptrade-retry")) notices.push("snaptrade-retry");
  if (localFailed) notices.push("local-retry");

  try {
    const rest = deps.pending.read().filter((p) => p.accountId !== accountId);
    deps.pending.write(left ? [...rest, left] : rest);
  } catch (err) {
    log(`[account-delete] could not update the local cleanup record: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: true, accountId, notices };
}

/** Finishes local cleanups a previous run could not complete. Returns how many are still pending. */
export async function retryPendingCleanups(deps: DesktopDeletionDeps): Promise<number> {
  const pending = deps.pending.read();
  if (pending.length === 0) return 0;
  const still: PendingCleanup[] = [];
  for (const entry of pending) {
    const { left } = await runLocalCleanup(entry, deps);
    if (left) still.push(left);
  }
  // Entries added while this ran (another deletion) are kept.
  const added = deps.pending.read().filter((p) => !pending.some((q) => q.accountId === p.accountId));
  deps.pending.write([...still, ...added]);
  return still.length + added.length;
}
