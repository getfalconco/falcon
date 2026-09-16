import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  type RiskComponentKey,
  type RiskHistoryItem,
  type RiskLatest,
  type RiskSnapshot,
  type RiskStatus,
} from "../../../shared/risk-types";
import { componentPayload, riskPanelRows, type RiskPanelRow } from "../../../shared/risk-panel-rows";

/**
 * Shift+R — the Risk Engine debug panel (spec §7). Header: score · band ·
 * computed_at · recompute. Body: five component rows (score bar, key value,
 * payload details), the driver sentence, the degraded list, the snapshot
 * history. Read-only view over the store; no styling ambitions.
 */

type Props = { onClose: () => void };

/** How often the open panel re-reads; the engine recomputes on its own triggers (§5). */
const POLL_MS = 60_000;

/**
 * Turns a bare channel error into the thing you actually have to do about it.
 *
 * Two ways `risk:latest` goes missing, and they need opposite fixes: with
 * FALCON_ENGINE_URL set the channel is answered by the always-on service, so an
 * unknown channel means that deployment is behind this build; without it the
 * channel is local, and electron-vite's dev server reloads the renderer but not
 * the main process, so handlers added since the session started were never
 * registered.
 */
function explain(error: string): string {
  if (/unknown channel/i.test(error)) {
    return "The engine service answered \"unknown channel\" — it is running a build older than this app. Redeploy apps/falcon-engine (or unset FALCON_ENGINE_URL to run the chain locally).";
  }
  if (/no handler registered/i.test(error)) {
    return "Risk is not registered in the running app — restart it (stop and re-run `pnpm dev:desktop`). electron-vite does not reload the main process, so handlers added since this session started are missing.";
  }
  return error;
}

const BAND_COLOR: Record<string, string> = {
  low: "#16A34A",
  moderate: "#CA8A04",
  elevated: "#EA580C",
  high: "#DC2626",
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/**
 * The one-line summary under a component's bar. Takes the snapshot rather than
 * the component map so a payload written before this component existed reads
 * as "not in this snapshot" instead of throwing.
 */
function keyValue(key: RiskComponentKey, snapshot: RiskSnapshot): string {
  switch (key) {
    case "concentration": {
      const c = componentPayload(snapshot, "concentration");
      return c ? `HHI ${c.hhi.toFixed(3)}` : MISSING;
    }
    case "market": {
      const c = componentPayload(snapshot, "market");
      return c ? `β_eff ${c.beta_eff.toFixed(2)} (β_port ${c.beta_port.toFixed(2)})` : MISSING;
    }
    case "volatility": {
      const c = componentPayload(snapshot, "volatility");
      return c ? `σ_p ${c.port_vol_daily_pct.toFixed(2)}%/day · SPY ${c.spy_vol_daily_pct.toFixed(2)}% · systematic ${pct(c.systematic_share)}` : MISSING;
    }
    case "network": {
      const c = componentPayload(snapshot, "network");
      if (!c) return MISSING;
      return `linked ${pct(c.linked_fraction, 1)} over ${c.pair_count} pair${c.pair_count === 1 ? "" : "s"}${c.excluded.length ? ` · excluded ${c.excluded.join(", ")}` : ""}`;
    }
    case "event": {
      const c = componentPayload(snapshot, "event");
      return c ? `raw ${c.raw.toFixed(2)}` : MISSING;
    }
    case "sharpe": {
      const c = componentPayload(snapshot, "sharpe");
      if (!c) return MISSING;
      return c.sharpe == null
        ? `no ratio — ${c.sessions} aligned session${c.sessions === 1 ? "" : "s"} (out of the blend)`
        : `Sharpe ${c.sharpe.toFixed(2)} over ${c.sessions} sessions · return ${c.ann_return_pct.toFixed(1)}%/yr · vol ${c.ann_vol_pct.toFixed(1)}%/yr · rf ${c.risk_free_pct}%`;
    }
  }
}

/** A snapshot written before this component existed carries no payload at all. */
const MISSING = "not in this snapshot — it predates the component";

function Details({ keyName, snapshot }: { keyName: RiskComponentKey; snapshot: RiskSnapshot }) {
  const row = "flex items-baseline gap-2 text-[11px] leading-snug text-[#4b5563]";
  switch (keyName) {
    case "concentration": {
      const c = componentPayload(snapshot, "concentration");
      if (!c) return null;
      return (
        <div className="mt-1 space-y-0.5">
          {c.top.map((t) => (
            <div key={t.ticker} className={row}>
              <span className="w-14 font-semibold text-[#1d1b1b]">{t.ticker}</span>
              <span className="tabular-nums">{pct(t.weight, 1)}</span>
            </div>
          ))}
        </div>
      );
    }
    case "network": {
      const c = componentPayload(snapshot, "network");
      if (!c) return null;
      return c.top_links.length === 0 ? (
        <div className="mt-1 text-[11px] text-[#9CA3AF]">No filing-backed links between held names.</div>
      ) : (
        <div className="mt-1 space-y-1">
          {c.top_links.map((l) => (
            <div key={`${l.a}-${l.b}-${l.edge_id}`} className="text-[11px] leading-snug text-[#4b5563]">
              <span className="font-semibold text-[#1d1b1b]">
                {l.a} ↔ {l.b}
              </span>{" "}
              <span>
                {l.via} · {l.category} · {l.tier} · l={l.link.toFixed(2)} · w={l.pair_weight.toFixed(3)}
                {l.counterparty_label ? ` · via ${l.counterparty_label}` : ""}
              </span>
              <div className="font-mono text-[10px] text-[#9CA3AF]">
                {l.edge_id}
                {l.edge_id_b ? ` + ${l.edge_id_b}` : ""}
              </div>
              {l.evidence_quote ? <div className="line-clamp-2 italic text-[#6b7280]">“{l.evidence_quote}”</div> : null}
            </div>
          ))}
        </div>
      );
    }
    case "event": {
      const c = componentPayload(snapshot, "event");
      if (!c) return null;
      return c.contributors.length === 0 ? (
        <div className="mt-1 text-[11px] text-[#9CA3AF]">No open incidents, active anomalies or scheduled events on held names.</div>
      ) : (
        <div className="mt-1 space-y-0.5">
          {c.contributors.map((e, i) => (
            <div key={`${e.ticker}-${e.kind}-${i}`} className={row}>
              <span className="w-14 font-semibold text-[#1d1b1b]">{e.ticker}</span>
              <span className="w-32">{e.kind.replace(/_/g, " ")}</span>
              <span className="w-24">{e.detail}</span>
              <span className="tabular-nums">
                +{e.contribution} → {e.weighted.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      );
    }
    case "sharpe": {
      const c = componentPayload(snapshot, "sharpe");
      if (!c || c.excluded.length === 0) return null;
      return (
        <div className="mt-1 text-[11px] text-[#9CA3AF]">
          No aligned history, left out and the rest renormalised: {c.excluded.join(", ")}
        </div>
      );
    }
    default:
      return null;
  }
}

function ComponentRow({ row, snapshot }: { row: RiskPanelRow; snapshot: RiskSnapshot }) {
  const keyName = row.key;
  const { score, weight, isDriver } = row;
  if (score == null) {
    // Shown either way, because a row that just vanishes reads as a zero.
    return (
      <div className="rounded-xl border border-dashed border-[#e0e0da] bg-white/40 px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="w-44 text-[12px] font-semibold text-[#9CA3AF]">{row.label}</span>
          <span className="flex-1 text-[11px] text-[#9CA3AF]">
            {row.state === "absent" ? "not in this snapshot" : "not measured — excluded from the blend"}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-[#6b7280]">{keyValue(keyName, snapshot)}</div>
      </div>
    );
  }
  return (
    <div className={`rounded-xl border px-3 py-2 ${isDriver ? "border-[#189E9A]/50 bg-[#189E9A]/5" : "border-[#e0e0da] bg-white/60"}`}>
      <div className="flex items-center gap-3">
        <span className="w-44 text-[12px] font-semibold text-[#1d1b1b]">
          {row.label}
          {isDriver ? <span className="ml-1 rounded-full bg-[#189E9A] px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em] text-white">DRIVER</span> : null}
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#e9e9e4]">
          <div className="h-full rounded-full bg-[#1d1b1b]" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
        </div>
        <span className="w-10 text-right text-[13px] font-semibold tabular-nums text-[#1d1b1b]">{score}</span>
        <span className="w-20 text-right text-[10px] tabular-nums text-[#9CA3AF]">
          ×{weight.toFixed(2)} = {(score * weight).toFixed(1)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[#6b7280]">{keyValue(keyName, snapshot)}</div>
      <Details keyName={keyName} snapshot={snapshot} />
    </div>
  );
}

export default function RiskPanel({ onClose }: Props) {
  const [latest, setLatest] = useState<RiskLatest | null>(null);
  const [status, setStatus] = useState<RiskStatus | null>(null);
  const [history, setHistory] = useState<RiskHistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getRiskLatest) {
      setError("risk bridge unavailable — restart the app (new IPC handlers need a main-process restart)");
      return;
    }
    const [l, s, h] = await Promise.all([bridge.getRiskLatest(), bridge.getRiskStatus(), bridge.getRiskHistory({ limit: 120 })]);
    if (l.ok) setLatest({ snapshot: l.snapshot, riskCardEnabled: l.riskCardEnabled });
    else setError(l.error);
    if (s.ok) setStatus(s.status);
    if (h.ok) setHistory(h.history);
  }, []);

  useEffect(() => {
    void refresh();
    // The service has no window to push to, so the panel polls as well as
    // listening for the local broadcast.
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    const unsubscribe = window.meridian?.onRiskSnapshot?.(() => void refresh()) ?? (() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(poll);
      unsubscribe();
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, onClose]);

  const recompute = async () => {
    const bridge = window.meridian;
    if (!bridge?.recomputeRisk) return;
    setBusy(true);
    try {
      const res = await bridge.recomputeRisk();
      if (!res.ok) setError(res.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleCard = async (enabled: boolean) => {
    const bridge = window.meridian;
    if (!bridge?.setRiskCardEnabled) return;
    await bridge.setRiskCardEnabled(enabled);
    await refresh();
  };

  const snapshot = latest?.snapshot ?? null;
  const band = snapshot?.band ?? null;

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-[#1d1b1b]/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#F4F4F0] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-[#e0e0da] px-5 py-3">
          <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">RISK ENGINE · Shift+R</span>
          {snapshot && !snapshot.empty ? (
            <>
              <span className="text-[28px] font-semibold leading-none tabular-nums text-[#1d1b1b]">{snapshot.score}</span>
              <span className="rounded-full px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white" style={{ background: BAND_COLOR[band ?? "low"] }}>
                {band}
              </span>
            </>
          ) : snapshot?.empty ? (
            <span className="text-[13px] text-[#6b7280]">No open positions.</span>
          ) : (
            <span className="text-[13px] text-[#6b7280]">No snapshot yet.</span>
          )}
          <span className="text-[11px] tabular-nums text-[#9CA3AF]">computed {fmtWhen(snapshot?.computed_at)}</span>
          {snapshot ? <span className="text-[10px] text-[#b4b4ae]">trigger: {snapshot.trigger.join(", ")}</span> : null}
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-[#6b7280]">
              <input type="checkbox" checked={latest?.riskCardEnabled ?? false} onChange={(e) => void toggleCard(e.target.checked)} />
              riskCardEnabled
            </label>
            <button
              type="button"
              onClick={() => void recompute()}
              disabled={busy}
              className="rounded-lg bg-[#1d1b1b] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {busy ? "recomputing…" : "recompute"}
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[#6b7280] hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-[11px] leading-snug text-red-700">{explain(error)}</div> : null}

        <div className="flex min-h-0 flex-1">
          {/* Body */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {snapshot && !snapshot.empty && snapshot.components ? (
              <>
                <div className="mb-3 rounded-xl border border-[#e0e0da] bg-white px-3 py-2">
                  <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">DRIVER · {snapshot.driver?.component}</div>
                  <div className="font-baskerville text-[15px] text-[#1d1b1b]">{snapshot.driver?.sentence}</div>
                </div>
                <div className="space-y-2">
                  {riskPanelRows(snapshot).map((row) => (
                    <ComponentRow key={row.key} row={row} snapshot={snapshot} />
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
                    <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">
                      POSITIONS · invested {pct(snapshot.invested_fraction)} · {snapshot.position_count}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {snapshot.weights.map((w) => (
                        <div key={w.ticker} className="flex items-baseline gap-2 text-[11px] text-[#4b5563]">
                          <span className="w-14 font-semibold text-[#1d1b1b]">{w.ticker}</span>
                          <span className="w-12 tabular-nums">{pct(w.weight, 1)}</span>
                          <span className="tabular-nums">${w.market_value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          {w.side === "short" ? <span className="text-[#DC2626]">short</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
                    <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">DEGRADED · {snapshot.degraded.length}</div>
                    {snapshot.degraded.length === 0 ? (
                      <div className="mt-1 text-[11px] text-[#9CA3AF]">No substitutions.</div>
                    ) : (
                      <div className="mt-1 space-y-0.5">
                        {snapshot.degraded.map((d, i) => (
                          <div key={`${d.ticker}-${d.field}-${i}`} className="flex items-baseline gap-2 text-[11px] text-[#4b5563]">
                            <span className="w-14 font-semibold text-[#1d1b1b]">{d.ticker}</span>
                            <span className="w-16">{d.field}</span>
                            <span className="tabular-nums">→ {String(d.substitute)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {snapshot.graph_version ? (
                      <div className="mt-2 text-[10px] text-[#b4b4ae]">
                        graph pv{snapshot.graph_version.pipelineVersion} · {fmtWhen(snapshot.graph_version.generatedAt)}
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-[12px] text-[#6b7280]">
                {snapshot?.empty ? "No open positions — the card renders its empty state." : "Waiting for the first snapshot (the host computes ~30s after start)."}
              </div>
            )}

            {status ? (
              <div className="mt-4 rounded-xl border border-[#e0e0da] bg-white/40 px-3 py-2 text-[10px] text-[#6b7280]">
                <div>
                  data {status.dataDir} · snapshots {status.snapshotCount} · poll {status.pollIntervalMs / 1000}s · debounce {status.debounceMs / 1000}s · retention{" "}
                  {status.historyRetentionDays}d · last poll {fmtWhen(status.lastPollAt)}
                </div>
                <div>
                  account {status.account.received ? `received ${fmtWhen(status.account.as_of)} · ${status.account.positions} positions · cash ${status.account.cash.toFixed(0)}` : "not received yet"}
                </div>
                {status.keys ? (
                  <div className="font-mono">
                    close {status.keys.close || "—"} · bands {status.keys.bands || "—"} · horizon {status.keys.horizon || "—"}
                  </div>
                ) : null}
                {status.lastError ? <div className="text-red-600">last error: {status.lastError}</div> : null}
              </div>
            ) : null}
          </div>

          {/* History */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-l border-[#e0e0da] px-3 py-3">
            <div className="mb-2 text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">HISTORY · {history.length}</div>
            <div className="space-y-1">
              {history.map((h) => (
                <div key={h.computed_at} className="rounded-lg bg-white/60 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] tabular-nums text-[#9CA3AF]">{fmtWhen(h.computed_at)}</span>
                    <span className="text-[12px] font-semibold tabular-nums text-[#1d1b1b]">{h.empty ? "—" : h.score}</span>
                    {h.band ? (
                      <span className="rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.08em] text-white" style={{ background: BAND_COLOR[h.band] }}>
                        {h.band}
                      </span>
                    ) : null}
                    <span className="ml-auto text-[9px] text-[#b4b4ae]">{h.trigger.join("+")}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-[#6b7280]">
                    {h.driver_component ? `${h.driver_component} · ${h.driver_sentence}` : h.empty ? "empty" : ""}
                  </div>
                </div>
              ))}
              {history.length === 0 ? <div className="text-[11px] text-[#9CA3AF]">No snapshots yet.</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
