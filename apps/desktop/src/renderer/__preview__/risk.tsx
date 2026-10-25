import { createRoot } from "react-dom/client";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import "../globals.css";
import OpportunitiesPanel from "../components/dashboard/OpportunitiesPanel";
import PortfolioCard from "../components/dashboard/PortfolioCard";
import RiskHost from "../components/risk/RiskHost";
import fixture from "./risk-fixture.json";

// ?lang=tr-TR shows the card in that language (kept, as a pick would be).
{
  const lang = new URLSearchParams(location.search).get("lang");
  if (isLanguageCode(lang)) setLanguage(lang);
  applyLanguage();
}

/**
 * Scratch harness for the Risk Engine surfaces against a recorded real-data
 * snapshot (scripts/risk-replay.ts --json).
 *   ?view=panel                 Shift+R panel
 *   ?view=card&state=on         dashboard card, riskCardEnabled: true
 *   ?view=card&state=off        flag off → "Risk score unavailable", no number
 *   ?view=card&state=empty      flag on, empty snapshot, nothing held → "No positions to score yet"
 *   ?view=card&state=none       no snapshot yet for a held book → "Calculating your risk score"
 *   ?view=card&state=error      the read fails → the error line with Try again, no number
 *   ?view=card&state=loading    flag on, a demo push in flight → loading state
 *   ?view=panel&state=thin      Sharpe unmeasurable → the row is shown as out of the blend
 *   ?view=panel&state=boom      a corrupt payload → the error boundary holds, the app does not go white
 *   ?view=panel&state=legacy    a stored five-component snapshot (pre-Sharpe) → the row reads "not in this snapshot"
 *   ?view=both                  Positions card beside the risk card over the fixture's book
 *                               (its holdings + 5,000 cash): one weight for JPM on both.
 *                               Hover a row: the card reads that name (per-position metrics
 *                               below, preview values; JPM untracked, so no beta or vol)
 *   ?view=both&state=legacy     the same with a snapshot from before per-position metrics:
 *                               hovering shows the weight line alone
 */
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "panel";
const state = params.get("state") ?? "on";

const recorded = (fixture as any).snapshot;
/**
 * Per-position metrics in the engine's shape (risk/positions.ts). The recorded
 * fixture predates them, so these are preview values; the shares sum to 1 and
 * the earnings date sits two days out so the line shows whatever day it is.
 */
const PREVIEW_POSITIONS = [
  { ticker: "JPM", side: "long", account_weight: 0.32179, beta: null, daily_vol_pct: null, risk_share: 0.3102, earnings: null, correlation: null },
  { ticker: "NVDA", side: "long", account_weight: 0.20676, beta: 1.87, daily_vol_pct: 2.94, risk_share: 0.4417, earnings: { due_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), sessions_until: 2 }, correlation: { ticker: "JPM", value: 0.31, sessions: 89 } },
  { ticker: "CEG", side: "long", account_weight: 0.05688, beta: 1.42, daily_vol_pct: 3.12, risk_share: 0.0921, earnings: null, correlation: { ticker: "JPM", value: 0.27, sessions: 89 } },
  { ticker: "ZLAB", side: "long", account_weight: 0.05347, beta: 0.88, daily_vol_pct: 3.41, risk_share: 0.0684, earnings: null, correlation: { ticker: "JPM", value: 0.12, sessions: 89 } },
  { ticker: "OPK", side: "long", account_weight: 0.05327, beta: 0.64, daily_vol_pct: 2.6, risk_share: 0.0412, earnings: null, correlation: null },
  { ticker: "BNTX", side: "long", account_weight: 0.0526, beta: 0.41, daily_vol_pct: 2.05, risk_share: 0.0464, earnings: null, correlation: { ticker: "JPM", value: 0.08, sessions: 89 } },
];
const real = view === "both" && state !== "legacy" ? { ...recorded, positions: PREVIEW_POSITIONS } : recorded;
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

/** The fixture's book as a paper account, priced at the snapshot's own values. */
const BOTH_PRICES: Record<string, number> = { JPM: 300, NVDA: 182.65, CEG: 278.42, ZLAB: 26.17, OPK: 1.49, BNTX: 102.645 };
// "none" needs a held book too, or the card reads it as nothing to score.
if (view === "both" || state === "none") {
  const positions: Record<string, { symbol: string; shares: number; costUsd: number }> = {};
  for (const w of real.weights as Array<{ ticker: string; market_value: number }>) {
    const price = BOTH_PRICES[w.ticker];
    positions[w.ticker] = { symbol: w.ticker, shares: w.market_value / price, costUsd: w.market_value * 0.9 };
  }
  localStorage.setItem("falcon.paperPositions", JSON.stringify(positions));
  localStorage.setItem("falcon.paperBalance", "5000");
}

(window as any).meridian = {
  getLiveQuote: async (symbol: string) =>
    BOTH_PRICES[symbol] != null ? { ok: true, quote: { symbol, price: BOTH_PRICES[symbol], session: "closed" } } : { ok: false },
  getStockQuote: async (symbol: string) =>
    BOTH_PRICES[symbol] != null ? { ok: true, quote: { symbol, price: BOTH_PRICES[symbol] } } : { ok: false },
  getRiskLatest: async () =>
    state === "error" ? { ok: false, error: "engine timed out" } : { ok: true, snapshot: state === "none" ? null : snapshot, riskCardEnabled },
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
  // "none" never gets its score here, so the card stays on its calculating line.
  recomputeRisk: async () =>
    state === "none" ? new Promise<never>(() => {}) : state === "error" ? { ok: false, error: "engine timed out" } : { ok: true, snapshot, riskCardEnabled },
  setRiskCardEnabled: async () => ({ ok: true }),
  updateRiskAccount: async () => ({ ok: true }),
  onRiskSnapshot: () => () => {},
};

if (state === "loading") setTimeout(() => window.dispatchEvent(new CustomEvent("falcon:risk-pending")), 50);
// Shift+R, the way the app opens it.
if (view !== "card" && view !== "both") setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", code: "KeyR", shiftKey: true })), 60);

createRoot(document.getElementById("root")!).render(
  view === "both" ? (
    <div className="flex min-h-screen items-center justify-center gap-6 bg-surface-0 p-10">
      <div className="w-[380px] shrink-0">
        <PortfolioCard masked={false} onToggleMasked={() => {}} />
      </div>
      <div className="h-[460px] w-[380px]">
        <OpportunitiesPanel />
      </div>
    </div>
  ) : view === "card" ? (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-10">
      <div className="h-[460px] w-[380px]">
        <OpportunitiesPanel />
      </div>
    </div>
  ) : (
    <div className="min-h-screen bg-surface-0">
      <div className="p-6 font-sans text-[12px] text-content-secondary">dashboard stays mounted behind the panel</div>
      <RiskHost />
    </div>
  ),
);
