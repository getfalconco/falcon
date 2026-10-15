import { useEffect, type ReactNode } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { HEAD_CLASS, QUIET_NOTE_CLASS } from "@/components/briefing/briefing-styles";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { countdown, relativeTime, sayCount, triggerNoun, triggerNounShort, upcoming } from "./agent-format";
import { BUTTON, LABEL, SKELETON, TickerChip, useNow } from "./agent-ui";
import {
  ensureRecentDetails,
  latestReports,
  openAgent,
  refreshAgents,
  useAgents,
} from "./agents-store";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
  /** View Agents: opens the home screen's Agents tab. */
  onOpenAgents?: () => void;
};

/** How many report rows and coming-up rows the card lists at most. */
const REPORT_ROWS = 4;
const UPCOMING_ROWS = 3;

function Skeleton() {
  return (
    <div className="space-y-5 pt-1" aria-hidden>
      {["w-[72%]", "w-[58%]", "w-[66%]"].map((w) => (
        <div key={w} className="space-y-1.5">
          <div className={cn(SKELETON, "h-2.5 w-[38%]")} />
          <div className={cn(SKELETON, "h-3", w)} />
        </div>
      ))}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className={cn(LABEL, "pb-1.5 text-[10.5px]")}>{label}</h3>
      {children}
    </section>
  );
}

/**
 * Agents on the dashboard: how many are watching, the newest write-ups, and
 * what is coming up soon. A row opens that agent in the Agents tab; the
 * round arrow in the masthead opens the tab itself, as the calendar card's
 * does for the calendar.
 */
export default function AgentsCard({ onDuplicate, onRemove, onOpenAgents }: Props) {
  const snap = useAgents();
  const now = useNow();
  const { language: lang, t } = useI18n();

  // The newest reports live in each agent's detail; fetch the few needed.
  const agentKey = snap.agents.map((a) => `${a.id}:${a.lastFiredAt ?? ""}`).join("|");
  useEffect(() => {
    if (snap.phase === "ready") ensureRecentDetails(REPORT_ROWS);
  }, [snap.phase, agentKey]);

  const active = snap.agents.filter((a) => a.status === "active").length;
  const unread = snap.agents.reduce((n, a) => n + a.unread, 0);
  const reports = latestReports(snap, REPORT_ROWS);
  const soon = upcoming(snap.agents, now).slice(0, UPCOMING_ROWS);

  let body: ReactNode;
  if (snap.phase === "unavailable") {
    body = (
      <div className="space-y-1">
        <p className="text-[13px] leading-[1.5] text-[#6b7280]">{t("agents.card.unavailable")}</p>
        <p className={QUIET_NOTE_CLASS}>{t("agents.card.unavailableHint")}</p>
      </div>
    );
  } else if (snap.phase === "error" && snap.agents.length === 0) {
    body = (
      <div className="space-y-2">
        <p className="text-[13px] leading-[1.5] text-[#6b7280]">{t("agents.card.loadFailed")}</p>
        <button type="button" onClick={() => void refreshAgents()} className={BUTTON}>
          {t("agents.tryAgain")}
        </button>
      </div>
    );
  } else if (snap.phase !== "ready" && snap.agents.length === 0) {
    body = <Skeleton />;
  } else if (snap.agents.length === 0) {
    // Empty is one line. The way in is the round arrow in the masthead,
    // which every state of this card already has.
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-[13px] text-[#9CA3AF]">{t("agents.card.emptyTitle")}</p>
      </div>
    );
  } else {
    body = (
      <div className="scrollbar-meridian -mx-2 min-h-0 flex-1 space-y-5 overflow-y-auto px-2">
        <Section label={t("agents.card.latest")}>
          {reports.length === 0 ? (
            <p className={QUIET_NOTE_CLASS}>{t("agents.card.noReports")}</p>
          ) : (
            <ul className="-mx-2">
              {reports.map(({ agent, report }) => {
                const fresh = snap.fresh[agent.id] === report.id;
                return (
                  <li key={report.id}>
                    <button
                      type="button"
                      onClick={() => openAgent(agent.id, "reports", report.id)}
                      className={cn(
                        "app-no-drag group/row w-full rounded-xl px-2 py-2 text-left transition-colors duration-300 hover:bg-[#1d1b1b]/[0.04]",
                        fresh && "bg-[#1d1b1b]/[0.04]",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-label={report.read ? undefined : t("agents.unread")}
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            report.read ? "bg-transparent" : "bg-[#1d1b1b]",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#6b7280]">{agent.name}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-[#9CA3AF]">{relativeTime(report.at, now, lang)}</span>
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 line-clamp-2 pl-3 text-[12.5px] leading-[1.4]",
                          report.read ? "text-[#4b5563]" : "font-medium text-[#1d1b1b]",
                        )}
                      >
                        {report.headline}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {soon.length > 0 ? (
          <Section label={t("agents.card.comingUp")}>
            <ul className="-mx-2">
              {soon.map((agent) => {
                const first = agent.triggers[0];
                // The ticker leads the row, so the row names the event without it.
                const chipped = first && "ticker" in first && first.ticker === agent.ticker;
                const short =
                  !first || first.kind === "news" || first.kind === "schedule"
                    ? null
                    : chipped
                      ? triggerNounShort(first, lang)
                      : triggerNoun(first, lang);
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      onClick={() => openAgent(agent.id, "overview")}
                      className="app-no-drag flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[#1d1b1b]/[0.04]"
                    >
                      {agent.ticker ? <TickerChip ticker={agent.ticker} /> : null}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#1d1b1b]">
                        {short ?? agent.name}
                      </span>
                      <span className="shrink-0 text-[11.5px] tabular-nums text-[#6b7280]">{countdown(agent.nextExpectedAt, now, lang)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("agents.card.label")}
        meta={
          snap.phase === "ready" && snap.agents.length > 0 ? (
            <span className={cn(HEAD_CLASS, "select-none truncate")}>
              {sayCount(lang, "agents.card.active", active)}
              {unread > 0 ? ` · ${sayCount(lang, "agents.unreadCount", unread)}` : ""}
            </span>
          ) : null
        }
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        // The door to the Agents tab, the same round arrow the calendar card carries.
        onOpen={onOpenAgents}
        openLabel={t("agents.card.viewAll")}
      />

      <div className="flex min-h-0 flex-1 flex-col pt-4">
        {body}
      </div>
    </div>
  );
}
