import { useEffect, useMemo, useState } from "react";
import { ensureRecentDetails, loadAgentDetail, openAgent, useAgents } from "@/components/agents/agents-store";
import { useI18n } from "@/lib/i18n";
import { useStockTab } from "@/lib/stock-tab-store";
import { cn } from "@/lib/utils";
import type { AgentReport } from "../../../../shared/agent-types";
import { agentIsAbout, stockAgentReports, type ReportsByAgent } from "../stock-agent-reports";
import type { StockSectionProps } from "./types";

/**
 * Stock tab, 8: the reader's agent reports about this stock, newest first:
 * every report of an agent watching it, and any other agent's report that
 * names it (stock-agent-reports.ts). Each row is the agent, the day and the
 * headline; pressing it opens that report in the Agents tab.
 *
 * Source: the agents store (lib/agents-client.ts behind it). The reports of
 * the agents about this stock are fetched when the section opens; for the
 * rest, the agents that ran most recently.
 */

const SHOWN = 5;
/** How many recently active agents to load for reports that name the stock. */
const RECENT_AGENTS = 8;

export default function AgentReportsSection({ ticker }: StockSectionProps) {
  const { t, locale } = useI18n();
  const snap = useAgents();
  const { recent } = useStockTab();
  const companyName = recent.find((r) => r.symbol === ticker)?.companyName ?? null;
  const [expanded, setExpanded] = useState(false);

  const aboutIds = useMemo(
    () =>
      snap.agents
        .filter((a) => agentIsAbout(a, ticker))
        .map((a) => a.id)
        .join(","),
    [snap.agents, ticker],
  );
  useEffect(() => {
    if (snap.phase !== "ready") return;
    for (const id of aboutIds ? aboutIds.split(",") : []) {
      if (!snap.details[id]) void loadAgentDetail(id);
    }
    ensureRecentDetails(RECENT_AGENTS);
    // Details are read, not watched: a load is asked for once per agent.
  }, [snap.phase, aboutIds]);

  const reportsByAgent = useMemo(() => {
    const out: Record<string, readonly AgentReport[] | undefined> = {};
    for (const [id, entry] of Object.entries(snap.details)) out[id] = entry?.detail?.reports;
    return out as ReportsByAgent;
  }, [snap.details]);

  const rows = useMemo(
    () => stockAgentReports(snap.agents, reportsByAgent, ticker, companyName),
    [snap.agents, reportsByAgent, ticker, companyName],
  );
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }), [locale]);
  const dateLong = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "long" }), [locale]);

  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, SHOWN);
  const more = rows.length - shown.length;
  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? { short: date.format(d), long: dateLong.format(d) } : null;
  };

  return (
    <div>
      <ul className="divide-y divide-black/[0.06]">
        {shown.map(({ agent, report }) => {
          const at = when(report.at);
          return (
            <li key={report.id}>
              <button
                type="button"
                onClick={() => openAgent(agent.id, "reports", report.id)}
                aria-label={t("stocktab.reports.open", { agent: agent.name, date: at?.long ?? "" })}
                className="group grid w-full grid-cols-[minmax(0,10rem)_4.5rem_minmax(0,1fr)] items-baseline gap-x-4 rounded-lg px-2 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-edge-focus motion-reduce:transition-none"
              >
                <span className="truncate text-[12.5px] text-content-secondary">{agent.name}</span>
                <span className="text-[12px] tabular-nums text-content-tertiary">{at?.short ?? ""}</span>
                <span className="truncate text-[13.5px] text-content-primary">{report.headline}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={cn(
            "mt-2 rounded-md px-2 py-1 text-[12px] text-content-secondary outline-none hover:text-content-primary focus-visible:ring-2 focus-visible:ring-edge-focus",
          )}
        >
          {t("stocktab.reports.more", { count: more })}
        </button>
      ) : null}
    </div>
  );
}
