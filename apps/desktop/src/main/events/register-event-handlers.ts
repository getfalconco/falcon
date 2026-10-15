import { registerIpcHandler } from "../ipc-register";
import {
  curateNewsFeed,
  getEventsPollStatus,
  listNewsArticles,
  verdictIndex,
  listStoredEvents,
  resolveEventsDataDir,
  runNewsEventPoll,
  setPollCompleteHook,
} from "@meridian/research/news";
import { startNewsEventPoller } from "./event-poller.js";
import { notifyNewEvents } from "./notify-new-events.js";
import { setNotificationSource } from "../notifications/notifier";
import { NewsFeedCache } from "./news-feed-cache.js";
import { repairEventsText, repairFeedText } from "./feed-text.js";
import type { NewsFeedOptions } from "../../shared/news-feed";
import { getClassifierHost } from "../classifier/classifier-host";

/**
 * The feed's last good answers, beside the events store (FALCON_EVENTS_DATA_DIR,
 * under the runtime data root). One per process; `news:feed` reads through it
 * and `news:feed-cached` peeks at it.
 */
const newsFeedCache = new NewsFeedCache({ dir: () => resolveEventsDataDir() });

export function registerEventHandlers(): void {
  registerIpcHandler("events:list", async (_event, options?: { days?: number; ticker?: string }) => {
    try {
      const events = await listStoredEvents(resolveEventsDataDir(), options);
      // Events filed before ingestion repaired provider mojibake are fixed on the way out.
      return repairEventsText({ ok: true as const, events }) as { ok: true; events: typeof events };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });

  // An engine channel: with a service configured (the normal case) this is
  // answered there, from the poll that actually runs. This local body only
  // serves a checkout that runs the chain itself, and knows no sectors. It
  // decides what the card shows the same way the engine does, from this
  // process's own classifier verdicts (news/curation.ts).
  //
  // Either way the answer goes through the feed cache: a repeat inside its
  // freshness window is served from memory, identical requests share one
  // call, and every good answer is kept on disk for the next launch.
  registerIpcHandler(
    "news:feed",
    async (_event, options?: { days?: number; limit?: number }) => {
      try {
        const raw = await listNewsArticles(resolveEventsDataDir(), options);
        const host = getClassifierHost();
        const articles = curateNewsFeed(raw, {
          verdictFor: verdictIndex(host.verdictStore.list()),
          companyName: (t) => host.metadata.context(t).official_name,
        });
        return {
          ok: true as const,
          articles: articles.map((a) => ({ ...a, sectors: [] as string[] })),
          status: getEventsPollStatus(),
        };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Provider mojibake in headlines and summaries is repaired before the cache keeps them.
    { around: (args, answer) => newsFeedCache.get(args[0] as NewsFeedOptions | undefined, async () => repairFeedText(await answer())) },
  );

  // The last good feed, however old, with its age, and no request behind it:
  // what the card shows the moment it opens after a restart, while `news:feed`
  // is out. Local on purpose (not an engine channel), so it never waits on
  // the network.
  registerIpcHandler("news:feed-cached", async (_event, options?: NewsFeedOptions) => {
    return repairFeedText(newsFeedCache.peek(options));
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

  // This machine now finds material events itself, so their alerts can fire.
  setNotificationSource("marketEvents", { available: true, note: null });
  startNewsEventPoller();
}
