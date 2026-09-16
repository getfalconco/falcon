/** Shared copy + form schema for the internship hiring funnel. */

export const DEPARTMENTS = [
  { key: "community", label: "Community Management" },
  { key: "media", label: "Media" },
  { key: "research", label: "Research" },
] as const;

export type Department = (typeof DEPARTMENTS)[number]["key"];

export const STAGE_LABELS: Record<string, string> = {
  applied: "Stage 1 · Applied",
  task_sent: "Stage 2 · Task sent",
  task_submitted: "Stage 2 · Submitted",
  task_scored: "Stage 2 · Scored",
  interview_invited: "Stage 3 · Interview invited",
  interview_booked: "Stage 3 · Interview booked",
  interview_done: "Interview done",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export const APPLICATION_QUESTIONS = [
  {
    id: "why_falcon",
    label: "Why Falcon?",
    placeholder: "A few sentences on why you want this internship.",
    maxLength: 600,
  },
  {
    id: "relevant_work",
    label: "What have you built or led that is relevant?",
    placeholder: "Projects, clubs, writing, research — be concrete.",
    maxLength: 600,
  },
  {
    id: "hours",
    label: "How many hours per week can you commit?",
    placeholder: "e.g. 8–12 hours after school / between classes",
    maxLength: 120,
  },
] as const;

export function departmentLabel(key: string): string {
  return DEPARTMENTS.find((d) => d.key === key)?.label ?? key;
}

export function formatByteSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Seed placeholders — replace with a .docx upload per department in admin. */
export const DEFAULT_TASK_DOCS: Record<
  Department,
  { title: string; body_md: string; rubric_md: string }
> = {
  community: {
    title: "Welcome thread exercise",
    body_md: "",
    rubric_md: "",
  },
  media: {
    title: "One-page product story",
    body_md: "",
    rubric_md: "",
  },
  research: {
    title: "Second-order news brief",
    body_md: "",
    rubric_md: "",
  },
};
