import { withClock } from "@/lib/clock";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { plural } from "@/lib/panels-format";
import { shortcutText, type ShortcutId } from "@/lib/shortcuts";
import { useIsStaff } from "@/lib/staff";
import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { GaugeContext, GaugeDecisionState, GaugeDirection, GaugePricingStatus, GaugeStatusInfo } from "../../../shared/gauge-types";
import { useGaugeReadout } from "../../hooks/useGaugeReadout";
import GaugeChecklist from "./GaugeChecklist";
import GaugeSetupBlock, { GAUGE_STATE_LABEL_KEY, StateBadge } from "./GaugeSetupBlock";

/**
 * Shift+F — the Gauge panel (v2 §5). The hero is the recognized setup, its
 * reading and the decision state; underneath it the action line when something
 * is missing; the eight v1 checks fold away as evidence, closed by default,
 * with their raw values intact for debugging. Ticker picker and manual context
 * entry unchanged. Read-only over the host.
 */

type Props = { onClose: () => void; initialTicker?: string };

function fmtWhen(iso: string | null | undefined, locale: string, na: string): string {
  if (!iso) return na;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, withClock({ month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
}

/** The footer's list of instrument panels, each with its own shortcut. */
const PANEL_LINKS: ReadonlyArray<{ id: ShortcutId; key: MessageKey }> = [
  { id: "gauge", key: "panels.gauge.panel.gauge" },
  { id: "tracker", key: "panels.gauge.panel.tracker" },
  { id: "base", key: "panels.gauge.panel.base" },
  { id: "analyst", key: "panels.gauge.panel.analyst" },
  { id: "propagation", key: "panels.gauge.panel.propagation" },
  { id: "risk", key: "panels.gauge.panel.risk" },
  { id: "screen", key: "panels.gauge.panel.screen" },
  { id: "graph", key: "panels.gauge.panel.graph" },
];

const inputCls = "rounded-md border border-edge bg-white px-2 py-1 text-[11px] text-content-primary outline-none focus:border-tone-teal";

export default function GaugePanel({ onClose, initialTicker }: Props) {
  const { t, locale } = useI18n();
  // Reloading the config changes the Gauge for every account on the engine:
  // staff only there, so the button is off for members.
  const staff = useIsStaff();
  const na = t("common.na");
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
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-ink/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-surface-1 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-edge px-5 py-3">
          <span className="shrink-0 font-sans text-[11px] font-medium tracking-[0.04em] text-content-tertiary">{t("panels.gauge.header", { shortcut: shortcutText("gauge") })}</span>
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
            <input className={`${inputCls} w-20`} placeholder={t("panels.gauge.anyTicker")} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </form>
          <div className="ml-2 flex shrink-0 overflow-hidden rounded-md border border-edge text-[11px]">
            {(["standalone", "context"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 ${mode === m ? "bg-ink text-white" : "bg-white text-content-secondary"}`}>
                {t(m === "standalone" ? "panels.gauge.mode.standalone" : "panels.gauge.mode.context")}
              </button>
            ))}
          </div>
          {r && r.tracked && (
            <>
              <StateBadge state={r.state} />
              <span className="min-w-0 truncate text-[13px] text-content-primary">
                <span className="font-medium">{r.setup.name}</span>
                <span className="text-content-secondary"> · {r.setup.read}</span>
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] tabular-nums text-content-disabled">
              {r
                ? `${t("panels.gauge.computed", { when: fmtWhen(r.computed_at, locale, na) })}${state.memoHit ? ` · ${t("panels.gauge.memo")}` : ""}`
                : state.loading
                  ? t("panels.gauge.computing")
                  : ""}
            </span>
            <button type="button" onClick={() => void state.refresh(true)} disabled={state.loading} className="rounded-lg bg-ink px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50">
              {state.loading ? t("panels.gauge.computing") : t("panels.gauge.recompute")}
            </button>
            <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-lg p-1.5 text-content-secondary hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Context entry */}
        {mode === "context" && (
          <div className="flex flex-wrap items-center gap-3 border-b border-edge bg-white/60 px-5 py-2 text-[11px] text-content-body">
            <span className="text-[10px] uppercase tracking-[0.1em] text-content-tertiary">{t("panels.gauge.manualContext")}</span>
            <label className="flex items-center gap-1">
              {t("panels.gauge.expected")}
              <select className={inputCls} value={direction} onChange={(e) => setDirection(e.target.value as GaugeDirection | "unresolved")}>
                <option value="up">{t("panels.gauge.direction.up")}</option>
                <option value="down">{t("panels.gauge.direction.down")}</option>
                <option value="unresolved">{t("panels.gauge.direction.unresolved")}</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              {t("panels.gauge.event")}
              <input type="datetime-local" className={inputCls} value={eventTs} onChange={(e) => setEventTs(e.target.value)} />
            </label>
            <label className="flex items-center gap-1">
              {t("panels.gauge.pricing")}
              <select className={inputCls} value={pricing} onChange={(e) => setPricing(e.target.value as GaugePricingStatus | "")}>
                <option value="">{na}</option>
                {(["open", "partial", "priced", "stale", "unknown"] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`panels.gauge.pricing.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              {t("panels.gauge.sessionsSince")}
              <input className={`${inputCls} w-14`} placeholder={t("panels.gauge.auto")} value={sessions} onChange={(e) => setSessions(e.target.value)} />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={thesisIsEvent} onChange={(e) => setThesisIsEvent(e.target.checked)} />
              {t("panels.gauge.thesisIsEvent")}
            </label>
          </div>
        )}

        {state.error ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-[11px] text-red-700">{state.error}</div> : null}

        <div className="flex min-h-0 flex-1">
          {/* Body */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {r ? (
              <div className="rounded-xl border border-edge bg-white px-4 py-3">
                <GaugeSetupBlock readout={r} />
                <GaugeChecklist readout={r} collapsible showValues />
                {r.summary.calibrating && (
                  <div className="mt-2 rounded-md border border-tone-warning-line bg-tone-warning-soft px-2 py-1 text-[10.5px] text-tone-warning">{t("panels.gauge.calibrating")}</div>
                )}
                {state.errors.length > 0 && <p className="mt-3 text-[10.5px] text-content-tertiary">{t("panels.gauge.gather", { errors: state.errors.join(" · ") })}</p>}
              </div>
            ) : (
              <p className="text-[12px] text-content-tertiary">{state.loading ? t("panels.gauge.computing") : t("panels.gauge.noReadoutPanel")}</p>
            )}
            {r?.context && (
              <div className="mt-3 rounded-xl border border-edge bg-white/60 px-3 py-2 font-mono text-[10px] leading-relaxed text-content-secondary">
                {t("panels.gauge.context", { json: JSON.stringify(r.context) })}
              </div>
            )}
          </div>

          {/* Status rail */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-l border-edge bg-white/50 px-4 py-4 text-[11px] text-content-body">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.1em] text-content-tertiary">{t("panels.gauge.host")}</span>
              <button
                type="button"
                onClick={() => void reloadConfig()}
                disabled={!staff}
                title={staff ? undefined : t("access.staffOnly.action")}
                className="rounded-md border border-edge bg-white px-2 py-0.5 text-[10px] text-content-secondary hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50"
              >
                {t("panels.gauge.reloadConfig")}
              </button>
            </div>
            {status ? (
              <>
                <div className="space-y-0.5">
                  <div>{t("panels.gauge.trackedTickers", { n: status.trackedTickers })}</div>
                  <div>{t("panels.gauge.r2Floor", { value: Number.isFinite(status.r2Floor) ? status.r2Floor : na })}</div>
                  <div>{t("panels.gauge.memoStats", { ms: status.memoTtlMs, size: status.memoSize })}</div>
                  <div>{t("panels.gauge.calibratingAt", { n: status.calibratingNaCount })}</div>
                  <div className="truncate" title={status.configFile}>
                    {t("panels.gauge.configFile", { file: status.configFile })}
                  </div>
                  {status.lastError && <div className="text-red-600">{t("panels.gauge.error", { message: status.lastError })}</div>}
                </div>
                <div className="mt-3 text-[10px] uppercase tracking-[0.1em] text-content-tertiary">{t("panels.gauge.setups")}</div>
                <div className="mt-1 space-y-0.5">
                  <div>
                    {status.screenAvailable
                      ? plural(t, locale, "panels.gauge.screenAvailable", status.screenFindings)
                      : t("panels.gauge.screenUnavailable")}
                  </div>
                  <div>
                    {!status.snapshots.enabled
                      ? t("panels.gauge.ledgerOff")
                      : status.snapshots.lastSession
                        ? t("panels.gauge.ledgerLast", { n: status.snapshots.count, session: status.snapshots.lastSession })
                        : t("panels.gauge.ledger", { n: status.snapshots.count })}
                  </div>
                  <div className="font-mono text-[10px] leading-relaxed text-content-secondary">{status.setupOrder.join(" → ")}</div>
                </div>
                <div className="mt-3 text-[10px] uppercase tracking-[0.1em] text-content-tertiary">{t("panels.gauge.thresholds")}</div>
                <div className="mt-1 space-y-0.5 font-mono text-[10px]">
                  {Object.entries(status.thresholds).map(([group, vals]) => (
                    <div key={group}>
                      <span className="text-content-primary">{group}</span>{" "}
                      {Object.entries(vals)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" ")}
                    </div>
                  ))}
                </div>
                <div className="mt-3 text-[10px] uppercase tracking-[0.1em] text-content-tertiary">{t("panels.gauge.today", { day: status.counters.day })}</div>
                <div className="mt-1 space-y-0.5">
                  <div>{t("panels.gauge.readouts", { n: status.counters.total, hits: status.counters.memo_hits })}</div>
                  <div>{t("panels.gauge.bySurface", { list: Object.entries(status.counters.by_surface).map(([k, v]) => `${k} ${v}`).join(" · ") || na })}</div>
                  <div>{t("panels.gauge.byState", {
                      list:
                        Object.entries(status.counters.by_state)
                          .map(([k, v]) => `${k in GAUGE_STATE_LABEL_KEY ? t(GAUGE_STATE_LABEL_KEY[k as GaugeDecisionState]) : k} ${v}`)
                          .join(" · ") || na,
                    })}</div>
                </div>
              </>
            ) : (
              <div className="text-content-tertiary">{t("panels.gauge.statusUnavailable")}</div>
            )}
            <p className="mt-4 text-[10px] leading-relaxed text-content-disabled">
              {t("panels.gauge.about")}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-edge px-5 py-2 text-[10px] text-content-disabled">
          <span>{t("panels.gauge.footerKeys", { shortcut: shortcutText("gauge") })}</span>
          <span>
            {t("panels.gauge.footerPanels")} {PANEL_LINKS.map((p) => `${shortcutText(p.id)} ${t(p.key)}`).join(" · ")}
          </span>
        </div>
      </div>
    </div>
  );
}
