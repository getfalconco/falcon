import { createRoot } from "react-dom/client";
import "../globals.css";
import ScreenPanel from "../components/screen/ScreenPanel";
import fixture from "./screen-fixture.json";
import gaugeFixture from "./screen-gauge-fixture.json";

/**
 * Scratch harness for the Shift+S Screen panel against a recorded real-data
 * findings store (scripts/screen-replay.ts history --write) and a recorded
 * Gauge standalone readout (scripts/gauge-replay.ts readout QCOM --json).
 *   screen.html            the panel on the fixture store
 *   screen.html?empty=1    no scan yet
 *   screen.html?select=QCOM&gauge=1   pre-select the first QCOM row and open the Gauge link (headless screenshots)
 *   screen.html?rescan=1&nochange=1   press rescan (nochange: zero-transition scan → the "no change" line)
 */
const params = new URLSearchParams(location.search);
const empty = params.get("empty") === "1";
const select = params.get("select");
const autoGauge = params.get("gauge") === "1";
const showEnded = params.get("ended") === "1";
const autoRescan = params.get("rescan") === "1";
const noChange = params.get("nochange") === "1";

type Finding = { ended_at: string | null; day_count: number; pattern: string; ticker: string };
const state = fixture as unknown as { findings: Finding[]; scans: unknown[] };
const priority: Record<string, number> = { quiet_accumulation: 1, independent_tape: 2, insider_divergence: 3, compression: 4 };
const labels = { quiet_accumulation: "Quiet accumulation", compression: "Compression", independent_tape: "Independent tape", insider_divergence: "Insider divergence" };
const active = state.findings.filter((f) => f.ended_at == null).sort((a, b) => b.day_count - a.day_count || priority[a.pattern] - priority[b.pattern] || a.ticker.localeCompare(b.ticker));
const ended = state.findings.filter((f) => f.ended_at != null).sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
const lastScan = state.scans.length ? state.scans[state.scans.length - 1] : null;
const payload = empty ? { active: [], ended: [], last_scan: null, labels, priority } : { active, ended, last_scan: lastScan, labels, priority };

const gaugeOpens: unknown[] = [];
window.addEventListener("falcon:gauge-open", (e) => {
  gaugeOpens.push((e as CustomEvent).detail);
  (window as any).__gaugeOpens = gaugeOpens;
});

(window as any).meridian = {
  getScreenFindings: async () => ({ ok: true, ...payload }),
  getScreenStatus: async () => ({
    ok: true,
    status: {
      dataDir: "apps/desktop/data/screen",
      configFile: "apps/desktop/data/screen/config.json",
      findingsFile: "apps/desktop/data/screen/findings.json",
      patterns: { quiet_accumulation: { enabled: true, priority: 1 }, compression: { enabled: true, priority: 4 }, independent_tape: { enabled: true, priority: 2 }, insider_divergence: { enabled: true, priority: 3 } },
      retentionDays: 180,
      pollIntervalMs: 60000,
      scanCount: state.scans.length,
      lastScan,
      lastPollAt: (lastScan as any)?.scanned_at ?? null,
      lastError: null,
      keys: { session: (lastScan as any)?.session ?? "2026-08-21", landed: 42, total: 42 },
      r2Floor: 0.15,
    },
  }),
  rescanScreen: async () => ({ ok: true, scan: noChange ? { ...(lastScan as any), new: 0, continuing: 0, ended: 0, scanned_at: new Date().toISOString() } : lastScan, ...payload }),
  onScreenScan: () => () => {},
  getGaugeReadout: async (req: { ticker: string }) => ({ ok: true, readout: { ...(gaugeFixture as any).readout, ticker: req.ticker }, errors: [], memo_hit: false }),
};

if (autoRescan) {
  setTimeout(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "rescan")?.click(), 400);
}

if (showEnded) {
  setTimeout(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("ENDED"))?.click(), 300);
}

if (select) {
  let tries = 0;
  const tick = () => {
    tries++;
    const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith(select));
    if (row) {
      row.click();
      if (autoGauge) setTimeout(() => (document.querySelector("[data-testid=open-in-gauge]") as HTMLButtonElement | null)?.click(), 50);
      return;
    }
    if (tries < 100) setTimeout(tick, 50);
  };
  setTimeout(tick, 100);
}

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-[#EAEAE6]">
    <ScreenPanel onClose={() => {}} />
  </div>,
);
