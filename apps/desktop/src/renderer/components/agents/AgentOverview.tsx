import type { ReactNode } from "react";
import { Activity, AlertCircle, BarChart3, Bell, CalendarClock, CalendarX2, FileDiff, FileText, Globe2, Inbox, Network, Newspaper, Smartphone, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Agent, AgentTriggerKind } from "../../../shared/agent-types";
import {
  capitalize,
  countdown,
  dateTime,
  endsSentence,
  firstStatusLine,
  isDueNow,
  relativePhrase,
  relativeTime,
  sayLines,
  shortDate,
  statusLabel,
  triggerSentence,
} from "./agent-format";
import { LABEL } from "./agent-ui";

const KIND_ICON: Readonly<Record<AgentTriggerKind, LucideIcon>> = {
  earnings: BarChart3,
  filing: FileText,
  price_move: Activity,
  news: Newspaper,
  macro: Globe2,
  linked: Network,
  filing_changes: FileDiff,
  schedule: CalendarClock,
};

function Block({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0", className)}>
      <h3 className={cn(LABEL, "pb-2")}>{label}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/60 bg-white/55 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]">
      <div className={cn(LABEL, "text-[10.5px]")}>{label}</div>
      <div className="mt-1 truncate text-[17px] font-medium tabular-nums text-[#1d1b1b]">{value}</div>
      {sub ? <div className="mt-0.5 truncate text-[11.5px] text-[#9CA3AF]">{sub}</div> : null}
    </div>
  );
}

/**
 * What the agent is, in the reader's words first and then as Falcon read
 * them: triggers as sentences, the metrics with the reader's bar, where
 * findings go, and where the agent stands right now.
 */
export default function AgentOverview({ agent, reportCount, now }: { agent: Agent; reportCount: number; now: number }) {
  const { language: lang, t } = useI18n();
  const next = countdown(agent.nextExpectedAt, now, lang);
  const waiting = agent.status === "active" || agent.status === "error";
  const lastFired = relativePhrase(agent.lastFiredAt, now, lang);
  const edited = relativePhrase(agent.updatedAt, now, lang);
  const first = firstStatusLine(agent, now, lang);

  return (
    <div className="space-y-7">
      {first ? (
        <p role="status" className="text-[13.5px] leading-[1.55] text-[#1d1b1b]">
          {first}
        </p>
      ) : null}

      {agent.status === "error" ? (
        <div className="flex items-start gap-2.5 rounded-2xl bg-[#FEE2E2] px-4 py-3 text-[12.5px] leading-[1.5] text-[#991B1B]">
          <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <div>
            <div className="font-medium">{t("agents.overview.errorTitle")}</div>
            {agent.error ? <div className="mt-0.5">{agent.error}</div> : null}
            <div className="mt-0.5 opacity-80">{t("agents.overview.errorHint")}</div>
          </div>
        </div>
      ) : null}

      <Block label={t("agents.yourBrief")}>
        <blockquote className="border-l-2 border-black/[0.1] pl-4 font-baskerville text-[15px] leading-[1.65] text-[#1d1b1b]">
          {agent.brief}
        </blockquote>
      </Block>

      <div className="grid grid-cols-3 gap-3">
        <Stat
          label={t("agents.overview.nextEvent")}
          value={
            waiting && next
              ? isDueNow(agent.nextExpectedAt, now)
                ? t("agents.overview.dueNow")
                : capitalize(next, lang)
              : agent.status === "paused"
                ? statusLabel("paused", lang)
                : agent.status === "completed"
                  ? t("agents.overview.done")
                  : t("agents.overview.notDated")
          }
          sub={waiting && agent.nextExpectedAt ? dateTime(agent.nextExpectedAt, lang) : waiting ? t("agents.overview.firesWhen") : undefined}
        />
        <Stat
          label={t("agents.overview.lastChecked")}
          value={agent.lastCheckedAt ? relativeTime(agent.lastCheckedAt, now, lang) : t("agents.overview.notYet")}
          sub={agent.lastCheckedAt ? dateTime(agent.lastCheckedAt, lang) : undefined}
        />
        <Stat
          label={t("agents.overview.reports")}
          value={reportCount}
          sub={
            !agent.lastFiredAt
              ? t("agents.overview.noneYet")
              : lastFired.kind === "on"
                ? t("agents.overview.lastOn", { date: lastFired.text })
                : t("agents.overview.lastAgo", { when: lastFired.text })
          }
        />
      </div>

      {!first && agent.nextAction && agent.status === "active" ? (
        <p className="-mt-3 text-[12.5px] leading-[1.5] text-[#6b7280]">{sayLines(agent.nextActionLines, lang, agent.nextAction)}</p>
      ) : null}

      <Block label={t("agents.wakesUp")}>
        <ul className="space-y-1.5">
          {agent.triggers.map((trigger, i) => {
            const Icon = KIND_ICON[trigger.kind];
            return (
              <li key={i} className="flex items-center gap-2.5 text-[13.5px] text-[#1d1b1b]">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] text-[#4b5563]">
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                </span>
                {triggerSentence(trigger, lang)}
              </li>
            );
          })}
          {agent.triggers.length === 0 ? <li className="text-[12.5px] text-[#9CA3AF]">{t("agents.overview.noTrigger")}</li> : null}
        </ul>
      </Block>

      <Block label={t("agents.overview.reportsOn")}>
        {agent.metrics.length === 0 ? (
          <p className="text-[12.5px] text-[#9CA3AF]">{t("agents.overview.noMetrics")}</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-black/[0.06]">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.04]">
                  <th className="px-4 py-2 font-['Geist_Mono'] text-[9.5px] font-normal uppercase tracking-[0.06em] text-[#9CA3AF]">{t("agents.metric")}</th>
                  <th className="px-4 py-2 font-['Geist_Mono'] text-[9.5px] font-normal uppercase tracking-[0.06em] text-[#9CA3AF]">{t("agents.yourBar")}</th>
                </tr>
              </thead>
              <tbody>
                {agent.metrics.map((m, i) => (
                  <tr key={m.id} className={cn(i > 0 && "border-t border-black/[0.06]")}>
                    <td className="px-4 py-2.5 text-[#1d1b1b]">{m.label}</td>
                    <td className="px-4 py-2.5 text-[#4b5563]">{m.expectation || <span className="text-[#9CA3AF]">{t("agents.overview.againstConsensus")}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {agent.instructions ? (
        <Block label={t("agents.writeup")}>
          <p className="text-[13px] leading-[1.6] text-[#4b5563]">{agent.instructions}</p>
        </Block>
      ) : null}

      <Block label={t("agents.delivery")}>
        <ul className="space-y-2 text-[13px]">
          <li className="flex items-center gap-2.5">
            <Inbox className="h-3.5 w-3.5 shrink-0 text-[#4b5563]" strokeWidth={1.75} aria-hidden />
            <span className="text-[#1d1b1b]">{t("agents.dailyDigest")}</span>
            <span className="text-[#9CA3AF]">{agent.channels.includes("digest") ? t("agents.on") : t("agents.off")}</span>
          </li>
          <li className="flex items-center gap-2.5">
            <Bell className="h-3.5 w-3.5 shrink-0 text-[#4b5563]" strokeWidth={1.75} aria-hidden />
            <span className="text-[#1d1b1b]">{t("agents.desktopNotification")}</span>
            <span className="text-[#9CA3AF]">{agent.channels.includes("desktop") ? t("agents.on") : t("agents.off")}</span>
          </li>
          <li className="flex items-center gap-2.5">
            <Smartphone className="h-3.5 w-3.5 shrink-0 text-[#4b5563]" strokeWidth={1.75} aria-hidden />
            <span className="shrink-0 text-[#1d1b1b]">{t("agents.mobilePush")}</span>
            <span className="min-w-0 text-[#9CA3AF]">
              {agent.channels.includes("mobile_push") ? t("agents.overview.mobileOn") : t("agents.off")}
            </span>
          </li>
          <li className="flex items-center gap-2.5">
            <CalendarClock className="h-3.5 w-3.5 shrink-0 text-[#4b5563]" strokeWidth={1.75} aria-hidden />
            <span className="text-[#1d1b1b]">{agent.oneShot ? t("agents.oneShot") : t("agents.overview.keepsAfter")}</span>
          </li>
          <li className="flex items-center gap-2.5">
            <CalendarX2 className="h-3.5 w-3.5 shrink-0 text-[#4b5563]" strokeWidth={1.75} aria-hidden />
            <span className="text-[#6b7280]">{t("agents.confirm.ends")}</span>
            <span className="text-[#1d1b1b]">{endsSentence(agent.ends, lang)}</span>
          </li>
        </ul>
      </Block>

      <p className="text-[11.5px] text-[#9CA3AF]">
        {t("agents.overview.created", { date: shortDate(agent.createdAt, lang) })}
        {agent.updatedAt && agent.updatedAt !== agent.createdAt
          ? ` · ${edited.kind === "on" ? t("agents.overview.editedOn", { date: edited.text }) : t("agents.overview.editedAgo", { when: edited.text })}`
          : ""}
      </p>
    </div>
  );
}
