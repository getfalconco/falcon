import { na } from "@/lib/i18n/na";
import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { shortcutText } from "@/lib/shortcuts";
import { useT, type MessageKey, type TFunction } from "@/lib/i18n";
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
function explain(error: string, t: TFunction): string {
  if (error === BRIDGE_MISSING) return t("instruments.common.bridgeUnavailable", { name: "Quant Lab" });
  if (/unknown channel/i.test(error)) return t("instruments.quantlab.notRegistered");
  return error;
}

/** Error value for "the preload has no Quant Lab bridge"; explained in the reader's language. */
const BRIDGE_MISSING = "\u0000bridge-missing";

const TABS: Array<{ key: Tab; label: MessageKey }> = [
  { key: "builder", label: "instruments.quantlab.tab.builder" },
  { key: "results", label: "instruments.quantlab.tab.results" },
  { key: "live", label: "instruments.quantlab.tab.live" },
];

/**
 * Quant Lab (§10) — builder, results, live ledger.
 *
 * Developer-grade styling and no product surfacing: nothing here writes to the
 * dashboard, and nothing on the dashboard links here.
 */
export default function QuantLabPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
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
      setError(BRIDGE_MISSING);
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
    } else setError(s.error);
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
        if (result && !result.ok) setError(result.error);
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
      if (result && !result.ok) setError(result.error);
      else await refresh();
    },
    [refresh],
  );

  const sweep = useCallback(async () => {
    setBusy("sweep");
    try {
      const result = await window.meridian?.sweepQuantLabLedger();
      if (result && !result.ok) setError(result.error);
      else await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-ink/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1240px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-surface-1 shadow-2xl">
        <div className="flex items-center gap-4 border-b border-edge px-5 py-3">
          <span className="shrink-0 font-sans text-[11px] font-medium tracking-[0.04em] text-content-tertiary">
            {t("instruments.quantlab.title", { key: shortcutText("quantlab") })}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {TABS.map((tabDef) => (
              <button
                key={tabDef.key}
                data-tab={tabDef.key}
                onClick={() => setTab(tabDef.key)}
                className={`whitespace-nowrap rounded-md px-3 py-1 text-[12px] transition-colors ${
                  tab === tabDef.key ? "bg-ink text-white" : "text-content-secondary hover:bg-surface-3"
                }`}
              >
                {t(tabDef.label)}
              </button>
            ))}
          </div>
          <span className="min-w-0 truncate text-[11px] text-content-tertiary tabular-nums">
            {status
              ? t("instruments.quantlab.status", {
                  series: status.seriesCount,
                  from: status.seriesFrom ?? na(),
                  to: status.seriesTo ?? na(),
                  strategies: status.strategyCount,
                  runs: status.reportCount,
                })
              : t("instruments.common.loading")}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              onClick={() => void refresh()}
              className="rounded-md px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-3"
            >
              {t("instruments.quantlab.refresh")}
            </button>
            <button
              onClick={onClose}
              aria-label={t("common.close")}
              title={t("common.close")}
              className="rounded-md p-1 text-content-secondary hover:bg-surface-3"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-edge bg-surface-2 px-5 py-2 text-[12px] text-tone-negative">{explain(error, t)}</div>
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

        <div className="border-t border-edge px-5 py-2 text-[10px] text-content-tertiary">
          {t("instruments.quantlab.footer", { key: shortcutText("quantlab") })}
        </div>
      </div>
    </div>
  );
}
