import {
  isQuietTime,
  type NotificationSettings,
} from "../../../shared/notification-settings";
import type { Delivery, DeliveryChannel, DeliveryResult } from "./types";
import { mList, mt } from "../../i18n";

/**
 * Native desktop notifications for agent reports, under the reader's
 * Settings > Notifications: the master switch, the "agents" category, sound
 * and quiet hours.
 *
 * Quiet hours hold a notification rather than drop it: the report is stored
 * and marked unread either way, and once the window ends the held ones are
 * shown (one line per agent, or a single summary when several piled up).
 * Held notifications live in memory; after a restart the unread count on
 * the agent is what remains, which is the same thing the reader would see.
 *
 * Electron is injected (`show`), so the gate and the hold are tested without it.
 */

export type DesktopChannelDeps = {
  readSettings: () => NotificationSettings;
  /** Shows one notification; returns whether the OS took it. */
  show: (content: { title: string; body: string }, onClick: () => void) => boolean;
  /** The reader clicked: open this agent (and report). */
  onOpen: (agentId: string, reportId?: string) => void;
  supported: () => boolean;
  now?: () => Date;
};

/** What became of the daily digest notification: "held" (quiet hours) is tried again later. */
export type DigestOutcome = "shown" | "held" | "off" | "unsupported" | "failed";

/** One agent's line in the daily digest. */
export type DigestItem = { agentId: string; reportId: string; title: string; body: string };

export type DesktopChannel = DeliveryChannel & {
  /** Shows what quiet hours held, if the window has ended. Returns how many were released. */
  flushHeld(): number;
  heldCount(): number;
  /**
   * The daily digest as one notification, under the same gate as a report's:
   * the master switch, the agents category and quiet hours (which hold it).
   * One agent reads as its own notification; several as a count and names.
   * A click opens the newest report's agent.
   */
  showDigest(items: readonly DigestItem[]): DigestOutcome;
};

export function createDesktopChannel(deps: DesktopChannelDeps): DesktopChannel {
  const now = deps.now ?? (() => new Date());
  let held: Delivery[] = [];

  const showOne = (d: Delivery): boolean =>
    deps.show({ title: d.title, body: d.body }, () => deps.onOpen(d.agent.id, d.report.id));

  return {
    channel: "desktop",

    deliver(d: Delivery): DeliveryResult {
      if (!deps.supported()) return { channel: "desktop", status: "unsupported", note: "This system cannot show notifications.", line: { code: "delivery.desktopUnsupported" } };
      const settings = deps.readSettings();
      if (!settings.enabled || !settings.categories.agents) {
        return { channel: "desktop", status: "off", note: "Notification not sent: agent notifications are off in Settings.", line: { code: "delivery.desktopOff" } };
      }
      if (isQuietTime(settings.quietHours, now())) {
        held = [...held.filter((h) => h.agent.id !== d.agent.id), d];
        return {
          channel: "desktop",
          status: "held",
          note: `Notification held for quiet hours (until ${settings.quietHours.end}).`,
          line: { code: "delivery.desktopHeld", params: { time: settings.quietHours.end } },
        };
      }
      return showOne(d)
        ? { channel: "desktop", status: "shown", note: "Desktop notification sent.", line: { code: "delivery.desktopShown" } }
        : { channel: "desktop", status: "failed", note: "The desktop notification could not be shown.", line: { code: "delivery.desktopFailed" } };
    },

    flushHeld(): number {
      if (held.length === 0) return 0;
      const settings = deps.readSettings();
      if (!settings.enabled || !settings.categories.agents) {
        held = [];
        return 0;
      }
      if (isQuietTime(settings.quietHours, now())) return 0;
      const batch = held;
      held = [];
      if (batch.length === 1) {
        showOne(batch[0]!);
      } else {
        const first = batch[0]!;
        deps.show(
          {
            title: mt("notify.agents.title"),
            body: mt("notify.agents.quietBody", { count: batch.length, names: mList(batch.map((d) => d.title)) }),
          },
          () => deps.onOpen(first.agent.id, first.report.id),
        );
      }
      return batch.length;
    },

    heldCount: () => held.length,

    showDigest(items: readonly DigestItem[]): DigestOutcome {
      if (items.length === 0) return "shown";
      if (!deps.supported()) return "unsupported";
      const settings = deps.readSettings();
      if (!settings.enabled || !settings.categories.agents) return "off";
      if (isQuietTime(settings.quietHours, now())) return "held";
      const newest = items[items.length - 1]!;
      const content =
        items.length === 1
          ? { title: mt("notify.agents.digestTitle"), body: `${newest.title}: ${newest.body}` }
          : {
              title: mt("notify.agents.digestTitle"),
              body: mt("notify.agents.digestBody", { count: items.length, names: mList(items.map((i) => i.title)) }),
            };
      return deps.show(content, () => deps.onOpen(newest.agentId, newest.reportId)) ? "shown" : "failed";
    },
  };
}
