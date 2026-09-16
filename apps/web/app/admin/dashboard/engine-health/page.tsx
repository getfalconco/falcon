import { Activity, AlertTriangle, CheckCircle2, CircleSlash, Clock } from "lucide-react";
import { getEngineHealth, type EngineHealthStatus } from "@/lib/admin-engine-health";
import { CARD, MICRO_LABEL, formatNumber, formatRelativeTime } from "../../components/overview/helpers";
import AdminPageHeader from "../../components/AdminPageHeader";
import { ADMIN_SHELL } from "../../admin-theme";

export const dynamic = "force-dynamic";

const STATUS_META: Record<
  EngineHealthStatus,
  { label: string; tone: string; ring: string; icon: typeof CheckCircle2; blurb: string }
> = {
  healthy: {
    label: "Healthy",
    tone: "text-emerald-700",
    ring: "border-emerald-200/80 bg-emerald-50",
    icon: CheckCircle2,
    blurb: "The news-worker is polling and reporting on schedule.",
  },
  stale: {
    label: "Stale",
    tone: "text-amber-700",
    ring: "border-amber-200/80 bg-amber-50",
    icon: Clock,
    blurb: "No recent heartbeat — the worker may be down or stuck.",
  },
  error: {
    label: "Error",
    tone: "text-red-700",
    ring: "border-red-200/80 bg-red-50",
    icon: AlertTriangle,
    blurb: "The last cycle reported an error.",
  },
  down: {
    label: "No signal",
    tone: "text-[#6b7280]",
    ring: "border-black/10 bg-white",
    icon: CircleSlash,
    blurb: "No heartbeat has been received from the worker yet.",
  },
};

function formatInterval(ms: number | null): string {
  if (!ms) return "—";
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  let s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${CARD} p-4`}>
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-2 text-[22px] font-medium leading-none tabular-nums text-[#1d1b1b]">{value}</p>
    </div>
  );
}

export default async function EngineHealthTabPage() {
  const h = await getEngineHealth();
  const meta = STATUS_META[h.status];
  const StatusIcon = meta.icon;

  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <AdminPageHeader
        eyebrow="Engine"
        title="Engine health"
        description={`news-worker (Railway) · ${
          h.updatedAt ? `heartbeat ${formatRelativeTime(h.updatedAt)}` : "no heartbeat yet"
        }${h.version ? ` · ${h.version}` : ""}`}
      />

      {h.missingTable ? (
        <p className="mt-5 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          The <code className="rounded bg-black/[0.04] px-1">engine_health</code> table does not exist
          yet. Run <code className="rounded bg-black/[0.04] px-1">apps/web/supabase/engine_health.sql</code>{" "}
          in the Supabase SQL editor, then the worker will start reporting.
        </p>
      ) : h.degraded ? (
        <p className="mt-5 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          Live data is unavailable right now.
        </p>
      ) : null}

      {/* Status banner */}
      <div className={`mt-5 flex items-center gap-3 rounded-lg border px-5 py-4 ${meta.ring}`}>
        <StatusIcon className={`h-5 w-5 ${meta.tone}`} strokeWidth={2} />
        <div>
          <p className={`text-[15px] font-medium ${meta.tone}`}>{meta.label}</p>
          <p className="text-[12px] text-[#6b7280]">{meta.blurb}</p>
        </div>
        <Activity className="ml-auto h-4 w-4 text-[#1d1b1b]/20" strokeWidth={1.75} />
      </div>

      {/* Stats */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Last poll" value={h.lastPollAt ? formatRelativeTime(h.lastPollAt) : "—"} />
        <Stat label="Articles checked" value={h.articlesChecked != null ? formatNumber(h.articlesChecked) : "—"} />
        <Stat label="New events (last)" value={h.newEvents != null ? formatNumber(h.newEvents) : "—"} />
        <Stat label="Signals saved (last)" value={h.signalsSaved != null ? formatNumber(h.signalsSaved) : "—"} />
        <Stat label="Cycles" value={h.cycles != null ? formatNumber(h.cycles) : "—"} />
        <Stat label="Errors" value={h.errors != null ? formatNumber(h.errors) : "—"} />
        <Stat label="Uptime" value={formatUptime(h.startedAt)} />
        <Stat label="Poll interval" value={formatInterval(h.pollIntervalMs)} />
      </div>

      {/* Last cycle detail */}
      <div className={`${CARD} mt-3 p-4`}>
        <p className={MICRO_LABEL}>Last cycle</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px] text-[#1d1b1b]/70">
          <span>
            Duration <span className="tabular-nums text-[#1d1b1b]/90">{formatDuration(h.cycleMs)}</span>
          </span>
          <span className="text-[#1d1b1b]/25">·</span>
          <span className="text-[#1d1b1b]/70">{h.lastSummary ?? "No summary reported."}</span>
        </div>
      </div>

      {h.lastError ? (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-red-700/90">Last error</p>
          <p className="mt-1.5 break-words font-mono text-[12px] text-red-200/90">{h.lastError}</p>
        </div>
      ) : null}
    </div>
  );
}
