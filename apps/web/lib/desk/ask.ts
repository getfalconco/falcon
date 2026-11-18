/**
 * The Desk AI's clarifying questions (the `ask_user` tool), the parts the
 * client and the server share: the question/answer shapes, their checks, and
 * how a question and its answer read in the text history. Pure (no server
 * imports). The tool definition, the signed pending state and the history
 * pairing are server-side, in lib/desk/tools/ask.ts.
 *
 * Flow: Claude calls `ask_user`; the route ends the reply there and sends the
 * card on the stream (RUN_MARK `{"t":"ask","id","questions","token"}`); the
 * member picks an answer (or types a normal message instead); the next request
 * carries `ask: { token, answers? }` and the route supplies the tool_result.
 */

export const ASK_TOOL_NAME = "ask_user";

export const ASK_LIMITS = {
  questions: 3,
  minOptions: 2,
  maxOptions: 4,
  question: 200,
  header: 16,
  label: 60,
  description: 160,
  other: 500,
} as const;

export type AskOption = { label: string; description: string; recommended?: boolean };
export type AskQuestion = { question: string; header: string; options: AskOption[]; multiSelect: boolean };
/** One answer per question, in order: the labels picked, and the member's own words for "Other". */
export type AskAnswer = { choices: string[]; other?: string };
/** A card as the chat keeps it (lab/sessions.ts). `skipped`: the member typed a message instead. */
export type DeskAsk = { id: string; questions: AskQuestion[]; token: string; answers?: AskAnswer[]; skipped?: boolean };

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Checks and tidies `ask_user` input: recommended option first (at most one), no "Other" (the card adds it), duplicates dropped. */
export function parseAskInput(input: unknown): { ok: true; questions: AskQuestion[] } | { ok: false; error: string } {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: "questions must be a list of 1 to 3 questions." };
  if (raw.length > ASK_LIMITS.questions) return { ok: false, error: "Ask at most 3 questions at once." };
  const questions: AskQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = (raw[i] ?? {}) as Record<string, unknown>;
    const question = text(o.question, ASK_LIMITS.question);
    if (!question) return { ok: false, error: `Question ${i + 1} has no text.` };
    const header = text(o.header, ASK_LIMITS.header) || question.slice(0, ASK_LIMITS.header);
    const seen = new Set<string>();
    let recommended = false;
    const options: AskOption[] = [];
    for (const opt of Array.isArray(o.options) ? o.options : []) {
      const p = (opt ?? {}) as Record<string, unknown>;
      const label = text(p.label, ASK_LIMITS.label);
      const key = label.toLowerCase();
      if (!label || seen.has(key) || /^other\b/i.test(label)) continue;
      seen.add(key);
      const option: AskOption = { label, description: text(p.description, ASK_LIMITS.description) };
      if (p.recommended === true && !recommended) {
        recommended = true;
        option.recommended = true;
        options.unshift(option);
      } else options.push(option);
    }
    if (options.length < ASK_LIMITS.minOptions) return { ok: false, error: `Question ${i + 1} needs 2 to 4 distinct options (the card adds "Other" itself).` };
    if (options.length > ASK_LIMITS.maxOptions) return { ok: false, error: `Question ${i + 1} has more than 4 options.` };
    questions.push({ question, header, options, multiSelect: o.multiSelect === true });
  }
  return { ok: true, questions };
}

/** The member's answers, checked against the questions: known labels only, one pick for a single-select question, something for each. Null when they do not fit. */
export function cleanAnswers(v: unknown, questions: AskQuestion[]): AskAnswer[] | null {
  if (!Array.isArray(v) || v.length !== questions.length) return null;
  const out: AskAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const a = (v[i] ?? {}) as Record<string, unknown>;
    const labels = new Set(q.options.map((o) => o.label));
    const picked = Array.isArray(a.choices) ? a.choices.filter((c): c is string => typeof c === "string" && labels.has(c)) : [];
    const choices = q.options.map((o) => o.label).filter((l) => picked.includes(l));
    const other = typeof a.other === "string" ? a.other.trim().slice(0, ASK_LIMITS.other) : "";
    if (!q.multiSelect && choices.length + (other ? 1 : 0) > 1) return null;
    if (!choices.length && !other) return null;
    out.push(other ? { choices, other } : { choices });
  }
  return out;
}

/** "S&P 500, Nasdaq 100" or "my own: 2015 to 2020". */
export function answerText(a: AskAnswer): string {
  return [...a.choices, ...(a.other ? [`"${a.other}"`] : [])].join(", ");
}

/** The answers as the member's message in the text history: "Universe: S&P 500\nPeriod: \"2015 to 2020\"". */
export function answersForHistory(ask: Pick<DeskAsk, "questions" | "answers">): string {
  return ask.questions.map((q, i) => `${q.header}: ${ask.answers?.[i] ? answerText(ask.answers[i]!) : "(no answer)"}`).join("\n");
}

/** The card in words, so later turns know it was asked (history context, lib/desk/history-context.ts; the session title). */
export function askForHistory(ask: DeskAsk): string {
  const qs = ask.questions.map((q) => `${q.question} (options: ${q.options.map((o) => o.label).join("; ")}; or their own answer)`).join(" ");
  const tail = ask.answers ? "" : ask.skipped ? " The member did not pick an option and wrote the next message instead." : "";
  return `You asked the member: ${qs}${tail}`;
}

/** A card read back from storage, or undefined when it does not hold up. */
export function cleanAsk(v: unknown): DeskAsk | undefined {
  const o = v as Partial<DeskAsk> | null;
  if (!o || typeof o.id !== "string" || typeof o.token !== "string") return undefined;
  const parsed = parseAskInput({ questions: o.questions });
  if (!parsed.ok) return undefined;
  const out: DeskAsk = { id: o.id, questions: parsed.questions, token: o.token };
  const answers = o.answers === undefined ? null : cleanAnswers(o.answers, parsed.questions);
  if (answers) out.answers = answers;
  else if (o.skipped === true) out.skipped = true;
  return out;
}

/**
 * The card in the reply stream: the route writes `<mark>{"t":"ask",...}\n`
 * (RUN_MARK framing); the last one wins. The chat's parser skips these lines.
 */
export function askFromStream(raw: string, mark: string): DeskAsk | undefined {
  let found: DeskAsk | undefined;
  for (let i = raw.indexOf(`${mark}{"t":"ask"`); i >= 0; i = raw.indexOf(`${mark}{"t":"ask"`, i + 1)) {
    const nl = raw.indexOf("\n", i);
    if (nl < 0) break;
    try {
      found = cleanAsk(JSON.parse(raw.slice(i + 1, nl))) ?? found;
    } catch {
      // A line this client cannot read: skip it.
    }
  }
  return found;
}

/**
 * What the next request sends about a card, from the thread before the new
 * reply: the answers when the reply follows an answered card, `{ token }` alone
 * when the viewer wrote a message instead of picking (the server sends a note
 * as the result, then that message). Null when no card is waiting.
 */
export function askToSend(before: { role: "user" | "assistant"; ask?: DeskAsk }[]): { token: string; answers?: AskAnswer[] } | null {
  const last = before[before.length - 1];
  if (last?.role === "assistant" && last.ask?.answers) return { token: last.ask.token, answers: last.ask.answers };
  const prev = before[before.length - 2];
  if (last?.role === "user" && prev?.role === "assistant" && prev.ask && !prev.ask.answers) return { token: prev.ask.token };
  return null;
}
