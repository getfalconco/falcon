import { getEventsPollStatus, runNewsEventPoll } from "@meridian/research/news";

const POLL_INTERVAL_MS = 60_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

async function pollTick(): Promise<void> {
  await runNewsEventPoll();
  pollTimer = setTimeout(() => {
    void pollTick();
  }, POLL_INTERVAL_MS);
}

export function startNewsEventPoller(): void {
  if (started) return;
  started = true;

  console.info("[events] starting news poller (1 min interval)");
  void runNewsEventPoll().finally(() => {
    pollTimer = setTimeout(() => {
      void pollTick();
    }, POLL_INTERVAL_MS);
  });
}

export function stopNewsEventPoller(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  started = false;
}

export { getEventsPollStatus, runNewsEventPoll };
