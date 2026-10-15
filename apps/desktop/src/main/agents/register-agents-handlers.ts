import { BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import type { AgentDraft, AgentPatch, AgentPushEvent } from "../../shared/agent-types";
import { userKeyFromAccessToken } from "../briefing/user-key";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { readNotificationSettings } from "../notifications/notification-settings-store";
import { notify, setNotificationSource } from "../notifications/notifier";
import { getRendererSession } from "../session-bridge";
import { createDesktopChannel, type DesktopChannel } from "./channels/desktop";
import { createDigestChannel } from "./channels/digest";
import { createMobilePushChannel } from "./channels/mobile-push";
import { AgentEngine } from "./engine";
import { agentsModelConfigured, anthropicAgentCaller } from "./anthropic";
import { createLiveSources } from "./sources-live";

/**
 * Agents over IPC: `agents:<method>` invoke channels answering with
 * `AgentResult<T>`, and `agents:event` pushed to every window (see
 * `shared/agent-types.ts`). The engine itself (engine.ts) knows nothing of
 * Electron; this file supplies the window, the notifications, the account and
 * the live data sources.
 *
 * Agents are local to this machine and run while the app is open. They are
 * not engine channels: with FALCON_ENGINE_URL set they still answer here.
 */

const PUSH_CHANNEL = "agents:event";

function broadcast(event: AgentPushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(PUSH_CHANNEL, event);
  }
}

/** The account key from the session token: the Supabase `sub`, or "anon". */
function currentUserKey(): string {
  return userKeyFromAccessToken(getRendererSession().accessToken);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let engine: AgentEngine | null = null;
let desktop: DesktopChannel | null = null;

function getEngine(): AgentEngine {
  if (engine) return engine;
  desktop = createDesktopChannel({
    readSettings: () => readNotificationSettings(resolveDataRoot()),
    supported: () => Notification.isSupported(),
    // notify() applies the same gate again; the channel decides first so it can hold for quiet hours.
    show: (content, onClick) => notify("agents", content, { onClick }),
    onOpen: (agentId, reportId) => broadcast({ type: "open-agent", agentId, ...(reportId ? { reportId } : {}) }),
  });
  const channel = desktop;
  engine = new AgentEngine({
    // Resolved per call, not at import: a packaged build moves the data root at startup.
    get root() {
      return resolveDataRoot();
    },
    userKey: currentUserKey,
    userId: () => {
      const key = currentUserKey();
      return UUID.test(key) ? key : undefined;
    },
    sources: createLiveSources(),
    caller: () => (agentsModelConfigured() ? anthropicAgentCaller : null),
    channels: (store) => [
      channel,
      createMobilePushChannel({ append: (entry) => store.appendOutbox(entry), newId: () => randomUUID() }),
      createDigestChannel({ append: (entry) => store.appendDigest(entry), newId: () => randomUUID() }),
    ],
    sendDigest: (items) => channel.showDigest(items),
    emit: broadcast,
    onTick: () => {
      channel.flushHeld();
    },
  });
  return engine;
}

export function registerAgentsHandlers(): void {
  registerIpcHandler("agents:list", () => getEngine().list());
  registerIpcHandler("agents:get", (_event, id: string) => getEngine().get(id));
  registerIpcHandler("agents:draftFromBrief", (_event, brief: string, context?: unknown) => getEngine().draftFromBrief(brief, context));
  registerIpcHandler("agents:create", (_event, draft: AgentDraft) => getEngine().create(draft));
  registerIpcHandler("agents:update", (_event, id: string, patch: AgentPatch) => getEngine().update(id, patch));
  registerIpcHandler("agents:setStatus", (_event, id: string, status: "active" | "paused") => getEngine().setStatus(id, status));
  registerIpcHandler("agents:remove", (_event, id: string) => getEngine().remove(id));
  registerIpcHandler("agents:runNow", (_event, id: string) => getEngine().runNow(id));
  registerIpcHandler("agents:sendMessage", (_event, id: string, text: string) => getEngine().sendMessage(id, text));
  registerIpcHandler("agents:markRead", (_event, id: string) => getEngine().markRead(id));
}

/** Starts the scheduler. Call once the app is ready. */
export function bootstrapAgents(): void {
  setNotificationSource("agents", { available: true, note: null });
  getEngine().start();
}
