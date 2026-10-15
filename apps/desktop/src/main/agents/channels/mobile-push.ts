import type { OutboxEntry } from "../store";
import type { Delivery, DeliveryChannel, DeliveryResult } from "./types";

/**
 * Mobile push, recorded now and delivered once the mobile app exists.
 *
 * Today nothing is sent anywhere. A `mobile_push` delivery is written to the
 * account's local outbox (`<data root>/agents/<user>/outbox.json`) with
 * status "pending: mobile app not available yet", so the record of what
 * would have gone out exists from the first report.
 *
 * DESIGN NOTE: how this works once there is a mobile app.
 *
 *   1. Device registration. The mobile app signs in with the same Supabase
 *      account and registers its push token (APNs / FCM) in a
 *      `device_push_tokens` table (user_id, platform, token, created_at,
 *      last_seen_at), insert and delete under RLS by the owning user only.
 *      The desktop never sees the tokens.
 *
 *   2. Agents move server side. A notification that depends on this desktop
 *      being open is not a mobile feature. The agent definitions (this store's
 *      agents.json) sync to an `agents` table keyed by user_id, and the trigger
 *      loop in `triggers.ts` (pure, fed by `AgentDataSources`) runs inside the
 *      always-on falcon-engine service with server-side sources and the
 *      engine's own Claude API route. The desktop becomes a client of that table,
 *      like the chain panels already are with FALCON_ENGINE_URL.
 *
 *   3. Sending. The engine writes each report to an `agent_reports` table and
 *      enqueues a push per registered device (title = agent name, body =
 *      headline, data = { agentId, reportId } so a tap opens the report),
 *      sent with the APNs / FCM credentials held only by the engine. Failed
 *      tokens (410 / unregistered) are deleted. Quiet hours and the "agents"
 *      category come from the same notification settings, synced per user.
 *
 *   4. Until the server path exists, this outbox is the migration seed: its
 *      pending rows say which reports a device would have received.
 *
 * No remote table or service is created by this file.
 */

export const MOBILE_PENDING_STATUS = "pending: mobile app not available yet";

export type MobilePushDeps = {
  append: (entry: OutboxEntry) => void;
  newId: () => string;
  now?: () => Date;
};

export function createMobilePushChannel(deps: MobilePushDeps): DeliveryChannel {
  const now = deps.now ?? (() => new Date());
  return {
    channel: "mobile_push",
    deliver(d: Delivery): DeliveryResult {
      try {
        deps.append({
          id: deps.newId(),
          at: now().toISOString(),
          agentId: d.agent.id,
          reportId: d.report.id,
          channel: "mobile_push",
          title: d.title,
          body: d.body,
          status: MOBILE_PENDING_STATUS,
        });
        return { channel: "mobile_push", status: "queued", note: "Mobile push saved for later: the mobile app is not available yet.", line: { code: "delivery.mobileQueued" } };
      } catch {
        return { channel: "mobile_push", status: "failed", note: "The mobile push could not be saved.", line: { code: "delivery.mobileFailed" } };
      }
    },
  };
}
