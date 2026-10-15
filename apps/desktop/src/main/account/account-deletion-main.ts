import { BrowserWindow, dialog } from "electron";
import { resolveDataRoot } from "../data-root";
import { invokeChannel } from "../ipc-register";
import { engineRemote, engineUrl } from "../engine/engine-client";
import { mt, type MainMessageKey } from "../i18n";
import { userKeyFromAccessToken } from "../briefing/user-key";
import {
  deleteSnaptradeUser,
  forgetLocalSnaptradeIdentity,
  isSnaptradeConfigured,
  localSnaptradeIdentity,
} from "../snaptrade/snaptrade-service";
import {
  deleteAccountFromDesktop,
  retryPendingCleanups,
  type DeletionNotice,
  type DesktopDeletionDeps,
  type DesktopDeletionOutcome,
  type ServerDeleteResult,
} from "./account-deletion";
import { readPendingCleanups, wipeLocalAccountData, writePendingCleanups } from "./local-account-wipe";

/**
 * The Electron side of account deletion (the order and the reasons are in
 * account-deletion.ts): which server to ask, how the engine is reached, where
 * the files live, and the dialog that tells the reader what is not finished.
 */

const HEADERS = { "Content-Type": "application/json", "User-Agent": "MeridianDesktop/1.0" };

type ServerReply = { ok?: boolean; error?: string; cleanup?: unknown };

function readCleanup(raw: unknown): Extract<ServerDeleteResult, { ok: true }>["cleanup"] {
  const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const status = (v: unknown) => (v === "done" || v === "none" || v === "queued" || v === "unavailable" ? v : null);
  const snaptrade = status(c?.snaptrade);
  const engine = status(c?.engine);
  return snaptrade && engine ? { snaptrade, engine } : null;
}

/**
 * The research-worker first (it removes the SnapTrade user and the engine
 * data inline), then the site's /api/account/delete, which queues those for
 * the worker. A base is skipped only when it cannot be reached or does not
 * have the route; an answer from it (a 401, or "not deleted, try again") is
 * final, since another base would delete the same account.
 */
async function deleteOnServer(token: string, siteBases: string[]): Promise<ServerDeleteResult> {
  const worker = (process.env.RESEARCH_WORKER_URL ?? "").trim().replace(/\/+$/, "");
  const bases = [...(worker ? [worker] : []), ...siteBases];
  let lastError = "Could not delete the account.";
  for (const base of bases) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/account/delete`, {
        method: "POST",
        headers: { ...HEADERS, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      continue; // unreachable: next base
    }
    if (res.status === 404 || res.status === 405) continue; // an older deployment without the route
    const data = (await res.json().catch(() => null)) as ServerReply | null;
    if (!data) continue;
    if (res.ok && data.ok) return { ok: true, cleanup: readCleanup(data.cleanup) };
    lastError = data.error ?? lastError;
    break;
  }
  return { ok: false, error: lastError };
}

/**
 * Erases the account's risk data while its session still works: on the
 * engine service through `/me/delete-data` (valid session, approval not
 * needed), or, with no engine service, this machine's risk files through the
 * local `risk:delete-user-data` handler.
 */
async function clearEngineRiskData(token: string): Promise<{ ok: boolean; remote: boolean }> {
  const remote = engineRemote();
  try {
    if (remote) {
      const res = await fetch(`${engineUrl()}/me/delete-data`, {
        method: "POST",
        headers: { ...HEADERS, Authorization: `Bearer ${token}` },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, remote };
    }
    const result = await invokeChannel<{ ok?: boolean }>("risk:delete-user-data");
    return { ok: result?.ok === true, remote };
  } catch {
    return { ok: false, remote };
  }
}

function deps(token: string | null, siteBases: string[]): DesktopDeletionDeps {
  const direct = isSnaptradeConfigured();
  return {
    accountIdFromToken: (t) => {
      const key = userKeyFromAccessToken(t);
      return key === "anon" ? null : key;
    },
    deleteOnServer: (t) => deleteOnServer(t, siteBases),
    // A retry on a later launch has no token; a remote engine's data is then
    // the server queue's to retry, so only the local files are this run's job.
    clearEngineRiskData: () =>
      token || !engineRemote() ? clearEngineRiskData(token ?? "") : Promise.resolve({ ok: true, remote: true }),
    localSnaptradeUserId: (accountId) => localSnaptradeIdentity(accountId)?.userId ?? null,
    deleteSnaptradeUser: direct ? deleteSnaptradeUser : null,
    wipe: (accountId) =>
      wipeLocalAccountData(resolveDataRoot(), accountId, {
        removeSnaptradeIdentity: () => forgetLocalSnaptradeIdentity(accountId),
      }),
    pending: {
      read: () => readPendingCleanups(resolveDataRoot()),
      write: (list) => writePendingCleanups(resolveDataRoot(), list),
    },
  };
}

const NOTICE_KEYS: Record<DeletionNotice, MainMessageKey> = {
  "snaptrade-retry": "dialog.accountDeleted.snaptrade",
  "engine-retry": "dialog.accountDeleted.engineRetry",
  "engine-manual": "dialog.accountDeleted.engineManual",
  "local-retry": "dialog.accountDeleted.local",
};

/** Tells the reader, before the app signs out, what the deletion could not finish. */
async function showNotices(notices: DeletionNotice[], owner: BrowserWindow | null): Promise<void> {
  if (notices.length === 0) return;
  const options = {
    type: "warning" as const,
    title: mt("dialog.accountDeleted.title"),
    message: mt("dialog.accountDeleted.title"),
    detail: notices.map((n) => mt(NOTICE_KEYS[n])).join("\n\n"),
    buttons: [mt("dialog.accountDeleted.ok")],
    noLink: true,
  };
  try {
    if (owner) await dialog.showMessageBox(owner, options);
    else await dialog.showMessageBox(options);
  } catch {
    // No window to show it on: the outcome still reaches the renderer.
  }
}

export async function deleteAccountFromMain(
  accessToken: string,
  siteBases: string[],
  owner: BrowserWindow | null,
): Promise<DesktopDeletionOutcome> {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  const outcome = await deleteAccountFromDesktop(token, deps(token, siteBases));
  if (outcome.ok) await showNotices(outcome.notices, owner);
  return outcome;
}

/** Finishes, a little after launch, the local cleanup of an account deleted on an earlier run. */
export function retryAccountCleanupsSoon(siteBases: string[]): void {
  const timer = setTimeout(() => {
    retryPendingCleanups(deps(null, siteBases))
      .then((left) => {
        if (left > 0) console.warn(`[account-delete] ${left} local cleanup(s) still pending`);
      })
      .catch((err) => console.warn("[account-delete] retry failed:", err instanceof Error ? err.message : err));
  }, 20_000);
  timer.unref?.();
}
