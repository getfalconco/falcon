import { na } from "@/lib/i18n/na";
import { withClock } from "@/lib/clock";
import { shortcutText } from "@/lib/shortcuts";
import { useIsStaff } from "@/lib/staff";
import { useI18n, type TFunction } from "@/lib/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { GaugeReadout } from "../../../shared/gauge-types";
import {
  SCREEN_PATTERNS,
  type ScreenFinding,
  type ScreenFindingsPayload,
  type ScreenPattern,
  type ScreenScan,
  type ScreenStatus,
} from "../../../shared/screen-types";

/**
 * Shift+S — the Screen debug panel (spec §7). Header: last scan · findings
 * count · rescan. List: TICKER · pattern · day N · key values · modifiers,
 * active first (day_count desc, then pattern priority), ended collapsible
 * below. Row click → detail: full values payload, the qualifying sessions,
 * the per-session views and "open in Gauge →" (standalone-mode readout for
 * the ticker — the chain's first link). Filters: pattern, ticker. Read-only
 * view over the findings store; no styling ambitions.
 */

type Props = { onClose: () => void };

const PATTERN_COLOR: Record<ScreenPattern, string> = {
  quiet_accumulation: "var(--teal)",
  compression: "var(--text-secondary)",
  independent_tape: "var(--violet)",
  insider_divergence: "var(--yellow)",
};

/** Error value for "the preload has no bridge for this"; rendered through t() so it follows the language. */
const SCREEN_BRIDGE_MISSING = "\u0000screen-bridge-missing";
const GAUGE_BRIDGE_MISSING = "\u0000gauge-bridge-missing";

function errorText(error: string, t: TFunction): string {
  if (error === SCREEN_BRIDGE_MISSING) return t("instruments.common.bridgeUnavailable", { name: "Screen" });
  if (error === GAUGE_BRIDGE_MISSING) return t("instruments.common.bridgeUnavailable", { name: "Gauge" });
  return error;
}

function fmtWhen(iso: string | null | undefined, locale: string): string {
  if (!iso) return na();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, withClock({ month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pct(v: number | null, digits = 1, signed = false): string {
  if (v == null) return na();
  const s = `${(Math.abs(v) * 100).toFixed(digits)}%`;
  if (!signed) return s;
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

function fix(v: number | null, digits = 2): string {
  return v == null ? na() : v.toFixed(digits);
}

/** The row's key values — one short clause per pattern, condition language only. */
function keyValues(f: ScreenFinding, t: TFunction): string {
  const v = f.values;
  switch (f.pattern) {
    case "quiet_accumulation":
      return t("instruments.screen.kv.quiet", {
        qualifying: num(v.sessions_qualifying) ?? "?",
        window: num(v.sessions_window) ?? "?",
        avg: fix(num(v.avg_volume_ratio), 1),
        m5: fix(num(v.momentum_5d_z), 1),
      });
    case "compression":
      return t("instruments.screen.kv.compression", {
        regime: fix(num(v.vol_regime)),
        range: pct(num(v.range)),
        bound: pct(num(v.range_bound)),
      });
    case "independent_tape":
      return t("instruments.screen.kv.independent", {
        qualifying: num(v.sessions_qualifying) ?? "?",
        window: num(v.sessions_window) ?? "?",
        direction: String(v.direction ?? ""),
        net: pct(num(v.net_residual), 1, true),
        z: fix(num(v.net_residual_z), 1),
        r2: fix(num(v.r2)),
      });
    case "insider_divergence":
      return t("instruments.screen.kv.insider", {
        direction: String(v.direction ?? "?"),
        n: num(v.insider_count) ?? "?",
        m20: pct(num(v.momentum_20d), 1, true),
        z: fix(num(v.momentum_20d_z), 1),
      });
  }
}

function modifierText(m: string, t: TFunction): string {
  return m === "near_52w_high"
    ? t("instruments.screen.near52High")
    : m === "near_52w_low"
      ? t("instruments.screen.near52Low")
      : m;
}

function Row({ f, label, selected, onSelect }: { f: ScreenFinding; label: string; selected: boolean; onSelect: () => void }) {
  const { t, locale } = useI18n();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left ${selected ? "border-tone-teal/60 bg-tone-teal-fill/5" : "border-edge bg-white/60 hover:bg-white"}`}
    >
      <span className="w-12 shrink-0 text-[13px] font-semibold text-content-primary">{f.ticker}</span>
      <span className="w-28 shrink-0 truncate text-[11px] font-medium" style={{ color: PATTERN_COLOR[f.pattern] }}>
        {label}
      </span>
      <span className="w-16 shrink-0 whitespace-nowrap text-[11px] tabular-nums text-content-primary">
        {t("instruments.screen.day", { n: f.day_count })}
        {f.state === "new" ? (
          <span className="ml-1 rounded-full bg-tone-teal-solid px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em] text-white">
            {t("instruments.screen.new")}
          </span>
        ) : null}
      </span>
      {f.emitted_at ? (
        <span
          className="shrink-0 rounded-full border border-tone-violet/30 bg-tone-violet-soft px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em] text-tone-violet"
          title={t("instruments.screen.emittedHint", {
            when: new Date(f.emitted_at).toLocaleString(locale, withClock()),
            key: shortcutText("analyst"),
          })}
        >
          {t("instruments.screen.emitted")}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 text-[10.5px] leading-tight tabular-nums text-content-body">{keyValues(f, t)}</span>
      {f.modifiers.length || f.ended_at ? (
        <span className="w-24 shrink-0 text-right text-[10px] leading-tight text-content-tertiary">
          {[
            ...f.modifiers.map((m) => modifierText(m, t)),
            ...(f.ended_at
              ? [t("instruments.screen.endedOn", { date: f.ended_at, reason: f.ended_reason?.replace(/_/g, " ") ?? "" })]
              : []),
          ].join(" · ")}
        </span>
      ) : null}
    </button>
  );
}

function GaugeBlock({ ticker }: { ticker: string }) {
  const { t } = useI18n();
  const [readout, setReadout] = useState<GaugeReadout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    setReadout(null);
    setError(null);
    setOpened(false);
  }, [ticker]);

  const open = async () => {
    setOpened(true);
    // The chain's first link: hand the ticker to the Gauge host (standalone
    // mode) and show its readout here — a read-only dependency on Gauge.
    window.dispatchEvent(new CustomEvent("falcon:gauge-open", { detail: { ticker, mode: "standalone", source: "screen" } }));
    const bridge = window.meridian;
    if (!bridge?.getGaugeReadout) {
      setError(GAUGE_BRIDGE_MISSING);
      return;
    }
    setLoading(true);
    try {
      const res = await bridge.getGaugeReadout({ ticker, context: null, surface: "other" });
      if (res.ok) setReadout(res.readout);
      else setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-edge bg-white px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{t("instruments.screen.gaugeTitle")}</span>
        <button type="button" onClick={() => void open()} className="ml-auto shrink-0 rounded-lg bg-ink px-3 py-1 text-[11px] font-medium text-white" data-testid="open-in-gauge">
          {t("instruments.screen.openInGauge")}
        </button>
      </div>
      {!opened ? <div className="mt-1 text-[11px] text-content-tertiary">{t("instruments.screen.chain", { ticker })}</div> : null}
      {loading ? <div className="mt-1 text-[11px] text-content-secondary">{t("instruments.screen.reading")}</div> : null}
      {error ? <div className="mt-1 text-[11px] text-red-700">{errorText(error, t)}</div> : null}
      {readout ? (
        <div className="mt-2">
          <div className="font-baskerville text-[14px] text-content-primary">{readout.summary.sentence}</div>
          <div className="mt-1 text-[10px] text-content-tertiary">
            {t("instruments.screen.readoutMeta", {
              mode: readout.mode,
              asOf: readout.quant_as_of ?? na(),
              aligned: readout.summary.aligned,
              evaluable: readout.summary.evaluable,
              unavailable: readout.summary.unavailable,
            })}
            {readout.summary.calibrating ? ` · ${t("instruments.screen.calibrating")}` : ""}
          </div>
          <div className="mt-1 space-y-0.5">
            {readout.checks.map((c) => (
              <div key={c.key} className="flex items-baseline gap-2 text-[11px] text-content-body">
                <span className="w-4 text-content-tertiary">{c.number}</span>
                <span className="w-32 font-medium text-content-primary">{c.label}</span>
                <span className="w-14 font-semibold" style={{ color: c.status === "fail" ? "var(--negative)" : c.status === "caution" ? "var(--yellow)" : c.status === "pass" ? "var(--positive)" : "var(--text-tertiary)" }}>
                  {c.status}
                </span>
                <span className="min-w-0 flex-1">
                  {c.reason}
                  {c.note ? <span className="text-content-tertiary"> · {c.note}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ f, label }: { f: ScreenFinding; label: string }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="text-[22px] font-semibold text-content-primary">{f.ticker}</span>
        <span className="text-[13px] font-medium" style={{ color: PATTERN_COLOR[f.pattern] }}>
          {label}
        </span>
        <span className="text-[11px] tabular-nums text-content-secondary">
          {t("instruments.screen.detailMeta", { state: f.state, n: f.day_count, first: f.first_session, last: f.last_evaluated })}
          {f.ended_at
            ? ` · ${t("instruments.screen.endedDetail", { date: f.ended_at, reason: f.ended_reason?.replace(/_/g, " ") ?? "" })}`
            : ""}
        </span>
      </div>
      <div className="mt-2 rounded-xl border border-edge bg-white px-3 py-2">
        <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{t("instruments.screen.read")}</div>
        <div className="font-baskerville text-[15px] text-content-primary">{f.read}</div>
        {f.modifiers.length ? (
          <div className="mt-1 text-[11px] text-content-secondary">
            {t("instruments.screen.modifiers", { list: f.modifiers.map((m) => modifierText(m, t)).join(" · ") })}
          </div>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-edge bg-white/60 px-3 py-2">
          <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{t("instruments.screen.values")}</div>
          <div className="mt-1 space-y-0.5">
            {Object.entries(f.values).map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2 text-[11px] text-content-body">
                <span className="w-40 truncate font-mono text-[10px] text-content-secondary">{k}</span>
                <span className="tabular-nums text-content-primary">{v == null ? "null" : typeof v === "number" ? (Math.abs(v) < 1 && v !== 0 ? v.toFixed(4) : String(v)) : String(v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-white/60 px-3 py-2">
          <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">
            {t("instruments.screen.qualifying", { n: f.qualifying_sessions.length })}
          </div>
          <div className="mt-1 text-[11px] tabular-nums text-content-primary">{f.qualifying_sessions.length ? f.qualifying_sessions.join(" · ") : na()}</div>
          <div className="mt-2 text-[10px] font-medium tracking-[0.08em] text-content-tertiary">
            {t("instruments.screen.heldOn", { n: f.sessions.length })}
          </div>
          <div className="mt-1 text-[11px] tabular-nums text-content-body">{f.sessions.join(" · ")}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-edge bg-white/60 px-3 py-2">
        <div className="text-[10px] font-medium tracking-[0.08em] text-content-tertiary">
          {t("instruments.screen.sessionViews", { n: f.sessions_view.length })}
        </div>
        {/* Nowrap and its own scroll: longer column names (de, fr) must not squeeze the dates apart. */}
        <div className="overflow-x-auto">
        <table className="mt-1 w-full whitespace-nowrap text-[11px] tabular-nums text-content-body [&_td]:pr-3 [&_th]:pr-3">
          <thead>
            <tr className="text-left text-[10px] text-content-tertiary">
              <th className="font-medium">{t("instruments.screen.col.session")}</th>
              <th className="font-medium">{t("instruments.screen.col.close")}</th>
              <th className="font-medium">{t("instruments.screen.col.ret")}</th>
              <th className="font-medium">{t("instruments.screen.col.bench")}</th>
              <th className="font-medium">{t("instruments.screen.col.volRatio")}</th>
              <th className="font-medium">{t("instruments.screen.col.residual")}</th>
              <th className="font-medium">{t("instruments.screen.col.residualZ")}</th>
            </tr>
          </thead>
          <tbody>
            {f.sessions_view.map((s) => {
              const q = f.qualifying_sessions.includes(s.d);
              return (
                <tr key={s.d} className={q ? "font-semibold text-content-primary" : ""}>
                  <td>
                    {s.d}
                    {q ? " ✓" : ""}
                  </td>
                  <td>{s.close.toFixed(2)}</td>
                  <td>{pct(s.ret, 2, true)}</td>
                  <td>{pct(s.bench_ret, 2, true)}</td>
                  <td>{fix(s.volume_ratio)}×</td>
                  <td>{pct(s.residual_move, 2, true)}</td>
                  <td>{fix(s.residual_z)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      <GaugeBlock ticker={f.ticker} />
    </div>
  );
}

export default function ScreenPanel({ onClose }: Props) {
  const { t, tNodes, locale } = useI18n();
  // A rescan rewrites the shared findings (and can emit into the shared
  // pipeline) for every account; the engine takes it from staff only.
  const staff = useIsStaff();
  const [payload, setPayload] = useState<ScreenFindingsPayload | null>(null);
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [lastScan, setLastScan] = useState<ScreenScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Result of the last manual rescan (clears itself): the scan, or "none"
   * when it produced none. Kept as data so the line follows the language.
   */
  const [flash, setFlash] = useState<{ scan: ScreenScan | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [showDegraded, setShowDegraded] = useState(false);
  const [patternFilter, setPatternFilter] = useState<ScreenPattern | "all">("all");
  const [tickerFilter, setTickerFilter] = useState("");

  const refresh = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getScreenFindings) {
      setError(SCREEN_BRIDGE_MISSING);
      return;
    }
    const [f, s] = await Promise.all([bridge.getScreenFindings(), bridge.getScreenStatus()]);
    if (f.ok) {
      setPayload({ active: f.active, ended: f.ended, last_scan: f.last_scan, labels: f.labels, priority: f.priority });
      setLastScan(f.last_scan);
      setError(null);
    } else setError(f.error);
    if (s.ok) setStatus(s.status);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.meridian?.onScreenScan?.(() => void refresh()) ?? (() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, onClose]);

  useEffect(() => {
    if (!flash) return;
    const handle = setTimeout(() => setFlash(null), 8_000);
    return () => clearTimeout(handle);
  }, [flash]);

  const rescan = async () => {
    const bridge = window.meridian;
    if (!bridge?.rescanScreen) {
      setError(SCREEN_BRIDGE_MISSING);
      return;
    }
    setBusy(true);
    try {
      const res = await bridge.rescanScreen();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // A rescan of an already-scanned session is idempotent by design (§5):
      // same session, same series, same findings. Without an explicit result
      // line the button reads as dead, so say what the run did — including
      // "no change", which is the normal answer between two closes.
      setFlash({ scan: res.scan ?? null });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const matches = useCallback(
    (f: ScreenFinding) => (patternFilter === "all" || f.pattern === patternFilter) && (!tickerFilter.trim() || f.ticker.includes(tickerFilter.trim().toUpperCase())),
    [patternFilter, tickerFilter],
  );
  const active = useMemo(() => (payload?.active ?? []).filter(matches), [payload, matches]);
  const ended = useMemo(() => (payload?.ended ?? []).filter(matches), [payload, matches]);
  const selected = useMemo(() => [...(payload?.active ?? []), ...(payload?.ended ?? [])].find((f) => f.id === selectedId) ?? null, [payload, selectedId]);
  const labels = payload?.labels;
  const labelOf = (p: ScreenPattern) => labels?.[p] ?? p.replace(/_/g, " ");

  const flashText = (() => {
    if (!flash) return null;
    const s = flash.scan;
    if (s == null) return t("instruments.screen.flashNone");
    const line = t("instruments.screen.flashScanned", {
      session: s.session,
      scanned: s.tickers_scanned,
      total: s.tickers_total,
      new: s.new,
      continuing: s.continuing,
      ended: s.ended,
      degraded: s.degraded.length,
    });
    const noChange = s.new + s.continuing + s.ended === 0 ? ` · ${t("instruments.screen.flashNoChange")}` : "";
    return `${line}${noChange} · ${new Date(s.scanned_at).toLocaleTimeString(locale, withClock())}`;
  })();

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-ink/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1180px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-surface-1 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-edge px-5 py-3">
          <span className="shrink-0 font-sans text-[11px] font-medium tracking-[0.04em] text-content-tertiary">
            {t("instruments.screen.title", { key: shortcutText("screen") })}
          </span>
          <span className="shrink-0 text-[13px] text-content-primary">
            {lastScan ? (
              <>
                {tNodes("instruments.screen.lastScan", {
                  session: <span className="font-semibold tabular-nums">{lastScan.session}</span>,
                })}
                <span className="text-[11px] text-content-tertiary"> · {fmtWhen(lastScan.scanned_at, locale)} · {lastScan.trigger}</span>
              </>
            ) : (
              <span className="text-content-secondary">{t("instruments.screen.noScan")}</span>
            )}
          </span>
          <span className="min-w-0 text-[11px] tabular-nums text-content-secondary">
            {tNodes("instruments.screen.findings", {
              active: <span className="font-semibold text-content-primary">{payload?.active.length ?? 0}</span>,
              ended: payload?.ended.length ?? 0,
            })}
            {lastScan
              ? ` · ${t("instruments.screen.scanSummary", {
                  new: lastScan.new,
                  continuing: lastScan.continuing,
                  ended: lastScan.ended,
                  degraded: lastScan.degraded.length,
                })}`
              : ""}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <select className="rounded-md border border-edge bg-white px-2 py-1 text-[11px] text-content-primary" value={patternFilter} onChange={(e) => setPatternFilter(e.target.value as ScreenPattern | "all")}>
              <option value="all">{t("instruments.screen.allPatterns")}</option>
              {SCREEN_PATTERNS.map((p) => (
                <option key={p} value={p}>
                  {labelOf(p)}
                </option>
              ))}
            </select>
            <input
              lang="en"
              className="w-24 rounded-md border border-edge bg-white px-2 py-1 text-[11px] uppercase text-content-primary outline-none focus:border-tone-teal"
              placeholder={t("instruments.screen.tickerPlaceholder")}
              value={tickerFilter}
              onChange={(e) => setTickerFilter(e.target.value)}
            />
            <button
              type="button"
              onClick={() => void rescan()}
              disabled={!staff || busy}
              title={staff ? undefined : t("access.staffOnly.action")}
              data-testid="screen-rescan"
              className="whitespace-nowrap rounded-lg bg-ink px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {busy ? t("instruments.screen.scanning") : t("instruments.screen.rescan")}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              title={t("common.close")}
              className="rounded-lg p-1.5 text-content-secondary hover:bg-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-[11px] text-red-700">{errorText(error, t)}</div> : null}
        {flashText ? (
          <div className="border-b border-tone-teal/30 bg-tone-teal-fill/10 px-5 py-2 text-[11px] tabular-nums text-tone-teal">{flashText}</div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {/* List */}
          <div className="w-[600px] shrink-0 overflow-y-auto border-r border-edge px-4 py-3">
            <div className="mb-2 text-[10px] font-medium tracking-[0.08em] text-content-tertiary">{t("instruments.screen.active", { n: active.length })}</div>
            {active.length === 0 ? (
              <div className="text-[12px] text-content-secondary">{payload ? t("instruments.screen.noActive") : t("instruments.screen.loading")}</div>
            ) : (
              <div className="space-y-1">
                {active.map((f) => (
                  <Row key={f.id} f={f} label={labelOf(f.pattern)} selected={f.id === selectedId} onSelect={() => setSelectedId(f.id)} />
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowEnded((v) => !v)}
              data-testid="screen-ended-toggle"
              className="mt-4 flex items-center gap-1 text-[10px] font-medium tracking-[0.08em] text-content-tertiary"
            >
              {showEnded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {t("instruments.screen.ended", { n: ended.length })}
            </button>
            {showEnded ? (
              <div className="mt-2 space-y-1 opacity-80">
                {ended.length === 0 ? <div className="text-[12px] text-content-secondary">{t("instruments.screen.noEnded")}</div> : null}
                {ended.map((f) => (
                  <Row key={f.id} f={f} label={labelOf(f.pattern)} selected={f.id === selectedId} onSelect={() => setSelectedId(f.id)} />
                ))}
              </div>
            ) : null}

            {lastScan && lastScan.degraded.length > 0 ? (
              <>
                <button type="button" onClick={() => setShowDegraded((v) => !v)} className="mt-4 flex items-center gap-1 text-[10px] font-medium tracking-[0.08em] text-content-tertiary">
                  {showDegraded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {t("instruments.screen.degraded", { n: lastScan.degraded.length })}
                </button>
                {showDegraded ? (
                  <div className="mt-2 space-y-0.5">
                    {lastScan.degraded.map((d, i) => (
                      <div key={`${d.ticker}-${d.pattern}-${i}`} className="flex items-baseline gap-2 text-[11px] text-content-body">
                        <span className="w-14 font-semibold text-content-primary">{d.ticker}</span>
                        <span className="w-32">{d.pattern === "all" ? t("instruments.screen.allPatterns") : labelOf(d.pattern)}</span>
                        <span className="min-w-0 flex-1 truncate">{d.reason}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {/* Detail */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {selected ? (
              <Detail f={selected} label={labelOf(selected.pattern)} />
            ) : (
              <div className="text-[12px] text-content-secondary">{t("instruments.screen.clickHint")}</div>
            )}

            {status ? (
              <div className="mt-4 rounded-xl border border-edge bg-white/40 px-3 py-2 text-[10px] text-content-secondary">
                <div>
                  {t("instruments.screen.statusLine", {
                    dir: status.dataDir,
                    scans: status.scanCount,
                    poll: status.pollIntervalMs / 1000,
                    days: status.retentionDays,
                    when: fmtWhen(status.lastPollAt, locale),
                  })}
                  {status.r2Floor != null ? ` · ${t("instruments.screen.r2Floor", { value: status.r2Floor })}` : ""}
                </div>
                <div>
                  {t("instruments.screen.patterns")}{" "}
                  {SCREEN_PATTERNS.map(
                    (p) =>
                      `${p} ${status.patterns[p].enabled ? t("instruments.common.on") : t("instruments.common.off")}/p${status.patterns[p].priority}`,
                  ).join(" · ")}
                </div>
                {status.keys ? (
                  <div className="font-mono">
                    {t("instruments.screen.hook", {
                      session: status.keys.session,
                      landed: status.keys.landed,
                      total: status.keys.total,
                    })}
                  </div>
                ) : null}
                {status.lastError ? (
                  <div className="text-red-600">{t("instruments.screen.lastError", { error: status.lastError })}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="border-t border-edge px-5 py-2 text-[10px] text-content-tertiary">
          {t("instruments.screen.footer", { key: shortcutText("screen"), emitted: t("instruments.screen.emitted") })}
        </div>
      </div>
    </div>
  );
}
