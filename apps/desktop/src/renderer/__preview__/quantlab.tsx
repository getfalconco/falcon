import { createRoot } from "react-dom/client";
import "../globals.css";
import QuantLabPanel from "../components/quantlab/QuantLabPanel";
import fixture from "./quantlab-fixture.json";

/**
 * Scratch harness for the Shift+Q Quant Lab panel against RECORDED REAL DATA
 * (scripts/quantlab-replay.ts fixture) — 76 backfilled series, four stored
 * backtest reports and the live ledger.
 *
 *   quantlab.html                the Builder tab
 *   quantlab.html?tab=results    a completed backtest report
 *   quantlab.html?tab=live       the live signal ledger
 *   quantlab.html?select=<id>    pre-select a strategy
 *   quantlab.html?empty=1        a fresh install: no series, no strategies
 */
const params = new URLSearchParams(location.search);
const tab = params.get("tab") ?? "builder";
const select = params.get("select");
const empty = params.get("empty") === "1";

type Fixture = typeof fixture;
const data = fixture as Fixture;

const strategies = empty ? [] : data.strategies;
const reports = empty ? [] : data.reports;
const ledger = empty ? [] : data.ledger;
const status = empty
  ? { ...data.status, seriesCount: 0, seriesFrom: null, seriesTo: null, strategyCount: 0, reportCount: 0, ledgerCount: 0 }
  : data.status;

// The panel talks to main over `window.meridian`; stub exactly the calls it makes.
(window as unknown as { meridian: Record<string, unknown> }).meridian = {
  getQuantLabStatus: async () => ({ ok: true, status }),
  getQuantLabStrategies: async () => ({ ok: true, strategies }),
  getQuantLabReports: async () => ({ ok: true, reports }),
  getQuantLabLedger: async () => ({ ok: true, signals: ledger }),
  runQuantLabBacktest: async () => ({ ok: false, error: "preview harness — backtests run in the main process" }),
  setQuantLabLive: async () => ({ ok: true, strategies }),
  sweepQuantLabLedger: async () => ({ ok: true, recorded: 0, filled: 0 }),
  reloadQuantLab: async () => ({ ok: true, status }),
  onQuantLabBacktest: () => () => {},
};

createRoot(document.getElementById("root")!).render(<QuantLabPanel onClose={() => {}} />);

// Drive the panel into the requested state once it has mounted and loaded.
setTimeout(() => {
  const buttons = [...document.querySelectorAll("button")];
  if (select) {
    const row = buttons.find((b) => b.textContent?.includes(select));
    row?.click();
  }
  if (tab !== "builder") {
    const label = tab === "results" ? "Results" : "Live";
    buttons.find((b) => b.textContent?.trim() === label)?.click();
  }
}, 400);
