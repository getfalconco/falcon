import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type {
  DiagnosticsEnvInfo,
  ProviderCheckResult,
  ProviderCheckStatus,
} from "../../../shared/diagnostics-types";

/**
 * Shift+H — environment / provider / engine diagnostics. Built to answer one
 * question fast: does the PACKAGED exe behave like the dev build? Three bands:
 *
 *   Environment — packaged flag, provider routing (direct vs Railway proxy),
 *                 base URLs, data root, key presence (never values).
 *   Providers   — live pings through the same env routing the engines use.
 *   Engines     — every engine host's own status IPC, so a row that errors
 *                 here means the engine didn't bootstrap in this build.
 *
 * Debug-grade like the other Shift panels; no styling ambitions.
 */

type Props = { onClose: () => void };

const STATUS_COLOR: Record<ProviderCheckStatus, string> = {
  ok: "#16A34A",
  fail: "#DC2626",
  "missing-key": "#EA580C",
  skipped: "#9CA3AF",
};

function StatusPill({ status }: { status: ProviderCheckStatus }) {
  return (
    <span
      className="rounded-full px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white"
      style={{ background: STATUS_COLOR[status] }}
    >
      {status}
    </span>
  );
}

/* -------------------------------- engines -------------------------------- */

type EngineOutcome = { ok: boolean; summary: string };

/** Compact one-liner out of an arbitrary status object — debug panel, not a contract. */
function summarize(data: unknown): string {
  if (data == null) return "—";
  if (typeof data !== "object") return String(data);
  const obj = data as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      const text = typeof value === "string" ? (value.length > 40 ? `${value.slice(0, 40)}…` : value) : String(value);
      parts.push(`${key}=${text}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}[${value.length}]`);
    }
    if (parts.length >= 8) break;
  }
  return parts.length ? parts.join(" · ") : JSON.stringify(obj).slice(0, 120);
}

type Bridge = NonNullable<typeof window.meridian>;

const ENGINE_CHECKS: Array<{
  id: string;
  label: string;
  run: (bridge: Bridge) => Promise<EngineOutcome>;
}> = [
  {
    id: "tracker",
    label: "Tracker (Engine1)",
    run: async (b) => {
      const r = await b.getTrackerStatus();
      return { ok: r.ok, summary: summarize(r.status) };
    },
  },
  {
    id: "events",
    label: "News events poller",
    run: async (b) => {
      const r = await b.getNewsEventsStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "classifier",
    label: "Classifier",
    run: async (b) => {
      const r = await b.getClassifierStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "analyst",
    label: "Analyst",
    run: async (b) => {
      const r = await b.getAnalystStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "propagation",
    label: "Propagation engine",
    run: async (b) => {
      const r = await b.getPropagationStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "risk",
    label: "Risk engine",
    run: async (b) => {
      const r = await b.getRiskStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "gauge",
    label: "Gauge",
    run: async (b) => {
      const r = await b.getGaugeStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "screen",
    label: "Screen",
    run: async (b) => {
      const r = await b.getScreenStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "base",
    label: "Base (replay-only)",
    run: async (b) => {
      const r = await b.getBaseConfig();
      return r.ok ? { ok: true, summary: summarize(r.config) } : { ok: false, summary: r.error };
    },
  },
];

type EngineRow = { id: string; label: string; state: "pending" | "ok" | "fail"; summary: string };

/* --------------------------------- panel ---------------------------------- */

export default function DiagnosticsPanel({ onClose }: Props) {
  const [env, setEnv] = useState<DiagnosticsEnvInfo | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderCheckResult[] | null>(null);
  const [providersBusy, setProvidersBusy] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [engines, setEngines] = useState<EngineRow[]>([]);

  const loadEnv = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getDiagnosticsEnv) {
      setEnvError("diagnostics bridge unavailable — restart the app (new IPC handlers need a main-process restart)");
      return;
    }
    const r = await bridge.getDiagnosticsEnv();
    if (r.ok) setEnv(r.env);
    else setEnvError(r.error);
  }, []);

  const runProviders = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.runDiagnosticsProviders) return;
    setProvidersBusy(true);
    setProvidersError(null);
    try {
      const r = await bridge.runDiagnosticsProviders();
      if (r.ok) setProviders(r.results);
      else setProvidersError(r.error);
    } finally {
      setProvidersBusy(false);
    }
  }, []);

  const runEngines = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge) return;
    setEngines(ENGINE_CHECKS.map((c) => ({ id: c.id, label: c.label, state: "pending", summary: "…" })));
    await Promise.all(
      ENGINE_CHECKS.map(async (check) => {
        let row: EngineRow;
        try {
          const outcome = await check.run(bridge);
          row = { id: check.id, label: check.label, state: outcome.ok ? "ok" : "fail", summary: outcome.summary };
        } catch (err) {
          row = {
            id: check.id,
            label: check.label,
            state: "fail",
            summary: err instanceof Error ? err.message : String(err),
          };
        }
        setEngines((prev) => prev.map((r) => (r.id === row.id ? row : r)));
      }),
    );
  }, []);

  useEffect(() => {
    void loadEnv();
    void runEngines();
    void runProviders();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loadEnv, runEngines, runProviders, onClose]);

  const sectionTitle = "font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]";

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-[#1d1b1b]/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#F4F4F0] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-[#e0e0da] px-5 py-3">
          <span className={sectionTitle}>DIAGNOSTICS · Shift+H</span>
          {env ? (
            <>
              <span className="rounded-full bg-[#1d1b1b] px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                {env.packaged ? "packaged" : "dev"}
              </span>
              <span
                className="rounded-full px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white"
                style={{ background: env.providerMode === "proxy" ? "#7C3AED" : "#189E9A" }}
              >
                {env.providerMode === "proxy" ? "proxy → worker" : "direct keys"}
              </span>
              <span className="text-[11px] tabular-nums text-[#9CA3AF]">
                v{env.appVersion} · electron {env.electron} · node {env.node}
              </span>
            </>
          ) : (
            <span className="text-[13px] text-[#6b7280]">{envError ?? "loading…"}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void loadEnv();
                void runEngines();
                void runProviders();
              }}
              disabled={providersBusy}
              className="rounded-lg bg-[#1d1b1b] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {providersBusy ? "checking…" : "re-run checks"}
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[#6b7280] hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Environment */}
          <section>
            <div className={sectionTitle}>ENVIRONMENT</div>
            {env ? (
              <div className="mt-2 space-y-3">
                <div className="rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2 text-[11px] leading-relaxed text-[#4b5563]">
                  <div>
                    <span className="font-semibold text-[#1d1b1b]">anthropic base</span>{" "}
                    <span className="font-mono">{env.anthropicBaseUrl}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-[#1d1b1b]">finnhub base</span>{" "}
                    <span className="font-mono">{env.finnhubBaseUrl}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-[#1d1b1b]">worker url</span>{" "}
                    <span className="font-mono">{env.workerUrl ?? "— (not set)"}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-[#1d1b1b]">data root</span>{" "}
                    <span className="font-mono">{env.dataRoot}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-[#1d1b1b]">supabase session</span>{" "}
                    {env.session.hasToken ? `token present (pushed ${env.session.updatedAt ?? "?"})` : "no token — sign in first"}
                    {env.session.hasSupabaseUrl ? "" : " · no supabase url"}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
                  {env.keys.map((k) => (
                    <div key={k.name} className="flex items-baseline gap-2 text-[11px]">
                      <span
                        className="inline-block h-2 w-2 shrink-0 self-center rounded-full"
                        style={{ background: k.present ? "#16A34A" : "#DC2626" }}
                      />
                      <span className="font-mono font-semibold text-[#1d1b1b]">{k.name}</span>
                      <span className="tabular-nums text-[#6b7280]">
                        {k.present ? `set (${k.length} chars)` : "not set"}
                      </span>
                      {k.note ? <span className="text-[10px] italic text-[#9CA3AF]">{k.note}</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : envError ? (
              <div className="mt-2 text-[12px] text-[#DC2626]">{envError}</div>
            ) : null}
          </section>

          {/* Providers */}
          <section>
            <div className="flex items-baseline gap-3">
              <div className={sectionTitle}>PROVIDERS (LIVE)</div>
              <span className="text-[10px] text-[#9CA3AF]">
                pings run through the same base-URL routing the engines use — green here means the packaged proxy path works
              </span>
            </div>
            {providersError ? <div className="mt-2 text-[12px] text-[#DC2626]">{providersError}</div> : null}
            <div className="mt-2 space-y-1.5">
              {(providers ?? []).map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
                  <StatusPill status={p.status} />
                  <span className="w-72 text-[12px] font-semibold text-[#1d1b1b]">{p.label}</span>
                  <span className="w-14 text-[11px] tabular-nums text-[#6b7280]">{p.httpStatus ?? ""}</span>
                  <span className="w-20 text-[11px] tabular-nums text-[#6b7280]">
                    {p.latencyMs != null ? `${p.latencyMs} ms` : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#6b7280]" title={p.detail}>
                    {p.detail ?? ""}
                  </span>
                </div>
              ))}
              {!providers && !providersError ? (
                <div className="text-[12px] text-[#6b7280]">{providersBusy ? "running live checks…" : "—"}</div>
              ) : null}
            </div>
          </section>

          {/* Engines */}
          <section>
            <div className="flex items-baseline gap-3">
              <div className={sectionTitle}>ENGINES</div>
              <span className="text-[10px] text-[#9CA3AF]">each row is the engine host&apos;s own status IPC — a red row didn&apos;t bootstrap</span>
            </div>
            <div className="mt-2 space-y-1.5">
              {engines.map((e) => (
                <div key={e.id} className="flex items-center gap-3 rounded-xl border border-[#e0e0da] bg-white/60 px-3 py-2">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: e.state === "ok" ? "#16A34A" : e.state === "fail" ? "#DC2626" : "#CA8A04" }}
                  />
                  <span className="w-72 text-[12px] font-semibold text-[#1d1b1b]">{e.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#6b7280]" title={e.summary}>
                    {e.summary}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
