import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type {
  EngineConnectionCheck,
  EngineEndpoint,
  EngineProviderStatus,
  EnginesCheckResult,
  EnginesOverview,
} from "../../../shared/engines-settings";
import type { ProviderCheckResult } from "../../../shared/diagnostics-types";
import type { ClassifierStatus } from "../../../shared/classifier-types";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { Switch } from "./controls";
import { useI18n, useT, type MessageKey, type TFunction } from "@/lib/i18n";
import { withClock } from "@/lib/clock";
import { useIsStaff } from "@/lib/staff";

/**
 * Engines — where Falcon's engines run and what they talk to.
 *
 * Everything here is read from the main process, which is the only side that
 * knows: the engine service and research worker addresses (FALCON_ENGINE_URL,
 * RESEARCH_WORKER_URL), whether each provider has what it needs (presence
 * only — a key's value never leaves main), and which models are in use.
 * "Check connection" pings the engine's /health and Yahoo, and runs the same
 * free provider checks as the Shift+H diagnostics panel.
 *
 * The two classifier switches are the Base panel's own (classifier:set-enabled
 * and classifier:set-rescore), so there is one copy of that state. With the
 * engine service in use they change the service, which is where the
 * classifier runs.
 *
 * Addresses and models come from the deployment's environment and are read at
 * launch, so they are shown, not edited.
 */

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-60";

const PILL = "rounded-lg bg-black/[0.04] px-2.5 py-1 font-['Geist_Mono'] text-[12px] text-content-body";

const MUTED = "text-[12.5px] font-normal text-content-tertiary";

type Tone = "ok" | "fail" | "warn" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  ok: "text-tone-positive",
  fail: "text-tone-negative",
  warn: "text-tone-warning",
  muted: "text-content-tertiary",
};

/** A coloured dot and a few words. The dot takes the text colour, so the dark palette follows. */
function Badge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1.5 text-[12.5px] font-normal", TONE_CLASS[tone])}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** One live check, as a badge. Nothing until a check has run. */
function CheckBadge({ check, busy }: { check: EngineConnectionCheck | ProviderCheckResult | null | undefined; busy: boolean }) {
  const t = useT();
  if (busy) return <Badge tone="muted">{t("settings.pane.checking")}</Badge>;
  if (!check) return null;
  if (check.status === "ok") {
    return (
      <Badge tone="ok" title={check.detail}>
        {check.latencyMs === undefined
          ? t("settings.engines.badge.reachable")
          : t("settings.engines.badge.reachableMs", { ms: check.latencyMs })}
      </Badge>
    );
  }
  if (check.status === "skipped") return <Badge tone="muted" title={check.detail}>{t("settings.engines.badge.notInUse")}</Badge>;
  if (check.status === "missing-key") return <Badge tone="warn" title={check.detail}>{t("settings.engines.badge.noKey")}</Badge>;
  const http = "httpStatus" in check && check.httpStatus ? check.httpStatus : null;
  return (
    <Badge tone="fail" title={check.detail}>
      {http ? t("settings.engines.badge.unreachableHttp", { status: http }) : t("settings.engines.badge.unreachable")}
    </Badge>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const SOURCE_TEXT: Record<EngineEndpoint["source"], MessageKey> = {
  default: "settings.engines.source.default",
  env: "settings.engines.source.env",
  off: "settings.engines.source.off",
};

/** What each provider is for, by id; main's English for one added before it is worded here. */
const USED_FOR: Readonly<Record<EngineProviderStatus["id"], MessageKey>> = {
  anthropic: "settings.engines.usedFor.anthropic",
  openrouter: "settings.engines.usedFor.openrouter",
  finnhub: "settings.engines.usedFor.finnhub",
  edgar: "settings.engines.usedFor.edgar",
  yahoo: "settings.engines.usedFor.yahoo",
  supabase: "settings.engines.usedFor.supabase",
};

function providerDescription(provider: EngineProviderStatus, t: TFunction): string {
  const key = USED_FOR[provider.id];
  const usedFor = !key
    ? provider.usedFor
    : provider.id === "openrouter"
      ? t(key, { engines: (provider.routedEngines ?? []).join(", ") })
      : t(key);
  return provider.id === "supabase" && !provider.configured
    ? t("settings.engines.providerNoHost", { usedFor })
    : t("settings.engines.provider", { usedFor, host: provider.host });
}

/** The models' rows, by id. */
const MODEL_LABELS: Readonly<Record<string, MessageKey>> = {
  classifier: "settings.engines.model.classifier",
  analyst: "settings.engines.model.analyst",
  propagation: "settings.engines.model.propagation",
  step1: "settings.engines.model.step1",
  insight: "settings.engines.model.insight",
  gloss: "settings.engines.model.gloss",
  briefing: "settings.engines.model.briefing",
  agents: "settings.engines.model.agents",
};

/* ---------------------------------- data ---------------------------------- */

type Checks = {
  engines: EnginesCheckResult | null;
  providers: ProviderCheckResult[] | null;
  at: Date | null;
  /** Set when a check could not run at all, as opposed to a provider failing it. */
  error: string | null;
};

function useEnginesData() {
  const bridge = typeof window === "undefined" ? undefined : window.meridian;
  const t = useT();
  const noAnswer = t("settings.engines.check.noAnswer");
  const [overview, setOverview] = useState<EnginesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Checks>({ engines: null, providers: null, at: null, error: null });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!bridge?.getEnginesOverview) return;
    let alive = true;
    void bridge.getEnginesOverview().then(
      (res) => {
        if (!alive) return;
        if (res.ok) setOverview(res.overview);
        else setError(res.error);
      },
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const check = useCallback(async () => {
    if (!bridge?.checkEngines) return;
    setChecking(true);
    try {
      const [engines, providers] = await Promise.all([
        bridge.checkEngines().catch(() => null),
        bridge.runDiagnosticsProviders?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      const failed = [engines, providers].find((r) => r && !r.ok) as { error: string } | undefined;
      setChecks({
        engines: engines?.ok ? engines.result : null,
        providers: providers?.ok ? providers.results : null,
        at: new Date(),
        error: !engines || !providers ? noAnswer : (failed?.error ?? null),
      });
    } finally {
      setChecking(false);
    }
  }, [bridge, noAnswer]);

  return { available: Boolean(bridge?.getEnginesOverview), overview, error, checks, checking, check };
}

/* -------------------------------- sections -------------------------------- */

function EndpointValue({ endpoint, fallback }: { endpoint: EngineEndpoint; fallback: string }) {
  if (!endpoint.url) return <span className={MUTED}>{fallback}</span>;
  return (
    <span data-selectable title={endpoint.url} className={cn(PILL, "select-text")}>
      {hostOf(endpoint.url)}
    </span>
  );
}

function ConnectionSection({
  overview,
  checks,
  checking,
  onCheck,
}: {
  overview: EnginesOverview;
  checks: Checks;
  checking: boolean;
  onCheck: () => void;
}) {
  const { t, locale } = useI18n();
  const { engine, worker } = overview;
  const workerCheck = checks.providers?.find((c) => c.id === "worker");
  const engineCheck = checks.engines?.engine;
  const engineDescription = engine.url
    ? t("settings.engines.engine.description", { source: t(SOURCE_TEXT[engine.source]) })
    : engine.localChain
      ? t("settings.engines.engine.localChain")
      : t("settings.engines.engine.none");

  return (
    <SettingsSection title={t("settings.engines.service")}>
      <SettingsRow label={t("settings.engines.engine")} description={engineDescription}>
        <div className="flex items-center gap-3">
          <CheckBadge check={engineCheck} busy={checking && Boolean(engine.url)} />
          {engineCheck?.status === "ok" && engineCheck.version ? (
            <span className={MUTED}>v{engineCheck.version}</span>
          ) : null}
          <EndpointValue
            endpoint={engine}
            fallback={engine.localChain ? t("settings.engines.thisApp") : t("settings.engines.off")}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        label={t("settings.engines.worker")}
        description={
          worker.url
            ? t("settings.engines.worker.description", { source: t(SOURCE_TEXT[worker.source]) })
            : t("settings.engines.worker.none")
        }
      >
        <div className="flex items-center gap-3">
          <CheckBadge check={workerCheck} busy={checking && Boolean(worker.url)} />
          <EndpointValue endpoint={worker} fallback={t("settings.engines.off")} />
        </div>
      </SettingsRow>

      <SettingsRow
        label={t("settings.engines.calls")}
        description={
          overview.providerMode === "proxy" ? t("settings.engines.calls.proxy") : t("settings.engines.calls.direct")
        }
      >
        <span className={MUTED}>
          {overview.providerMode === "proxy" ? t("settings.engines.calls.proxyValue") : t("settings.engines.calls.directValue")}
        </span>
      </SettingsRow>

      <SettingsRow
        label={t("settings.engines.check")}
        description={
          checks.error
            ? t("settings.engines.check.error", { error: checks.error })
            : checks.at
              ? t("settings.engines.check.at", {
                  time: checks.at.toLocaleTimeString(locale, withClock({ hour: "numeric", minute: "2-digit", second: "2-digit" })),
                })
              : t("settings.engines.check.idle")
        }
        className="border-b-0"
      >
        <button type="button" onClick={onCheck} disabled={checking} className={BUTTON}>
          {checking ? t("settings.pane.checking") : t("settings.engines.check")}
        </button>
      </SettingsRow>
      {/* A packaged build's rows already say "Built-in address"; only a dev build needs to know where to change them. */}
      {overview.packaged ? null : (
        <p className="text-[12px] font-normal leading-snug text-content-tertiary">{t("settings.engines.addressesEnv")}</p>
      )}
    </SettingsSection>
  );
}

function providerConfigBadge(provider: EngineProviderStatus, overview: EnginesOverview, t: TFunction) {
  if (provider.keyless) return <Badge tone="muted">{t("settings.engines.badge.keyless")}</Badge>;
  if (provider.route === "worker") {
    // In proxy mode the "key" is the reader's own session; the real key is on the worker.
    return overview.signedIn ? (
      <Badge tone="ok">{t("settings.engines.badge.viaWorker")}</Badge>
    ) : (
      <Badge tone="warn">{t("settings.engines.badge.signIn")}</Badge>
    );
  }
  if (provider.id === "supabase") {
    return provider.configured ? (
      <Badge tone="ok">{t("settings.engines.badge.configured")}</Badge>
    ) : (
      <Badge tone="fail">{t("settings.engines.badge.urlMissing")}</Badge>
    );
  }
  return provider.configured ? (
    <Badge tone="ok">{t("settings.engines.badge.keyConfigured")}</Badge>
  ) : (
    <Badge tone="fail">{t("settings.engines.badge.keyMissing")}</Badge>
  );
}

function ProvidersSection({ overview, checks, checking }: { overview: EnginesOverview; checks: Checks; checking: boolean }) {
  const liveFor = (id: EngineProviderStatus["id"]): EngineConnectionCheck | ProviderCheckResult | null | undefined => {
    if (id === "yahoo") return checks.engines?.yahoo;
    return checks.providers?.find((c) => c.id === id);
  };
  const checkable = (id: EngineProviderStatus["id"]) => id !== "openrouter";
  const t = useT();

  return (
    <SettingsSection title={t("settings.engines.providers")}>
      {overview.providers.map((provider) => (
        <SettingsRow key={provider.id} label={provider.label} description={providerDescription(provider, t)}>
          <div className="flex items-center gap-3">
            {checkable(provider.id) ? <CheckBadge check={liveFor(provider.id)} busy={checking} /> : null}
            {providerConfigBadge(provider, overview, t)}
          </div>
        </SettingsRow>
      ))}
      <SettingsRow
        label="OpenAI, Perplexity, Massive"
        description={t("settings.engines.unused.description")}
        className="border-b-0"
      >
        <span className={MUTED}>{t("settings.engines.unused.value")}</span>
      </SettingsRow>
    </SettingsSection>
  );
}

function ClassifierSection({ overview }: { overview: EnginesOverview }) {
  const bridge = typeof window === "undefined" ? undefined : window.meridian;
  const [status, setStatus] = useState<ClassifierStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"enabled" | "rescore" | null>(null);
  const t = useT();
  // Both switches change the classifier for every account: the engine takes
  // them from staff only, so members see the state but cannot flip it.
  const staff = useIsStaff();

  useEffect(() => {
    if (!bridge?.getClassifierStatus) return;
    let alive = true;
    void bridge.getClassifierStatus().then(
      (res) => {
        if (!alive) return;
        if (res.ok) setStatus(res.status);
        else setError(res.error);
      },
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const apply = async (which: "enabled" | "rescore", value: boolean) => {
    if (!bridge) return;
    setBusy(which);
    setError(null);
    try {
      const res = which === "enabled" ? await bridge.setClassifierEnabled(value) : await bridge.setClassifierRescore(value);
      if (res.ok) setStatus(res.status);
      else setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remote = Boolean(overview.engine.url);
  const minutes = status ? Math.round(status.cycle_interval_ms / 60_000) : null;
  const loopDescription = !status
    ? t("settings.engines.classifier.loop")
    : status.configured
      ? t("settings.engines.classifier.loopOn", { minutes: minutes ?? 0, model: status.model })
      : t("settings.engines.classifier.loopNoKey");

  return (
    <SettingsSection title={t("settings.engines.classifier")}>
      <SettingsRow label={t("settings.engines.classifier.live")} description={loopDescription}>
        <Switch
          label={t("settings.engines.classifier.live")}
          checked={Boolean(status?.enabled)}
          disabled={!staff || !status || !status.configured || busy !== null}
          onChange={(v) => void apply("enabled", v)}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.engines.classifier.rescore")}
        description={t("settings.engines.classifier.rescoreDescription")}
        className="border-b-0"
      >
        <Switch
          label={t("settings.engines.classifier.rescore")}
          checked={Boolean(status?.rescore_enabled)}
          disabled={!staff || !status || busy !== null}
          onChange={(v) => void apply("rescore", v)}
        />
      </SettingsRow>
      <p className={cn("text-[12px] font-normal leading-snug", error ? "text-tone-negative" : "text-content-tertiary")}>
        {error
          ? t("settings.engines.classifier.error", { error })
          : !staff
            ? t("access.staffOnly.setting")
            : remote
            ? t("settings.engines.classifier.remote", { host: hostOf(overview.engine.url ?? "") })
            : t("settings.engines.classifier.local")}
      </p>
    </SettingsSection>
  );
}

type ChainModel = { id: string; label: string; model: string | null };

function ModelsSection({ overview }: { overview: EnginesOverview }) {
  const bridge = typeof window === "undefined" ? undefined : window.meridian;
  const [chain, setChain] = useState<ChainModel[] | null>(null);
  const t = useT();

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const pick = async (id: string, label: string, ask: (() => Promise<unknown>) | undefined): Promise<ChainModel> => {
      try {
        const res = (await ask?.()) as { ok: boolean; status?: { model?: string } } | undefined;
        return { id, label, model: res?.ok ? (res.status?.model ?? null) : null };
      } catch {
        return { id, label, model: null };
      }
    };
    void Promise.all([
      pick("classifier", "Classifier", bridge.getClassifierStatus),
      pick("analyst", "Analyst", bridge.getAnalystStatus),
      pick("propagation", "Propagation judge", bridge.getPropagationStatus),
    ]).then((rows) => alive && setChain(rows));
    return () => {
      alive = false;
    };
  }, [bridge]);

  const chainWhere = overview.engine.url ? "engine" : "app";
  const rows = [
    ...(chain ?? []).map((m) => ({ ...m, where: chainWhere })),
    ...overview.localModels.map((m) => ({
      id: m.id,
      label: m.label,
      model: m.model,
      where: m.where === "this app" ? "app" : "worker",
    })),
  ];
  const WHERE: Record<string, MessageKey> = {
    engine: "settings.engines.where.engine",
    app: "settings.engines.where.app",
    worker: "settings.engines.where.worker",
  };

  return (
    <SettingsSection title={t("settings.engines.models")}>
      {rows.map((row, i) => (
        <SettingsRow
          key={row.id}
          label={MODEL_LABELS[row.id] ? t(MODEL_LABELS[row.id]!) : row.label}
          description={t(WHERE[row.where]!)}
          className={i === rows.length - 1 ? "border-b-0" : undefined}
        >
          {row.model ? (
            <span data-selectable className={cn(PILL, "select-text")}>
              {row.model}
            </span>
          ) : (
            <span className={MUTED}>
              {row.where === "worker" ? t("settings.engines.setByWorker") : t("settings.pane.unavailable")}
            </span>
          )}
        </SettingsRow>
      ))}
      <p className="text-[12px] font-normal leading-snug text-content-tertiary">
        {t("settings.engines.modelsNote")}
      </p>
    </SettingsSection>
  );
}

export default function EnginesPane() {
  const { available, overview, error, checks, checking, check } = useEnginesData();
  const t = useT();

  if (!available) {
    return (
      <SettingsSection title={t("settings.section.engines")}>
        <SettingsRow label={t("settings.engines.desktopOnly")} className="border-b-0">
          <span className={MUTED}>{t("settings.pane.unavailable")}</span>
        </SettingsRow>
      </SettingsSection>
    );
  }
  if (!overview) {
    return (
      <SettingsSection title={t("settings.engines.service")}>
        <p className={cn("py-4", error ? "text-[12.5px] text-tone-negative" : MUTED)}>
          {error ? t("settings.engines.readFailed", { error }) : t("settings.pane.loading")}
        </p>
      </SettingsSection>
    );
  }
  return (
    <>
      <ConnectionSection overview={overview} checks={checks} checking={checking} onCheck={() => void check()} />
      <ProvidersSection overview={overview} checks={checks} checking={checking} />
      <ClassifierSection overview={overview} />
      <ModelsSection overview={overview} />
    </>
  );
}
