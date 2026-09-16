import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type {
  BacktestReport,
  LiveSignal,
  QuantLabStatus,
  StrategyRow,
} from "../../../shared/quantlab-types";
import ResultsTab from "./ResultsTab";
import BuilderTab from "./BuilderTab";
import LiveTab from "./LiveTab";

type Tab = "builder" | "results" | "live";

/**
 * Turns Electron's bare "unknown channel" into the thing you actually have to
 * do about it.
 *
 * `electron-vite dev` rebuilds the preload and reloads the renderer but does
 * NOT restart the main process, so a session started before these handlers
 * existed has a new preload calling handlers that were never registered. The
 * panel then looks empty rather than broken, which is the worst of both.
 */
function explain(error: string): string {
  if (/unknown channel/i.test(error)) {
    return "Quant Lab is not registered in the running app — restart it (stop and re-run `pnpm dev:desktop`). electron-vite does not reload the main process, so handlers added since this session started are missing.";
  }
  return error;
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "builder", label: "Builder" },
  { key: "results", label: "Results" },
  { key: "live", label: "Live" },
];

/**
 * Quant Lab (§10) — builder, results, live ledger.
 *
 * Developer-grade styling and no product surfacing: nothing here writes to the
 * dashboard, and nothing on the dashboard links here.
 */
export default function QuantLabPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("builder");
  const [status, setStatus] = useState<QuantLabStatus | null>(null);
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [reports, setReports] = useState<BacktestReport[]>([]);
  const [ledger, setLedger] = useState<LiveSignal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getQuantLabStrategies) {
      setError("quant lab bridge unavailable — restart the app (new IPC handlers need a main-process restart)");
      return;
    }
    const [s, st, r, l] = await Promise.all([
      bridge.getQuantLabStrategies(),
      bridge.getQuantLabStatus(),
      bridge.getQuantLabReports(),
      bridge.getQuantLabLedger(),
    ]);
    if (s.ok) {
      setStrategies(s.strategies);
      setSelectedId((prev) => prev ?? s.strategies[0]?.strategy.strategy_id ?? null);
      setError(null);
    } else setError(explain(s.error));
    if (st.ok) setStatus(st.status);
    if (r.ok) setReports(r.reports);
    if (l.ok) setLedger(l.signals);
  }, []);

  useEffect(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh, onClose]);

  const selected = useMemo(
    () => strategies.find((s) => s.strategy.strategy_id === selectedId) ?? null,
    [strategies, selectedId],
  );
  const selectedReports = useMemo(
    () => reports.filter((r) => r.strategy_id === selectedId).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [reports, selectedId],
  );

  const runBacktest = useCallback(
    async (strategyId: string) => {
      setBusy(strategyId);
      setError(null);
      try {
        const result = await window.meridian?.runQuantLabBacktest({ strategyId });
        if (result && !result.ok) setError(explain(result.error));
        else {
          setTab("results");
          await refresh();
        }
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const toggleLive = useCallback(
    async (row: StrategyRow) => {
      const result = await window.meridian?.setQuantLabLive({
        strategyId: row.strategy.strategy_id,
        version: row.strategy.version,
        enabled: !row.strategy.live_enabled,
      });
      if (result && !result.ok) setError(explain(result.error));
      else await refresh();
    },
    [refresh],
  );

  const sweep = useCallback(async () => {
    setBusy("sweep");
    try {
      const result = await window.meridian?.sweepQuantLabLedger();
      if (result && !result.ok) setError(explain(result.error));
      else await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-[#1d1b1b]/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1240px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#F4F4F0] shadow-2xl">
        <div className="flex items-center gap-4 border-b border-[#e0e0da] px-5 py-3">
          <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
            QUANT LAB · Shift+Q
          </span>
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
                  tab === t.key ? "bg-[#1d1b1b] text-white" : "text-[#6b7280] hover:bg-[#e8e8e2]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[#9CA3AF] tabular-nums">
            {status
              ? `${status.seriesCount} series · ${status.seriesFrom ?? "—"} → ${status.seriesTo ?? "—"} · ${status.strategyCount} strategies · ${status.reportCount} runs`
              : "loading…"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              className="rounded-md px-2 py-1 text-[11px] text-[#6b7280] hover:bg-[#e8e8e2]"
            >
              Refresh
            </button>
            <button onClick={onClose} className="rounded-md p-1 text-[#6b7280] hover:bg-[#e8e8e2]">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-[#e0e0da] bg-[#fdf3f3] px-5 py-2 text-[12px] text-[#b23b3b]">{error}</div>
        )}

        <div className="flex min-h-0 flex-1">
          {tab === "builder" && (
            <BuilderTab
              strategies={strategies}
              selected={selected}
              onSelect={setSelectedId}
              onRunBacktest={runBacktest}
              busy={busy}
            />
          )}
          {tab === "results" && <ResultsTab reports={selectedReports} strategies={strategies} onSelect={setSelectedId} selectedId={selectedId} />}
          {tab === "live" && (
            <LiveTab
              strategies={strategies}
              ledger={ledger}
              onToggleLive={toggleLive}
              onSweep={sweep}
              busy={busy}
            />
          )}
        </div>

        <div className="border-t border-[#e0e0da] px-5 py-2 text-[10px] text-[#9CA3AF]">
          Shift+Q to toggle · Esc to close · developer surface, nothing here reaches the dashboard · returns are gross
          (no costs, no slippage) · no orders, no sizing
        </div>
      </div>
    </div>
  );
}
