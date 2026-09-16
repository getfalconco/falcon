import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Play, RefreshCw } from "lucide-react";
import {
  ANALYST_CAUSES,
  ANALYST_EDGE_STATUSES,
  ANALYST_REQUEST_KINDS,
  type AnalystCause,
  type AnalystEdgeStatus,
  type AnalystOutput,
  type AnalystOutputDetail,
  type AnalystReactionState,
  type AnalystRequestKind,
  type AnalystStatus,
} from "../../../shared/analyst-types";

/**
 * Analyst instrument view (spec §9), mounted inside the Base panel as its
 * third tab; Shift+A opens the panel straight here. Stream of outputs
 * (`TICKER · kind · cause · edge_status · watch_trigger`), click → the full
 * output with its reaction_state, resolved evidence and a link to the source
 * incident. Sidebar: counts by cause and edge_status, edge_deviations,
 * grounding_failed, failures/retries, latency p50/p95, estimated spend, the
 * budget, the breaker and the Phase A switch. Phase B surfacing is displayed
 * only — it flips after the rubric gate.
 */

const CAUSE_STYLE: Record<AnalystCause, string> = {
  identified: "bg-[#dcfce7] text-[#166534]",
  partially_identified: "bg-[#fef3c7] text-[#92400e]",
  unidentified: "bg-[#f1f1ec] text-[#6b7280]",
};

const EDGE_STYLE: Record<AnalystEdgeStatus, string> = {
  no_edge: "bg-[#f1f1ec] text-[#8b8b86]",
  potential_edge: "bg-[#ede9fe] text-[#5b21b6]",
  watch: "bg-[#e0f2fe] text-[#075985]",
};

const KIND_STYLE: Record<AnalystRequestKind, string> = {
  anomaly_review: "bg-[#e0e7ff] text-[#3730a3]",
  scheduled_brief: "bg-[#ffedd5] text-[#9a3412]",
  // S3: Screen-driven structure reviews read as a distinct channel.
  structure_review: "bg-[#ccfbf1] text-[#0f766e]",
};

function fmtTime(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function fmtPct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(2)}%`;
}

function Counter({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 font-mono text-[10px]">
      <span className="text-[#b4b4ae]">{label}</span>
      <span className={tone ?? "text-[#1d1b1b]"}>{value}</span>
    </div>
  );
}

function Switch({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      title={hint}
      className="flex w-full items-center justify-between rounded border border-[#e0e0da] bg-white px-2 py-1 text-left font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
    >
      <span>{label}</span>
      <span
        className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${
          checked ? "bg-[#dcfce7] text-[#166534]" : "bg-[#f1f1ec] text-[#8b8b86]"
        }`}
      >
        {checked ? "on" : "off"}
      </span>
    </button>
  );
}

function Bar({ label, value, max, className }: { label: string; value: number; max: number; className: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className={`w-[118px] shrink-0 truncate rounded px-1.5 py-0.5 font-mono text-[10px] ${className}`}>{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#ececE6]">
        <div className="h-full rounded-full bg-[#1d1b1b]/25" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-5 shrink-0 text-right font-mono text-[10px] text-[#6b7280]">{value}</span>
    </div>
  );
}

function ReactionBlock({ r }: { r: AnalystReactionState }) {
  return (
    <div className="rounded border border-[#e0e0da] bg-white px-2 py-1.5 font-mono text-[10px] text-[#1d1b1b]">
      <div className="mb-1 text-[#b4b4ae]">reaction_state</div>
      <div>
        basis <span className="text-[#6b7280]">{r.basis}</span> · realized_z{" "}
        <span className={r.realized_z != null && Math.abs(r.realized_z) >= 2 ? "text-[#991b1b]" : undefined}>{fmtNum(r.realized_z)}</span>{" "}
        · realized {fmtPct(r.realized_pct)}
      </div>
      <div>
        best_cause{" "}
        {r.best_cause ? (
          <span className="text-[#6b7280]" title={r.best_cause.headline}>
            {r.best_cause.event_type} · {r.best_cause.materiality} · {r.best_cause.direction}
          </span>
        ) : (
          <span className="text-[#b4b4ae]">none</span>
        )}
      </div>
      <div>
        tier_expectation_z {fmtNum(r.tier_expectation_z, 1)} · comparison <span className="text-[#6b7280]">{r.comparison}</span> · edge_default{" "}
        <span className="text-[#6b7280]">{r.edge_default}</span>
      </div>
    </div>
  );
}

function OutputRow({ o, selected, onSelect }: { o: AnalystOutput; selected: boolean; onSelect: () => void }) {
  return (
    <li className={`py-1.5 ${selected ? "bg-[#f1f1ec]/70" : ""}`}>
      <button type="button" onClick={onSelect} className="w-full px-1 text-left">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="w-[82px] shrink-0 font-mono text-[10px] text-[#a3a39c]">{fmtTime(o.produced_at)}</span>
          <span className="font-mono text-[11px] font-medium text-[#1d1b1b]">{o.ticker}</span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${KIND_STYLE[o.kind]}`}>{o.kind}</span>
          {o.status === "failed" ? (
            <span className="rounded bg-[#fee2e2] px-1.5 py-0.5 font-mono text-[10px] text-[#991b1b]">failed</span>
          ) : (
            <>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${CAUSE_STYLE[o.cause]}`}>{o.cause}</span>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${EDGE_STYLE[o.edge_status]}`}>{o.edge_status}</span>
            </>
          )}
          {o.grounding_failed && (
            <span className="rounded bg-[#fef3c7] px-1.5 py-0.5 font-mono text-[10px] text-[#92400e]" title="cause downgraded after repeated grounding failures">
              grounding_failed
            </span>
          )}
          {o.edge_deviation && (
            <span className="rounded bg-[#ede9fe] px-1.5 py-0.5 font-mono text-[10px] text-[#5b21b6]" title={`edge_status differs from edge_default ${o.reaction_state.edge_default}`}>
              deviation
            </span>
          )}
          {o.update && <span className="rounded border border-[#e0e0da] px-1.5 py-0.5 font-mono text-[10px] text-[#8b8b86]">update</span>}
          {o.superseded_by && (
            <span className="rounded border border-dashed border-[#e0e0da] px-1.5 py-0.5 font-mono text-[10px] text-[#b4b4ae]" title={`superseded by ${o.superseded_by}`}>
              superseded
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate pl-[90px] text-[12px] text-[#1d1b1b]" title={o.status === "failed" ? o.failure_reason ?? "" : o.watch_trigger ?? o.cause_summary}>
          {o.status === "failed" ? o.failure_reason : o.watch_trigger ?? o.cause_summary}
        </div>
      </button>
    </li>
  );
}

function Detail({
  detail,
  onOpenIncident,
}: {
  detail: AnalystOutputDetail;
  onOpenIncident: (ticker: string, incidentId: string) => void;
}) {
  const o = detail.output;
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-medium text-[#1d1b1b]">{o.ticker}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${KIND_STYLE[o.kind]}`}>{o.kind}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${CAUSE_STYLE[o.cause]}`}>{o.cause}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${EDGE_STYLE[o.edge_status]}`}>{o.edge_status}</span>
        {o.status === "failed" && <span className="rounded bg-[#fee2e2] px-1.5 py-0.5 font-mono text-[10px] text-[#991b1b]">failed</span>}
        <span className="ml-auto font-mono text-[10px] text-[#a3a39c]">
          {o.model} · {o.prompt_version} · {o.attempts} attempt{o.attempts === 1 ? "" : "s"} · {(o.latency_ms / 1000).toFixed(1)}s
        </span>
      </div>

      {o.status === "failed" ? (
        <div className="font-mono text-[11px] text-[#b45309]">{o.failure_reason}</div>
      ) : (
        <>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">cause_summary</div>
            <div className="text-[12px] text-[#1d1b1b]">{o.cause_summary}</div>
          </div>
          {o.mechanism && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">mechanism</div>
              <div className="text-[12px] text-[#1d1b1b]">{o.mechanism}</div>
            </div>
          )}
          {o.edge_rationale && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">
                edge_rationale{o.edge_deviation ? ` · deviation from ${o.reaction_state.edge_default}` : ""}
              </div>
              <div className="text-[12px] text-[#1d1b1b]">{o.edge_rationale}</div>
            </div>
          )}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">watch_trigger</div>
            <div className="text-[12px] text-[#1d1b1b]">{o.watch_trigger ?? <span className="text-[#b4b4ae]">—</span>}</div>
          </div>
        </>
      )}

      <ReactionBlock r={o.reaction_state} />

      {o.retry_errors && o.retry_errors.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">retried attempts ({o.retry_errors.length})</div>
          <ul className="mt-0.5 space-y-0.5">
            {o.retry_errors.map((e, i) => (
              <li key={i} className="font-mono text-[10px] text-[#b45309]" title={e}>
                {e.length > 220 ? e.slice(0, 220) + "…" : e}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">
          evidence ({o.evidence.length}){o.grounding_failed ? " · grounding_failed" : ""}
        </div>
        {detail.evidence.length === 0 ? (
          <div className="font-mono text-[10px] text-[#b4b4ae]">none cited</div>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {detail.evidence.map((e) => (
              <li key={e.message_id} className="flex items-baseline gap-2 font-mono text-[10px]">
                <span className="shrink-0 text-[#a3a39c]">{e.timestamp ? fmtTime(e.timestamp) : "—"}</span>
                <span className="shrink-0 rounded bg-[#f1f1ec] px-1 text-[#6b7280]">{e.type}</span>
                <span className="min-w-0 truncate text-[#1d1b1b]" title={e.line}>
                  {e.line}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[#eeeee8] pt-2 font-mono text-[10px] text-[#8b8b86]">
        <span title={o.incident_id}>incident {o.incident_id.slice(0, 8)}</span>
        <span title={o.request_id}>· request {o.request_id.slice(-10)}</span>
        {o.prior_request_id && <span title={o.prior_request_id}>· prior {o.prior_request_id.slice(-10)}</span>}
        {o.superseded_by && <span title={o.superseded_by}>· superseded by {o.superseded_by.slice(-10)}</span>}
        {detail.chain.length > 1 && <span>· chain {detail.chain.length}</span>}
        <button
          type="button"
          onClick={() => onOpenIncident(o.ticker, o.incident_id)}
          disabled={!detail.incident_found}
          title={detail.incident_found ? "Open the source incident in the incidents tab" : "Incident not in the current replay window"}
          className="ml-auto flex items-center gap-1 rounded border border-[#e0e0da] bg-white px-2 py-0.5 text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
        >
          <ExternalLink className="h-3 w-3" strokeWidth={2} aria-hidden /> source incident
        </button>
      </div>
    </div>
  );
}

export default function AnalystView({ onOpenIncident }: { onOpenIncident: (ticker: string, incidentId: string) => void }) {
  const [status, setStatus] = useState<AnalystStatus | null>(null);
  const [outputs, setOutputs] = useState<AnalystOutput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kindFilter, setKindFilter] = useState<AnalystRequestKind | "all">("all");
  const [causeFilter, setCauseFilter] = useState<AnalystCause | "all">("all");
  const [edgeFilter, setEdgeFilter] = useState<AnalystEdgeStatus | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "failed">("all");
  const [currentOnly, setCurrentOnly] = useState(true);
  const [selected, setSelected] = useState<{ incident_id: string; request_id: string } | null>(null);
  const [detail, setDetail] = useState<AnalystOutputDetail | null>(null);

  const load = useCallback(async () => {
    const [s, o] = await Promise.all([
      window.meridian?.getAnalystStatus(),
      window.meridian?.listAnalystOutputs({ limit: 300 }),
    ]);
    if (s?.ok) setStatus(s.status);
    else if (s) setError(s.error);
    if (o?.ok) setOutputs(o.outputs);
    else if (o) setError(o.error);
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void window.meridian?.getAnalystOutputDetail(selected.incident_id, selected.request_id).then((res) => {
      if (cancelled) return;
      if (res?.ok) setDetail(res.detail);
      else if (res) setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const runCycle = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await window.meridian?.runAnalystCycle({ dryRun });
      if (res && !res.ok) setError(res.error);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    const res = await window.meridian?.setAnalystEnabled(enabled);
    if (res?.ok) setStatus(res.status);
    else if (res) setError(res.error);
  };

  const visible = useMemo(
    () =>
      outputs.filter((o) => {
        if (kindFilter !== "all" && o.kind !== kindFilter) return false;
        if (causeFilter !== "all" && o.cause !== causeFilter) return false;
        if (edgeFilter !== "all" && o.edge_status !== edgeFilter) return false;
        if (statusFilter !== "all" && o.status !== statusFilter) return false;
        if (currentOnly && o.superseded_by !== null) return false;
        return true;
      }),
    [outputs, kindFilter, causeFilter, edgeFilter, statusFilter, currentOnly],
  );

  const current = useMemo(() => outputs.filter((o) => o.superseded_by === null && o.status === "ok"), [outputs]);
  const byCause = useMemo(
    () => ANALYST_CAUSES.map((c) => [c, current.filter((o) => o.cause === c).length] as const),
    [current],
  );
  const byEdge = useMemo(
    () => ANALYST_EDGE_STATUSES.map((e) => [e, current.filter((o) => o.edge_status === e).length] as const),
    [current],
  );
  // S4: the structure channel is watched on its own — its unidentified rate
  // is expected to run high, so a shared rate would hide both signals.
  const byKind = useMemo(
    () =>
      ANALYST_REQUEST_KINDS.map((k) => {
        const rows = current.filter((o) => o.kind === k);
        const unidentified = rows.filter((o) => o.cause === "unidentified").length;
        return {
          kind: k,
          total: rows.length,
          today: rows.filter((o) => o.produced_at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
          unidentified_rate: rows.length ? unidentified / rows.length : null,
        };
      }),
    [current],
  );
  const maxKind = Math.max(1, ...byKind.map((k) => k.total));
  const maxCause = Math.max(1, ...byCause.map(([, n]) => n));
  const maxEdge = Math.max(1, ...byEdge.map(([, n]) => n));
  const unidentifiedRate = current.length ? current.filter((o) => o.cause === "unidentified").length / current.length : null;

  const m = status?.metrics;
  const breakerOpen = status?.breaker.status === "open";
  const run = status?.last_run ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* Sidebar: phase, budget/breaker, counters, distributions, last run */}
      <aside className="w-[264px] shrink-0 overflow-y-auto border-r border-[#eeeee8] px-3 py-3">
        <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">phase</div>
        <div className="mt-1.5 space-y-1">
          <Switch
            label={`A · live loop (${status?.model ?? "—"})`}
            checked={Boolean(status?.enabled)}
            onChange={(v) => void setEnabled(v)}
            disabled={!status?.configured}
            hint={
              status?.configured
                ? "Replay Base every 15 min and analyze analyst-routed incidents, log-only. Spends Anthropic quota."
                : "ANTHROPIC_API_KEY is not set in apps/desktop/.env"
            }
          />
          <Switch
            label="B · surfacing in app"
            checked={Boolean(status?.surfacing_enabled)}
            disabled
            hint="analystSurfacingEnabled — flips only after the 30-output rubric gate (separate task). Edit config.json to change."
          />
          {!status?.configured && (
            <div className="font-mono text-[10px] text-[#b45309]">no ANTHROPIC_API_KEY in main process</div>
          )}
        </div>

        <div className="mt-3 flex gap-1">
          <button
            type="button"
            disabled={busy || !status?.configured || breakerOpen}
            onClick={() => void runCycle(false)}
            className="flex flex-1 items-center justify-center gap-1 rounded border border-[#e0e0da] bg-white py-1 font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            title="Replay Base over the Tracker log and analyze the analyst-routed incidents now (within budget)"
          >
            <Play className="h-3 w-3" strokeWidth={2} aria-hidden /> run cycle
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runCycle(true)}
            className="flex-1 rounded border border-[#e0e0da] bg-white py-1 font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            title="Build requests and reaction states only — nothing is sent"
          >
            dry run
          </button>
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">budget · breaker</div>
        <div className="mt-1.5 space-y-0.5">
          <Counter
            label={`budget ${status?.budget.day ?? ""}`}
            value={status ? `${status.budget.used}/${status.budget.daily} · ${status.budget.remaining} left` : "—"}
          />
          <Counter
            label="breaker"
            value={
              status
                ? status.breaker.status === "open"
                  ? `open until ${status.breaker.open_until ? fmtTime(status.breaker.open_until) : "?"}`
                  : `closed · ${status.breaker.consecutive_failures} consec · ${status.breaker.trips} trips`
                : "—"
            }
            tone={breakerOpen ? "text-[#991b1b]" : undefined}
          />
          <Counter label="next cycle" value={status?.next_cycle_at ? fmtTime(status.next_cycle_at) : status?.enabled ? "pending" : "loop off"} />
          <Counter label="timeout · concurrency · effort" value={status ? `${status.timeout_ms / 1000}s · ${status.concurrency} · ${status.effort}` : "—"} />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">counters</div>
        <div className="mt-1.5 space-y-0.5">
          <Counter label="outputs ok / failed" value={m ? `${m.outputs_ok} / ${m.outputs_failed}` : "—"} />
          <Counter label="in store · current · perm-failed" value={status ? `${status.output_count} · ${status.current_count} · ${status.permanent_failures}` : "—"} />
          <Counter label="grounding_failed" value={m?.grounding_failed ?? "—"} tone={m && m.grounding_failed > 0 ? "text-[#b45309]" : undefined} />
          <Counter label="edge_deviations" value={m?.edge_deviations ?? "—"} />
          <Counter label="unidentified rate" value={unidentifiedRate == null ? "—" : `${Math.round(unidentifiedRate * 100)}%`} />
          <Counter label="validation / transport fails" value={m ? `${m.validation_failures} / ${m.transport_failures}` : "—"} />
          <Counter label="retries · superseded · cache" value={m ? `${m.retries} · ${m.superseded} · ${m.cache_hits}` : "—"} />
          <Counter
            label="latency p50 / p95"
            value={status ? `${status.latency_p50_ms == null ? "—" : (status.latency_p50_ms / 1000).toFixed(1) + "s"} / ${status.latency_p95_ms == null ? "—" : (status.latency_p95_ms / 1000).toFixed(1) + "s"}` : "—"}
          />
          <Counter
            label="tokens in / out"
            value={m ? `${(m.input_tokens / 1000).toFixed(1)}k / ${(m.output_tokens / 1000).toFixed(1)}k` : "—"}
          />
          <Counter label="est. spend" value={status ? `$${status.estimated_spend_usd.toFixed(3)}` : "—"} />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">by kind (current)</div>
        <div className="mt-1.5 space-y-1">
          {byKind.map((k) => (
            <Bar key={k.kind} label={k.kind.replace("_review", "").replace("_brief", "")} value={k.total} max={maxKind} className={KIND_STYLE[k.kind]} />
          ))}
        </div>
        <div className="mt-1.5 space-y-0.5">
          {byKind.map((k) => (
            <Counter
              key={k.kind}
              label={`${k.kind} today · unid.`}
              value={`${k.today} · ${k.unidentified_rate == null ? "—" : Math.round(k.unidentified_rate * 100) + "%"}`}
            />
          ))}
          <Counter
            label="structure sub-cap"
            value={status ? `${status.budget.structure_used}/${status.budget.structure_cap} · ${status.budget.structure_remaining} left` : "—"}
          />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">by cause (current)</div>
        <div className="mt-1.5 space-y-1">
          {byCause.map(([c, n]) => (
            <Bar key={c} label={c} value={n} max={maxCause} className={CAUSE_STYLE[c]} />
          ))}
        </div>
        <div className="mt-3 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">by edge_status (current)</div>
        <div className="mt-1.5 space-y-1">
          {byEdge.map(([e, n]) => (
            <Bar key={e} label={e} value={n} max={maxEdge} className={EDGE_STYLE[e]} />
          ))}
        </div>

        {run && (
          <div className="mt-4 space-y-0.5 border-t border-[#eeeee8] pt-2 font-mono text-[10px] text-[#8b8b86]">
            <div>
              <span className="text-[#b4b4ae]">last run</span> {fmtTime(run.finished_at)}
              {run.dry_run ? " (dry)" : ""}
            </div>
            <div>
              <span className="text-[#b4b4ae]">scanned</span> {run.messages_scanned} · <span className="text-[#b4b4ae]">incidents</span> {run.incidents_replayed} ·{" "}
              <span className="text-[#b4b4ae]">analyst</span> {run.analyst_incidents}
            </div>
            <div>
              <span className="text-[#b4b4ae]">requests</span> {run.requests_built} · <span className="text-[#b4b4ae]">produced</span> {run.already_produced} ·{" "}
              <span className="text-[#b4b4ae]">updates</span> {run.updates}
            </div>
            <div>
              <span className="text-[#b4b4ae]">dispatched</span> {run.dispatched} · <span className="text-[#b4b4ae]">deferred</span> {run.deferred_by_budget} ·{" "}
              <span className="text-[#b4b4ae]">ok</span> {run.ok} · <span className="text-[#b4b4ae]">downgraded</span> {run.downgraded} ·{" "}
              <span className="text-[#b45309]">failed {run.failed}</span>
            </div>
            {run.errors.map((e) => (
              <div key={e} className="truncate text-[#b45309]" title={e}>
                {e}
              </div>
            ))}
            {run.preview.length > 0 && (
              <div className="pt-1">
                <div className="text-[#b4b4ae]">{run.dry_run ? "would send" : "sent"}</div>
                {run.preview.map((p) => (
                  <div key={p.request_id} className="truncate" title={`${p.request_id} · ${p.prompt_chars} prompt chars · ${p.news_lines} news lines (+${p.news_excluded} counted)`}>
                    {p.ticker} · {p.kind === "scheduled_brief" ? "brief" : "review"} · {p.message_count} msg · {p.anomaly_types.join("+") || "—"} · z {fmtNum(p.reaction_state.realized_z, 1)} →{" "}
                    {p.reaction_state.edge_default}
                    {p.update ? " · update" : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Output stream + detail */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-[#eeeee8] px-4 py-2">
          <div className="flex rounded-md border border-[#e0e0da] bg-white p-0.5">
            {(["all", "ok", "failed"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded px-2 py-1 text-[11px] transition-colors ${
                  statusFilter === s ? "bg-[#1d1b1b] text-white" : "text-[#6b7280] hover:text-[#1d1b1b]"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as AnalystRequestKind | "all")} className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]">
            <option value="all">all kinds</option>
            {ANALYST_REQUEST_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select value={causeFilter} onChange={(e) => setCauseFilter(e.target.value as AnalystCause | "all")} className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]">
            <option value="all">all causes</option>
            {ANALYST_CAUSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={edgeFilter} onChange={(e) => setEdgeFilter(e.target.value as AnalystEdgeStatus | "all")} className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]">
            <option value="all">all edge_status</option>
            {ANALYST_EDGE_STATUSES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 font-mono text-[10px] text-[#6b7280]">
            <input type="checkbox" checked={currentOnly} onChange={(e) => setCurrentOnly(e.target.checked)} /> current only
          </label>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={2} aria-hidden /> refresh
          </button>
          <span className="ml-auto font-mono text-[10px] text-[#a3a39c]">
            {visible.length} outputs · prompt {status?.prompt_version ?? "—"} · log-only
          </span>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className={`min-h-0 overflow-y-auto px-3 py-2 ${detail ? "w-[46%] border-r border-[#eeeee8]" : "flex-1"}`}>
            {error ? (
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#b45309]">{error}</div>
            ) : visible.length === 0 ? (
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#a3a39c]">
                no outputs — run a cycle (replay-driven generation) or enable the Phase A loop
              </div>
            ) : (
              <ul className="divide-y divide-[#eeeee8]">
                {visible.map((o) => (
                  <OutputRow
                    key={`${o.incident_id}|${o.request_id}`}
                    o={o}
                    selected={selected?.incident_id === o.incident_id && selected?.request_id === o.request_id}
                    onSelect={() =>
                      setSelected((prev) =>
                        prev && prev.incident_id === o.incident_id && prev.request_id === o.request_id
                          ? null
                          : { incident_id: o.incident_id, request_id: o.request_id },
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </div>
          {detail && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Detail detail={detail} onOpenIncident={onOpenIncident} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
