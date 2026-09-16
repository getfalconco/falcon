import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { GaugeContext, GaugeDirection, GaugePricingStatus, GaugeStatusInfo } from "../../../shared/gauge-types";
import { useGaugeReadout } from "../../hooks/useGaugeReadout";
import GaugeChecklist from "./GaugeChecklist";
import GaugeSetupBlock, { StateBadge } from "./GaugeSetupBlock";

/**
 * Shift+F — the Gauge panel (v2 §5). The hero is the recognized setup, its
 * reading and the decision state; underneath it the action line when something
 * is missing; the eight v1 checks fold away as evidence, closed by default,
 * with their raw values intact for debugging. Ticker picker and manual context
 * entry unchanged. Read-only over the host.
 */

type Props = { onClose: () => void; initialTicker?: string };

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const inputCls = "rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b] outline-none focus:border-[#189E9A]";

export default function GaugePanel({ onClose, initialTicker }: Props) {
  const [tickers, setTickers] = useState<string[]>([]);
  const [ticker, setTicker] = useState<string>(initialTicker ?? "NVDA");
  const [typed, setTyped] = useState<string>("");
  const [mode, setMode] = useState<"standalone" | "context">("standalone");
  const [direction, setDirection] = useState<GaugeDirection | "unresolved">("up");
  const [eventTs, setEventTs] = useState<string>(() => new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 16));
  const [pricing, setPricing] = useState<GaugePricingStatus | "">("open");
  const [sessions, setSessions] = useState<string>("");
  const [thesisIsEvent, setThesisIsEvent] = useState(false);
  const [status, setStatus] = useState<GaugeStatusInfo | null>(null);

  const context = useMemo<GaugeContext | null>(() => {
    if (mode !== "context") return null;
    const ts = eventTs ? new Date(eventTs) : null;
    return {
      expected_direction: direction === "unresolved" ? null : direction,
      event_ts: ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : "",
      source: "manual",
      pricing_status: pricing || null,
      sessions_since_event: sessions.trim() === "" ? null : Number(sessions),
      thesis_is_scheduled_event: thesisIsEvent,
    };
  }, [mode, direction, eventTs, pricing, sessions, thesisIsEvent]);

  const state = useGaugeReadout(ticker, context, "panel", 60_000);

  const loadStatus = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getGaugeStatus) return;
    const res = await bridge.getGaugeStatus();
    if (res.ok) setStatus(res.status);
  }, []);

  useEffect(() => {
    const bridge = window.meridian;
    void (async () => {
      if (bridge?.getGaugeTickers) {
        const res = await bridge.getGaugeTickers();
        if (res.ok) {
          setTickers(res.tickers);
          if (res.tickers.length && !initialTicker && !res.tickers.includes(ticker)) setTicker(res.tickers[0]);
        }
      }
      await loadStatus();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [state.readout, loadStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reloadConfig = async () => {
    const bridge = window.meridian;
    if (!bridge?.reloadGaugeConfig) return;
    const res = await bridge.reloadGaugeConfig();
    if (res.ok) setStatus(res.status);
    await state.refresh(true);
  };

  const r = state.readout;

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-[#1d1b1b]/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#F4F4F0] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#e0e0da] px-5 py-3">
          <span className="shrink-0 font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">GAUGE · Shift+F</span>
          <select className={inputCls} value={tickers.includes(ticker) ? ticker : ""} onChange={(e) => e.target.value && setTicker(e.target.value)}>
            {!tickers.includes(ticker) && <option value="">{ticker}</option>}
            {tickers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const t = typed.trim().toUpperCase();
              if (t) setTicker(t);
              setTyped("");
            }}
          >
            <input className={`${inputCls} w-20`} placeholder="any ticker" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </form>
          <div className="ml-2 flex shrink-0 overflow-hidden rounded-md border border-[#e0e0da] text-[11px]">
            {(["standalone", "context"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 ${mode === m ? "bg-[#1d1b1b] text-white" : "bg-white text-[#6b7280]"}`}>
                {m}
              </button>
            ))}
          </div>
          {r && r.tracked && (
            <>
              <StateBadge state={r.state} />
              <span className="min-w-0 truncate text-[13px] text-[#1d1b1b]">
                <span className="font-medium">{r.setup.name}</span>
                <span className="text-[#6b7280]"> — {r.setup.read}</span>
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] tabular-nums text-[#b4b4ae]">
              {r ? `computed ${fmtWhen(r.computed_at)}${state.memoHit ? " · memo" : ""}` : state.loading ? "computing…" : ""}
            </span>
            <button type="button" onClick={() => void state.refresh(true)} disabled={state.loading} className="rounded-lg bg-[#1d1b1b] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50">
              {state.loading ? "computing…" : "recompute"}
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[#6b7280] hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Context entry */}
        {mode === "context" && (
          <div className="flex flex-wrap items-center gap-3 border-b border-[#e0e0da] bg-white/60 px-5 py-2 text-[11px] text-[#4b5563]">
            <span className="text-[10px] uppercase tracking-[0.1em] text-[#9CA3AF]">manual context</span>
            <label className="flex items-center gap-1">
              expected
              <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value as GaugeDirection | "unresolved")}>
                <option value="up">up</option>
                <option value="down">down</option>
                <option value="unresolved">unresolved</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              event
              <input type="datetime-local" className={inputCls} value={eventTs} onChange={(e) => setEventTs(e.target.value)} />
            </label>
            <label className="flex items-center gap-1">
              pricing
              <select className={inputCls} value={pricing} onChange={(e) => setPricing(e.target.value as GaugePricingStatus | "")}>
                <option value="">—</option>
                {(["open", "partial", "priced", "stale", "unknown"] as const).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              sessions since
              <input className={`${inputCls} w-14`} placeholder="auto" value={sessions} onChange={(e) => setSessions(e.target.value)} />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={thesisIsEvent} onChange={(e) => setThesisIsEvent(e.target.checked)} />
              thesis is the scheduled event
            </label>
          </div>
        )}

        {state.error ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-[11px] text-red-700">{state.error}</div> : null}

        <div className="flex min-h-0 flex-1">
          {/* Body */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {r ? (
              <div className="rounded-xl border border-[#e0e0da] bg-white px-4 py-3">
                <GaugeSetupBlock readout={r} />
                <GaugeChecklist readout={r} collapsible showValues />
                {r.summary.calibrating && (
                  <div className="mt-2 rounded-md border border-[#e7d9a8] bg-[#fbf6e3] px-2 py-1 text-[10.5px] text-[#8a6d1d]">calibrating — limited history</div>
                )}
                {state.errors.length > 0 && <p className="mt-3 text-[10.5px] text-[#9CA3AF]">gather: {state.errors.join(" · ")}</p>}
              </div>
            ) : (
              <p className="text-[12px] text-[#9CA3AF]">{state.loading ? "computing…" : "No readout."}</p>
            )}
            {r?.context && (
              <div className="mt-3 rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2 font-mono text-[10px] leading-relaxed text-[#6b7280]">
                context {JSON.stringify(r.context)}
              </div>
            )}
          </div>

          {/* Status rail */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-l border-[#e0e0da] bg-white/50 px-4 py-4 text-[11px] text-[#4b5563]">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.1em] text-[#9CA3AF]">host</span>
              <button type="button" onClick={() => void reloadConfig()} className="rounded-md border border-[#e0e0da] bg-white px-2 py-0.5 text-[10px] text-[#6b7280] hover:bg-[#fafaf7]">
                reload config
              </button>
            </div>
            {status ? (
              <>
                <div className="space-y-0.5">
                  <div>tracked tickers {status.trackedTickers}</div>
                  <div>r² floor (Tracker) {Number.isFinite(status.r2Floor) ? status.r2Floor : "—"}</div>
                  <div>memo ttl {status.memoTtlMs} ms · size {status.memoSize}</div>
                  <div>calibrating at ≥ {status.calibratingNaCount} n/a</div>
                  <div className="truncate" title={status.configFile}>
                    config {status.configFile}
                  </div>
                  {status.lastError && <div className="text-red-600">error {status.lastError}</div>}
                </div>
                <div className="mt-3 text-[10px] uppercase tracking-[0.1em] text-[#9CA3AF]">setups</div>
                <div className="mt-1 space-y-0.5">
                  <div>screen {status.screenAvailable ? `available · ${status.screenFindings} finding${status.screenFindings === 1 ? "" : "s"} on this ticker` : "unavailable — instantaneous rows only"}</div>
                  <div>ledger {status.snapshots.enabled ? `${status.snapshots.count} lines${status.snapshots.lastSession ? ` · last ${status.snapshots.lastSession}` : ""}` : "off"}</div>
                  <div className="font-mono text-[10px] leading-relaxed text-[#6b7280]">{status.setupOrder.join(" → ")}</div>
                </div>
                <div className="mt-3 text-[10px] uppercase tracking-[0.1em] text-[#9CA3AF]">thresholds</div>
                <div className="mt-1 space-y-0.5 font-mono text-[10px]">
                  {Object.entries(status.thresholds).map(([group, vals]) => (
                    <div key={group}>
                      <span className="text-[#1d1b1b]">{group}</span>{" "}
                      {Object.entries(vals)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" ")}
                    </div>
                  ))}
                </div>
                <div className="mt-3 text-[10px] uppercase tracking-[0.1em] text-[#9CA3AF]">today ({status.counters.day})</div>
                <div className="mt-1 space-y-0.5">
                  <div>readouts {status.counters.total} · memo hits {status.counters.memo_hits}</div>
                  <div>by surface {Object.entries(status.counters.by_surface).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</div>
                  <div>by state {Object.entries(status.counters.by_state).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</div>
                </div>
              </>
            ) : (
              <div className="text-[#9CA3AF]">status unavailable</div>
            )}
            <p className="mt-4 text-[10px] leading-relaxed text-[#b4b4ae]">
              Deterministic, read-only, no LLM. Every row reads Tracker / Base / Propagation state already on disk. Condition language only — no advice vocabulary (enforced by test).
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[#e0e0da] px-5 py-2 text-[10px] text-[#b4b4ae]">
          <span>Shift+F to toggle · Esc to close · thresholds and templates live in data/gauge/config.json</span>
          <span>panels: Shift+F gauge · Shift+T tracker · Shift+B base · Shift+A analyst · Shift+P propagation · Shift+R risk · Shift+S screen · Shift+G graph</span>
        </div>
      </div>
    </div>
  );
}
