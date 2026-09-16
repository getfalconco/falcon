import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutList, Play, RefreshCw, Waves, X } from "lucide-react";
import { isLiveRun, runBadge } from "@/lib/second-order-card";
import type {
  PropagationRun,
  PropagationRunListItem,
  PropagationStatus,
} from "../../../shared/propagation-run-types";
import RippleMap from "./RippleMap";
import RippleTable from "./RippleTable";
import TargetDrawer from "./TargetDrawer";
import { targetKey } from "./ripple-layout";
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

function RunRow({ item, active, onClick }: { item: PropagationRunListItem; active: boolean; onClick: () => void }) {
  const badge = runBadge(item.summary);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`app-no-drag w-full rounded-lg px-3 py-2 text-left transition-colors ${active ? "bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]" : "hover:bg-white/60"}`}
      style={{ opacity: item.superseded ? 0.55 : 1 }}
    >
      <div className="flex items-center gap-2">
        <span className="font-baskerville text-[14px] leading-none text-[#1d1b1b]">{item.root_ticker}</span>
        <span className="text-[10px]" style={{ color: directionColor(item.event_direction) }}>
          {directionGlyph(item.event_direction)}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-[#b4b4ae]">{fmtDay(item.event_ts)}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-[#6b7280]">{item.event_label}</div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          className="rounded-full px-1.5 py-[1px] text-[9px] font-semibold tracking-[0.08em]"
          style={
            badge.tone === "open"
              ? { background: ACCENT, color: "#fff", border: `1px solid ${ACCENT}` }
              : badge.tone === "against"
                ? { background: AMBER_SOFT, color: AMBER, border: `1px solid ${AMBER_LINE}` }
                : { color: "#9CA3AF", border: "1px solid #e0e0da" }
          }
        >
          {badge.word}
        </span>
        <span className="text-[10px] text-[#b4b4ae]">
          {item.summary.targets} target{item.summary.targets === 1 ? "" : "s"}
          {item.status === "stage1_only" ? " · stage-1" : ""}
          {item.superseded ? " · superseded" : ""}
        </span>
      </div>
    </button>
  );
}

function Skeleton() {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div className="absolute h-[52%] w-[52%] rounded-full border border-[#e6e6e0]" />
      <div className="absolute h-[34%] w-[34%] rounded-full border border-[#e6e6e0]" />
      <div className="h-20 w-20 animate-pulse rounded-full bg-[#e6e6e0]" />
      {[0, 90, 180, 270].map((deg) => (
        <div
          key={deg}
          className="absolute h-11 w-[92px] animate-pulse rounded-lg bg-[#ececE6]"
          style={{ transform: `rotate(${deg}deg) translate(0, -190px) rotate(${-deg}deg)` }}
        />
      ))}
    </div>
  );
}

function NoEdge({ run }: { run: PropagationRun }) {
  const reason =
    run.reachable === 0
      ? `${run.root_ticker} has no relationships in the graph yet.`
      : run.targets.length === 0
        ? `${run.reachable} reachable counterpart${run.reachable === 1 ? "y" : "ies"} — none transmit a ${eventTypeWord(run.event.type).toLowerCase()} event.`
        : "All reachable targets priced or non-transmitting.";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-12 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-[#e0e0da]">
        <div className="h-3 w-3 rounded-full bg-[#1d1b1b]" />
      </div>
      <h2 className="font-baskerville text-[28px] leading-tight text-[#1d1b1b]">No edge across the network.</h2>
      <p className="mt-3 max-w-[440px] text-[13px] leading-relaxed text-[#6b7280]">{reason}</p>
      {run.targets.length > 0 && (
        <p className="mt-2 text-[11px] text-[#9CA3AF]">
          {summaryLine(run.summary)}
          {run.non_transmitting ? ` · ${run.non_transmitting} non-transmitting` : ""}
        </p>
      )}
    </div>
  );
}

export default function RipplePanel({ onClose, focus }: Props) {
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
        setRuns(r.runs);
        setError(null);
      } else {
        setRuns([]);
        setError(r?.error ?? "propagation unavailable");
      }
      setFixtures(f?.ok ? f.runs.filter((r) => isLiveRun(r.summary)) : []);
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
    const off = window.meridian?.onPropagationEvent?.((incoming) => {
      setRuns((prev) => {
        const rest = (prev ?? []).filter((r) => r.run_id !== incoming.run_id);
        return [incoming, ...rest];
      });
      setNote(`${incoming.root_ticker}: ${incoming.summary.open} open · ${incoming.summary.targets} targets (fast path)`);
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
          setRun(res.run);
          if (pendingKey.current) {
            setSelectedKey(pendingKey.current);
            pendingKey.current = null;
          }
        } else setError(res?.error ?? "run unavailable");
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
          setNote(
            `${made} new run${made === 1 ? "" : "s"}` +
              (r.stage2_calls > 0 ? ` · ${r.stage2_calls} refined` : "") +
              (r.failed > 0 ? ` · ${r.failed} failed` : ""),
          );
        } else {
          setNote(
            `Nothing new — ${r.already_produced} incident${r.already_produced === 1 ? "" : "s"} already have a run` +
              (r.below_band > 0 ? `, ${r.below_band} below the dispatch band` : "") +
              ".",
          );
        }
      } else setError(res?.error ?? "cycle failed");
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
  const graphStamp = run ? `graph pv${run.graph_version.pipelineVersion} · ${fmtDay(run.graph_version.generatedAt)}` : null;

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-[#1d1b1b]/30 backdrop-blur-[3px]">
      <div className="flex h-[90%] w-[94%] overflow-hidden rounded-2xl border border-[#e6e6e0] bg-[#f7f7f4] shadow-[0_30px_80px_rgba(0,0,0,0.25)]">
        {/* Left rail — run list */}
        <aside className="flex w-[250px] shrink-0 flex-col border-r border-[#e6e6e0] bg-[#f3f3ef]">
          <div className="flex items-center gap-2 px-4 pb-2 pt-4">
            <Waves className="h-4 w-4 text-[#1d1b1b]" strokeWidth={1.75} aria-hidden />
            <span className="font-baskerville text-[15px] text-[#1d1b1b]">Propagation</span>
            <span className="ml-auto text-[10px] text-[#b4b4ae]">
              {liveCount} live
              {hiddenNoEdge > 0 ? ` · ${hiddenNoEdge} ${showResolved ? "resolved" : "hidden"}` : ""}
            </span>
          </div>
          <div className="scrollbar-meridian min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {runs === null && (
              <div className="space-y-2 p-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-[#e9e9e3]" />
                ))}
              </div>
            )}
            {runs !== null && visibleRuns.length === 0 && (
              <div className="px-3 py-6 text-[11.5px] leading-relaxed text-[#9CA3AF]">
                {hiddenNoEdge > 0 && !showResolved
                  ? `No open edge right now — ${hiddenNoEdge} run${hiddenNoEdge === 1 ? "" : "s"} with nothing left to absorb are hidden.`
                  : "No runs yet. A run is produced when Base routes a mapped 8-K or event gap, or when a P2+ incident carries a network-relevant verdict."}
              </div>
            )}
            {visibleRuns.map((item) => (
              <RunRow key={item.run_id} item={item} active={item.run_id === selectedRunId} onClick={() => setSelectedRunId(item.run_id)} />
            ))}
            {fixtures.length > 0 && (
              <div className="mt-3 border-t border-dashed border-[#e0e0da] pt-2">
                <div className="flex items-center justify-between px-3 pb-1">
                  <span className="text-[9.5px] uppercase tracking-[0.14em] text-[#b4b4ae]">Fixtures</span>
                  <span className="text-[9.5px] text-[#b4b4ae]">synthetic · not in the rubric</span>
                </div>
                {fixtures.map((item) => (
                  <RunRow key={item.run_id} item={item} active={item.run_id === selectedRunId} onClick={() => setSelectedRunId(item.run_id)} />
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-[#e6e6e0] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void runCycle()}
                className="app-no-drag inline-flex items-center gap-1.5 rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[10.5px] text-[#1d1b1b] transition-colors hover:bg-[#fbfbf9] disabled:opacity-50"
                title="Replay Base over the Tracker stream and run every qualifying incident"
              >
                {busy ? <RefreshCw className="h-3 w-3 animate-spin" strokeWidth={1.75} /> : <Play className="h-3 w-3" strokeWidth={1.75} />}
                Run now
              </button>
              <button
                type="button"
                onClick={() => setShowSuperseded((v) => !v)}
                className="app-no-drag text-[10px] text-[#9CA3AF] transition-colors hover:text-[#1d1b1b]"
              >
                {showSuperseded ? "hide superseded" : "show superseded"}
              </button>
              {hiddenNoEdge > 0 && (
                <button
                  type="button"
                  onClick={() => setShowResolved((v) => !v)}
                  className="app-no-drag text-[10px] text-[#9CA3AF] transition-colors hover:text-[#1d1b1b]"
                  title="Runs with nothing left open. Their absorption curves are how we learn when a second-order move actually arrives."
                >
                  {showResolved ? "hide" : "show"} {hiddenNoEdge} resolved
                </button>
              )}
            </div>
            {status && (
              <div className="mt-2 space-y-0.5 font-mono text-[9.5px] text-[#b4b4ae]">
                <div>
                  loop {status.enabled ? "on" : "off"} · stage-2 {status.configured ? status.model : "no key"} · budget {status.budget.used}/{status.budget.daily}
                </div>
                <div>
                  open-rate {status.metrics.targets_total ? Math.round((100 * status.metrics.open_total) / status.metrics.targets_total) : 0}% · untracked{" "}
                  {status.metrics.targets_total ? Math.round((100 * status.metrics.untracked_total) / status.metrics.targets_total) : 0}% · vetoes {status.metrics.vetoes} · unclear resolved{" "}
                  {status.metrics.unclear_resolved}/{status.metrics.unclear_total}
                </div>
                <div style={{ color: status.metrics.contradicted_total > 0 ? AMBER : undefined }}>
                  contradicted-rate{" "}
                  {status.metrics.targets_total
                    ? Math.round((100 * status.metrics.contradicted_total) / status.metrics.targets_total)
                    : 0}
                  % ({status.metrics.contradicted_total}) — matrix calibration signal
                </div>
                {status.last_run && (
                  <div>
                    last cycle {fmtWhen(status.last_run.finished_at)} · {status.last_run.requests_built} req · {status.last_run.ok} ok · {status.last_run.stage1_only} stage-1
                  </div>
                )}
                {/* Phase B in one click: the dashboard card is dark until this
                    is on, and until now the only way to flip it was the config
                    file plus a restart. */}
                <button
                  type="button"
                  className="app-no-drag text-left font-mono text-[9.5px] text-[#b4b4ae] underline decoration-dotted underline-offset-2 hover:text-[#6b6b64]"
                  onClick={() => {
                    void (async () => {
                      await window.meridian?.setPropagationSurfacing(!status.surfacing_enabled);
                      await loadList();
                    })();
                  }}
                >
                  {status.surfacing_enabled
                    ? "surfacing on · dashboard may show runs"
                    : "Phase A · Shift+P only — turn surfacing on"}
                </button>
              </div>
            )}
            {note && <div className="mt-1.5 font-mono text-[9.5px] leading-relaxed text-[#6b7280]">{note}</div>}
            {error && <div className="mt-1.5 text-[10px] text-[#DC2626]">{error}</div>}
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header — event card */}
          <header className="flex items-start gap-4 border-b border-[#e6e6e0] px-6 pb-4 pt-5">
            <div className="min-w-0 flex-1">
              {run ? (
                <>
                  <h1 className="font-baskerville text-[26px] leading-[1.15] text-[#1d1b1b]">
                    <span className="mr-3">{run.root_ticker}</span>
                    <span className="text-[#3b3b3b]">{run.event.label}</span>
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[#6b7280]">
                    <span>{eventTypeWord(run.event.type)}</span>
                    <span className="text-[#d6d6cf]">·</span>
                    <span>{run.event.materiality} materiality</span>
                    <span className="text-[#d6d6cf]">·</span>
                    <span style={{ color: directionColor(run.event.direction) }}>
                      {directionGlyph(run.event.direction)} {directionWord(run.event.direction)}
                    </span>
                    <span className="text-[#d6d6cf]">·</span>
                    <span>{fmtWhen(run.event.event_ts)}</span>
                    {fmtLag(run.event.event_ts, run.produced_at) && (
                      <>
                        <span className="text-[#d6d6cf]">·</span>
                        <span
                          title="Event instant → run produced. Under an hour is a move that may still be open; days mean the tape had it first."
                          style={{ color: Date.parse(run.produced_at) - Date.parse(run.event.event_ts) > 6 * 3600_000 ? AMBER : undefined }}
                        >
                          {fmtLag(run.event.event_ts, run.produced_at)}
                        </span>
                      </>
                    )}
                    <span className="text-[#d6d6cf]">·</span>
                    <span className="text-[#1d1b1b]">{summaryLine(run.summary)}</span>
                    {run.overflow > 0 && <span className="text-[#b4b4ae]">+{run.overflow} beyond cap</span>}
                    {run.synthetic && (
                      <span className="rounded-full border border-dashed border-[#d6d6cf] px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-[#9CA3AF]">fixture · synthetic</span>
                    )}
                    {run.status === "stage1_only" && (
                      <span className="rounded-full border border-[#e0e0da] px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-[#9CA3AF]">refinement unavailable</span>
                    )}
                    {stale && <span className="rounded-full border border-[#e0e0da] px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-[#9CA3AF]">stale</span>}
                    {run.superseded_by && <span className="rounded-full border border-[#e0e0da] px-1.5 py-[1px] text-[9.5px] tracking-[0.06em] text-[#9CA3AF]">superseded</span>}
                  </div>
                </>
              ) : (
                <>
                  <div className="h-7 w-[60%] animate-pulse rounded bg-[#e9e9e3]" />
                  <div className="mt-2.5 h-3 w-[40%] animate-pulse rounded bg-[#ececE6]" />
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {graphStamp && <span className="font-mono text-[9.5px] text-[#b4b4ae]">{graphStamp}</span>}
              <div className="flex rounded-md border border-[#e0e0da] bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setMode("map")}
                  className={`app-no-drag rounded p-1 transition-colors ${mode === "map" ? "bg-[#1d1b1b] text-white" : "text-[#9CA3AF] hover:text-[#1d1b1b]"}`}
                  aria-label="Map"
                  title="Ripple map"
                >
                  <Waves className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={() => setMode("list")}
                  className={`app-no-drag rounded p-1 transition-colors ${mode === "list" ? "bg-[#1d1b1b] text-white" : "text-[#9CA3AF] hover:text-[#1d1b1b]"}`}
                  aria-label="List"
                  title="Ranked table"
                >
                  <LayoutList className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="app-no-drag rounded-md p-1 text-[#9CA3AF] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
                aria-label="Close"
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
                  <p className="max-w-[420px] font-baskerville text-[22px] leading-snug text-[#6b7280]">Select a run — or press Run now to replay Base over the Tracker stream.</p>
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
                  <div className="rounded-full border border-[#e0e0da] bg-white/85 px-4 py-1.5 font-baskerville text-[13px] text-[#1d1b1b] shadow-sm backdrop-blur-sm">
                    {run.summary.untracked > 0 && run.summary.untracked === run.summary.targets
                      ? `No edge across the tracked network — ${run.summary.untracked} reachable counterpart${run.summary.untracked === 1 ? "y is" : "ies are"} untracked.`
                      : "No edge across the network — all reachable targets priced or non-transmitting."}
                  </div>
                </div>
              )}
              {run && (run.summary.contradicted ?? 0) > 0 && mode === "map" && (
                <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
                  <div
                    className="rounded-full px-4 py-1.5 font-baskerville text-[13px] shadow-sm backdrop-blur-sm"
                    style={{ background: AMBER_SOFT, color: AMBER, border: `1px solid ${AMBER_LINE}` }}
                  >
                    {run.summary.contradicted} target{run.summary.contradicted === 1 ? "" : "s"} moved against the transmitted direction.
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
