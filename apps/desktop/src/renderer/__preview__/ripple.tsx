import { createRoot } from "react-dom/client";
import "../globals.css";
import RipplePanel from "../components/propagation/RipplePanel";
import fixture from "./ripple-fixture.json";

/**
 * Scratch harness for the Shift+P ripple view (spec §8 step 5): renders the
 * panel against a recorded run so every state can be checked without the
 * Electron app. The fixture is the real NVDA / Cloverleaf run from the local
 * store — the one whose supplier and partner targets moved against the
 * transmitted direction (`contradicted`).
 *
 *   ?target=<ticker>  open that target's drawer on load
 *   ?mode=list        land on the ranked table instead of the map
 */
const params = new URLSearchParams(location.search);
const run = (fixture as { run: Record<string, unknown> }).run;
const listItem = (fixture as { listItem: Record<string, unknown> }).listItem;

const wantTicker = params.get("target");
const targets = (run.targets ?? []) as Array<{ ticker: string | null; target: string; relationship: { role: string } }>;
const focusTarget = wantTicker
  ? targets.find((t) => (t.ticker ?? "").toUpperCase() === wantTicker.toUpperCase())
  : null;

(window as unknown as { meridian: Record<string, unknown> }).meridian = {
  listPropagationRuns: async (options?: { synthetic?: string }) => ({
    ok: true,
    runs: options?.synthetic === "only" ? [] : [listItem],
  }),
  getPropagationRun: async () => ({ ok: true, run, chain: [listItem] }),
  getPropagationStatus: async () => ({
    ok: true,
    status: {
      enabled: false,
      configured: true,
      running: false,
      surfacing_enabled: false,
      model: "claude-fable-5",
      budget: { day: "2026-08-24", used: 4, remaining: 26, daily: 30 },
      metrics: {
        targets_total: 13,
        open_total: 0,
        partial_total: 0,
        priced_total: 3,
        contradicted_total: 2,
        untracked_total: 8,
        vetoes: 2,
        unclear_resolved: 0,
        unclear_total: 0,
      },
      last_run: null,
    },
  }),
  getPropagationAbsorption: async () => ({
    ok: true,
    curve: [
      { session: 0, date: "2026-08-21", close: 947.74, raw_pct: 0.01524, bench_pct: 0.00409, residual_pct: 0.017, multiple: 7.0 },
      { session: 1, date: "2026-08-24", close: 971.59, raw_pct: 0.04077, bench_pct: 0.0011, residual_pct: 0.0413, multiple: 17.0 },
    ],
  }),
  getGaugeReadout: async () => ({ ok: false, error: "gauge off in preview" }),
  openExternal: async () => {},
};

createRoot(document.getElementById("root")!).render(
  <RipplePanel
    onClose={() => {}}
    focus={
      focusTarget
        ? { runId: String(listItem.run_id), targetKey: `${focusTarget.target}|${focusTarget.relationship.role}` }
        : { runId: String(listItem.run_id) }
    }
  />,
);
