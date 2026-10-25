import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutList, Play, RefreshCw, Waves, X } from "lucide-react";
import { isLiveRun, runBadge } from "@/lib/second-order-card";
import { useI18n, type TFunction } from "@/lib/i18n";
import { plural } from "@/lib/panels-format";
import { shortcutText } from "@/lib/shortcuts";
import { useIsStaff } from "@/lib/staff";
import type {
  PropagationRun,
  PropagationRunListItem,
  PropagationStatus,
} from "../../../shared/propagation-run-types";
import RippleMap from "./RippleMap";
import RippleTable from "./RippleTable";
import TargetDrawer from "./TargetDrawer";
import { targetKey } from "./ripple-layout";
import { repairRun, repairRunList, repairRunListItem } from "../../../shared/display-text";
import {
  ACCENT,
  AMBER,
  AMBER_LINE,
  AMBER_SOFT,
  directionColor,
  directionGlyph,
  directionWord,
  eventTypeWord,
  fmtDay,
  fmtLag,
  fmtWhen,
  materialityWord,
  summaryLine,
} from "./ripple-format";

/**
 * The ripple view (spec §8) — Shift+P. Left rail: recent runs. Header: the
 * event card (serif headline). Centre: the ripple map or the ranked table.
 * Right: the target drawer. Every state is designed: loading, the run, the
 * no-edge statement (a feature, not an apology), stage-1-only, stale.
 */

type Props = {
  onClose: () => void;
  /** Land on this run, and open this target's drawer once the run resolves. */
  focus?: { runId: string; targetKey?: string } | null;
};

/**
 * The rail badge in the reader's language. Which badge a run gets is
 * `runBadge`'s call (shared with the dashboard card); only its tone is read
 * here, and the words are this panel's own.
 */
function badgeWord(summary: PropagationRunListItem["summary"], tone: string, t: TFunction): string {
  if (tone === "open") return t("panels.ripple.badge.open", { n: summary.open });
  if (tone === "against") return t("panels.ripple.badge.against", { n: summary.contradicted ?? 0 });
  if (tone === "partial") return t("panels.ripple.badge.partial", { n: summary.partial });
  if (tone === "priced") return t("panels.ripple.badge.priced", { n: summary.priced });
  return t("panels.ripple.badge.none");
}

function RunRow({ item, active, onClick }: { item: PropagationRunListItem; active: boolean; onClick: () => void }) {
  const { t, locale } = useI18n();
  const badge = runBadge(item.summary);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`app-no-drag w-full rounded-lg px-3 py-2 text-left transition-colors ${active ? "bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]" : "hover:bg-white/60"}`}
      style={{ opacity: item.superseded ? 0.55 : 1 }}
    >
      <div className="flex items-center gap-2">
        <span className="font-baskerville text-[14px] leading-none text-content-primary">{item.root_ticker}</span>
        <span className="text-[10px]" style={{ color: directionColor(item.event_direction) }}>
          {directionGlyph(item.event_direction)}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-content-disabled">{fmtDay(item.event_ts, locale, t("common.na"))}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-content-secondary">{item.event_label}</div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          className="rounded-full px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em]"
          style={
            badge.tone === "open"
              ? { background: ACCENT, color: "#fff", border: `1px solid ${ACCENT}` }
              : badge.tone === "against"
                ? { background: AMBER_SOFT, color: AMBER, border: `1px solid ${AMBER_LINE}` }
                : { color: "var(--text-tertiary)", border: "1px solid var(--border-default)" }
          }
        >
          {badgeWord(item.summary, badge.tone, t)}
        </span>
        <span className="text-[10px] text-content-disabled">
          {plural(t, locale, "panels.ripple.summary.names", item.summary.targets)}
          {item.status === "stage1_only" ? ` · ${t("panels.ripple.stage1")}` : ""}
          {item.superseded ? ` · ${t("panels.ripple.superseded")}` : ""}
        </span>
      </div>
    </button>
  );
}

function Skeleton() {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div className="absolute h-[52%] w-[52%] rounded-full border border-edge" />
      <div className="absolute h-[34%] w-[34%] rounded-full border border-edge" />
      <div className="h-20 w-20 animate-pulse rounded-full bg-surface-3" />
      {[0, 90, 180, 270].map((deg) => (
        <div
          key={deg}
          className="absolute h-11 w-[92px] animate-pulse rounded-lg bg-surface-3"
          style={{ transform: `rotate(${deg}deg) translate(0, -190px) rotate(${-deg}deg)` }}
        />
      ))}
    </div>
  );
}

function NoEdge({ run }: { run: PropagationRun }) {
  const { t, locale } = useI18n();
  const reason =
    run.reachable === 0
      ? t("panels.ripple.noEdge.noRelationships", { ticker: run.root_ticker })
      : run.targets.length === 0
        ? plural(t, locale, "panels.ripple.noEdge.noneTransmit", run.reachable, { type: eventTypeWord(run.event.type, t) })
        : t("panels.ripple.noEdge.allPriced");
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-12 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-edge">
        <div className="h-3 w-3 rounded-full bg-ink" />
      </div>
      <h2 className="font-baskerville text-[28px] leading-tight text-content-primary">{t("panels.ripple.noEdge.title")}</h2>
      <p className="mt-3 max-w-[440px] text-[13px] leading-relaxed text-content-secondary">{reason}</p>
      {run.targets.length > 0 && (
        <p className="mt-2 text-[11px] text-content-tertiary">
          {summaryLine(run.summary, t, locale)}
          {run.non_transmitting ? ` · ${t("panels.ripple.summary.nonTransmitting", { n: run.non_transmitting })}` : ""}
        </p>
      )}
    </div>
  );
}

export default function RipplePanel({ onClose, focus }: Props) {
  const { t, locale } = useI18n();
  // "Run now" and the surfacing switch change propagation for every account:
  // the engine takes them from staff only.
  const staff = useIsStaff();
  const na = t("common.na");
  /** For fallback wording inside callbacks that must not re-run when the language changes. */
  const tRef = useRef(t);
  tRef.current = t;
  const [runs, setRuns] = useState<PropagationRunListItem[] | null>(null);
  /** Fixture / synthetic runs — listed apart, never mixed into the live stream. */
  const [fixtures, setFixtures] = useState<PropagationRunListItem[]>([]);
  const [status, setStatus] = useState<PropagationStatus | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<PropagationRun | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"map" | "list">("map");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);
  /** Resolved runs — everything priced, nothing left open. Off by default;
   *  their absorption curves are the calibration record, so they stay reachable. */
  const [showResolved, setShowResolved] = useState(false);
  /** What the last manual cycle did — cleared on the next click. */
  const [note, setNote] = useState<string | null>(null);
  /** A drawer the caller asked for, held until its run has loaded. */
  const pendingKey = useRef<string | null>(focus?.targetKey ?? null);

  const loadList = useCallback(async () => {
    try {
      const [r, f, s] = await Promise.all([
        window.meridian?.listPropagationRuns({ limit: 200 }),
        window.meridian?.listPropagationRuns({ limit: 50, synthetic: "only" }),
        window.meridian?.getPropagationStatus(),
      ]);
      if (r?.ok) {
        setRuns(repairRunList(r.runs));
        setError(null);
      } else {
        setRuns([]);
        setError(r?.error ?? tRef.current("panels.ripple.error.unavailable"));
      }
      setFixtures(f?.ok ? repairRunList(f.runs).filter((r) => isLiveRun(r.summary)) : []);
      if (s?.ok) setStatus(s.status);
    } catch (err) {
      // A main process without the handlers (stale dev build) must not leave the
      // skeleton up forever.
      setRuns([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // The fast lane pushes a run the moment it exists — prepend it rather than
  // waiting for the next manual refresh, and select it when nothing is open.
  useEffect(() => {
    const off = window.meridian?.onPropagationEvent?.((pushed) => {
      const incoming = repairRunListItem(pushed);
      setRuns((prev) => {
        const rest = (prev ?? []).filter((r) => r.run_id !== incoming.run_id);
        return [incoming, ...rest];
      });
      setNote(tRef.current("panels.ripple.note.fastPath", { ticker: incoming.root_ticker, open: incoming.summary.open, n: incoming.summary.targets }));
    });
    return () => off?.();
  }, []);

  // Opened from elsewhere in the app (the second-order card's target strip):
  // jump to that run, and remember which drawer to open when it arrives.
  useEffect(() => {
    if (!focus?.runId) return;
    pendingKey.current = focus.targetKey ?? null;
    setSelectedRunId(focus.runId);
  }, [focus]);

  // Default to the newest current run.
  // A run is listed while it still has something to say: an open target, a
  // partial one, or one the tape moved against (isLiveRun). Fully priced and
  // nothing-transmitted runs stay in the store and the counters only.
  const visibleRuns = useMemo(
    () =>
      (runs ?? []).filter(
        (r) => (showSuperseded || !r.superseded) && (showResolved || isLiveRun(r.summary)),
      ),
    [runs, showSuperseded, showResolved],
  );
  const liveCount = useMemo(
    () => visibleRuns.filter((r) => isLiveRun(r.summary)).length,
    [visibleRuns],
  );
  const hiddenNoEdge = useMemo(
    () =>
      (runs ?? []).filter((r) => (showSuperseded || !r.superseded) && !isLiveRun(r.summary)).length,
    [runs, showSuperseded],
  );
  useEffect(() => {
    if (!selectedRunId && visibleRuns.length > 0) setSelectedRunId(visibleRuns[0].run_id);
  }, [visibleRuns, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    setLoadingRun(true);
    setSelectedKey(null);
    void window.meridian
      ?.getPropagationRun(selectedRunId)
      .then((res) => {
        if (cancelled) return;
        setLoadingRun(false);
        if (res?.ok) {
          setRun(repairRun(res.run));
          if (pendingKey.current) {
            setSelectedKey(pendingKey.current);
            pendingKey.current = null;
          }
        } else setError(res?.error ?? tRef.current("panels.ripple.error.run"));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadingRun(false);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedKey) setSelectedKey(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, selectedKey]);

  /**
   * A cycle usually produces nothing: every qualifying incident already has a
   * run, and the list is unchanged. Say so — silence reads as a dead button.
   */
  const runCycle = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await window.meridian?.runPropagationCycle({});
      if (res?.ok) {
        setStatus(res.status);
        await loadList();
        const r = res.run;
        const made = r.ok + r.stage1_only;
        if (r.errors.length > 0) setNote(r.errors[0]);
        else if (made > 0) {
          const parts = [plural(t, locale, "panels.ripple.note.newRuns", made)];
          if (r.stage2_calls > 0) parts.push(t("panels.ripple.note.refined", { n: r.stage2_calls }));
          if (r.failed > 0) parts.push(t("panels.ripple.note.failed", { n: r.failed }));
          setNote(parts.join(" · "));
        } else {
          setNote(
            r.below_band > 0
              ? plural(t, locale, "panels.ripple.note.nothingNewBelow", r.already_produced, { below: r.below_band })
              : plural(t, locale, "panels.ripple.note.nothingNew", r.already_produced),
          );
        }
      } else setError(res?.error ?? t("panels.ripple.error.cycle"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const selectedTarget = useMemo(
    () => (run && selectedKey ? run.targets.find((t) => targetKey(t) === selectedKey) ?? null : null),
    [run, selectedKey],
  );

  const stale = run ? run.targets.some((t) => t.pricing.status === "stale") && run.summary.open === 0 && run.summary.partial === 0 : false;
  const graphStamp = run
    ? t("panels.ripple.graphStamp", { version: run.graph_version.pipelineVersion, date: fmtDay(run.graph_version.generatedAt, locale, na) })
    : null;
  const lag = run ? fmtLag(run.event.event_ts, run.produced_at, t, locale) : null;

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-ink/30 backdrop-blur-[3px]">
      <div className="flex h-[90%] w-[94%] overflow-hidden rounded-2xl border border-edge bg-surface-2 shadow-[0_30px_80px_rgba(0,0,0,0.25)]">
        {/* Left rail — run list */}
        <aside className="flex w-[250px] shrink-0 flex-col border-r border-edge bg-surface-2">
          <div className="flex items-center gap-2 px-4 pb-2 pt-4">
            <Waves className="h-4 w-4 text-content-primary" strokeWidth={1.75} aria-hidden />
            <span className="font-baskerville text-[15px] text-content-primary">{t("panels.ripple.title")}</span>
            <span className="ml-auto text-[10px] text-content-disabled">
              {t("panels.ripple.live", { n: liveCount })}
              {hiddenNoEdge > 0
                ? ` · ${t(showResolved ? "panels.ripple.resolved" : "panels.ripple.hidden", { n: hiddenNoEdge })}`
                : ""}
            </span>
          </div>
          <div className="scrollbar-meridian min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {runs === null && (
              <div className="space-y-2 p-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-3" />
                ))}
              </div>
            )}
            {runs !== null && visibleRuns.length === 0 && (
              <div className="px-3 py-6 text-[11.5px] leading-relaxed text-content-tertiary">
                {hiddenNoEdge > 0 && !showResolved
                  ? plural(t, locale, "panels.ripple.empty.hidden", hiddenNoEdge)
                  : t("panels.ripple.empty.none")}
              </div>
            )}
            {visibleRuns.map((item) => (
              <RunRow key={item.run_id} item={item} active={item.run_id === selectedRunId} onClick={() => setSelectedRunId(item.run_id)} />
            ))}
            {fixtures.length > 0 && (
              <div className="mt-3 border-t border-dashed border-edge pt-2">
                <div className="flex items-center justify-between px-3 pb-1">
                  <span className="text-[9.5px] uppercase tracking-[0.14em] text-content-disabled">{t("panels.ripple.fixtures")}</span>
                  <span className="text-[9.5px] text-content-disabled">{t("panels.ripple.fixturesNote")}</span>
                </div>
                {fixtures.map((item) => (
                  <RunRow key={item.run_id} item={item} active={item.run_id === selectedRunId} onClick={() => setSelectedRunId(item.run_id)} />
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-edge px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <button
                type="button"
                disabled={!staff || busy}
                onClick={() => void runCycle()}
                className="app-no-drag inline-flex items-center gap-1.5 rounded-md border border-edge bg-white px-2 py-1 text-[10.5px] text-content-primary transition-colors hover:bg-surface-2 disabled:opacity-50"
                title={staff ? t("panels.ripple.runNowTitle") : t("access.staffOnly.action")}
              >
                {busy ? <RefreshCw className="h-3 w-3 animate-spin" strokeWidth={1.75} /> : <Play className="h-3 w-3" strokeWidth={1.75} />}
                {t("panels.ripple.runNow")}
              </button>
              <button
                type="button"
                onClick={() => setShowSuperseded((v) => !v)}
                className="app-no-drag text-[10px] text-content-tertiary transition-colors hover:text-content-primary"
              >
                {showSuperseded ? t("panels.ripple.hideSuperseded") : t("panels.ripple.showSuperseded")}
              </button>
              {hiddenNoEdge > 0 && (
                <button
                  type="button"
                  onClick={() => setShowResolved((v) => !v)}
                  className="app-no-drag text-[10px] text-content-tertiary transition-colors hover:text-content-primary"
                  title={t("panels.ripple.resolvedTitle")}
                >
                  {t(showResolved ? "panels.ripple.hideResolved" : "panels.ripple.showResolved", { n: hiddenNoEdge })}
                </button>
              )}
            </div>
            {status && (
              <div className="mt-2 space-y-0.5 font-mono text-[9.5px] text-content-disabled">
                <div>
                  {t("panels.ripple.status.loop", {
                    loop: t(status.enabled ? "panels.ripple.status.on" : "panels.ripple.status.off"),
                    model: status.configured ? status.model : t("panels.ripple.status.noKey"),
                    used: status.budget.used,
                    daily: status.budget.daily,
                  })}
                </div>
                <div>
                  {t("panels.ripple.status.rates", {
                    open: status.metrics.targets_total ? Math.round((100 * status.metrics.open_total) / status.metrics.targets_total) : 0,
                    untracked: status.metrics.targets_total ? Math.round((100 * status.metrics.untracked_total) / status.metrics.targets_total) : 0,
                    vetoes: status.metrics.vetoes,
                    resolved: status.metrics.unclear_resolved,
                    total: status.metrics.unclear_total,
                  })}
                </div>
                <div style={{ color: status.metrics.contradicted_total > 0 ? AMBER : undefined }}>
                  {t("panels.ripple.status.contradicted", {
                    pct: status.metrics.targets_total
                      ? Math.round((100 * status.metrics.contradicted_total) / status.metrics.targets_total)
                      : 0,
                    n: status.metrics.contradicted_total,
                  })}
                </div>
                {status.last_run && (
                  <div>
                    {t("panels.ripple.status.lastCycle", {
                      when: fmtWhen(status.last_run.finished_at, locale, na),
                      requests: status.last_run.requests_built,
                      ok: status.last_run.ok,
                      stage1: status.last_run.stage1_only,
                    })}
                  </div>
                )}
                {/* Phase B in one click: the dashboard card is dark until this
                    is on, and until now the only way to flip it was the config
                    file plus a restart. */}
                <button
                  type="button"
                  disabled={!staff}
                  title={staff ? undefined : t("access.staffOnly.setting")}
                  className="app-no-drag text-left font-mono text-[9.5px] text-content-disabled underline decoration-dotted underline-offset-2 hover:text-content-secondary disabled:pointer-events-none disabled:no-underline"
                  onClick={() => {
                    void (async () => {
                      await window.meridian?.setPropagationSurfacing(!status.surfacing_enabled);
                      await loadList();
                    })();
                  }}
                >
                  {status.surfacing_enabled
                    ? t("panels.ripple.status.surfacingOn")
                    : t("panels.ripple.status.surfacingOff", { shortcut: shortcutText("propagation") })}
                </button>
              </div>
            )}
            {note && <div className="mt-1.5 font-mono text-[9.5px] leading-relaxed text-content-secondary">{note}</div>}
            {error && <div className="mt-1.5 text-[10px] text-tone-negative">{error}</div>}
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header — event card */}
          <header className="flex items-start gap-4 border-b border-edge px-6 pb-4 pt-5">
            <div className="min-w-0 flex-1">
              {run ? (
                <>
                  <h1 className="font-baskerville text-[26px] leading-[1.15] text-content-primary">
                    <span className="mr-3">{run.root_ticker}</span>
                    <span className="text-content-body">{run.event.label}</span>
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-content-secondary">
                    <span>{eventTypeWord(run.event.type, t)}</span>
                    <span className="text-content-disabled">·</span>
                    <span>{materialityWord(run.event.materiality, t)}</span>
                    <span className="text-content-disabled">·</span>
                    <span style={{ color: directionColor(run.event.direction) }}>
                      {directionGlyph(run.event.direction)} {directionWord(run.event.direction, t)}
                    </span>
                    <span className="text-content-disabled">·</span>
                    <span>{fmtWhen(run.event.event_ts, locale, na)}</span>
                    {lag && (
                      <>
                        <span className="text-content-disabled">·</span>
                        <span
                          title={t("panels.ripple.lagTitle")}
                          style={{ color: Date.parse(run.produced_at) - Date.parse(run.event.event_ts) > 6 * 3600_000 ? AMBER : undefined }}
                        >
                          {lag}
                        </span>
                      </>
                    )}
                    <span className="text-content-disabled">·</span>
                    <span className="text-content-primary">{summaryLine(run.summary, t, locale)}</span>
                    {run.overflow > 0 && <span className="text-content-disabled">{t("panels.ripple.beyondCap", { n: run.overflow })}</span>}
                    {run.synthetic && (
                      <span className="rounded-full border border-dashed border-edge-strong px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-content-tertiary">{t("panels.ripple.fixtureBadge")}</span>
                    )}
                    {run.status === "stage1_only" && (
                      <span className="rounded-full border border-edge px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-content-tertiary">{t("panels.ripple.refinementUnavailable")}</span>
                    )}
                    {stale && <span className="rounded-full border border-edge px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-content-tertiary">{t("panels.ripple.stale")}</span>}
                    {run.superseded_by && <span className="rounded-full border border-edge px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-content-tertiary">{t("panels.ripple.superseded")}</span>}
                  </div>
                </>
              ) : (
                <>
                  <div className="h-7 w-[60%] animate-pulse rounded bg-surface-3" />
                  <div className="mt-2.5 h-3 w-[40%] animate-pulse rounded bg-surface-3" />
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {graphStamp && <span className="font-mono text-[9.5px] text-content-disabled">{graphStamp}</span>}
              <div className="flex rounded-md border border-edge bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setMode("map")}
                  className={`app-no-drag rounded p-1 transition-colors ${mode === "map" ? "bg-ink text-white" : "text-content-tertiary hover:text-content-primary"}`}
                  aria-label={t("panels.ripple.mode.map")}
                  title={t("panels.ripple.mode.mapTitle")}
                >
                  <Waves className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={() => setMode("list")}
                  className={`app-no-drag rounded p-1 transition-colors ${mode === "list" ? "bg-ink text-white" : "text-content-tertiary hover:text-content-primary"}`}
                  aria-label={t("panels.ripple.mode.list")}
                  title={t("panels.ripple.mode.listTitle")}
                >
                  <LayoutList className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="app-no-drag rounded-md p-1 text-content-tertiary transition-colors hover:bg-black/[0.04] hover:text-content-primary"
                aria-label={t("common.close")}
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
          </header>

          {/* Centre + drawer */}
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              {loadingRun || (!run && runs === null) ? (
                <Skeleton />
              ) : !run ? (
                <div className="flex h-full items-center justify-center px-12 text-center">
                  <p className="max-w-[420px] font-baskerville text-[22px] leading-snug text-content-secondary">{t("panels.ripple.pick", { action: t("panels.ripple.runNow") })}</p>
                </div>
              ) : run.targets.length === 0 ? (
                <NoEdge run={run} />
              ) : mode === "map" ? (
                run.targets.length === 0 ? (
                  <NoEdge run={run} />
                ) : (
                  <RippleMap run={run} selectedKey={selectedKey} onSelect={setSelectedKey} />
                )
              ) : (
                <RippleTable run={run} selectedKey={selectedKey} onSelect={setSelectedKey} />
              )}
              {/* The no-edge statement belongs to a run that really has nothing
                  left — never to one the tape argued against (that is the amber
                  line below, and its own badge in the rail). */}
              {run && !isLiveRun(run.summary) && run.targets.length > 0 && mode === "map" && (
                <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
                  <div className="rounded-full border border-edge bg-white/85 px-4 py-1.5 font-baskerville text-[13px] text-content-primary shadow-sm backdrop-blur-sm">
                    {run.summary.untracked > 0 && run.summary.untracked === run.summary.targets
                      ? plural(t, locale, "panels.ripple.noEdge.bannerUntracked", run.summary.untracked)
                      : t("panels.ripple.noEdge.bannerAll")}
                  </div>
                </div>
              )}
              {run && (run.summary.contradicted ?? 0) > 0 && mode === "map" && (
                <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
                  <div
                    className="rounded-full px-4 py-1.5 font-baskerville text-[13px] shadow-sm backdrop-blur-sm"
                    style={{ background: AMBER_SOFT, color: AMBER, border: `1px solid ${AMBER_LINE}` }}
                  >
                    {plural(t, locale, "panels.ripple.againstBanner", run.summary.contradicted ?? 0)}
                  </div>
                </div>
              )}
            </div>
            {run && selectedTarget && <TargetDrawer run={run} target={selectedTarget} onClose={() => setSelectedKey(null)} />}
          </div>
        </div>
      </div>
    </div>
  );
}
