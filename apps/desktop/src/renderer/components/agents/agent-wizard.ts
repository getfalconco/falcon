import type { AgentDraft } from "../../../shared/agent-types";
import type { LanguageCode } from "../../lib/i18n/languages";
import { briefReady, draftIssues, type DraftIssue } from "./agent-draft";

/**
 * Create Agent in two steps, as a pure reducer so the rules are tested
 * without React (AgentWizard.tsx draws them):
 *
 *   describe  the agent's name (the reader's own, never replaced) and what
 *             it should do, in the reader's words
 *   confirm   "Did we understand you?": Falcon's reading as a few plain
 *             sentences, Start agent, or Change to go back with the words
 *             intact
 *
 * Next reads the instruction and moves on only once the draft is in. When
 * the words give nothing to act on, the draft carries one question
 * (`clarify`) and the flow stays on the first step to ask it; the answer is
 * added to the instruction and read again. Going back keeps the draft and
 * the reader's edits for as long as the instruction is unchanged.
 */

export const WIZARD_STEPS = ["describe", "confirm"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const DESCRIBE = 0;
export const CONFIRM = 1;

export type WizardState = {
  /** Index into WIZARD_STEPS. */
  step: number;
  /** The reader's name for the agent. The draft always carries it as is. */
  name: string;
  /** What the agent should do, in the reader's words. */
  brief: string;
  /** The starter whose brief was put in, while the reader keeps one. */
  templateId: string | null;
  /** The answer to the draft's question, while there is one. */
  answer: string;
  draft: AgentDraft | null;
  /** The text the draft was read from (brief plus answer, trimmed). */
  draftedFrom: string | null;
  /** The text being read right now, or null. */
  draftingFor: string | null;
  draftError: string | null;
  /** Create was pressed with something left to fix: the problems show. */
  tried: boolean;
  creating: boolean;
  createError: string | null;
};

export type WizardAction =
  | { type: "name"; text: string }
  | { type: "brief"; text: string }
  | { type: "template"; id: string; text: string }
  | { type: "answer"; text: string }
  | { type: "draft-start"; text: string }
  | { type: "draft-done"; text: string; draft: AgentDraft }
  | { type: "draft-failed"; text: string; error: string }
  | { type: "edit"; draft: AgentDraft }
  | { type: "back" }
  | { type: "forward" }
  | { type: "tried" }
  | { type: "create-start" }
  | { type: "create-failed"; error: string }
  | { type: "reset" };

export function initialWizard(): WizardState {
  return {
    step: DESCRIBE,
    name: "",
    brief: "",
    templateId: null,
    answer: "",
    draft: null,
    draftedFrom: null,
    draftingFor: null,
    draftError: null,
    tried: false,
    creating: false,
    createError: null,
  };
}

/** The question the current draft asks, when it was read from the brief as it stands. */
export function pendingQuestion(s: WizardState): AgentDraft["clarify"] | null {
  if (!s.draft?.clarify) return null;
  return s.draftedFrom === s.brief.trim() ? s.draft.clarify : null;
}

/**
 * What is sent to be read: the brief, and the answer to the draft's question
 * when one was asked and answered ("watch tech" and "NVDA" read as
 * "watch tech (NVDA)").
 */
export function composeBrief(brief: string, answer: string): string {
  const b = brief.trim();
  const a = answer.trim();
  return a ? `${b} (${a})` : b;
}

/** The text Next would send: the brief with the answer once a question is pending. */
export function textToRead(s: WizardState): string {
  return s.draft?.clarify && s.draftedFrom === s.brief.trim() ? composeBrief(s.brief, s.answer) : s.brief.trim();
}

/** The draft in hand was read from what the reader has now. */
export function draftCurrent(s: WizardState): boolean {
  return Boolean(s.draft) && s.draftedFrom === textToRead(s) && !s.draft!.clarify;
}

/** What stops the draft from being created. */
export function confirmIssues(s: WizardState, lang: LanguageCode = "en-US"): DraftIssue[] {
  return s.draft ? draftIssues(s.draft, lang) : [];
}

/** What Next (or Create) does now. */
export type NextMove = "blocked" | "answer" | "draft" | "advance" | "fix" | "create" | "busy";

/** Why Next is blocked, for its tooltip. */
export type BlockReason = "both" | "name" | "describe" | "answer" | null;

export function nextMove(s: WizardState): NextMove {
  if (s.creating || s.draftingFor !== null) return "busy";
  if (s.step === DESCRIBE) {
    if (!briefReady(s.brief) || !s.name.trim()) return "blocked";
    if (pendingQuestion(s)) return s.answer.trim() ? "draft" : "answer";
    return draftCurrent(s) ? "advance" : "draft";
  }
  if (!s.draft) return "blocked";
  return confirmIssues(s).length > 0 ? "fix" : "create";
}

export function blockReason(s: WizardState): BlockReason {
  const move = nextMove(s);
  if (move === "blocked") {
    if (s.step !== DESCRIBE) return null;
    const named = Boolean(s.name.trim());
    const described = briefReady(s.brief);
    return !named && !described ? "both" : !named ? "name" : "describe";
  }
  if (move === "answer") return "answer";
  return null;
}

export function wizardReducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case "name":
      // The reader's name goes straight onto a draft in hand: nothing replaces it.
      return { ...s, name: a.text, draft: s.draft ? { ...s.draft, name: a.text.trim() || s.draft.name } : s.draft };
    case "brief":
      return { ...s, brief: a.text, templateId: a.text.trim() ? s.templateId : null, draftError: null };
    case "template":
      return { ...s, brief: a.text, templateId: a.id, answer: "", draftError: null };
    case "answer":
      return { ...s, answer: a.text };
    case "draft-start":
      return { ...s, draftingFor: a.text, draftError: null };
    case "draft-done": {
      // An answer for a text that has since changed is dropped.
      if (s.draftingFor !== a.text) return s;
      if (textToRead(s) !== a.text) return { ...s, draftingFor: null };
      const asked = Boolean(a.draft.clarify);
      // A question keeps the reader on the first step, keyed to the brief so the answer is added to it.
      const from = asked ? s.brief.trim() : a.text;
      return {
        ...s,
        // An answered question becomes part of the brief, so Back and Next find the same words.
        brief: !asked && a.text !== s.brief.trim() ? a.text : s.brief,
        // The reader's own name, never the one the model suggests.
        draft: { ...a.draft, name: s.name.trim() || a.draft.name, brief: a.draft.brief || a.text },
        draftedFrom: from,
        draftingFor: null,
        draftError: null,
        tried: false,
        answer: asked ? s.answer : "",
        step: asked ? DESCRIBE : CONFIRM,
      };
    }
    case "draft-failed":
      if (s.draftingFor !== a.text) return s;
      return { ...s, draftingFor: null, draftError: a.error };
    case "edit":
      return { ...s, draft: { ...a.draft, name: s.name.trim() || a.draft.name }, createError: null };
    case "back":
      return s.creating ? s : { ...s, step: DESCRIBE, createError: null };
    case "forward":
      // Back and Next again with the same words: the draft and the reader's edits are still there.
      return draftCurrent(s) ? { ...s, step: CONFIRM } : s;
    case "tried":
      return { ...s, tried: true };
    case "create-start":
      return { ...s, creating: true, createError: null };
    case "create-failed":
      return { ...s, creating: false, createError: a.error };
    case "reset":
      return initialWizard();
  }
}
