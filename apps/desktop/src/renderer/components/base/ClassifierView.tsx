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

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
        {checked ? "on" : "off"}
      </span>
    </button>
  );
}

export default function ClassifierView() {
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
        <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">phase</div>
        <div className="mt-1.5 space-y-1">
          <Switch
            label={`A · live loop (${status?.model ?? "—"})`}
            checked={Boolean(status?.enabled)}
            onChange={(v) => void setEnabled(v)}
            disabled={!status?.configured}
            hint={
              status?.configured
                ? "Classify live Tracker flow every 15 min, log-only. Spends Anthropic quota."
                : "ANTHROPIC_API_KEY is not set in apps/desktop/.env"
            }
          />
          <Switch
            label="B · re-score in Base"
            checked={Boolean(status?.rescore_enabled)}
            onChange={(v) => void setRescore(v)}
            hint="Apply the §10b severity mapping in Base scoring. Only after the eval gate passes."
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
            title="Build requests from the Tracker log and classify them now (within budget)"
          >
            <Play className="h-3 w-3" strokeWidth={2} aria-hidden /> run cycle
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runCycle(true)}
            className="flex-1 rounded border border-[#e0e0da] bg-white py-1 font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            title="Build requests only — nothing is sent"
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
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">counters</div>
        <div className="mt-1.5 space-y-0.5">
          <Counter label="verdicts ok / failed" value={m ? `${m.verdicts_ok} / ${m.verdicts_failed}` : "—"} />
          <Counter label="in store · permanent-failed" value={status ? `${status.verdict_count} · ${status.permanent_failures}` : "—"} />
          <Counter label="validation / transport fails" value={m ? `${m.validation_failures} / ${m.transport_failures}` : "—"} />
          <Counter label="retries · cache hits" value={m ? `${m.retries} · ${m.cache_hits}` : "—"} />
          <Counter label="addenda · disagreements" value={m ? `${m.addenda} · ${m.verdict_disagreements}` : "—"} />
          <Counter label="overflow (>8 tickers)" value={m?.overflows ?? "—"} />
          <Counter
            label="latency p50 / p95"
            value={status ? `${status.latency_p50_ms ?? "—"} / ${status.latency_p95_ms ?? "—"} ms` : "—"}
          />
          <Counter
            label="tokens in / out"
            value={m ? `${(m.input_tokens / 1000).toFixed(1)}k / ${(m.output_tokens / 1000).toFixed(1)}k` : "—"}
          />
          <Counter label="est. spend" value={status ? `$${status.estimated_spend_usd.toFixed(3)}` : "—"} />
          <Counter label="metadata rows" value={status?.metadata_rows ?? "—"} />
        </div>

        <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">event types</div>
        <div className="mt-1.5 space-y-1">
          {byType.length === 0 && <div className="font-mono text-[10px] text-[#c9c9c1]">no verdicts yet</div>}
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
              <span className="text-[#b4b4ae]">last run</span> {fmtTime(status.last_run.finished_at)}
              {status.last_run.dry_run ? " (dry)" : ""}
            </div>
            <div>
              <span className="text-[#b4b4ae]">scanned</span> {status.last_run.messages_scanned} ·{" "}
              <span className="text-[#b4b4ae]">requests</span> {status.last_run.requests_built} ·{" "}
              <span className="text-[#b4b4ae]">covered</span> {status.last_run.covered}
            </div>
            <div>
              <span className="text-[#b4b4ae]">dispatched</span> {status.last_run.dispatched} ·{" "}
              <span className="text-[#b4b4ae]">deferred</span> {status.last_run.deferred_by_budget} ·{" "}
              <span className="text-[#b4b4ae]">ok</span> {status.last_run.ok} ·{" "}
              <span className="text-[#b45309]">failed {status.last_run.failed}</span>
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
                {s}
              </button>
            ))}
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ClassifierEventType | "all")}
            className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]"
          >
            <option value="all">all event types</option>
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
            <RefreshCw className="h-3 w-3" strokeWidth={2} aria-hidden /> refresh
          </button>
          <span className="ml-auto font-mono text-[10px] text-[#a3a39c]">
            {visible.length} verdicts · prompt {status?.prompt_version ?? "—"}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {error ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#b45309]">{error}</div>
          ) : visible.length === 0 ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#a3a39c]">
              no verdicts — run a cycle or enable the Phase A loop
            </div>
          ) : (
            <ul className="divide-y divide-[#eeeee8]">
              {visible.map((v) => (
                <li key={`${v.article_key}|${v.prompt_version}|${v.model}`} className="py-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="w-[82px] shrink-0 font-mono text-[10px] text-[#a3a39c]">{fmtTime(v.classified_at)}</span>
                    <span className="shrink-0 rounded bg-[#e0e7ff] px-1.5 py-0.5 font-mono text-[10px] text-[#3730a3]">
                      {v.event_type}
                    </span>
                    {v.status === "failed" && (
                      <span className="shrink-0 rounded bg-[#fee2e2] px-1.5 py-0.5 font-mono text-[10px] text-[#991b1b]">failed</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[#1d1b1b]" title={v.failure_reason ?? v.event_label}>
                      {v.status === "failed" ? v.failure_reason : v.event_label || "—"}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[#b4b4ae]">
                      {v.kind} · scope {v.syndication_scope}
                      {v.metadata_missing ? " · no-meta" : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 pl-[90px]">
                    {v.tickers.map((t) => (
                      <span
                        key={t.ticker}
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${RELEVANCE_STYLE[t.relevance]}`}
                        title={entryLabel(t)}
                      >
                        {t.ticker}
                        {t.relevance !== "none" && (
                          <>
                            {" "}
                            <span className={MATERIALITY_STYLE[t.materiality]}>{t.materiality}</span>{" "}
                            {DIRECTION_GLYPH[t.direction]}
                          </>
                        )}
                        {t.relevance === "none" && <span className="text-[#b4b4ae]"> none</span>}
                      </span>
                    ))}
                    {v.unassessed_tickers.map((t) => (
                      <span key={`u-${t}`} className="rounded border border-dashed border-[#e0e0da] px-1.5 py-0.5 font-mono text-[10px] text-[#b4b4ae]" title="unassessed">
                        {t}
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
