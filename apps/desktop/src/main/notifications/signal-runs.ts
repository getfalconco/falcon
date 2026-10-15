import type { PropagationRunListItem } from "../../shared/propagation-run-types";
import { mt, mtCount } from "../i18n";

/**
 * Which propagation runs are worth a notification. Pure, so the rule can be
 * tested on its own.
 *
 * A second-order signal is announced once per incident — the first run that
 * says something, not every re-run or update after it — and only when it has
 * an open name: a target the market has not priced yet, which is the whole
 * reason to interrupt someone. Fixture runs, failed runs and superseded ones
 * never qualify; the dashboard card does not show them either.
 */
export function isNotifiableRun(run: PropagationRunListItem): boolean {
  return !run.synthetic && run.status !== "failed" && !run.superseded && run.summary.open > 0;
}

/**
 * The runs in `runs` whose incident has not been seen yet and that qualify.
 * Every incident in `runs` is added to `seen`, qualifying or not, so a run
 * that only becomes interesting on a later update does not fire then either:
 * the reader would get an alert for an event that is already old.
 */
export function takeNewSignalRuns(seen: Set<string>, runs: readonly PropagationRunListItem[]): PropagationRunListItem[] {
  const fresh: PropagationRunListItem[] = [];
  for (const run of runs) {
    const key = run.incident_id || run.run_id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isNotifiableRun(run)) fresh.push(run);
  }
  return fresh;
}

/** Title and body for one batch of new runs. */
export function describeSignalRuns(runs: readonly PropagationRunListItem[]): { title: string; body: string } {
  const line = (r: PropagationRunListItem) => {
    const names = mtCount("notify.signals.openOne", "notify.signals.openOther", r.summary.open);
    const label = r.event_label?.trim();
    return label ? `${r.root_ticker}: ${label} (${names})` : `${r.root_ticker} (${names})`;
  };
  if (runs.length === 1) {
    const r = runs[0];
    const names = mtCount("notify.signals.reachesOne", "notify.signals.reachesOther", r.summary.open);
    return {
      title: mt("notify.signals.title", { ticker: r.root_ticker }),
      body: r.event_label?.trim() ? `${r.event_label.trim()}\n${names}` : names,
    };
  }
  const shown = runs.slice(0, 3).map(line);
  if (runs.length > shown.length) shown.push(mt("notify.more", { count: runs.length - shown.length }));
  return { title: mt("notify.signals.batchTitle", { count: runs.length }), body: shown.join("\n") };
}
