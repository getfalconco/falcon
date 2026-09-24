import { registerIpcHandler } from "../ipc-register";
import {
  getEventsPollStatus,
  listNewsArticles,
  listStoredEvents,
  resolveEventsDataDir,
  runNewsEventPoll,
  setPollCompleteHook,
} from "@meridian/research/news";
import { startNewsEventPoller } from "./event-poller.js";
import { notifyNewEvents } from "./notify-new-events.js";

export function registerEventHandlers(): void {
  registerIpcHandler("events:list", async (_event, options?: { days?: number; ticker?: string }) => {
    try {
      const events = await listStoredEvents(resolveEventsDataDir(), options);
      return { ok: true as const, events };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });

  // An engine channel: with a service configured (the normal case) this is
  // answered there, from the poll that actually runs. This local body only
  // serves a checkout that runs the chain itself, and knows no sectors.
  registerIpcHandler("news:feed", async (_event, options?: { days?: number; limit?: number }) => {
    try {
      const articles = await listNewsArticles(resolveEventsDataDir(), options);
      return {
        ok: true as const,
        articles: articles.map((a) => ({ ...a, sectors: [] as string[] })),
        status: getEventsPollStatus(),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("events:status", async () => {
    return { ok: true as const, status: getEventsPollStatus() };
  });

  registerIpcHandler("events:poll-now", async () => {
    if (getEventsPollStatus().running) {
      return { ok: true as const, status: getEventsPollStatus() };
    }
    void runNewsEventPoll().catch((err) => {
      console.error("[events] background poll error:", err);
    });
    return { ok: true as const, status: getEventsPollStatus() };
  });
}

export function bootstrapNewsEvents(): void {
  // Opportunity generation (propagation) is owned by the always-on Railway
  // falcon-engine service, which runs 24/7 even when this desktop is closed and writes
  // results to Supabase. The desktop only reads those opportunities (see
  // `signals:list`), so it must NOT run propagation itself — doing so would
  // double the Finnhub + LLM spend against the same events. We still poll news
  // locally to power the desktop's own events view and new-event notifications.
  setPollCompleteHook((status, newEvents) => {
    if (status.lastNewEvents > 0) {
      console.info(
        `[events] ${status.lastNewEvents} new event(s) — notifying (propagation runs server-side)`,
      );
      notifyNewEvents(newEvents);
    }
  });

  startNewsEventPoller();
}
