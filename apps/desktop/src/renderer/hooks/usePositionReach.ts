import { useEffect, useState } from "react";
import type {
  PropagationRun,
  PropagationRunListItem,
} from "../../shared/propagation-run-types";
import { isLiveRun } from "@/lib/second-order-card";

/**
 * Which live propagation events reach each held name — the Positions card's
 * "Reaching" column and the line under each stock. A holding is reached when
 * a current run with something still open lists it as a target that was not
 * vetoed. The run list gives only counts, so each open run is loaded once
 * (cached by id) to read its targets.
 */

export type Reach = {
  run_id: string;
  /** The company the event happened to. */
  root: string;
  /** The event's type, as a short phrase — "guidance", "export controls". */
  what: string;
  /** Where this holding stands on the move: still open, part way, or done. */
  status: "open" | "partial" | "priced";
};

const POLL_MS = 60_000;
const runCache = new Map<string, PropagationRun>();

async function loadRun(id: string): Promise<PropagationRun | null> {
  const hit = runCache.get(id);
  if (hit) return hit;
  try {
    const res = await window.meridian?.getPropagationRun?.(id);
    if (res?.ok) {
      runCache.set(id, res.run);
      return res.run;
    }
  } catch {
    /* a run that will not load is a run that reaches nothing */
  }
  return null;
}

function phrase(item: PropagationRunListItem): string {
  const type = (item.event_type ?? "").replace(/_/g, " ").trim();
  return type || "event";
}

/**
 * @param symbolsKey comma-joined, sorted symbols — a stable effect dependency.
 */
export function usePositionReach(symbolsKey: string): Record<string, Reach[]> {
  const [reach, setReach] = useState<Record<string, Reach[]>>({});

  useEffect(() => {
    const held = new Set(symbolsKey ? symbolsKey.split(",").filter(Boolean) : []);
    if (held.size === 0) {
      setReach({});
      return;
    }
    let cancelled = false;

    const load = async () => {
      let items: PropagationRunListItem[] = [];
      try {
        const res = await window.meridian?.listPropagationRuns?.({
          currentOnly: true,
          synthetic: "exclude",
          limit: 200,
        });
        if (res?.ok) items = res.runs.filter((r) => isLiveRun(r.summary) && !r.superseded);
      } catch {
        items = [];
      }
      const runs = await Promise.all(items.map((i) => loadRun(i.run_id)));
      if (cancelled) return;

      const next: Record<string, Reach[]> = {};
      items.forEach((item, i) => {
        const run = runs[i];
        if (!run) return;
        for (const t of run.targets) {
          const ticker = (t.ticker ?? "").toUpperCase();
          if (!ticker || !held.has(ticker)) continue;
          if (t.stage2?.verdict === "vetoed") continue;
          const status: Reach["status"] =
            t.pricing.status === "open"
              ? "open"
              : t.pricing.status === "partial"
                ? "partial"
                : "priced";
          (next[ticker] ??= []).push({
            run_id: run.run_id,
            root: run.root_ticker.toUpperCase(),
            what: phrase(item),
            status,
          });
        }
      });
      // Open first, then partial, then priced — the line under a row reads
      // the first one.
      const rank = { open: 0, partial: 1, priced: 2 } as const;
      for (const list of Object.values(next)) list.sort((a, b) => rank[a.status] - rank[b.status]);
      setReach(next);
    };

    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbolsKey]);

  return reach;
}
