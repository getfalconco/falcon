import type { AgentDraft, AgentTrigger } from "../../../shared/agent-types";
import type { LanguageCode } from "../../lib/i18n/languages";
import { say } from "./agent-format";

/**
 * What stops a draft from being saved, as pure functions so the create flow,
 * the setup wizard and the edit form all hold a draft to the same rules, and
 * a test can run them without React.
 */

/**
 * The shortest brief worth sending to `draftFromBrief`: two short words
 * ("watch tech") are enough, since a vague brief is answered with one
 * question rather than refused.
 */
export const BRIEF_MIN_LENGTH = 8;

/** A brief long enough to be read. */
export function briefReady(brief: string): boolean {
  return brief.trim().length >= BRIEF_MIN_LENGTH;
}

/** Whether a trigger is complete enough to save; the reason is shown as is. */
export function triggerProblem(t: AgentTrigger, lang: LanguageCode = "en-US"): string | null {
  if ((t.kind === "earnings" || t.kind === "filing" || t.kind === "price_move") && !t.ticker.trim()) {
    return say(lang, `agents.problem.ticker.${t.kind}`);
  }
  if (t.kind === "linked" && !t.ticker.trim()) return say(lang, "agents.problem.ticker.linked");
  if (t.kind === "filing_changes" && !t.ticker.trim()) return say(lang, "agents.problem.ticker.changes");
  if (t.kind === "linked" && t.events.length === 0) return say(lang, "agents.problem.linkedEvents");
  if (t.kind === "filing" && t.forms.length === 0) return say(lang, "agents.problem.forms");
  if (t.kind === "price_move" && !(t.thresholdPct > 0)) return say(lang, "agents.problem.size");
  if (t.kind === "macro" && !t.event.trim()) return say(lang, "agents.problem.release");
  // A news trigger with neither a ticker nor keywords is the market's headlines: allowed.
  return null;
}

/** The part of the draft a problem is about, so a stepped flow can show it where it is fixed. */
export type DraftPart = "name" | "triggers";

export type DraftIssue = { part: DraftPart; text: string };

/** Every problem with a draft, each tagged with the part it is about. */
export function draftIssues(d: AgentDraft, lang: LanguageCode = "en-US"): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!d.name.trim()) out.push({ part: "name", text: say(lang, "agents.problem.name") });
  if (d.triggers.length === 0) out.push({ part: "triggers", text: say(lang, "agents.problem.trigger") });
  for (const t of d.triggers) {
    const p = triggerProblem(t, lang);
    if (p) out.push({ part: "triggers", text: p });
  }
  // No channel is fine: every report is in the app, so that is in-app only.
  return out;
}

/** What stops a draft from being saved, one line each; empty means it can be. */
export function draftProblems(d: AgentDraft, lang: LanguageCode = "en-US"): string[] {
  return Array.from(new Set(draftIssues(d, lang).map((i) => i.text)));
}

/** The draft as `create` takes it: the name trimmed, blank metrics dropped, blank bars cleared. */
export function cleanDraft(d: AgentDraft): AgentDraft {
  return {
    ...d,
    name: d.name.trim(),
    metrics: d.metrics
      .filter((m) => m.label.trim())
      .map((m) => ({ ...m, label: m.label.trim(), expectation: m.expectation?.trim() || undefined })),
  };
}
