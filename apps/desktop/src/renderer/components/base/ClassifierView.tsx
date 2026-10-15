import { na } from "@/lib/i18n/na";
import { withClock } from "@/lib/clock";
import { useI18n } from "@/lib/i18n";
import { useIsStaff } from "@/lib/staff";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import type {
  ClassifierEventType,
  ClassifierStatus,
  ClassifierTickerVerdict,
  ClassifierVerdict,
} from "../../../shared/classifier-types";

/**
 * Classifier instrument view (spec §12), mounted inside the Shift+B Base
 * panel. Stream of recent verdicts, the event_type × relevance × materiality
 * histogram, failure/retry/breaker/addendum/disagreement/overflow counters,
 * latency p50/p95, estimated spend, the daily budget, and the two phase
 * switches: the Phase A loop (spends Anthropic quota) and Phase B re-score.
 */

const RELEVANCE_STYLE: Record<string, string> = {
  direct: "bg-[#dcfce7] text-[#166534]",
  indirect: "bg-[#fef3c7] text-[#92400e]",
  none: "bg-[#f1f1ec] text-[#8b8b86]",
};

const MATERIALITY_STYLE: Record<string, string> = {
  high: "text-[#991b1b]",
  standard: "text-[#1d1b1b]",
  low: "text-[#8b8b86]",
};

const DIRECTION_GLYPH: Record<string, string> = {
  positive: "▲",
  negative: "▼",
  mixed: "◆",
  unclear: "·",
};

function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, withClock({
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }));
}

function entryLabel(t: ClassifierTickerVerdict): string {
  if (t.relevance === "none") return "none";
  return `${t.relevance}/${t.materiality}/${t.direction}`;
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
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
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

export default function ClassifierView() {
  const { t, locale } = useI18n();
  // The phase switches and the run buttons change the shared classifier for
  // every account; the engine takes them from staff only.
  const staff = useIsStaff();
  const [status, setStatus] = useState<ClassifierStatus | null>(null);
  const [verdicts, setVerdicts] = useState<ClassifierVerdict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typeFilter, setTypeFilter] = useState<ClassifierEventType | "all">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "failed">("all");

  const load = useCallback(async () => {
    const [s, v] = await Promise.all([
      window.meridian?.getClassifierStatus(),
      window.meridian?.listClassifierVerdicts({ limit: 300 }),
    ]);
    if (s?.ok) setStatus(s.status);
    else if (s) setError(s.error);
    if (v?.ok) setVerdicts(v.verdicts);
    else if (v) setError(v.error);
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  const runCycle = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await window.meridian?.runClassifierCycle({ dryRun });
      if (res && !res.ok) setError(res.error);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    const res = await window.meridian?.setClassifierEnabled(enabled);
    if (res?.ok) setStatus(res.status);
    else if (res) setError(res.error);
  };

  const setRescore = async (enabled: boolean) => {
    const res = await window.meridian?.setClassifierRescore(enabled);
    if (res?.ok) setStatus(res.status);
    else if (res) setError(res.error);
  };

  const cells = useMemo(() => {
    const by = status?.metrics.by_cell ?? {};
    return Object.entries(by)
      .map(([key, count]) => {
        const [event_type, relevance, materiality] = key.split("|");
        return { key, event_type, relevance, materiality, count };
      })
      .sort((a, b) => b.count - a.count);
  }, [status]);

  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) m.set(c.event_type, (m.get(c.event_type) ?? 0) + c.count);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [cells]);
  const maxType = Math.max(1, ...byType.map(([, n]) => n));

  const visible = useMemo(
    () =>
      verdicts.filter((v) => {
        if (typeFilter !== "all" && v.event_type !== typeFilter) return false;
        if (statusFilter !== "all" && v.status !== statusFilter) return false;
        return true;
      }),
    [verdicts, typeFilter, statusFilter],
  );

  const m = status?.metrics;
  const breakerOpen = status?.breaker.status === "open";

  return (
    <div className="flex min-h-0 flex-1">
      {/* Sidebar: counters + controls */}
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
                  ? t("instruments.classifier.liveLoopHint")
                  : t("instruments.common.apiKeyUnset")
            }
          />
          <Switch
            label={t("instruments.classifier.rescoreLabel")}
            checked={Boolean(status?.rescore_enabled)}
            onChange={(v) => void setRescore(v)}
            disabled={!staff}
            hint={staff ? t("instruments.classifier.rescoreHint") : t("access.staffOnly.setting")}
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
            title={staff ? t("instruments.classifier.runCycleHint") : t("access.staffOnly.action")}
          >
            <Play className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden /> {t("instruments.common.runCycle")}
          </button>
          <button
            type="button"
            disabled={!staff || busy}
            onClick={() => void runCycle(true)}
            className="flex-1 rounded border border-[#e0e0da] bg-white py-1 font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            title={staff ? t("instruments.classifier.dryRunHint") : t("access.staffOnly.action")}
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
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.common.counters")}</div>
        <div className="mt-1.5 space-y-0.5">
          <Counter label={t("instruments.classifier.verdictsOkFailed")} value={m ? `${m.verdicts_ok} / ${m.verdicts_failed}` : na()} />
          <Counter label={t("instruments.classifier.inStore")} value={status ? `${status.verdict_count} · ${status.permanent_failures}` : na()} />
          <Counter label={t("instruments.common.validationTransport")} value={m ? `${m.validation_failures} / ${m.transport_failures}` : na()} />
          <Counter label={t("instruments.classifier.retries")} value={m ? `${m.retries} · ${m.cache_hits}` : na()} />
          <Counter label={t("instruments.classifier.addenda")} value={m ? `${m.addenda} · ${m.verdict_disagreements}` : na()} />
          <Counter label={t("instruments.classifier.overflow")} value={m?.overflows ?? na()} />
          <Counter
            label={t("instruments.common.latency")}
            value={status ? `${status.latency_p50_ms ?? na()} / ${status.latency_p95_ms ?? na()} ms` : na()}
          />
          <Counter
            label={t("instruments.common.tokens")}
            value={m ? `${(m.input_tokens / 1000).toFixed(1)}k / ${(m.output_tokens / 1000).toFixed(1)}k` : na()}
          />
          <Counter label={t("instruments.common.estSpend")} value={status ? `$${status.estimated_spend_usd.toFixed(3)}` : na()} />
          <Counter label={t("instruments.classifier.metadataRows")} value={status?.metadata_rows ?? na()} />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">{t("instruments.classifier.eventTypes")}</div>
        <div className="mt-1.5 space-y-1">
          {byType.length === 0 && <div className="font-mono text-[10px] text-[#c9c9c1]">{t("instruments.classifier.noVerdictsYet")}</div>}
          {byType.map(([type, count]) => (
            <div key={type} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[#6b7280]">{type}</span>
              <div className="h-1.5 w-14 overflow-hidden rounded-full bg-[#ececE6]">
                <div className="h-full rounded-full bg-[#1d1b1b]/25" style={{ width: `${Math.round((count / maxType) * 100)}%` }} />
              </div>
              <span className="w-5 text-right font-mono text-[10px] text-[#6b7280]">{count}</span>
            </div>
          ))}
        </div>

        {status?.last_run && (
          <div className="mt-4 space-y-0.5 border-t border-[#eeeee8] pt-2 font-mono text-[10px] text-[#8b8b86]">
            <div>
              <span className="text-[#b4b4ae]">{t("instruments.common.lastRun")}</span> {fmtTime(status.last_run.finished_at, locale)}
              {status.last_run.dry_run ? ` ${t("instruments.common.dryTag")}` : ""}
            </div>
            <div>
              <span className="text-[#b4b4ae]">{t("instruments.common.scanned")}</span> {status.last_run.messages_scanned} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.common.requests")}</span> {status.last_run.requests_built} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.classifier.covered")}</span> {status.last_run.covered}
            </div>
            <div>
              <span className="text-[#b4b4ae]">{t("instruments.common.dispatched")}</span> {status.last_run.dispatched} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.common.deferred")}</span> {status.last_run.deferred_by_budget} ·{" "}
              <span className="text-[#b4b4ae]">{t("instruments.common.ok")}</span> {status.last_run.ok} ·{" "}
              <span className="text-[#b45309]">{t("instruments.common.failedCount", { n: status.last_run.failed })}</span>
            </div>
            {status.last_run.errors.map((e) => (
              <div key={e} className="truncate text-[#b45309]" title={e}>
                {e}
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Verdict stream */}
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
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ClassifierEventType | "all")}
            className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]"
          >
            <option value="all">{t("instruments.classifier.allEventTypes")}</option>
            {byType.map(([type]) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={2} aria-hidden /> {t("instruments.common.refresh")}
          </button>
          <span className="ml-auto font-mono text-[10px] text-[#a3a39c]">
            {t("instruments.classifier.count", { n: visible.length, version: status?.prompt_version ?? na() })}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {error ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#b45309]">{error}</div>
          ) : visible.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center font-mono text-[12px] text-[#a3a39c]">
              {t("instruments.classifier.empty")}
            </div>
          ) : (
            <ul className="divide-y divide-[#eeeee8]">
              {visible.map((v) => (
                <li key={`${v.article_key}|${v.prompt_version}|${v.model}`} className="py-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="w-[82px] shrink-0 font-mono text-[10px] text-[#a3a39c]">{fmtTime(v.classified_at, locale)}</span>
                    <span className="shrink-0 rounded bg-[#e0e7ff] px-1.5 py-0.5 font-mono text-[10px] text-[#3730a3]">
                      {v.event_type}
                    </span>
                    {v.status === "failed" && (
                      <span className="shrink-0 rounded bg-[#fee2e2] px-1.5 py-0.5 font-mono text-[10px] text-[#991b1b]">{t("instruments.common.failed")}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[#1d1b1b]" title={v.failure_reason ?? v.event_label}>
                      {v.status === "failed" ? v.failure_reason : v.event_label || na()}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[#b4b4ae]">
                      {t("instruments.classifier.scope", { kind: v.kind, scope: v.syndication_scope })}
                      {v.metadata_missing ? ` · ${t("instruments.classifier.noMeta")}` : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 pl-[90px]">
                    {v.tickers.map((tv) => (
                      <span
                        key={tv.ticker}
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${RELEVANCE_STYLE[tv.relevance]}`}
                        title={entryLabel(tv)}
                      >
                        {tv.ticker}
                        {tv.relevance !== "none" && (
                          <>
                            {" "}
                            <span className={MATERIALITY_STYLE[tv.materiality]}>{tv.materiality}</span>{" "}
                            {DIRECTION_GLYPH[tv.direction]}
                          </>
                        )}
                        {tv.relevance === "none" && <span className="text-[#b4b4ae]"> none</span>}
                      </span>
                    ))}
                    {v.unassessed_tickers.map((u) => (
                      <span key={`u-${u}`} className="rounded border border-dashed border-[#e0e0da] px-1.5 py-0.5 font-mono text-[10px] text-[#b4b4ae]" title={t("instruments.classifier.unassessed")}>
                        {u}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
