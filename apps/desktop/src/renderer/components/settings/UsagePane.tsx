import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { UsageSummary } from "../../../shared/privacy-types";
import { countAccountResearch, currentAccessToken } from "@/lib/privacy-data";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { Value, formatCount, formatTokens } from "./pane-kit";
import { useI18n, type MessageKey, type TFunction } from "@/lib/i18n";
import { withClock } from "@/lib/clock";
import { durationText, pluralKey } from "./i18n-helpers";

/**
 * Usage — counted, never estimated. Three sources, each named where it is
 * shown:
 *   - the research worker's own allowance for this account (one new company
 *     research per window, apps/research-worker/src/research-quota.ts);
 *   - the account's research jobs in Supabase, the rows that allowance counts;
 *   - this machine's files: the extractor's per-filing stats (which record
 *     tokens and its own cost estimate), saved briefings, and each local
 *     engine's metrics file (main/privacy).
 * Where a source has nothing to say, the row says so instead of showing zero.
 */

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; error: string };

type Quota = {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
  allowed: boolean;
  /** Sent by the worker though the preload type leaves it out. */
  windowMs?: number;
};

function monthStartDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function windowText(ms: number | undefined, locale: string): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3_600_000;
  return hours >= 1 && Number.isInteger(hours)
    ? durationText(locale, hours, "hour")
    : durationText(locale, Math.round(ms / 60_000), "minute");
}

function timeText(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(locale, withClock({ weekday: "short", hour: "numeric", minute: "2-digit" }));
}

/** What one completed unit of each local engine is called, one and many. */
const ENGINE_WORDS: Readonly<Record<UsageSummary["engines"][number]["key"], { label: MessageKey; one: MessageKey; other: MessageKey }>> = {
  propagation: {
    label: "settings.usage.engine.propagation",
    one: "settings.usage.engine.runs.one",
    other: "settings.usage.engine.runs.other",
  },
  classifier: {
    label: "settings.usage.engine.classifier",
    one: "settings.usage.engine.verdicts.one",
    other: "settings.usage.engine.verdicts.other",
  },
  analyst: {
    label: "settings.usage.engine.analyst",
    one: "settings.usage.engine.writeups.one",
    other: "settings.usage.engine.writeups.other",
  },
};

function Pending({ load, t }: { load: Load<unknown>; t: TFunction }) {
  return <Value muted>{load.state === "loading" ? t("settings.pane.counting") : t("settings.pane.unavailable")}</Value>;
}

function Allowance({ quota }: { quota: Load<Quota | null> }) {
  const { t, locale } = useI18n();
  if (quota.state !== "ready" || quota.value === null) {
    return (
      <SettingsRow
        label={t("settings.usage.allowance.label")}
        description={quota.state === "loading" ? undefined : t("settings.usage.allowance.unreachable")}
      >
        <Pending load={quota.state === "loading" ? quota : { state: "error", error: "" }} t={t} />
      </SettingsRow>
    );
  }
  const q = quota.value;
  const span = windowText(q.windowMs, locale);
  const limit = span
    ? t(pluralKey(locale, q.limit, "settings.usage.allowance.every.one", "settings.usage.allowance.every.other"), {
        count: formatCount(q.limit),
        span,
      })
    : t(pluralKey(locale, q.limit, "settings.usage.allowance.perWindow.one", "settings.usage.allowance.perWindow.other"), {
        count: formatCount(q.limit),
      });
  const next = !q.allowed && q.resetAt ? t("settings.usage.allowance.next", { time: timeText(q.resetAt, locale) }) : null;
  return (
    <SettingsRow label={t("settings.usage.allowance.label")} description={next ? t("settings.usage.allowance.withNext", { limit, next }) : limit}>
      <Value>{t("settings.usage.allowance.used", { used: formatCount(q.used), limit: formatCount(q.limit) })}</Value>
    </SettingsRow>
  );
}

export default function UsagePane({ user = null }: { user?: User | null }) {
  const [local, setLocal] = useState<Load<UsageSummary>>({ state: "loading" });
  const [jobs, setJobs] = useState<Load<{ total: number; thisMonth: number }>>({ state: "loading" });
  const [quota, setQuota] = useState<Load<Quota | null>>({ state: "loading" });
  const userId = user?.id ?? null;
  const { t, locale } = useI18n();
  const desktopOnly = t("settings.usage.desktopOnly");
  const notSignedIn = t("settings.account.notSignedIn");

  useEffect(() => {
    let live = true;
    const getUsage = window.meridian?.getUsageSummary;
    if (getUsage) {
      void getUsage().then(
        (r) => live && setLocal(r.ok ? { state: "ready", value: r.usage } : { state: "error", error: r.error }),
        (err: unknown) => live && setLocal({ state: "error", error: String(err) }),
      );
    } else {
      setLocal({ state: "error", error: desktopOnly });
    }

    void (async () => {
      const token = await currentAccessToken();
      const getQuota = window.meridian?.getStep1ResearchQuota;
      if (!token || !getQuota) {
        if (live) setQuota({ state: "ready", value: null });
        return;
      }
      try {
        const r = await getQuota(token);
        if (live) setQuota({ state: "ready", value: r.ok ? (r.quota as Quota) : null });
      } catch {
        if (live) setQuota({ state: "ready", value: null });
      }
    })();

    if (userId) {
      void countAccountResearch(userId, monthStartDate()).then((r) => {
        if (live) setJobs(r.ok ? { state: "ready", value: r } : { state: "error", error: r.error });
      });
    } else {
      setJobs({ state: "error", error: notSignedIn });
    }
    return () => {
      live = false;
    };
  }, [userId, desktopOnly, notSignedIn]);

  const usage = local.state === "ready" ? local.value : null;
  const ex = usage?.extractions;

  return (
    <>
      <SettingsSection title={t("settings.usage.research")}>
        <Allowance quota={quota} />
        <SettingsRow
          label={t("settings.usage.account.label")}
          description={jobs.state === "error" ? jobs.error : undefined}
          className="border-b-0"
        >
          {jobs.state === "ready" ? (
            <Value>
              {t("settings.usage.monthAllTime", {
                month: formatCount(jobs.value.thisMonth),
                total: formatCount(jobs.value.total),
              })}
            </Value>
          ) : (
            <Pending load={jobs} t={t} />
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("settings.privacy.device")}>
        <SettingsRow
          label={t("settings.usage.extractions.label")}
          description={
            local.state === "error"
              ? local.error
              : ex && ex.bundled > 0
                ? t("settings.usage.extractions.descriptionBundled", { count: formatCount(ex.bundled) })
                : undefined
          }
        >
          {ex ? (
            <Value>
              {t("settings.usage.monthAllTime", { month: formatCount(ex.thisMonth), total: formatCount(ex.total) })}
            </Value>
          ) : (
            <Pending load={local} t={t} />
          )}
        </SettingsRow>

        {ex && ex.withStats > 0 ? (
          <>
            <SettingsRow
              label={t("settings.usage.tokens.label")}
              description={t("settings.usage.tokens.description", { count: formatCount(ex.withStats) })}
            >
              <Value>
                {t("settings.usage.tokens.value", { in: formatTokens(ex.inputTokens), out: formatTokens(ex.outputTokens) })}
              </Value>
            </SettingsRow>
            <SettingsRow label={t("settings.usage.cost.label")} description={t("settings.usage.cost.description")}>
              <Value>${ex.estimatedCostUsd.toFixed(2)}</Value>
            </SettingsRow>
          </>
        ) : null}

        <SettingsRow
          label={t("settings.usage.briefings.label")}
          description={t("settings.usage.briefings.description")}
          className="border-b-0"
        >
          {usage ? (
            <Value>
              {t("settings.usage.monthSaved", {
                month: formatCount(usage.briefings.thisMonth),
                total: formatCount(usage.briefings.total),
              })}
            </Value>
          ) : (
            <Pending load={local} t={t} />
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("settings.usage.engines.title")}>
        {!usage ? (
          <SettingsRow label={t("settings.usage.engines.activity")} className="border-b-0">
            <Pending load={local} t={t} />
          </SettingsRow>
        ) : usage.enginesRemote ? (
          <SettingsRow label={t("settings.usage.engines.remote")} className="border-b-0">
            <Value muted>{t("settings.usage.engines.remoteValue")}</Value>
          </SettingsRow>
        ) : usage.engines.length === 0 ? (
          <SettingsRow
            label={t("settings.usage.engines.none")}
            description={t("settings.usage.engines.noneDescription")}
            className="border-b-0"
          >
            <Value muted>{t("settings.usage.engines.noneValue")}</Value>
          </SettingsRow>
        ) : (
          usage.engines.map((e, i) => {
            const words = ENGINE_WORDS[e.key];
            return (
              <SettingsRow
                key={e.key}
                label={words ? t(words.label) : e.label}
                description={t("settings.usage.engine.tokens", {
                  in: formatTokens(e.inputTokens),
                  out: formatTokens(e.outputTokens),
                })}
                className={i === usage.engines.length - 1 ? "border-b-0" : undefined}
              >
                <Value>
                  {words
                    ? t(pluralKey(locale, e.completed, words.one, words.other), { count: formatCount(e.completed) })
                    : `${formatCount(e.completed)} ${e.unit}`}
                </Value>
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>
    </>
  );
}
