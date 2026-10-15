import { shell } from "electron";
import { registerIpcHandler } from "../ipc-register";
import { isPlanKey, MEMBERSHIP_URL, PLAN_URLS } from "../../shared/plans";

/**
 * "View All Plans" → Upgrade / Downgrade. The renderer names a plan, never a
 * URL: the main process looks the page up in the fixed getfalcon.co table
 * (shared/plans) and opens it in the browser, so nothing about payment ever
 * happens inside the app. An unknown key falls back to the membership page.
 */
export function registerPlansHandlers(): void {
  registerIpcHandler("plans:open", async (_event, planKey: unknown) => {
    await shell.openExternal(isPlanKey(planKey) ? PLAN_URLS[planKey] : MEMBERSHIP_URL);
  });
}
