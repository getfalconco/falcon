import { BrowserWindow } from "electron";
import { registerIpcHandler } from "../ipc-register";
import { deleteAccountFromMain, retryAccountCleanupsSoon } from "../account/account-deletion-main";
import { loadDesktopEnv } from "../load-desktop-env";
import { submitApplication, type ApplyPayload } from "./apply";
import { getOwnMembership } from "./membership";

/**
 * Proxies the marketing site's waitlist endpoints from the main process, so the
 * renderer never makes a cross-origin request (which Electron blocks via CORS).
 */

function siteBases(): string[] {
  loadDesktopEnv(true);
  const configured = (process.env.SITE_URL ?? process.env.VITE_SITE_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  const bases = [configured, "https://getfalcon.co"].filter(Boolean);
  return Array.from(new Set(bases));
}

export function registerWaitlistHandlers(): void {
  // Account deletion: server, engine, SnapTrade and this machine's files
  // (account/account-deletion.ts). Answers { ok, accountId, notices } so the
  // renderer can clear its own storage for that account before signing out.
  registerIpcHandler("account:delete", async (event, accessToken: string) =>
    deleteAccountFromMain(accessToken, siteBases(), event ? BrowserWindow.fromWebContents(event.sender) : null),
  );
  retryAccountCleanupsSoon(siteBases());
  // The user's own ticket, asked for with their session token (membership.ts).
  // Takes no email: an older renderer that still passes one is ignored.
  registerIpcHandler("waitlist:membership", async () => getOwnMembership(siteBases()));
  // Sends the signed-in user's token when there is one (apply.ts).
  registerIpcHandler("waitlist:apply", async (_event, payload: ApplyPayload) =>
    submitApplication(siteBases(), payload),
  );
}
