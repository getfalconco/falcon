import { useEffect, useRef } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentReport } from "../../../shared/agent-types";
import { dateTime, paragraphs, relativeTime, secLinkParts, triggerKindLabel, verdictLabel, VERDICT_PILL } from "./agent-format";
import { LABEL, SKELETON, openLink } from "./agent-ui";

const TH = "px-3 py-2 font-['Geist_Mono'] text-[9.5px] font-normal uppercase tracking-[0.06em] text-content-tertiary";

function ReportCard({ report, now, focused, fresh }: { report: AgentReport; now: number; focused: boolean; fresh: boolean }) {
  const { language: lang, t } = useI18n();
  return (
    <article
      id={`report-${report.id}`}
      className={cn(
        "rounded-2xl border border-white/60 bg-white/55 px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 transition-shadow duration-500",
        focused || fresh ? "ring-black/[0.12]" : "ring-black/[0.04]",
      )}
    >
      <header className="flex items-center gap-2 text-[11.5px] text-content-tertiary">
        {!report.read ? <span aria-label={t("agents.unread")} className="h-1.5 w-1.5 rounded-full bg-ink" /> : null}
        <span>{triggerKindLabel(report.trigger, lang)}</span>
        <span aria-hidden>·</span>
        <time dateTime={report.at} title={dateTime(report.at, lang)}>
          {dateTime(report.at, lang)}
        </time>
        {now - Date.parse(report.at) < 2 * 86_400_000 ? <span className="ml-auto tabular-nums">{relativeTime(report.at, now, lang)}</span> : null}
      </header>

      <h3 className="mt-1.5 text-[16px] font-medium leading-[1.35] text-content-primary">{report.headline}</h3>

      {report.readings.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-black/[0.06]">
          <table className="w-full table-fixed text-left text-[12.5px]">
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[26%]" />
              <col className="w-[24%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-black/[0.06] bg-black/[0.04]">
                <th className={TH}>{t("agents.metric")}</th>
                <th className={TH}>{t("agents.report.reported")}</th>
                <th className={TH}>{t("agents.yourBar")}</th>
                <th className={cn(TH, "text-right")}>{t("agents.report.result")}</th>
              </tr>
            </thead>
            <tbody>
              {report.readings.map((r, i) => (
                <tr key={`${r.metricId}-${i}`} className={cn("align-top", i > 0 && "border-t border-black/[0.06]")}>
                  <td className="px-3 py-2.5 text-content-primary">{r.label}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium tabular-nums text-content-primary">{r.value}</div>
                    {r.comparison ? <div className="mt-0.5 text-[11px] leading-[1.35] text-content-tertiary">{r.comparison}</div> : null}
                  </td>
                  <td className="px-3 py-2.5 text-content-body">{r.expectation || <span className="text-content-tertiary">{t("agents.report.consensus")}</span>}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", VERDICT_PILL[r.verdict])}>
                      {verdictLabel(r.verdict, lang)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="mt-4 space-y-2.5">
        {paragraphs(report.summary).map((p, i) => (
          <p key={i} className="whitespace-pre-line text-[13.5px] leading-[1.65] text-content-body">
            {secLinkParts(p).map((part, j) =>
              part.url ? (
                <button
                  key={j}
                  type="button"
                  onClick={() => openLink(part.url)}
                  title={part.url}
                  className="app-no-drag inline-flex items-baseline gap-0.5 text-content-body underline decoration-content-disabled underline-offset-[3px] transition-colors hover:text-content-primary hover:decoration-content-primary"
                >
                  {part.text}
                  <ArrowUpRight className="h-3 w-3 shrink-0 self-center" strokeWidth={2} aria-hidden />
                </button>
              ) : (
                part.text
              ),
            )}
          </p>
        ))}
      </div>

      {report.sources.length > 0 ? (
        <footer className="mt-4 border-t border-black/[0.06] pt-3">
          <div className={cn(LABEL, "pb-1.5 text-[10.5px]")}>{t("agents.report.sources")}</div>
          <ul className="flex flex-wrap gap-1.5">
            {report.sources.map((s, i) =>
              s.url && /^https?:\/\//i.test(s.url) ? (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => openLink(s.url)}
                    title={s.url}
                    className="app-no-drag inline-flex max-w-[280px] items-center gap-1 rounded-lg bg-black/[0.04] px-2 py-1 text-[11.5px] text-content-body transition-colors hover:bg-black/[0.06] hover:text-content-primary"
                  >
                    <span className="truncate">{s.title}</span>
                    <ArrowUpRight className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
                  </button>
                </li>
              ) : (
                <li key={i} className="inline-flex max-w-[280px] items-center rounded-lg px-2 py-1 text-[11.5px] text-content-tertiary">
                  <span className="truncate">{s.title}</span>
                </li>
              ),
            )}
          </ul>
        </footer>
      ) : null}
    </article>
  );
}

export function ReportsSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1].map((k) => (
        <div key={k} className="space-y-3 rounded-2xl border border-black/[0.06] px-5 py-4">
          <div className={cn(SKELETON, "h-2.5 w-[30%]")} />
          <div className={cn(SKELETON, "h-4 w-[70%]")} />
          <div className={cn(SKELETON, "h-20 w-full")} />
        </div>
      ))}
    </div>
  );
}

/**
 * Every write-up the agent has produced, newest first. A report asked for by
 * id (from the dashboard, a notification, the timeline) is scrolled to and
 * given a slightly stronger edge.
 */
export default function AgentReports({
  reports,
  now,
  focusId,
  freshId,
  waitingText,
}: {
  reports: readonly AgentReport[];
  now: number;
  focusId?: string;
  freshId?: string;
  /** What the agent is waiting for, for the empty state. */
  waitingText: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    if (!focusId) return;
    const el = root.current?.querySelector(`#report-${CSS.escape(focusId)}`);
    el?.scrollIntoView({ block: "start" });
  }, [focusId, reports.length]);

  if (reports.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/[0.04] text-content-body">
          <FileText className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
        </span>
        <p className="mt-3 text-[14px] font-medium text-content-primary">{t("agents.reports.emptyTitle")}</p>
        <p className="mt-1 max-w-[340px] text-[12.5px] leading-[1.5] text-content-secondary">
          {t("agents.reports.emptyBody", { waiting: waitingText })}
        </p>
      </div>
    );
  }
  return (
    <div ref={root} className="space-y-3">
      {reports.map((r) => (
        <ReportCard key={r.id} report={r} now={now} focused={r.id === focusId} fresh={r.id === freshId} />
      ))}
    </div>
  );
}
