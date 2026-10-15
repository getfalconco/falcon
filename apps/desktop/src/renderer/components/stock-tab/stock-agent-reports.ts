import type { Agent, AgentReport } from "../../../shared/agent-types";

/**
 * Which agent reports are about one stock, for the Stock tab's Agent
 * reports section:
 *
 *   - every report of an agent about the ticker: its own ticker, or a
 *     trigger on it (earnings, a filing, a price move, its news), and
 *   - a report of any other agent whose headline or write-up names it: the
 *     ticker as a word ("NVDA", "$NVDA", "(NVDA)"; a one or two letter
 *     ticker only in the "$" or bracket forms, since "IT" or "A" in a
 *     sentence is a word), or the company's name without its legal suffix.
 *
 * Newest first, each report once. An agent whose reports are not loaded yet
 * still counts by its newest report's headline, which the list carries.
 *
 * Pure.
 */

export type StockAgentReport = {
  agent: Agent;
  report: Pick<AgentReport, "id" | "headline" | "at">;
  /** The agent is about this stock, or the report only names it. */
  via: "agent" | "mention";
};

/** The loaded reports of each agent, by agent id (the agents store's details). */
export type ReportsByAgent = Readonly<Record<string, readonly AgentReport[] | undefined>>;

export function agentIsAbout(agent: Agent, ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  if (!t) return false;
  if (agent.ticker?.trim().toUpperCase() === t) return true;
  return (agent.triggers ?? []).some((tr) => "ticker" in tr && typeof tr.ticker === "string" && tr.ticker.trim().toUpperCase() === t);
}

const LEGAL_SUFFIX =
  /[,.]?\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|sa|ag|nv|se|holdings?|group|class [a-c]|ordinary shares|common stock|adr|ads)\.?$/i;

/** "NVIDIA Corporation" -> "NVIDIA"; null when what is left is too short to tell apart from a word. */
export function bareCompanyName(name: string | null | undefined): string | null {
  let n = (name ?? "").trim();
  for (let i = 0; i < 4; i++) {
    const next = n.replace(LEGAL_SUFFIX, "").trim();
    if (next === n) break;
    n = next;
  }
  return n.length >= 4 ? n : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A test for text that names the stock. */
export function mentionTest(ticker: string, companyName?: string | null): (text: string) => boolean {
  const t = escape(ticker.trim().toUpperCase());
  const tickerRe =
    t.length >= 3 ? new RegExp(`(^|[^A-Za-z0-9])\\$?${t}(?![A-Za-z0-9])`) : new RegExp(`(\\$${t}(?![A-Za-z0-9])|\\(${t}\\))`);
  const name = bareCompanyName(companyName);
  const nameRe = name ? new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "iu") : null;
  return (text) => tickerRe.test(text) || (nameRe != null && nameRe.test(text));
}

export function stockAgentReports(
  agents: readonly Agent[],
  reports: ReportsByAgent,
  ticker: string,
  companyName?: string | null,
): StockAgentReport[] {
  const names = mentionTest(ticker, companyName);
  const out = new Map<string, StockAgentReport>();
  for (const agent of agents) {
    const about = agentIsAbout(agent, ticker);
    const loaded = reports[agent.id];
    const list: Array<Pick<AgentReport, "id" | "headline" | "at"> & { summary?: string }> = loaded
      ? [...loaded]
      : agent.latestReport
        ? [agent.latestReport]
        : [];
    for (const report of list) {
      if (!report?.id || out.has(report.id)) continue;
      const named = about || names(report.headline ?? "") || names(report.summary ?? "");
      if (!named) continue;
      out.set(report.id, {
        agent,
        report: { id: report.id, headline: report.headline, at: report.at },
        via: about ? "agent" : "mention",
      });
    }
  }
  const time = (s: string) => {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...out.values()].sort((a, b) => time(b.report.at) - time(a.report.at) || a.report.id.localeCompare(b.report.id));
}
