/**
 * The early-access application. One source of truth for the form on
 * /early-access and for the labels the admin Waitlist tab renders, so a
 * reworded option can never read one way to the applicant and another way to
 * the reviewer.
 */

export type ChoiceQuestion = {
  id: ApplicationField;
  kind: "choice";
  prompt: string;
  options: { value: string; label: string }[];
  /** Picking this value reveals a free-text box (stored in `<id>Other`). */
  revealsTextOn?: string;
};

export type TextQuestion = {
  id: ApplicationField;
  kind: "text";
  prompt: string;
  placeholder: string;
};

export type ApplicationQuestion = ChoiceQuestion | TextQuestion;

export type ApplicationField =
  | "describes"
  | "capital"
  | "process"
  | "hardest"
  | "win"
  | "agreement";

export const APPLICATION_QUESTIONS: ApplicationQuestion[] = [
  {
    id: "describes",
    kind: "choice",
    prompt: "What best describes you?",
    revealsTextOn: "other",
    options: [
      { value: "business_owner", label: "I own a business" },
      { value: "founder_operator", label: "I'm a founder or operator with equity" },
      { value: "high_earner", label: "I'm a high-earning professional" },
      { value: "finance", label: "I work in finance or investing" },
      { value: "serious_trader", label: "I'm a full-time or serious trader" },
      { value: "investor", label: "I'm primarily an investor" },
      { value: "other", label: "Other" },
    ],
  },
  {
    id: "capital",
    kind: "choice",
    prompt:
      "Falcon's founding membership is a paid plan built for serious traders. Assuming it's a fit, what best describes the capital you actively trade with?",
    options: [
      { value: "under_25k", label: "Under $25,000" },
      { value: "25k_100k", label: "$25,000 – $100,000" },
      { value: "100k_500k", label: "$100,000 – $500,000" },
      { value: "500k_plus", label: "$500,000+" },
      { value: "scaling", label: "I'm scaling up quickly" },
      { value: "too_much", label: "It's more than I'd want to commit right now" },
    ],
  },
  {
    id: "process",
    kind: "choice",
    prompt: "How do you currently decide what to buy, hold, or sell?",
    options: [
      { value: "own_research", label: "My own research and judgment" },
      {
        value: "mixed_sources",
        label: "A mix of newsletters, social media, and people I trust",
      },
      { value: "reactive", label: "I react when the market moves" },
      { value: "advisor", label: "A financial advisor or broker" },
      { value: "structured", label: "I already run a structured process" },
      { value: "none", label: "I don't have a consistent process yet" },
    ],
  },
  {
    id: "hardest",
    kind: "text",
    prompt: "What's the hardest part of staying ahead of the market right now?",
    placeholder: "A sentence or two is plenty.",
  },
  {
    id: "win",
    kind: "text",
    prompt: "What would make Falcon a clear win for you six months from now?",
    placeholder: "A sentence or two is plenty.",
  },
  {
    id: "agreement",
    kind: "choice",
    prompt:
      "I understand that applying doesn't guarantee acceptance. If approved, I'll be responsive when the Falcon team reaches out about membership.",
    options: [
      { value: "accept", label: "I accept" },
      { value: "decline", label: "I don't accept" },
    ],
  },
];

/** Answers keyed by question id, plus the free-text follow-ups. */
export type ApplicationAnswers = Partial<
  Record<ApplicationField | `${ApplicationField}Other`, string>
> & { submittedAt?: string };

/** Declining the agreement doesn't block the application — it flags it. */
export function isDeclined(answers: ApplicationAnswers | null): boolean {
  return answers?.agreement === "decline";
}

/** Human label for a stored answer, for the admin table. */
export function answerLabel(
  field: ApplicationField,
  answers: ApplicationAnswers | null,
): string | null {
  if (!answers) return null;
  const raw = answers[field];
  if (!raw) return null;

  const question = APPLICATION_QUESTIONS.find((q) => q.id === field);
  if (!question || question.kind === "text") return raw;

  if (question.revealsTextOn && raw === question.revealsTextOn) {
    return answers[`${field}Other`]?.trim() || "Other";
  }
  return question.options.find((o) => o.value === raw)?.label ?? raw;
}
