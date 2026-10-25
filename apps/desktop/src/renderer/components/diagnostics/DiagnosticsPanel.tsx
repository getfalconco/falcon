import { na } from "@/lib/i18n/na";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { shortcutText } from "@/lib/shortcuts";
import { useT, type MessageKey } from "@/lib/i18n";
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
  ok: "var(--positive)",
  fail: "var(--negative)",
  "missing-key": "var(--warning)",
  skipped: "var(--text-tertiary)",
};

const STATUS_LABEL: Record<ProviderCheckStatus, MessageKey> = {
  ok: "instruments.diagnostics.status.ok",
  fail: "instruments.diagnostics.status.fail",
  "missing-key": "instruments.diagnostics.status.missingKey",
  skipped: "instruments.diagnostics.status.skipped",
};

function StatusPill({ status }: { status: ProviderCheckStatus }) {
  const t = useT();
  return (
    <span
      className="rounded-full px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white"
      style={{ background: STATUS_COLOR[status] }}
      // A status this build has no word for is shown as its English code.
      lang={STATUS_LABEL[status] ? undefined : "en"}
    >
      {STATUS_LABEL[status] ? t(STATUS_LABEL[status]) : status}
    </span>
  );
}

/* -------------------------------- engines -------------------------------- */

type EngineOutcome = { ok: boolean; summary: string };

/** Compact one-liner out of an arbitrary status object — debug panel, not a contract. */
function summarize(data: unknown): string {
  if (data == null) return na();
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
  label: MessageKey;
  run: (bridge: Bridge) => Promise<EngineOutcome>;
}> = [
  {
    id: "tracker",
    label: "instruments.diagnostics.engine.tracker",
    run: async (b) => {
      const r = await b.getTrackerStatus();
      return { ok: r.ok, summary: summarize(r.status) };
    },
  },
  {
    id: "events",
    label: "instruments.diagnostics.engine.events",
    run: async (b) => {
      const r = await b.getNewsEventsStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "classifier",
    label: "instruments.diagnostics.engine.classifier",
    run: async (b) => {
      const r = await b.getClassifierStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "analyst",
    label: "instruments.diagnostics.engine.analyst",
    run: async (b) => {
      const r = await b.getAnalystStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "propagation",
    label: "instruments.diagnostics.engine.propagation",
    run: async (b) => {
      const r = await b.getPropagationStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "risk",
    label: "instruments.diagnostics.engine.risk",
    run: async (b) => {
      const r = await b.getRiskStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "gauge",
    label: "instruments.diagnostics.engine.gauge",
    run: async (b) => {
      const r = await b.getGaugeStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "screen",
    label: "instruments.diagnostics.engine.screen",
    run: async (b) => {
      const r = await b.getScreenStatus();
      return r.ok ? { ok: true, summary: summarize(r.status) } : { ok: false, summary: r.error };
    },
  },
  {
    id: "base",
    label: "instruments.diagnostics.engine.base",
    run: async (b) => {
      const r = await b.getBaseConfig();
      return r.ok ? { ok: true, summary: summarize(r.config) } : { ok: false, summary: r.error };
    },
  },
];

/** envError value for "the preload has no diagnostics bridge"; rendered through t(). */
const BRIDGE_MISSING = "\u0000bridge-missing";

type EngineRow = { id: string; label: MessageKey; state: "pending" | "ok" | "fail"; summary: string };

/* --------------------------------- panel ---------------------------------- */

export default function DiagnosticsPanel({ onClose }: Props) {
  const t = useT();
  const [env, setEnv] = useState<DiagnosticsEnvInfo | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderCheckResult[] | null>(null);
  const [providersBusy, setProvidersBusy] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [engines, setEngines] = useState<EngineRow[]>([]);

  const loadEnv = useCallback(async () => {
    const bridge = window.meridian;
    if (!bridge?.getDiagnosticsEnv) {
      // Kept as a marker, not as words: the message follows the language.
      setEnvError(BRIDGE_MISSING);
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

  const envErrorText =
    envError === BRIDGE_MISSING ? t("instruments.common.bridgeUnavailable", { name: "Diagnostics" }) : envError;

  const sectionTitle = "font-sans text-[11px] font-medium tracking-[0.04em] text-content-tertiary";

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-ink/30 backdrop-blur-[3px]">
      <div className="flex h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/70 bg-surface-1 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-edge px-5 py-3">
          <span className={`${sectionTitle} shrink-0`}>{t("instruments.diagnostics.title", { key: shortcutText("diagnostics") })}</span>
          {env ? (
            <>
              <span className="rounded-full bg-ink px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                {env.packaged ? t("instruments.diagnostics.packaged") : t("instruments.diagnostics.dev")}
              </span>
              <span
                className="rounded-full px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white"
                style={{ background: env.providerMode === "proxy" ? "var(--violet)" : "var(--teal)" }}
              >
                {env.providerMode === "proxy" ? t("instruments.diagnostics.proxy") : t("instruments.diagnostics.direct")}
              </span>
              <span className="text-[11px] tabular-nums text-content-tertiary">
                v{env.appVersion} · electron {env.electron} · node {env.node}
              </span>
            </>
          ) : (
            <span className="text-[13px] text-content-secondary">{envErrorText ?? t("instruments.common.loading")}</span>
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
              className="rounded-lg bg-ink px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {providersBusy ? t("instruments.diagnostics.checking") : t("instruments.diagnostics.rerun")}
            </button>
            <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className="rounded-lg p-1.5 text-content-secondary hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Environment */}
          <section>
            <div className={sectionTitle}>{t("instruments.diagnostics.environment")}</div>
            {env ? (
              <div className="mt-2 space-y-3">
                <div className="rounded-xl border border-edge bg-white/60 px-3 py-2 text-[11px] leading-relaxed text-content-body">
                  <div>
                    <span className="font-semibold text-content-primary">{t("instruments.diagnostics.anthropicBase")}</span>{" "}
                    <span className="font-mono">{env.anthropicBaseUrl}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-content-primary">{t("instruments.diagnostics.finnhubBase")}</span>{" "}
                    <span className="font-mono">{env.finnhubBaseUrl}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-content-primary">{t("instruments.diagnostics.workerUrl")}</span>{" "}
                    <span className="font-mono">{env.workerUrl ?? t("instruments.diagnostics.notSet")}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-content-primary">{t("instruments.diagnostics.dataRoot")}</span>{" "}
                    <span className="font-mono">{env.dataRoot}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-content-primary">{t("instruments.diagnostics.session")}</span>{" "}
                    {env.session.hasToken
                      ? t("instruments.diagnostics.tokenPresent", { when: env.session.updatedAt ?? "?" })
                      : t("instruments.diagnostics.noToken")}
                    {env.session.hasSupabaseUrl ? "" : ` · ${t("instruments.diagnostics.noSupabaseUrl")}`}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-edge bg-white/60 px-3 py-2">
                  {env.keys.map((k) => (
                    <div key={k.name} className="flex items-baseline gap-2 text-[11px]">
                      <span
                        className="inline-block h-2 w-2 shrink-0 self-center rounded-full"
                        style={{ background: k.present ? "var(--positive)" : "var(--negative)" }}
                      />
                      <span className="font-mono font-semibold text-content-primary">{k.name}</span>
                      <span className="tabular-nums text-content-secondary">
                        {k.present ? t("instruments.diagnostics.keySet", { n: k.length }) : t("instruments.diagnostics.keyNotSet")}
                      </span>
                      {k.note ? <span className="text-[10px] italic text-content-tertiary">{k.note}</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : envError ? (
              <div className="mt-2 text-[12px] text-tone-negative">{envErrorText}</div>
            ) : null}
          </section>

          {/* Providers */}
          <section>
            <div className="flex items-baseline gap-3">
              <div className={`${sectionTitle} shrink-0`}>{t("instruments.diagnostics.providers")}</div>
              <span className="text-[10px] text-content-tertiary">{t("instruments.diagnostics.providersHint")}</span>
            </div>
            {providersError ? <div className="mt-2 text-[12px] text-tone-negative">{providersError}</div> : null}
            <div className="mt-2 space-y-1.5">
              {(providers ?? []).map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-xl border border-edge bg-white/60 px-3 py-2">
                  <StatusPill status={p.status} />
                  <span className="w-72 text-[12px] font-semibold text-content-primary">{p.label}</span>
                  <span className="w-14 text-[11px] tabular-nums text-content-secondary">{p.httpStatus ?? ""}</span>
                  <span className="w-20 text-[11px] tabular-nums text-content-secondary">
                    {p.latencyMs != null ? `${p.latencyMs} ms` : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-content-secondary" title={p.detail}>
                    {p.detail ?? ""}
                  </span>
                </div>
              ))}
              {!providers && !providersError ? (
                <div className="text-[12px] text-content-secondary">{providersBusy ? t("instruments.diagnostics.runningChecks") : na()}</div>
              ) : null}
            </div>
          </section>

          {/* Engines */}
          <section>
            <div className="flex items-baseline gap-3">
              <div className={`${sectionTitle} shrink-0`}>{t("instruments.diagnostics.engines")}</div>
              <span className="text-[10px] text-content-tertiary">{t("instruments.diagnostics.enginesHint")}</span>
            </div>
            <div className="mt-2 space-y-1.5">
              {engines.map((e) => (
                <div key={e.id} className="flex items-center gap-3 rounded-xl border border-edge bg-white/60 px-3 py-2">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: e.state === "ok" ? "var(--positive)" : e.state === "fail" ? "var(--negative)" : "var(--yellow)" }}
                  />
                  <span className="w-72 text-[12px] font-semibold text-content-primary">{t(e.label)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-content-secondary" title={e.summary}>
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
