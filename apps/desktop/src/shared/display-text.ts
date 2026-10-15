/**
 * Mojibake repair at the renderer's read boundary.
 *
 * The main process repairs provider text as it ingests it, but propagation
 * runs mirrored from the server were written before that repair existed, so an
 * old row still carries "weekâ€™s" or "weekâs" in its event label. These helpers
 * fix the display text of what the renderer reads (event labels and evidence
 * lines, which are provider headlines) and leave every id, key, ticker and
 * enum as it came.
 *
 * One implementation: `repairMojibake` is the engine's own, imported from its
 * pure subpath so nothing Node-only reaches the Vite bundle.
 */

import { repairMojibake } from "@meridian/research/news/mojibake";
import type { PairHistoryEvent, PropagationPairHistory } from "./propagation-pair";
import type { PropagationRun, PropagationRunListItem } from "./propagation-run-types";

export { repairMojibake };

/** A string repaired; anything else as it came. */
function fix<T>(value: T): T {
  return (typeof value === "string" ? repairMojibake(value) : value) as T;
}

/** A run list row with its event label repaired. Same object when nothing changed. */
export function repairRunListItem<T extends Pick<PropagationRunListItem, "event_label">>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const event_label = fix(row.event_label);
  return event_label === row.event_label ? row : { ...row, event_label };
}

/** Every row of a run list, repaired. */
export function repairRunList<T extends Pick<PropagationRunListItem, "event_label">>(rows: T[]): T[] {
  return Array.isArray(rows) ? rows.map(repairRunListItem) : rows;
}

/** A full run with its event's label and evidence lines repaired. */
export function repairRun(run: PropagationRun): PropagationRun {
  if (!run || typeof run !== "object" || !run.event) return run;
  const label = fix(run.event.label);
  const lines = Array.isArray(run.event.evidence_lines) ? run.event.evidence_lines : null;
  const evidence_lines = lines ? lines.map(fix) : run.event.evidence_lines;
  const linesChanged = lines ? evidence_lines.some((l, i) => l !== lines[i]) : false;
  if (label === run.event.label && !linesChanged) return run;
  return { ...run, event: { ...run.event, label, evidence_lines: linesChanged ? evidence_lines : run.event.evidence_lines } };
}

/** A pair's history with each event's label repaired. */
export function repairPairHistory(history: PropagationPairHistory): PropagationPairHistory {
  if (!history || typeof history !== "object" || !Array.isArray(history.events)) return history;
  const events: PairHistoryEvent[] = history.events.map(repairRunListItem);
  return events.every((e, i) => e === history.events[i]) ? history : { ...history, events };
}
