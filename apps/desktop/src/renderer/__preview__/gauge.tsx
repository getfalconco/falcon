import { createRoot } from "react-dom/client";
import "../globals.css";
import GaugePanel from "../components/gauge/GaugePanel";
import GaugeContextBlock from "../components/gauge/GaugeContextBlock";
import TargetDrawer from "../components/propagation/TargetDrawer";
import amd from "./gauge-amd-fixture.json";
import nvda from "./gauge-nvda-fixture.json";
import aapl from "./gauge-aapl-fixture.json";
import mstr from "./gauge-mstr-fixture.json";
import avgo from "./gauge-avgo-fixture.json";
import context from "./gauge-context-fixture.json";

/**
 * Scratch harness for the Gauge v2 surfaces against recorded real-data
 * readouts (scripts/gauge-replay.ts readout <T> --json · propagation --json).
 *
 *   ?view=panel[&t=AMD|NVDA|AAPL|MSTR|AVGO]   Shift+F panel — hero + collapsible evidence
 *   ?view=panel&t=NVDA&open=1                 …with the evidence expanded
 *   ?view=drawer[&scroll=1]                   Propagation target drawer (context mode)
 *   ?view=stock                               the stock-page block
 *   ?view=states                              all four decision states side by side
 */
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "panel";

const readouts: Record<string, any> = {
  AMD: (amd as any).readout,
  NVDA: (nvda as any).readout,
  AAPL: (aapl as any).readout,
  MSTR: (mstr as any).readout,
  AVGO: (avgo as any).readout,
};
const contextReadout = (context as any).readout;
const run = (context as any).run;
const target = (context as any).target;
const picked = readouts[(params.get("t") ?? "AMD").toUpperCase()] ?? readouts.AMD;

(window as any).meridian = {
  getGaugeReadout: async (req: any) => ({
    ok: true,
    readout: req.context ? contextReadout : { ...(readouts[req.ticker?.toUpperCase()] ?? picked), ticker: req.ticker },
    errors: [],
    memo_hit: false,
  }),
  getGaugeStatus: async () => ({
    ok: true,
    status: {
      dataDir: "apps/desktop/data/gauge",
      configFile: "apps/desktop/data/gauge/config.json",
      memoTtlMs: 60000,
      memoSize: 3,
      calibratingNaCount: 3,
      r2Floor: 0.15,
      thresholds: {
        trend: { oppositeZFail: 1.5 },
        regime: { stableMax: 1.2, expandingMax: 1.5, contractingBelow: 0.8 },
        volume: { quietBelow: 0.7, elevatedAbove: 2, anomalyAbove: 3, buildingMin: 1 },
        stretch: { passZ: 1, cautionZ: 2, near52wPct: 0.02 },
        eventWall: { cautionSessions: 3, failSessions: 1, noteSessionsMax: 10, noteRhythmMin: 0.05 },
        freshness: { freshMaxSessions: 1, closedSessions: 3 },
      },
      trackedTickers: 72,
      counters: { day: "2026-08-24", total: 74, by_surface: { panel: 5, drawer: 2, script: 67 }, by_state: { actionable: 12, wait: 2, nothing_here: 23, unreadable: 35 }, memo_hits: 4 },
      lastError: null,
      screenAvailable: true,
      screenFindings: picked?.setup?.screen?.length ?? 0,
      snapshots: { enabled: true, file: "apps/desktop/data/gauge/snapshots.jsonl", count: 72, lastSession: "2026-08-24" },
      setupOrder: ["coiled_event_ahead", "event_wall", "regime_break", "move_spent", "divergence", "accumulation", "confirmed_drift", "quiet_drift", "coiled", "unreadable", "no_setup"],
    },
  }),
  getGaugeTickers: async () => ({ ok: true, tickers: ["AAPL", "AMD", "AVGO", "MSTR", "NVDA"] }),
  reloadGaugeConfig: async () => ({ ok: true, status: null }),
  openExternal: async () => undefined,
};

const root = createRoot(document.getElementById("root")!);
const card = "w-full max-w-2xl rounded-xl border border-[#e0e0da] bg-white px-4 py-3.5";

if (view === "drawer") {
  if (params.get("scroll")) {
    setTimeout(() => {
      const el = document.querySelector(".scrollbar-meridian");
      if (el) el.scrollTop = el.scrollHeight;
    }, 900);
  }
  root.render(
    <div className="flex h-screen bg-[#F4F4F0]">
      <div className="flex-1" />
      <TargetDrawer run={run} target={target} onClose={() => undefined} />
    </div>,
  );
} else if (view === "stock") {
  root.render(
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-[#F4F4F0] py-6">
      <p className="text-xs uppercase tracking-[0.12em] text-[#9CA3AF]">AMD</p>
      <GaugeContextBlock ticker="AMD" context={null} surface="stock" title="Tape state" className="w-full max-w-md rounded-xl border border-[#e6e6e0] bg-[#fbfbf9] px-3.5 py-3 text-left" />
    </div>,
  );
} else if (view === "states") {
  root.render(
    <div className="flex min-h-screen flex-col items-center gap-4 bg-[#F4F4F0] py-8">
      {[
        ["AMD", "actionable — a structure with nothing missing"],
        ["MSTR", "actionable — Screen's multi-session finding, confirmed by volume"],
        ["NVDA", "wait — the missing condition is the event, with its date"],
        ["AAPL", "unreadable — the measurement itself, stated plainly"],
      ].map(([t, caption]) => (
        <div key={t} className={card}>
          <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">
            {t} · {caption}
          </p>
          <GaugeContextBlock ticker={t} context={null} surface="stock" title="Tape state" className="rounded-lg border border-[#e6e6e0] bg-[#fbfbf9] px-3 py-2.5" />
        </div>
      ))}
    </div>,
  );
} else {
  root.render(<GaugePanel onClose={() => undefined} initialTicker={(params.get("t") ?? "AMD").toUpperCase()} />);
}
