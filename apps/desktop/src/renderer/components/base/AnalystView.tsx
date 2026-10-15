import { na } from "@/lib/i18n/na";
import { withClock } from "@/lib/clock";
import { useI18n } from "@/lib/i18n";
import { useIsStaff } from "@/lib/staff";
import { plural } from "./plural";
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

function fmtTime(iso: string, locale: string): string {
  if (!iso) return na();
  return new Date(iso).toLocaleString(locale, withClock({
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }));
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? na() : value.toFixed(digits);
}

function fmtPct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? na() : `${(value * 100).toFixed(2)}%`;
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
  const { t } = useI18n();
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
        {checked ? t("instruments.common.on") : t("instruments.common.off")}
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
  const { t } = useI18n();
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
          <span className="text-[#b4b4ae]">{t("instruments.common.none")}</span>
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
  const { t, locale } = useI18n();
  return (
    <li className={`py-1.5 ${selected ? "bg-[#f1f1ec]/70" : ""}`}>
      <button type="button" onClick={onSelect} className="w-full px-1 text-left">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="w-[82px] shrink-0 font-mono text-[10px] text-[#a3a39c]">{fmtTime(o.produced_at, locale)}</span>
          <span className="font-mono text-[11px] font-medium text-[#1d1b1b]">{o.ticker}</span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${KIND_STYLE[o.kind]}`}>{o.kind}</span>
          {o.status === "failed" ? (
            <span className="rounded bg-[#fee2e2] px-1.5 py-0.5 font-mono text-[10px] text-[#991b1b]">{t("instruments.common.failed")}</span>
          ) : (
            <>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${CAUSE_STYLE[o.cause]}`}>{o.cause}</span>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${EDGE_STYLE[o.edge_status]}`}>{o.edge_status}</span>
            </>
          )}
          {o.grounding_failed && (
            <span className="rounded bg-[#fef3c7] px-1.5 py-0.5 font-mono text-[10px] text-[#92400e]" title={t("instruments.analyst.groundingHint")}>
              grounding_failed
            </span>
          )}
          {o.edge_deviation && (
            <span className="rounded bg-[#ede9fe] px-1.5 py-0.5 font-mono text-[10px] text-[#5b21b6]" title={t("instruments.analyst.deviationHint", { value: o.reaction_state.edge_default })}>
              {t("instruments.analyst.deviation")}
            </span>
          )}
          {o.update && <span className="rounded border border-[#e0e0da] px-1.5 py-0.5 font-mono text-[10px] text-[#8b8b86]">{t("instruments.analyst.update")}</span>}
          {o.superseded_by && (
            <span className="rounded border border-dashed border-[#e0e0da] px-1.5 py-0.5 font-mono text-[10px] text-[#b4b4ae]" title={t("instruments.analyst.supersededBy", { id: o.superseded_by })}>
              {t("instruments.analyst.superseded")}
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
  const { t, locale } = useI18n();
  const o = detail.output;
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-medium text-[#1d1b1b]">{o.ticker}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${KIND_STYLE[o.kind]}`}>{o.kind}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${CAUSE_STYLE[o.cause]}`}>{o.cause}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${EDGE_STYLE[o.edge_status]}`}>{o.edge_status}</span>
        {o.status === "failed" && <span className="rounded bg-[#fee2e2] px-1.5 py-0.5 font-mono text-[10px] text-[#991b1b]">{t("instruments.common.failed")}</span>}
        <span className="ml-auto font-mono text-[10px] text-[#a3a39c]">
          {o.model} · {o.prompt_version} ·{" "}
          {t(plural(locale, o.attempts, "instruments.analyst.attempts.one", "instruments.analyst.attempts.other"), { n: o.attempts })} ·{" "}
          {(o.latency_ms / 1000).toFixed(1)}s
        </span>
      </div>

      {o.status === "failed" ? (
        <div className="font-mono text-[11px] text-[#b45309]">{o.failure_reason}</div>
      ) : (
        <>
          <div>
            <div lang="en" className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">cause_summary</div>
            <div className="text-[12px] text-[#1d1b1b]">{o.cause_summary}</div>
          </div>
          {o.mechanism && (
            <div>
              <div lang="en" className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">mechanism</div>
              <div className="text-[12px] text-[#1d1b1b]">{o.mechanism}</div>
            </div>
          )}
          {o.edge_rationale && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">
                <span lang="en">edge_rationale</span>
                {o.edge_deviation ? ` · ${t("instruments.analyst.deviationFrom", { value: o.reaction_state.edge_default })}` : ""}
              </div>
              <div className="text-[12px] text-[#1d1b1b]">{o.edge_rationale}</div>
            </div>
          )}
          <div>
            <div lang="en" className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">watch_trigger</div>
            <div className="text-[12px] text-[#1d1b1b]">{o.watch_trigger ?? <span className="text-[#b4b4ae]">{na()}</span>}</div>
          </div>
        </>
      )}

      <ReactionBlock r={o.reaction_state} />

      {o.retry_errors && o.retry_errors.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.analyst.retried", { n: o.retry_errors.length })}</div>
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
          {t("instruments.analyst.evidence", { n: o.evidence.length })}
          {o.grounding_failed ? <> · <span lang="en">grounding_failed</span></> : null}
        </div>
        {detail.evidence.length === 0 ? (
          <div className="font-mono text-[10px] text-[#b4b4ae]">{t("instruments.analyst.noneCited")}</div>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {detail.evidence.map((e) => (
              <li key={e.message_id} className="flex items-baseline gap-2 font-mono text-[10px]">
                <span className="shrink-0 text-[#a3a39c]">{e.timestamp ? fmtTime(e.timestamp, locale) : na()}</span>
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
        <span title={o.incident_id}>{t("instruments.analyst.incidentRef", { id: o.incident_id.slice(0, 8) })}</span>
        <span title={o.request_id}>· {t("instruments.analyst.requestRef", { id: o.request_id.slice(-10) })}</span>
        {o.prior_request_id && (
          <span title={o.prior_request_id}>· {t("instruments.analyst.priorRef", { id: o.prior_request_id.slice(-10) })}</span>
        )}
        {o.superseded_by && (
          <span title={o.superseded_by}>· {t("instruments.analyst.supersededBy", { id: o.superseded_by.slice(-10) })}</span>
        )}
        {detail.chain.length > 1 && <span>· {t("instruments.analyst.chain", { n: detail.chain.length })}</span>}
        <button
          type="button"
          onClick={() => onOpenIncident(o.ticker, o.incident_id)}
          disabled={!detail.incident_found}
          title={detail.incident_found ? t("instruments.analyst.openIncidentHint") : t("instruments.analyst.incidentMissing")}
          className="ml-auto flex items-center gap-1 rounded border border-[#e0e0da] bg-white px-2 py-0.5 text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
        >
          <ExternalLink className="h-3 w-3" strokeWidth={2} aria-hidden /> {t("instruments.analyst.sourceIncident")}
        </button>
      </div>
    </div>
  );
}

export default function AnalystView({ onOpenIncident }: { onOpenIncident: (ticker: string, incidentId: string) => void }) {
  const { t, locale } = useI18n();
  // The loop switch and the run buttons change the shared Analyst for every
  // account; the engine takes them from staff only.
  const staff = useIsStaff();
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
        <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.common.phase")}</div>
        <div className="mt-1.5 space-y-1">
          <Switch
            label={t("instruments.common.liveLoop", { model: status?.model ?? na() })}
            checked={Boolean(status?.enabled)}
            onChange={(v) => void setEnabled(v)}
            disabled={!staff || !status?.configured}
            hint={
              !staff
                ? t("access.staffOnly.setting")
                : status?.configured
                  ? t("instruments.analyst.liveLoopHint")
                  : t("instruments.common.apiKeyUnset")
            }
          />
          <Switch
            label={t("instruments.analyst.surfacingLabel")}
            checked={Boolean(status?.surfacing_enabled)}
            disabled
            hint={t("instruments.analyst.surfacingHint")}
          />
          {!staff && <div className="font-mono text-[10px] text-[#8b8b86]">{t("access.staffOnly.setting")}</div>}
          {!status?.configured && (
            <div className="font-mono text-[10px] text-[#b45309]">{t("instruments.common.noApiKey")}</div>
          )}
        </div>

        <div className="mt-3 flex gap-1">
          <button
            type="button"
            disabled={!staff || busy || !status?.configured || breakerOpen}
            onClick={() => void runCycle(false)}
            className="flex flex-1 items-center justify-center gap-1 rounded border border-[#e0e0da] bg-white py-1 font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            title={staff ? t("instruments.analyst.runCycleHint") : t("access.staffOnly.action")}
          >
            <Play className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden /> {t("instruments.common.runCycle")}
          </button>
          <button
            type="button"
            disabled={!staff || busy}
            onClick={() => void runCycle(true)}
            className="flex-1 rounded border border-[#e0e0da] bg-white py-1 font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            title={staff ? t("instruments.analyst.dryRunHint") : t("access.staffOnly.action")}
          >
            {t("instruments.common.dryRun")}
          </button>
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.common.budgetBreaker")}</div>
        <div className="mt-1.5 space-y-0.5">
          <Counter
            label={t("instruments.common.budget", { day: status?.budget.day ?? "" })}
            value={
              status
                ? t("instruments.common.budgetValue", {
                    used: status.budget.used,
                    daily: status.budget.daily,
                    remaining: status.budget.remaining,
                  })
                : na()
            }
          />
          <Counter
            label={t("instruments.common.breaker")}
            value={
              status
                ? status.breaker.status === "open"
                  ? t("instruments.common.breakerOpen", {
                      time: status.breaker.open_until ? fmtTime(status.breaker.open_until, locale) : "?",
                    })
                  : t("instruments.common.breakerClosed", {
                      failures: status.breaker.consecutive_failures,
                      trips: status.breaker.trips,
                    })
                : na()
            }
            tone={breakerOpen ? "text-[#991b1b]" : undefined}
          />
          <Counter
            label={t("instruments.common.nextCycle")}
            value={
              status?.next_cycle_at
                ? fmtTime(status.next_cycle_at, locale)
                : status?.enabled
                  ? t("instruments.common.pending")
                  : t("instruments.common.loopOff")
            }
          />
          <Counter label={t("instruments.analyst.runtime")} value={status ? `${status.timeout_ms / 1000}s · ${status.concurrency} · ${status.effort}` : na()} />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.common.counters")}</div>
        <div className="mt-1.5 space-y-0.5">
          <Counter label={t("instruments.analyst.outputsOkFailed")} value={m ? `${m.outputs_ok} / ${m.outputs_failed}` : na()} />
          <Counter label={t("instruments.analyst.inStore")} value={status ? `${status.output_count} · ${status.current_count} · ${status.permanent_failures}` : na()} />
          <Counter label="grounding_failed" value={m?.grounding_failed ?? na()} tone={m && m.grounding_failed > 0 ? "text-[#b45309]" : undefined} />
          <Counter label="edge_deviations" value={m?.edge_deviations ?? na()} />
          <Counter label={t("instruments.analyst.unidentifiedRate")} value={unidentifiedRate == null ? na() : `${Math.round(unidentifiedRate * 100)}%`} />
          <Counter label={t("instruments.common.validationTransport")} value={m ? `${m.validation_failures} / ${m.transport_failures}` : na()} />
          <Counter label={t("instruments.analyst.retries")} value={m ? `${m.retries} · ${m.superseded} · ${m.cache_hits}` : na()} />
          <Counter
            label={t("instruments.common.latency")}
            value={status ? `${status.latency_p50_ms == null ? na() : (status.latency_p50_ms / 1000).toFixed(1) + "s"} / ${status.latency_p95_ms == null ? na() : (status.latency_p95_ms / 1000).toFixed(1) + "s"}` : na()}
          />
          <Counter
            label={t("instruments.common.tokens")}
            value={m ? `${(m.input_tokens / 1000).toFixed(1)}k / ${(m.output_tokens / 1000).toFixed(1)}k` : na()}
          />
          <Counter label={t("instruments.common.estSpend")} value={status ? `$${status.estimated_spend_usd.toFixed(3)}` : na()} />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.analyst.byKind")}</div>
        <div className="mt-1.5 space-y-1">
          {byKind.map((k) => (
            <Bar key={k.kind} label={k.kind.replace("_review", "").replace("_brief", "")} value={k.total} max={maxKind} className={KIND_STYLE[k.kind]} />
          ))}
        </div>
        <div className="mt-1.5 space-y-0.5">
          {byKind.map((k) => (
            <Counter
              key={k.kind}
              label={t("instruments.analyst.kindToday", { kind: k.kind })}
              value={`${k.today} · ${k.unidentified_rate == null ? na() : Math.round(k.unidentified_rate * 100) + "%"}`}
            />
          ))}
          <Counter
            label={t("instruments.analyst.structureCap")}
            value={
              status
                ? t("instruments.common.budgetValue", {
                    used: status.budget.structure_used,
                    daily: status.budget.structure_cap,
                    remaining: status.budget.structure_remaining,
                  })
                : na()
            }
          />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.analyst.byCause")}</div>
        <div className="mt-1.5 space-y-1">
          {byCause.map(([c, n]) => (
            <Bar key={c} label={c} value={n} max={maxCause} className={CAUSE_STYLE[c]} />
          ))}
        </div>
        <div className="mt-3 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.analyst.byEdge")}</div>
        <div className="mt-1.5 space-y-1">
          {byEdge.map(([e, n]) => (
            <Bar key={e} label={e} value={n} max={maxEdge} className={EDGE_STYLE[e]} />
          ))}
        </div>

        {run && (
          <div className="mt-4 space-y-0.5 border-t border-[#eeeee8] pt-2 font-mono text-[10px] text-[#8b8b86]">
            <div>
              <span className="text-[#b4b4ae]">{t("instruments.common.lastRun")}</span> {fmtTime(run.finished_at, locale)}
              {run.dry_run ? ` ${t("instruments.common.dryTag")}` : ""}
            </div>
            <div>
              <span className="text-[#b4b4ae]">{t("instruments.common.scanned")}</span> {run.messages_scanned} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.analyst.incidents")}</span> {run.incidents_replayed} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.analyst.analyst")}</span> {run.analyst_incidents}
            </div>
            <div>
              <span className="text-[#b4b4ae]">{t("instruments.common.requests")}</span> {run.requests_built} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.analyst.produced")}</span> {run.already_produced} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.analyst.updates")}</span> {run.updates}
            </div>
            <div>
              <span className="text-[#b4b4ae]">{t("instruments.common.dispatched")}</span> {run.dispatched} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.common.deferred")}</span> {run.deferred_by_budget} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.common.ok")}</span> {run.ok} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.analyst.downgraded")}</span> {run.downgraded} ·{" "}
              <span className="text-[#b45309]">{t("instruments.common.failedCount", { n: run.failed })}</span>
            </div>
            {run.errors.map((e) => (
              <div key={e} className="truncate text-[#b45309]" title={e}>
                {e}
              </div>
            ))}
            {run.preview.length > 0 && (
              <div className="pt-1">
                <div className="text-[#b4b4ae]">{run.dry_run ? t("instruments.analyst.wouldSend") : t("instruments.analyst.sent")}</div>
                {run.preview.map((p) => (
                  <div key={p.request_id} className="truncate" title={t("instruments.analyst.previewHint", {
                      id: p.request_id,
                      chars: p.prompt_chars,
                      lines: p.news_lines,
                      excluded: p.news_excluded,
                    })}
                  >
                    {p.ticker} · {p.kind === "scheduled_brief" ? t("instruments.analyst.brief") : t("instruments.analyst.review")} ·{" "}
                    {t("instruments.base.msgCount", { n: p.message_count })} · {p.anomaly_types.join("+") || na()} · z{" "}
                    {fmtNum(p.reaction_state.realized_z, 1)} → {p.reaction_state.edge_default}
                    {p.update ? ` · ${t("instruments.analyst.update")}` : ""}
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
                {s === "all" ? t("instruments.common.all") : s === "ok" ? t("instruments.common.ok") : t("instruments.common.failed")}
              </button>
            ))}
          </div>
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as AnalystRequestKind | "all")} className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]">
            <option value="all">{t("instruments.analyst.allKinds")}</option>
            {ANALYST_REQUEST_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select value={causeFilter} onChange={(e) => setCauseFilter(e.target.value as AnalystCause | "all")} className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]">
            <option value="all">{t("instruments.analyst.allCauses")}</option>
            {ANALYST_CAUSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={edgeFilter} onChange={(e) => setEdgeFilter(e.target.value as AnalystEdgeStatus | "all")} className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]">
            <option value="all">{t("instruments.analyst.allEdge")}</option>
            {ANALYST_EDGE_STATUSES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 font-mono text-[10px] text-[#6b7280]">
            <input type="checkbox" checked={currentOnly} onChange={(e) => setCurrentOnly(e.target.checked)} /> {t("instruments.analyst.currentOnly")}
          </label>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={2} aria-hidden /> {t("instruments.common.refresh")}
          </button>
          <span className="ml-auto font-mono text-[10px] text-[#a3a39c]">
            {t("instruments.analyst.count", { n: visible.length, version: status?.prompt_version ?? na() })}
          </span>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className={`min-h-0 overflow-y-auto px-3 py-2 ${detail ? "w-[46%] border-r border-[#eeeee8]" : "flex-1"}`}>
            {error ? (
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#b45309]">{error}</div>
            ) : visible.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center font-mono text-[12px] text-[#a3a39c]">
                {t("instruments.analyst.empty")}
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
