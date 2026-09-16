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
  quiet_accumulation: "#189E9A",
  compression: "#6B7280",
  independent_tape: "#7C3AED",
  insider_divergence: "#CA8A04",
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pct(v: number | null, digits = 1, signed = false): string {
  if (v == null) return "—";
  const s = `${(Math.abs(v) * 100).toFixed(digits)}%`;
  if (!signed) return s;
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

function fix(v: number | null, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}

/** The row's key values — one short clause per pattern, condition language only. */
function keyValues(f: ScreenFinding): string {
  const v = f.values;
  switch (f.pattern) {
    case "quiet_accumulation":
      return `${num(v.sessions_qualifying) ?? "?"}/${num(v.sessions_window) ?? "?"} sessions · avg ${fix(num(v.avg_volume_ratio), 1)}× · m5 ${fix(num(v.momentum_5d_z), 1)}σ`;
    case "compression":
      return `regime ${fix(num(v.vol_regime))} · range ${pct(num(v.range))} / ${pct(num(v.range_bound))} band`;
    case "independent_tape":
      return `${num(v.sessions_qualifying) ?? "?"}/${num(v.sessions_window) ?? "?"} ${String(v.direction ?? "")} · net ${pct(num(v.net_residual), 1, true)} (${fix(num(v.net_residual_z), 1)}σ) · r² ${fix(num(v.r2))}`;
    case "insider_divergence":
      return `${String(v.direction ?? "?")} · ${num(v.insider_count) ?? "?"} insiders · m20 ${pct(num(v.momentum_20d), 1, true)} (${fix(num(v.momentum_20d_z), 1)}σ)`;
  }
}

function modifierText(m: string): string {
  return m === "near_52w_high" ? "near 52w high" : m === "near_52w_low" ? "near 52w low" : m;
}

function Row({ f, label, selected, onSelect }: { f: ScreenFinding; label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left ${selected ? "border-[#189E9A]/60 bg-[#189E9A]/5" : "border-[#e0e0da] bg-white/60 hover:bg-white"}`}
    >
      <span className="w-12 shrink-0 text-[13px] font-semibold text-[#1d1b1b]">{f.ticker}</span>
      <span className="w-28 shrink-0 truncate text-[11px] font-medium" style={{ color: PATTERN_COLOR[f.pattern] }}>
        {label}
      </span>
      <span className="w-16 shrink-0 text-[11px] tabular-nums text-[#1d1b1b]">
        day {f.day_count}
        {f.state === "new" ? <span className="ml-1 rounded-full bg-[#189E9A] px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em] text-white">NEW</span> : null}
      </span>
      {f.emitted_at ? (
        <span
          className="shrink-0 rounded-full border border-[#5b21b6]/30 bg-[#ede9fe] px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em] text-[#5b21b6]"
          title={`Emitted to Base as a tape_structure message on ${new Date(f.emitted_at).toLocaleString()} — Shift+A shows the Analyst answer if one was produced`}
        >
          EMITTED
        </span>
      ) : null}
      <span className="min-w-0 flex-1 text-[10.5px] leading-tight tabular-nums text-[#4b5563]">{keyValues(f)}</span>
      {f.modifiers.length || f.ended_at ? (
        <span className="w-24 shrink-0 text-right text-[10px] leading-tight text-[#9CA3AF]">
          {[...f.modifiers.map(modifierText), ...(f.ended_at ? [`ended ${f.ended_at} · ${f.ended_reason?.replace(/_/g, " ")}`] : [])].join(" · ")}
        </span>
      ) : null}
    </button>
  );
}

function GaugeBlock({ ticker }: { ticker: string }) {
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
      setError("gauge bridge unavailable — restart the app (new IPC handlers need a main-process restart)");
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
    <div className="mt-3 rounded-xl border border-[#e0e0da] bg-white px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">GAUGE · standalone</span>
        <button type="button" onClick={() => void open()} className="ml-auto rounded-lg bg-[#1d1b1b] px-3 py-1 text-[11px] font-medium text-white" data-testid="open-in-gauge">
          open in Gauge →
        </button>
      </div>
      {!opened ? <div className="mt-1 text-[11px] text-[#9CA3AF]">Screen finds → Gauge times → Analyst explains. Opens the standalone readout for {ticker}.</div> : null}
      {loading ? <div className="mt-1 text-[11px] text-[#6b7280]">reading…</div> : null}
      {error ? <div className="mt-1 text-[11px] text-red-700">{error}</div> : null}
      {readout ? (
        <div className="mt-2">
          <div className="font-baskerville text-[14px] text-[#1d1b1b]">{readout.summary.sentence}</div>
          <div className="mt-1 text-[10px] text-[#9CA3AF]">
            {readout.mode} · quant as of {readout.quant_as_of ?? "—"} · {readout.summary.aligned}/{readout.summary.evaluable} aligned · {readout.summary.unavailable} unavailable
            {readout.summary.calibrating ? " · calibrating" : ""}
          </div>
          <div className="mt-1 space-y-0.5">
            {readout.checks.map((c) => (
              <div key={c.key} className="flex items-baseline gap-2 text-[11px] text-[#4b5563]">
                <span className="w-4 text-[#9CA3AF]">{c.number}</span>
                <span className="w-32 font-medium text-[#1d1b1b]">{c.label}</span>
                <span className="w-14 font-semibold" style={{ color: c.status === "fail" ? "#DC2626" : c.status === "caution" ? "#CA8A04" : c.status === "pass" ? "#16A34A" : "#9CA3AF" }}>
                  {c.status}
                </span>
                <span className="min-w-0 flex-1">
                  {c.reason}
                  {c.note ? <span className="text-[#9CA3AF]"> — {c.note}</span> : null}
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
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="text-[22px] font-semibold text-[#1d1b1b]">{f.ticker}</span>
        <span className="text-[13px] font-medium" style={{ color: PATTERN_COLOR[f.pattern] }}>
          {label}
        </span>
        <span className="text-[11px] tabular-nums text-[#6b7280]">
          {f.state} · day {f.day_count} · {f.first_session} → {f.last_evaluated}
          {f.ended_at ? ` · ended ${f.ended_at} (${f.ended_reason?.replace(/_/g, " ")})` : ""}
        </span>
      </div>
      <div className="mt-2 rounded-xl border border-[#e0e0da] bg-white px-3 py-2">
        <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">READ</div>
        <div className="font-baskerville text-[15px] text-[#1d1b1b]">{f.read}</div>
        {f.modifiers.length ? <div className="mt-1 text-[11px] text-[#6b7280]">modifiers: {f.modifiers.map(modifierText).join(" · ")}</div> : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
          <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">VALUES</div>
          <div className="mt-1 space-y-0.5">
            {Object.entries(f.values).map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2 text-[11px] text-[#4b5563]">
                <span className="w-40 truncate font-mono text-[10px] text-[#6b7280]">{k}</span>
                <span className="tabular-nums text-[#1d1b1b]">{v == null ? "null" : typeof v === "number" ? (Math.abs(v) < 1 && v !== 0 ? v.toFixed(4) : String(v)) : String(v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
          <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">QUALIFYING SESSIONS · {f.qualifying_sessions.length}</div>
          <div className="mt-1 text-[11px] tabular-nums text-[#1d1b1b]">{f.qualifying_sessions.length ? f.qualifying_sessions.join(" · ") : "—"}</div>
          <div className="mt-2 text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">HELD ON · {f.sessions.length}</div>
          <div className="mt-1 text-[11px] tabular-nums text-[#4b5563]">{f.sessions.join(" · ")}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
        <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">SESSION VIEWS · last {f.sessions_view.length}</div>
        <table className="mt-1 w-full text-[11px] tabular-nums text-[#4b5563]">
          <thead>
            <tr className="text-left text-[10px] text-[#9CA3AF]">
              <th className="font-medium">session</th>
              <th className="font-medium">close</th>
              <th className="font-medium">ret</th>
              <th className="font-medium">bench</th>
              <th className="font-medium">vol ratio</th>
              <th className="font-medium">residual</th>
              <th className="font-medium">residual z</th>
            </tr>
          </thead>
          <tbody>
            {f.sessions_view.map((s) => {
              const q = f.qualifying_sessions.includes(s.d);
              return (
                <tr key={s.d} className={q ? "font-semibold text-[#1d1b1b]" : ""}>
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

      <GaugeBlock ticker={f.ticker} />
    </div>
  );
}

export default function ScreenPanel({ onClose }: Props) {
  const [payload, setPayload] = useState<ScreenFindingsPayload | null>(null);
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [lastScan, setLastScan] = useState<ScreenScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Result line for the last manual rescan (clears itself). */
  const [flash, setFlash] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [showDegraded, setShowDegraded] = useState(false);
  const [patternFilter, setPatternFilter] = useState<ScreenPattern | "all">("all");
  const [tickerFilter, setTickerFilter] = useState("");

  const refresh = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getScreenFindings) {
      setError("screen bridge unavailable — restart the app (new IPC handlers need a main-process restart)");
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
      setError("screen bridge unavailable — restart the app (new IPC handlers need a main-process restart)");
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
      const s = res.scan;
      setFlash(
        s == null
          ? "rescan produced no scan — the close-run has not landed for any ticker yet"
          : `scanned ${s.session} · ${s.tickers_scanned}/${s.tickers_total} tickers · ${s.new} new · ${s.continuing} continuing · ${s.ended} ended · ${s.degraded.length} degraded${
              s.new + s.continuing + s.ended === 0 ? " — no change (session already scanned)" : ""
            } · ${new Date(s.scanned_at).toLocaleTimeString()}`,
      );
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

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-[#1d1b1b]/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1180px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#F4F4F0] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-[#e0e0da] px-5 py-3">
          <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">SCREEN · Shift+S</span>
          <span className="text-[13px] text-[#1d1b1b]">
            {lastScan ? (
              <>
                last scan <span className="font-semibold tabular-nums">{lastScan.session}</span>
                <span className="text-[11px] text-[#9CA3AF]"> · {fmtWhen(lastScan.scanned_at)} · {lastScan.trigger}</span>
              </>
            ) : (
              <span className="text-[#6b7280]">No scan yet.</span>
            )}
          </span>
          <span className="text-[11px] tabular-nums text-[#6b7280]">
            findings <span className="font-semibold text-[#1d1b1b]">{payload?.active.length ?? 0}</span> active · {payload?.ended.length ?? 0} ended
            {lastScan ? ` · scan: ${lastScan.new} new · ${lastScan.continuing} continuing · ${lastScan.ended} ended · ${lastScan.degraded.length} degraded` : ""}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <select className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]" value={patternFilter} onChange={(e) => setPatternFilter(e.target.value as ScreenPattern | "all")}>
              <option value="all">all patterns</option>
              {SCREEN_PATTERNS.map((p) => (
                <option key={p} value={p}>
                  {labelOf(p)}
                </option>
              ))}
            </select>
            <input
              className="w-24 rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] uppercase text-[#1d1b1b] outline-none focus:border-[#189E9A]"
              placeholder="ticker"
              value={tickerFilter}
              onChange={(e) => setTickerFilter(e.target.value)}
            />
            <button type="button" onClick={() => void rescan()} disabled={busy} className="rounded-lg bg-[#1d1b1b] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50">
              {busy ? "scanning…" : "rescan"}
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[#6b7280] hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-[11px] text-red-700">{error}</div> : null}
        {flash ? <div className="border-b border-[#189E9A]/30 bg-[#189E9A]/10 px-5 py-2 text-[11px] tabular-nums text-[#0f5f5d]">{flash}</div> : null}

        <div className="flex min-h-0 flex-1">
          {/* List */}
          <div className="w-[600px] shrink-0 overflow-y-auto border-r border-[#e0e0da] px-4 py-3">
            <div className="mb-2 text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">ACTIVE · {active.length}</div>
            {active.length === 0 ? (
              <div className="text-[12px] text-[#6b7280]">{payload ? "No active findings." : "Loading…"}</div>
            ) : (
              <div className="space-y-1">
                {active.map((f) => (
                  <Row key={f.id} f={f} label={labelOf(f.pattern)} selected={f.id === selectedId} onSelect={() => setSelectedId(f.id)} />
                ))}
              </div>
            )}
            <button type="button" onClick={() => setShowEnded((v) => !v)} className="mt-4 flex items-center gap-1 text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">
              {showEnded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              ENDED · {ended.length}
            </button>
            {showEnded ? (
              <div className="mt-2 space-y-1 opacity-80">
                {ended.length === 0 ? <div className="text-[12px] text-[#6b7280]">No ended findings in the retention window.</div> : null}
                {ended.map((f) => (
                  <Row key={f.id} f={f} label={labelOf(f.pattern)} selected={f.id === selectedId} onSelect={() => setSelectedId(f.id)} />
                ))}
              </div>
            ) : null}

            {lastScan && lastScan.degraded.length > 0 ? (
              <>
                <button type="button" onClick={() => setShowDegraded((v) => !v)} className="mt-4 flex items-center gap-1 text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">
                  {showDegraded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  DEGRADED · {lastScan.degraded.length}
                </button>
                {showDegraded ? (
                  <div className="mt-2 space-y-0.5">
                    {lastScan.degraded.map((d, i) => (
                      <div key={`${d.ticker}-${d.pattern}-${i}`} className="flex items-baseline gap-2 text-[11px] text-[#4b5563]">
                        <span className="w-14 font-semibold text-[#1d1b1b]">{d.ticker}</span>
                        <span className="w-32">{d.pattern === "all" ? "all patterns" : labelOf(d.pattern)}</span>
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
              <div className="text-[12px] text-[#6b7280]">Click a finding for its full payload, the qualifying sessions and the Gauge link.</div>
            )}

            {status ? (
              <div className="mt-4 rounded-xl border border-[#e0e0da] bg-white/40 px-3 py-2 text-[10px] text-[#6b7280]">
                <div>
                  data {status.dataDir} · scans {status.scanCount} · poll {status.pollIntervalMs / 1000}s · retention {status.retentionDays}d · last poll {fmtWhen(status.lastPollAt)}
                  {status.r2Floor != null ? ` · r² floor ${status.r2Floor}` : ""}
                </div>
                <div>
                  patterns{" "}
                  {SCREEN_PATTERNS.map((p) => `${p} ${status.patterns[p].enabled ? "on" : "off"}/p${status.patterns[p].priority}`).join(" · ")}
                </div>
                {status.keys ? (
                  <div className="font-mono">
                    hook session {status.keys.session} · close-run landed {status.keys.landed}/{status.keys.total}
                  </div>
                ) : null}
                {status.lastError ? <div className="text-red-600">last error: {status.lastError}</div> : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="border-t border-[#e0e0da] px-5 py-2 text-[10px] text-[#9CA3AF]">
          Shift+S to toggle · Esc to close · surface-only apart from the S1 emit gate (EMITTED = a first sighting sent to Base) · conditions, not predictions
        </div>
      </div>
    </div>
  );
}
