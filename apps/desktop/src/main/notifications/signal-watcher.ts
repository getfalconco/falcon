import { invokeChannel } from "../ipc-register";
import type { PropagationRunListItem } from "../../shared/propagation-run-types";
import { notify, setNotificationSource } from "./notifier";
import { describeSignalRuns, takeNewSignalRuns } from "./signal-runs";

/**
 * Second-order signal notifications. Asks the same two questions the
 * dashboard's Insight card asks — the current propagation runs, and whether
 * runs are surfaced in the app at all — through `invokeChannel`, so it reads
 * the engine service or the local chain, whichever owns them.
 *
 * The first answer is only a baseline: whatever already exists when the app
 * opens was produced while the reader was away and is on the card already, so
 * nothing fires for it. After that, each new incident with an open name fires
 * once. While surfacing is off the card shows no runs, so nothing is sent for
 * them either — the alert would point at something the app hides.
 */

const FIRST_POLL_MS = 30_000;
/** Slower than the card (a minute): an alert a few minutes late costs nothing. */
const POLL_MS = 5 * 60_000;

type RunsReply = { ok: true; runs: PropagationRunListItem[] } | { ok: false; error: string };
type StatusReply = { ok: true; status: { surfacing_enabled: boolean } } | { ok: false; error: string };

let started = false;
let seen: Set<string> | null = null;
let surfacing: boolean | null = null;

function reportSource(): void {
  setNotificationSource(
    "secondOrderSignals",
    surfacing === false
      ? { available: false, note: "notify.source.signalsHidden" }
      : { available: true, note: null },
  );
}

async function poll(): Promise<void> {
  const [runs, status] = await Promise.allSettled([
    invokeChannel<RunsReply>("propagation:runs", { currentOnly: true, limit: 200 }),
    invokeChannel<StatusReply>("propagation:status"),
  ]);
  if (status.status === "fulfilled" && status.value?.ok) {
    surfacing = status.value.status.surfacing_enabled === true;
    reportSource();
  }
  if (runs.status !== "fulfilled" || !runs.value?.ok || !Array.isArray(runs.value.runs)) return;

  if (seen === null) {
    seen = new Set();
    takeNewSignalRuns(seen, runs.value.runs);
    return;
  }
  const fresh = takeNewSignalRuns(seen, runs.value.runs);
  if (fresh.length === 0 || surfacing !== true) return;
  notify("secondOrderSignals", describeSignalRuns(fresh));
}

export function startSignalWatcher(): void {
  if (started) return;
  started = true;
  reportSource();
  const tick = () => {
    void poll()
      .catch((err) => console.warn("[notifications] signal poll failed:", err instanceof Error ? err.message : err))
      .finally(() => setTimeout(tick, POLL_MS));
  };
  setTimeout(tick, FIRST_POLL_MS);
}
