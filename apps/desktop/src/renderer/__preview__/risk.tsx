import { createRoot } from "react-dom/client";
import "../globals.css";
import OpportunitiesPanel from "../components/dashboard/OpportunitiesPanel";
import RiskHost from "../components/risk/RiskHost";
import fixture from "./risk-fixture.json";

/**
 * Scratch harness for the Risk Engine surfaces against a recorded real-data
 * snapshot (scripts/risk-replay.ts --json).
 *   ?view=panel                 Shift+R panel
 *   ?view=card&state=on         dashboard card, riskCardEnabled: true
 *   ?view=card&state=off        flag off → static placeholder (unchanged)
 *   ?view=card&state=empty      flag on, empty snapshot → "No open positions."
 *   ?view=card&state=loading    flag on, a demo push in flight → loading state
 *   ?view=panel&state=thin      Sharpe unmeasurable → the row is shown as out of the blend
 *   ?view=panel&state=boom      a corrupt payload → the error boundary holds, the app does not go white
 *   ?view=panel&state=legacy    a stored five-component snapshot (pre-Sharpe) → the row reads "not in this snapshot"
 */
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "panel";
const state = params.get("state") ?? "on";

const real = (fixture as any).snapshot;
const emptySnapshot = { ...real, empty: true, score: null, band: null, components: null, driver: null, weights: [], position_count: 0, invested_fraction: 0 };
/** Too little history for §3.6: the component drops out and the rest renormalise. */
const thinSnapshot = {
  ...real,
  components: { ...real.components, sharpe: { ...real.components.sharpe, score: null, sharpe: null, sessions: 12 } },
  blend_weights: { concentration: 0.2045, market: 0.1932, volatility: 0.2045, network: 0.25, event: 0.1477, sharpe: 0 },
  degraded: [...real.degraded, { ticker: "*", field: "sharpe", substitute: "12 sessions" }],
};
/** Exactly what data/risk/snapshots.json holds today: written before §3.6 existed. */
const legacyComponents = { ...real.components };
delete (legacyComponents as any).sharpe;
const legacySnapshot = {
  ...real,
  schema_version: 1,
  components: legacyComponents,
  blend_weights: { concentration: 0.2, market: 0.2, volatility: 0.2, network: 0.25, event: 0.15 },
};
/** Deliberately corrupt: top_links is not an array, so rendering the row throws. */
const boomSnapshot = { ...real, components: { ...real.components, network: { ...real.components.network, top_links: "nope" } } };
const snapshot =
  state === "empty"
    ? emptySnapshot
    : state === "thin"
      ? thinSnapshot
      : state === "legacy"
        ? legacySnapshot
        : state === "boom"
          ? boomSnapshot
          : real;
const riskCardEnabled = state !== "off";

const history = [
  { computed_at: real.computed_at, score: real.score, band: real.band, driver_component: real.driver.component, driver_sentence: real.driver.sentence, trigger: ["manual"], empty: false },
  { computed_at: "2026-08-21T20:05:00.000Z", score: 34, band: "moderate", driver_component: "concentration", driver_sentence: "49% of the portfolio sits in NVDA.", trigger: ["close_run"], empty: false },
  { computed_at: "2026-08-20T20:05:00.000Z", score: 33, band: "moderate", driver_component: "concentration", driver_sentence: "49% of the portfolio sits in NVDA.", trigger: ["close_run", "band_change"], empty: false },
  { computed_at: "2026-08-19T14:00:00.000Z", score: null, band: null, driver_component: null, driver_sentence: null, trigger: ["startup"], empty: true },
];

(window as any).meridian = {
  getRiskLatest: async () => ({ ok: true, snapshot, riskCardEnabled }),
  getRiskStatus: async () => ({
    ok: true,
    status: {
      dataDir: "apps/desktop/data/risk",
      configFile: "apps/desktop/data/risk/config.json",
      riskCardEnabled,
      weights: real.blend_weights,
      debounceMs: 60000,
      pollIntervalMs: 60000,
      historyRetentionDays: 180,
      snapshotCount: history.length,
      latestComputedAt: real.computed_at,
      lastPollAt: real.computed_at,
      lastError: null,
      account: { received: true, as_of: real.computed_at, positions: real.position_count, cash: 5000 },
      keys: (fixture as any).keys,
    },
  }),
  getRiskHistory: async () => ({ ok: true, history }),
  recomputeRisk: async () => ({ ok: true, snapshot, riskCardEnabled }),
  setRiskCardEnabled: async () => ({ ok: true }),
  updateRiskAccount: async () => ({ ok: true }),
  onRiskSnapshot: () => () => {},
};

if (state === "loading") setTimeout(() => window.dispatchEvent(new CustomEvent("falcon:risk-pending")), 50);
// Shift+R, the way the app opens it.
if (view !== "card") setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", code: "KeyR", shiftKey: true })), 60);

createRoot(document.getElementById("root")!).render(
  view === "card" ? (
    <div className="flex min-h-screen items-center justify-center bg-[#EAEAE6] p-10">
      <div className="h-[460px] w-[380px]">
        <OpportunitiesPanel />
      </div>
    </div>
  ) : (
    <div className="min-h-screen bg-[#EAEAE6]">
      <div className="p-6 font-sans text-[12px] text-[#6b7280]">dashboard stays mounted behind the panel</div>
      <RiskHost />
    </div>
  ),
);
