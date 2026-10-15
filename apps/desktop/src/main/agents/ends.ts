import type { Agent, AgentClarify, AgentDraft, AgentEnds, AgentLine, AgentTrigger } from "../../shared/agent-types";
import type { AgentEngineState } from "./store";
import type { AgentDataSources } from "./sources";
import { filingMs, formMatches, isResultsFiling, line } from "./triggers";
import { addDaysYmd, nyInstant } from "./time";

/**
 * When an agent stops on its own, and the one question the create flow asks
 * when the reader's words are too vague to set up from. Pure apart from the
 * data sources `endReached` reads, so every rule runs in a test.
 *
 * Every new agent has an end. When the reader named none, one is proposed:
 *   - a one-report watch on results ends after that release;
 *   - a one-report watch on a filing ends after that filing;
 *   - a standing watch ends on a date, two quarters out when it follows
 *     results (so it sees two reports), 90 days out otherwise.
 */

/** Days a standing watch runs when the reader named no end. */
export const STANDING_DAYS = 90;
/** Days a standing results watch runs: two reporting seasons. */
export const STANDING_EARNINGS_DAYS = 184;

/** The end Falcon proposes for a draft that names none. */
export function proposeEnds(draft: Pick<AgentDraft, "ticker" | "triggers" | "oneShot">, today: string): AgentEnds {
  const earnings = draft.triggers.find((t): t is Extract<AgentTrigger, { kind: "earnings" }> => t.kind === "earnings");
  const filing = draft.triggers.find((t): t is Extract<AgentTrigger, { kind: "filing" }> => t.kind === "filing");
  if (draft.oneShot && earnings) return { kind: "earnings", ticker: earnings.ticker };
  if (draft.oneShot && filing && filing.forms[0]) return { kind: "filing", ticker: filing.ticker, form: filing.forms[0] };
  return { kind: "date", date: addDaysYmd(today, earnings ? STANDING_EARNINGS_DAYS : STANDING_DAYS) };
}

/** "Until 2026-12-31", "through 2026-12-31" or "until the 10-K": an end date the reader wrote. */
export function endsFromWords(brief: string, ticker: string | undefined): AgentEnds | undefined {
  const date = /\b(?:until|through|till|ending|ends?(?: on)?)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(brief)?.[1];
  if (date) return { kind: "date", date };
  if (!ticker) return undefined;
  if (/\b(?:until|till|through)\s+(?:they|it|the company)?\s*(?:reports?|results|earnings)\b/i.test(brief)) return { kind: "earnings", ticker };
  const form = /\b(?:until|till)\s+(?:they file\s+)?(?:the|its|their|a|an)?\s*(8-K|10-Q|10-K)\b/i.exec(brief)?.[1];
  if (form) return { kind: "filing", ticker, form: form.toUpperCase() };
  return undefined;
}

/** The instant a dated end passes: the start of the next New York day. */
export function endsInstantMs(ends: AgentEnds | undefined): number | null {
  if (!ends || ends.kind !== "date") return null;
  return nyInstant(addDaysYmd(ends.date, 1), "00:00").getTime();
}

/** The end in English, for the timeline and the model's context. */
export function describeEnds(ends: AgentEnds): string {
  switch (ends.kind) {
    case "date":
      return `after ${ends.date}`;
    case "earnings":
      return `after the next ${ends.ticker} results`;
    case "filing":
      return `after the next ${ends.ticker} ${ends.form}`;
  }
}

/** The end as a coded timeline line. */
export function endedLine(ends: AgentEnds): AgentLine {
  switch (ends.kind) {
    case "date":
      return line("activity.endedDate", { date: ends.date });
    case "earnings":
      return line("activity.endedEarnings", { ticker: ends.ticker });
    case "filing":
      return line("activity.endedFiling", { ticker: ends.ticker, form: ends.form });
  }
}

/**
 * Whether the agent's end has come. A results end waits for the agent's own
 * results report when it watches results (so a call write-up is not cut
 * short); otherwise any results release after creation ends it. A filing end
 * likewise waits for the agent's own report of that filing when it watches the
 * form. A source that cannot be read means "not yet".
 */
export async function endReached(
  agent: Pick<Agent, "ends" | "createdAt" | "triggers">,
  state: AgentEngineState,
  sources: Pick<AgentDataSources, "filings">,
  now: Date,
): Promise<boolean> {
  const ends = agent.ends;
  if (!ends) return false;
  if (ends.kind === "date") return now.getTime() >= endsInstantMs(ends)!;
  const created = Date.parse(agent.createdAt);
  if (ends.kind === "earnings") {
    const watched = agent.triggers.some((t) => t.kind === "earnings" && t.ticker === ends.ticker);
    if (watched) return state.firedKeys.some((k) => k.startsWith(`earnings:${ends.ticker}:`));
    try {
      return (await sources.filings(ends.ticker)).some((f) => isResultsFiling(f) && filingMs(f) >= created);
    } catch {
      return false;
    }
  }
  const watched = agent.triggers.some((t) => t.kind === "filing" && t.ticker === ends.ticker && formMatches(ends.form, t.forms));
  try {
    const filed = (await sources.filings(ends.ticker)).filter((f) => formMatches(f.form, [ends.form]) && filingMs(f) >= created);
    return watched ? filed.some((f) => state.firedKeys.includes(`filing:${f.accession}`)) : filed.length > 0;
  } catch {
    return false;
  }
}

/**
 * The one question to ask before a draft can be set up, or null. Agents need
 * not be about a company: a topic ("semiconductor suppliers"), a macro
 * release, a schedule or the market's headlines are all things to act on. So
 * the question comes only when nothing could be set from the words at all,
 * and it asks for what is missing: what to watch and when, or, when a company
 * or topic is named, what to watch for.
 */
export function clarifyFor(draft: Pick<AgentDraft, "ticker" | "triggers">): AgentClarify | null {
  if (draft.triggers.length > 0) return null;
  return draft.ticker ? { field: "trigger", question: "What to watch for?" } : { field: "subject", question: "What to watch, and when?" };
}
