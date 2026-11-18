/**
 * Falcon AI session titles (POST /api/desk/title): a short name for a Desk
 * session from its first question and answer, in the member's language, made
 * by a small, cheap model. The client applies it only while the session still
 * has its default title (lab/sessions.ts).
 */

/** Small and cheap; titles need no depth. */
export const TITLE_MODEL = "claude-haiku-5-5";
export const TITLE_MAX_WORDS = 5;
const TITLE_MAX_CHARS = 48;

export const TITLE_SYSTEM = `You name research chat sessions for Falcon, a US stock research tool. Reply with only the title: at most ${TITLE_MAX_WORDS} words, in the same language as the member's question (Turkish stays Turkish, English stays English), no quotes, no ending punctuation, no emoji. Name the topic (tickers in capitals), e.g. "NVDA margin trend" or "AAPL temettü geçmişi".`;

/** Turkish letters or common Turkish words: the title must then be Turkish (the small model tends to drift otherwise). */
export function looksTurkish(text: string): boolean {
  return /[çğıöşüÇĞİÖŞÜ]/.test(text) || /(^|\s)(ve|nedir|neden|nasıl|nasil|hangi|mi|mı|mu|için|icin|bu|ne|kaç|kac|hisse|şirket|sirket)(\s|\?|$)/i.test(text);
}

/** The prompt for one session: the question, the start of the answer and the title's language. */
export function titlePrompt(question: string, answer: string): string {
  const q = question.trim().slice(0, 1_200);
  const lang = looksTurkish(q) ? "Turkish" : /^[\x00-\x7F]*$/.test(q) ? "English" : "the same language as the question";
  return `Question:\n${q}\n\nStart of the answer:\n${answer.trim().slice(0, 600)}\n\nWrite the title in ${lang}.\nTitle:`;
}

/**
 * The model's reply as a title: first line, no label, quotes, Markdown or end
 * punctuation, at most TITLE_MAX_WORDS words and TITLE_MAX_CHARS characters.
 * Empty when nothing usable is left.
 */
export function cleanTitle(raw: string): string {
  let t = (raw ?? "").replace(/\r/g, "").trim().split("\n").find((l) => l.trim()) ?? "";
  t = t
    .replace(/^\s*(title|başlık|baslik)\s*[:：-]\s*/i, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, "")
    .replace(/["'“”‘’«».!?。…:;,\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = t.split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS);
  t = words.join(" ");
  if (t.length > TITLE_MAX_CHARS) t = t.slice(0, TITLE_MAX_CHARS).replace(/\s+\S*$/, "").trim() || t.slice(0, TITLE_MAX_CHARS);
  return t;
}
