import { withClock } from "@/lib/clock";
import { useI18n, type MessageKey, type TFunction } from "@/lib/i18n";
import { plural } from "@/lib/panels-format";
import { shortcutText } from "@/lib/shortcuts";
import { useIsStaff } from "@/lib/staff";
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
import { accountWeight, formatWeightPct } from "../../../shared/portfolio-weights";
import { categoryLabel } from "../../lib/graph-colors";
import { strengthWord } from "../propagation/ripple-format";

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
function explain(error: string, t: TFunction): string {
  if (/unknown channel/i.test(error)) return t("panels.risk.error.unknownChannel");
  if (/no handler registered/i.test(error)) return t("panels.risk.error.noHandler", { command: "`pnpm dev:desktop`" });
  return error;
}

/** Sentinel for the bridge-missing error, worded at render in the reader's language. */
const BRIDGE_MISSING = "\u0000risk-bridge";

const COMPONENT_KEY: Record<RiskComponentKey, MessageKey> = {
  concentration: "panels.risk.component.concentration",
  market: "panels.risk.component.market",
  volatility: "panels.risk.component.volatility",
  network: "panels.risk.component.network",
  event: "panels.risk.component.event",
  sharpe: "panels.risk.component.sharpe",
};

/** A component's name in the reader's language; one this build does not know reads as stored. */
function componentLabel(key: string | null | undefined, t: TFunction): string {
  if (!key) return "";
  return key in COMPONENT_KEY ? t(COMPONENT_KEY[key as RiskComponentKey]) : key;
}

const BANDS = ["low", "moderate", "elevated", "high"] as const;
function bandWord(band: string, t: TFunction): string {
  return (BANDS as readonly string[]).includes(band) ? t(`panels.risk.band.${band as (typeof BANDS)[number]}`) : band;
}

const TRIGGERS = ["startup", "manual", "position_change", "close_run", "band_change", "horizon_change", "demo"] as const;
function triggerWord(trigger: string, t: TFunction): string {
  return (TRIGGERS as readonly string[]).includes(trigger)
    ? t(`panels.risk.trigger.${trigger as (typeof TRIGGERS)[number]}`)
    : trigger.replace(/_/g, " ");
}

const KINDS = ["incident", "insider_cluster", "unexplained_move", "drift", "filing_overdue", "earnings_window"] as const;
function kindWord(kind: string, t: TFunction): string {
  return (KINDS as readonly string[]).includes(kind) ? t(`panels.risk.kind.${kind as (typeof KINDS)[number]}`) : kind.replace(/_/g, " ");
}

const BAND_COLOR: Record<string, string> = {
  low: "#16A34A",
  moderate: "#CA8A04",
  elevated: "#EA580C",
  high: "#DC2626",
};

function fmtWhen(iso: string | null | undefined, locale: string, na: string): string {
  if (!iso) return na;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, withClock({ month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
}

function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/**
 * A holding's weight as a reader sees it everywhere else: its share of the
 * whole account, cash included (shared/portfolio-weights.ts), so this panel
 * prints what the Positions card prints for the name at the snapshot's
 * prices. A snapshot that predates the account figure falls back to the
 * invested-only share the HHI runs on.
 */
function accountShareText(
  snapshot: RiskSnapshot,
  w: { weight: number; market_value: number; side: "long" | "short" },
  missing: string,
): string {
  const total = componentPayload(snapshot, "concentration")?.account_value;
  if (total == null) return pct(w.weight, 1);
  const signed = w.side === "short" ? -Math.abs(w.market_value) : Math.abs(w.market_value);
  return formatWeightPct(accountWeight(signed, total)) ?? missing;
}

/**
 * The one-line summary under a component's bar. Takes the snapshot rather than
 * the component map so a payload written before this component existed reads
 * as "not in this snapshot" instead of throwing.
 */
function keyValue(key: RiskComponentKey, snapshot: RiskSnapshot, t: TFunction, locale: string): string {
  const MISSING = t("panels.risk.missing");
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
      return c
        ? t("panels.risk.volatility", {
            port: c.port_vol_daily_pct.toFixed(2),
            spy: c.spy_vol_daily_pct.toFixed(2),
            share: pct(c.systematic_share),
          })
        : MISSING;
    }
    case "network": {
      const c = componentPayload(snapshot, "network");
      if (!c) return MISSING;
      const linked = plural(t, locale, "panels.risk.network", c.pair_count, { pct: pct(c.linked_fraction, 1) });
      return c.excluded.length ? `${linked} · ${t("panels.risk.networkExcluded", { list: c.excluded.join(", ") })}` : linked;
    }
    case "event": {
      const c = componentPayload(snapshot, "event");
      return c ? t("panels.risk.raw", { value: c.raw.toFixed(2) }) : MISSING;
    }
    case "sharpe": {
      const c = componentPayload(snapshot, "sharpe");
      if (!c) return MISSING;
      return c.sharpe == null
        ? plural(t, locale, "panels.risk.noRatio", c.sessions)
        : t("panels.risk.sharpe", {
            sharpe: c.sharpe.toFixed(2),
            n: c.sessions,
            ret: c.ann_return_pct.toFixed(1),
            vol: c.ann_vol_pct.toFixed(1),
            rf: c.risk_free_pct,
          });
    }
  }
}

function Details({ keyName, snapshot }: { keyName: RiskComponentKey; snapshot: RiskSnapshot }) {
  const { t } = useI18n();
  const row = "flex items-baseline gap-2 text-[11px] leading-snug text-[#4b5563]";
  switch (keyName) {
    case "concentration": {
      const c = componentPayload(snapshot, "concentration");
      if (!c) return null;
      return (
        <div className="mt-1 space-y-0.5">
          {c.top.map((h) => (
            <div key={h.ticker} className={row}>
              <span className="w-14 font-semibold text-[#1d1b1b]">{h.ticker}</span>
              <span className="tabular-nums">
                {h.account_weight === undefined ? pct(h.weight, 1) : (formatWeightPct(h.account_weight) ?? t("common.na"))}
              </span>
            </div>
          ))}
        </div>
      );
    }
    case "network": {
      const c = componentPayload(snapshot, "network");
      if (!c) return null;
      return c.top_links.length === 0 ? (
        <div className="mt-1 text-[11px] text-[#9CA3AF]">{t("panels.risk.noLinks")}</div>
      ) : (
        <div className="mt-1 space-y-1">
          {c.top_links.map((l) => (
            <div key={`${l.a}-${l.b}-${l.edge_id}`} className="text-[11px] leading-snug text-[#4b5563]">
              <span className="font-semibold text-[#1d1b1b]">
                {l.a} ↔ {l.b}
              </span>{" "}
              <span>
                {l.via === "direct" || l.via === "shared" ? t(`panels.risk.via.${l.via}`) : l.via} · {categoryLabel(l.category, t)} ·{" "}
                {strengthWord(l.tier, t)} · l={l.link.toFixed(2)} · w={l.pair_weight.toFixed(3)}
                {l.counterparty_label ? ` · ${t("panels.risk.viaLabel", { name: l.counterparty_label })}` : ""}
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
        <div className="mt-1 text-[11px] text-[#9CA3AF]">{t("panels.risk.noContributors")}</div>
      ) : (
        <div className="mt-1 space-y-0.5">
          {c.contributors.map((e, i) => (
            <div key={`${e.ticker}-${e.kind}-${i}`} className={row}>
              <span className="w-14 font-semibold text-[#1d1b1b]">{e.ticker}</span>
              <span className="w-32">{kindWord(e.kind, t)}</span>
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
          {t("panels.risk.sharpeExcluded", { list: c.excluded.join(", ") })}
        </div>
      );
    }
    default:
      return null;
  }
}

function ComponentRow({ row, snapshot }: { row: RiskPanelRow; snapshot: RiskSnapshot }) {
  const { t, locale } = useI18n();
  const keyName = row.key;
  const label = componentLabel(row.key, t) || row.label;
  const { score, weight, isDriver } = row;
  if (score == null) {
    // Shown either way, because a row that just vanishes reads as a zero.
    return (
      <div className="rounded-xl border border-dashed border-[#e0e0da] bg-white/40 px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="w-44 text-[12px] font-semibold text-[#9CA3AF]">{label}</span>
          <span className="flex-1 text-[11px] text-[#9CA3AF]">
            {row.state === "absent" ? t("panels.risk.notInSnapshot") : t("panels.risk.notMeasured")}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-[#6b7280]">{keyValue(keyName, snapshot, t, locale)}</div>
      </div>
    );
  }
  return (
    <div className={`rounded-xl border px-3 py-2 ${isDriver ? "border-[#189E9A]/50 bg-[#189E9A]/5" : "border-[#e0e0da] bg-white/60"}`}>
      <div className="flex items-center gap-3">
        <span className="w-44 text-[12px] font-semibold text-[#1d1b1b]">
          {label}
          {isDriver ? (
            <span className="ml-1 rounded-full bg-[#189E9A] px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em] text-white">
              {t("panels.risk.driverBadge")}
            </span>
          ) : null}
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#e9e9e4]">
          <div className="h-full rounded-full bg-[#1d1b1b]" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
        </div>
        <span className="w-10 text-right text-[13px] font-semibold tabular-nums text-[#1d1b1b]">{score}</span>
        <span className="w-20 text-right text-[10px] tabular-nums text-[#9CA3AF]">
          ×{weight.toFixed(2)} = {(score * weight).toFixed(1)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[#6b7280]">{keyValue(keyName, snapshot, t, locale)}</div>
      <Details keyName={keyName} snapshot={snapshot} />
    </div>
  );
}

export default function RiskPanel({ onClose }: Props) {
  const { t, locale } = useI18n();
  // The card flag is shared calibration config for every account; the engine
  // takes it from staff only.
  const staff = useIsStaff();
  const na = t("common.na");
  const [latest, setLatest] = useState<RiskLatest | null>(null);
  const [status, setStatus] = useState<RiskStatus | null>(null);
  const [history, setHistory] = useState<RiskHistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getRiskLatest) {
      setError(BRIDGE_MISSING);
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
    const res = await bridge.setRiskCardEnabled(enabled);
    if (!res.ok) setError(res.error);
    await refresh();
  };

  const snapshot = latest?.snapshot ?? null;
  const band = snapshot?.band ?? null;

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-[#1d1b1b]/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#F4F4F0] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-[#e0e0da] px-5 py-3">
          <span className="font-sans text-[11px] font-medium tracking-[0.04em] text-[#9CA3AF]">{t("panels.risk.header", { shortcut: shortcutText("risk") })}</span>
          {snapshot && !snapshot.empty ? (
            <>
              <span className="text-[28px] font-semibold leading-none tabular-nums text-[#1d1b1b]">{snapshot.score}</span>
              <span className="rounded-full px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white" style={{ background: BAND_COLOR[band ?? "low"] }}>
                {band ? bandWord(band, t) : null}
              </span>
            </>
          ) : snapshot?.empty ? (
            <span className="text-[13px] text-[#6b7280]">{t("panels.risk.noPositions")}</span>
          ) : (
            <span className="text-[13px] text-[#6b7280]">{t("panels.risk.noSnapshot")}</span>
          )}
          <span className="text-[11px] tabular-nums text-[#9CA3AF]">
            {t("panels.risk.computed", { when: fmtWhen(snapshot?.computed_at, locale, na) })}
          </span>
          {snapshot ? (
            <span className="text-[10px] text-[#b4b4ae]">
              {t("panels.risk.trigger", { list: snapshot.trigger.map((x) => triggerWord(x, t)).join(", ") })}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <label
              className="flex items-center gap-1.5 text-[11px] text-[#6b7280]"
              title={staff ? undefined : t("access.staffOnly.setting")}
            >
              <input
                type="checkbox"
                checked={latest?.riskCardEnabled ?? false}
                disabled={!staff}
                onChange={(e) => void toggleCard(e.target.checked)}
              />
              riskCardEnabled
            </label>
            <button
              type="button"
              onClick={() => void recompute()}
              disabled={busy}
              className="rounded-lg bg-[#1d1b1b] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {busy ? t("panels.risk.recomputing") : t("panels.risk.recompute")}
            </button>
            <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-lg p-1.5 text-[#6b7280] hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-[11px] leading-snug text-red-700">{error === BRIDGE_MISSING ? t("panels.risk.error.bridge") : explain(error, t)}</div> : null}

        <div className="flex min-h-0 flex-1">
          {/* Body */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {snapshot && !snapshot.empty && snapshot.components ? (
              <>
                <div className="mb-3 rounded-xl border border-[#e0e0da] bg-white px-3 py-2">
                  <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">
                    {t("panels.risk.driver", { component: componentLabel(snapshot.driver?.component, t) })}
                  </div>
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
                      {t("panels.risk.positions", { pct: pct(snapshot.invested_fraction), n: snapshot.position_count })}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {snapshot.weights.map((w) => (
                        <div key={w.ticker} className="flex items-baseline gap-2 text-[11px] text-[#4b5563]">
                          <span className="w-14 font-semibold text-[#1d1b1b]">{w.ticker}</span>
                          <span className="w-12 tabular-nums">{accountShareText(snapshot, w, t("common.na"))}</span>
                          <span className="tabular-nums">${w.market_value.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                          {w.side === "short" ? <span className="text-[#DC2626]">{t("panels.risk.short")}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
                    <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">{t("panels.risk.degraded", { n: snapshot.degraded.length })}</div>
                    {snapshot.degraded.length === 0 ? (
                      <div className="mt-1 text-[11px] text-[#9CA3AF]">{t("panels.risk.noSubstitutions")}</div>
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
                        {t("panels.risk.graphStamp", {
                          version: snapshot.graph_version.pipelineVersion,
                          when: fmtWhen(snapshot.graph_version.generatedAt, locale, na),
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-[12px] text-[#6b7280]">
                {snapshot?.empty ? t("panels.risk.emptyBody") : t("panels.risk.waiting")}
              </div>
            )}

            {status ? (
              <div className="mt-4 rounded-xl border border-[#e0e0da] bg-white/40 px-3 py-2 text-[10px] text-[#6b7280]">
                <div>
                  {t("panels.risk.status.data", {
                    dir: status.dataDir,
                    n: status.snapshotCount,
                    poll: status.pollIntervalMs / 1000,
                    debounce: status.debounceMs / 1000,
                    days: status.historyRetentionDays,
                    when: fmtWhen(status.lastPollAt, locale, na),
                  })}
                </div>
                <div>
                  {status.account.received
                    ? t("panels.risk.status.account", {
                        when: fmtWhen(status.account.as_of, locale, na),
                        n: status.account.positions,
                        cash: status.account.cash.toFixed(0),
                      })
                    : t("panels.risk.status.noAccount")}
                </div>
                {status.keys ? (
                  <div className="font-mono">
                    {t("panels.risk.status.keys", {
                      close: status.keys.close || na,
                      bands: status.keys.bands || na,
                      horizon: status.keys.horizon || na,
                    })}
                  </div>
                ) : null}
                {status.lastError ? <div className="text-red-600">{t("panels.risk.status.lastError", { message: status.lastError })}</div> : null}
              </div>
            ) : null}
          </div>

          {/* History */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-l border-[#e0e0da] px-3 py-3">
            <div className="mb-2 text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">{t("panels.risk.history", { n: history.length })}</div>
            <div className="space-y-1">
              {history.map((h) => (
                <div key={h.computed_at} className="rounded-lg bg-white/60 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] tabular-nums text-[#9CA3AF]">{fmtWhen(h.computed_at, locale, na)}</span>
                    <span className="text-[12px] font-semibold tabular-nums text-[#1d1b1b]">{h.empty ? na : h.score}</span>
                    {h.band ? (
                      <span className="rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.08em] text-white" style={{ background: BAND_COLOR[h.band] }}>
                        {bandWord(h.band, t)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-[9px] text-[#b4b4ae]">{h.trigger.map((x) => triggerWord(x, t)).join(" + ")}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-[#6b7280]">
                    {h.driver_component
                      ? `${componentLabel(h.driver_component, t)} · ${h.driver_sentence}`
                      : h.empty
                        ? t("panels.risk.empty")
                        : ""}
                  </div>
                </div>
              ))}
              {history.length === 0 ? <div className="text-[11px] text-[#9CA3AF]">{t("panels.risk.noHistory")}</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
