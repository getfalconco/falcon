import type { AgentChannel, AgentDraft, AgentFilingChangeKind, AgentTrigger } from "../../../shared/agent-types";
import { addDaysYmd, nyToday } from "../../../shared/earnings-view";
import type { LanguageCode } from "../../lib/i18n/languages";
import { say } from "./agent-format";
import { starterBrief, starterTitle, type StarterTemplate } from "./agent-templates";
import type { AgentsFocus } from "./agents-store";

/**
 * Ready-made drafts for the buttons that start an agent from a screen that
 * already knows what to watch: an earnings drawer's "Create agent", the
 * Filing changes card's "Watch filings", and the create flow's own starters.
 * The trigger is set here, so the create flow reaches "Did we understand
 * you?" without sending any words to be read. Nothing depends on the model being reachable, or on
 * the reader's language being one the fallback parser knows.
 *
 * The brief and the name are in the reader's language, for the reader to
 * see and keep; the engine never parses them on this path. Every other field
 * matches what the engine's own draft of the same words would carry (see
 * main/agents/llm.ts and main/agents/ends.ts), so an agent made here behaves
 * the same as one typed in.
 *
 * Pure: "today" is a parameter.
 */

/** As the engine's default (main/agents/validate.ts): one summary a day, every report in the app. */
const DEFAULT_CHANNELS: readonly AgentChannel[] = ["digest"];

/**
 * Days a standing watch on results or periodic reports runs when no end was
 * named: two reporting seasons, as `STANDING_EARNINGS_DAYS` in main/agents/ends.ts.
 */
export const STANDING_REPORTS_DAYS = 184;

/** Days any other standing watch runs when no end was named, as `STANDING_DAYS` in main/agents/ends.ts. */
export const STANDING_DAYS = 90;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function cleanTicker(ticker: string): string {
  return ticker.trim().replace(/^\$/, "").toUpperCase();
}

/**
 * One results release: the agent writes once when `ticker` reports, on EPS,
 * revenue and guidance against the consensus, and ends with that release.
 * `date` is the calendar's report date (YYYY-MM-DD, New York), shown as
 * "When" while it is still ahead.
 */
export function earningsWatchDraft(
  input: { ticker: string; brief: string; name?: string; date?: string | null; today?: string },
  lang: LanguageCode,
): AgentDraft {
  const ticker = cleanTicker(input.ticker);
  const today = input.today ?? nyToday();
  const draft: AgentDraft = {
    name: input.name?.trim() || say(lang, "agents.noun.earnings", { ticker }),
    brief: input.brief.trim(),
    ticker,
    triggers: [{ kind: "earnings", ticker, moment: "release" }],
    metrics: [
      { id: "m1", label: say(lang, "agents.prefill.metric.eps") },
      { id: "m2", label: say(lang, "agents.prefill.metric.revenue") },
      { id: "m3", label: say(lang, "agents.prefill.metric.guidance") },
    ],
    channels: [...DEFAULT_CHANNELS],
    oneShot: true,
    ends: { kind: "earnings", ticker },
    endsProposed: true,
  };
  // The engine's reading of a release date: 08:00 New York (noon UTC is the same day there).
  if (input.date && YMD.test(input.date) && input.date >= today) draft.nextExpectedAt = `${input.date}T12:00:00.000Z`;
  return draft;
}

/**
 * A standing watch on what `ticker`'s next 10-K, 10-Q or 20-F changes, every
 * kind of change (new risk factors, red flags, customers, suppliers), until
 * the proposed end two reporting seasons out.
 */
export function filingChangesWatchDraft(
  input: { ticker: string; brief?: string; name?: string; today?: string; kinds?: readonly AgentFilingChangeKind[] },
  lang: LanguageCode,
): AgentDraft {
  const ticker = cleanTicker(input.ticker);
  const today = input.today ?? nyToday();
  const kinds = [...new Set(input.kinds ?? [])];
  return {
    name: input.name?.trim() || say(lang, "agents.starter.changes.title", { ticker }),
    brief: input.brief?.trim() || say(lang, "agents.starter.changes.brief", { ticker }),
    ticker,
    // No `kinds` for all four (or none named), as the engine writes a watch on every kind.
    triggers: [kinds.length > 0 && kinds.length < 4 ? { kind: "filing_changes", ticker, kinds } : { kind: "filing_changes", ticker }],
    metrics: [],
    channels: [...DEFAULT_CHANNELS],
    oneShot: false,
    ends: { kind: "date", date: addDaysYmd(today, STANDING_REPORTS_DAYS) },
    endsProposed: true,
  };
}

/** A standing watch on one trigger, ending on a proposed date. */
function standingDraft(name: string, brief: string, ticker: string, trigger: AgentTrigger, days: number, today: string): AgentDraft {
  return {
    name,
    brief,
    ticker,
    triggers: [trigger],
    metrics: [],
    channels: [...DEFAULT_CHANNELS],
    oneShot: false,
    ends: { kind: "date", date: addDaysYmd(today, days) },
    endsProposed: true,
  };
}

/**
 * The draft a create flow starter stands for: its words (`starterBrief`) as
 * the brief, its title as the name. Each matches what the engine reads from
 * the starter's English words (main/agents/llm.ts and ends.ts; see
 * main/agents/create-v2.test.ts and linked.test.ts), so a starter sets up the
 * same agent in every language and with the model unreachable:
 *
 *   earnings  one results release, on revenue, gross margin and next-quarter
 *             guidance, ending with it
 *   filings   every 8-K, 10-Q and 10-K, standing 90 days
 *   insider   Form 4 open-market purchases only, standing 90 days
 *   linked    8-Ks and results of the critical suppliers and customers,
 *             standing two reporting seasons
 *   changes   new risk factors, red flags and newly named customers in the
 *             next 10-K or 10-Q, standing two reporting seasons
 */
export function starterDraft(t: StarterTemplate, lang: LanguageCode, today: string = nyToday()): AgentDraft {
  const ticker = cleanTicker(t.ticker);
  const brief = starterBrief({ ...t, ticker }, lang).text;
  const name = starterTitle({ ...t, ticker, example: false }, lang);
  switch (t.id) {
    case "earnings":
      return {
        ...earningsWatchDraft({ ticker, brief, name, date: t.date, today }, lang),
        metrics: [
          { id: "m1", label: say(lang, "agents.prefill.metric.revenue") },
          { id: "m2", label: say(lang, "agents.prefill.metric.grossMargin") },
          { id: "m3", label: say(lang, "agents.prefill.metric.nextGuidance") },
        ],
      };
    case "filings":
      return standingDraft(name, brief, ticker, { kind: "filing", ticker, forms: ["8-K", "10-Q", "10-K"] }, STANDING_DAYS, today);
    case "insider":
      return standingDraft(name, brief, ticker, { kind: "filing", ticker, forms: ["4"], insiderBuysOnly: true }, STANDING_DAYS, today);
    case "linked":
      return standingDraft(
        name,
        brief,
        ticker,
        { kind: "linked", ticker, relations: ["supplier", "customer"], minTier: "critical", events: ["earnings", "filing"], forms: ["8-K"] },
        STANDING_REPORTS_DAYS,
        today,
      );
    case "changes":
      return filingChangesWatchDraft({ ticker, brief, name, today, kinds: ["risk_factors", "red_flags", "customers"] }, lang);
  }
}

/** The request `openCreateAgent` sends, built here so its shape is tested without the store. */
export function createFocus(briefOrDraft: string | AgentDraft | undefined, name: string | undefined, seq: number): Extract<AgentsFocus, { kind: "create" }> {
  if (briefOrDraft && typeof briefOrDraft === "object") {
    const named = name?.trim() || briefOrDraft.name.trim();
    const draft: AgentDraft = { ...briefOrDraft, name: named, brief: briefOrDraft.brief.trim() };
    return { kind: "create", seq, brief: draft.brief, ...(named ? { name: named } : {}), draft };
  }
  const text = briefOrDraft?.trim();
  const named = name?.trim();
  return { kind: "create", seq, ...(text ? { brief: text } : {}), ...(named ? { name: named } : {}) };
}
