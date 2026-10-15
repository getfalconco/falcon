import type {
  Agent,
  AgentChannel,
  AgentDraft,
  AgentEnds,
  AgentFilingChangeKind,
  AgentLine,
  AgentMetricReading,
  AgentReport,
  AgentStatus,
  AgentTrigger,
  AgentTriggerKind,
} from "../../../shared/agent-types";
import { withClock } from "../../lib/clock";
import type { LanguageCode } from "../../lib/i18n/languages";
import { en, type MessageKey } from "../../lib/i18n/messages";
import { translate, type MessageVars } from "../../lib/i18n/translate";

/**
 * Words and numbers the agent screens print, as pure functions so the rules
 * can be tested without React. Every function that returns words takes the
 * reader's language; the words come from the agents message table
 * (lib/i18n/messages/areas/agents.ts), each sentence a whole template.
 *
 * Dates and relative times go through Intl in that language at run time, so
 * a month name is never a literal here (see the note on "may" in
 * shared/copy-rules), and times of day follow the reader's clock
 * (lib/clock.ts). Numbers that are financial values stay as the engine wrote
 * them.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Lang = LanguageCode;

export function say(lang: Lang, key: MessageKey, vars?: MessageVars): string {
  return translate(lang, key, vars);
}

export function hasKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/**
 * A brief with its placeholder ticker in place, and where that ticker sits so
 * the create flow can select it and the reader's typing replaces it. The
 * starter briefs (agent-templates.ts) carry `{ticker}`; a brief without the
 * placeholder is searched for the ticker as a whole word.
 */
export function fillTemplateTicker(text: string, ticker: string): { text: string; select: readonly [number, number] | null } {
  const at = text.indexOf("{ticker}");
  if (at >= 0) return { text: text.split("{ticker}").join(ticker), select: [at, at + ticker.length] };
  const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`).exec(text);
  return { text, select: found ? [found.index, found.index + ticker.length] : null };
}

/**
 * A message with a count: `<base>.one`, `<base>.other` (and any other plural
 * category a table carries), picked by the language's plural rules.
 */
export function sayCount(lang: Lang, base: string, count: number, vars?: MessageVars): string {
  let category: string = "other";
  try {
    category = new Intl.PluralRules(lang).select(count);
  } catch {
    /* "other" is always there */
  }
  const key = hasKey(`${base}.${category}`) ? `${base}.${category}` : `${base}.other`;
  return translate(lang, key as MessageKey, { count, ...vars });
}

/** First letter up, in the language's own casing ("i" is "İ" in Turkish). */
export function capitalize(text: string, lang: Lang): string {
  return text.charAt(0).toLocaleUpperCase(lang) + text.slice(1);
}

/**
 * A noun or label set in the middle of a sentence: lower-cased in languages
 * that do that, but German keeps its capitals, and acronyms and tickers
 * ("EPS", "NVDA") stay as written everywhere.
 */
export function midSentence(text: string, lang: Lang): string {
  if (lang === "de-DE") return text;
  return text
    .split(" ")
    .map((w) => (w.length > 1 && w.toLocaleUpperCase(lang) === w ? w : w.toLocaleLowerCase(lang)))
    .join(" ");
}

/**
 * The first word lower-cased for the middle of a sentence ("News" reads as
 * "news"), unless it is a ticker or an acronym, or the language is German.
 */
export function lowerFirst(text: string, lang: Lang): string {
  if (lang === "de-DE") return text;
  const [first] = text.split(" ");
  if (!first || first.toLocaleUpperCase(lang) === first) return text;
  return text.charAt(0).toLocaleLowerCase(lang) + text.slice(1);
}

export const TRIGGER_KINDS: readonly AgentTriggerKind[] = ["earnings", "filing", "filing_changes", "linked", "price_move", "news", "macro", "schedule"];

/** The changes a filing changes watch can look for, in the order the editor shows them. */
export const CHANGE_KINDS: readonly AgentFilingChangeKind[] = ["risk_factors", "red_flags", "customers", "suppliers"];

/** What a filing changes watch looks for, as a phrase: "new risk factors or red flags"; every kind when none are picked. */
export function changesWhat(t: Extract<AgentTrigger, { kind: "filing_changes" }>, lang: Lang): string {
  const kinds = t.kinds && t.kinds.length > 0 ? CHANGE_KINDS.filter((k) => t.kinds!.includes(k)) : CHANGE_KINDS;
  return joinOr(
    kinds.map((k) => say(lang, `agents.changes.kind.${k}` as MessageKey)),
    lang,
  );
}

export function triggerKindLabel(kind: AgentTriggerKind, lang: Lang): string {
  return say(lang, `agents.kind.${kind}` as MessageKey);
}

export function statusLabel(status: AgentStatus, lang: Lang): string {
  return say(lang, `agents.status.${status}` as MessageKey);
}

/** Dot colours per status, in the palette the dark theme already translates. */
export const STATUS_DOT: Readonly<Record<AgentStatus, string>> = {
  active: "bg-[#16A34A]",
  paused: "bg-[#9CA3AF]",
  completed: "bg-[#1d1b1b]/30",
  error: "bg-[#DC2626]",
};

/** 2024-01-07 was a Sunday: day 0 of the contract's `weekday`. */
const SUNDAY = Date.UTC(2024, 0, 7, 12);

/** The weekday's name in the reader's language, as Intl spells it. */
export function weekdayName(day: number | undefined, lang: Lang, width: "long" | "short" = "long"): string {
  const d = (((day ?? 1) % 7) + 7) % 7;
  return new Intl.DateTimeFormat(lang, { weekday: width, timeZone: "UTC" }).format(new Date(SUNDAY + d * DAY));
}

/** "10-Q, 8-K or 4": a short list in running text, in the language's own way. */
export function joinOr(items: readonly string[], lang: Lang = "en-US"): string {
  const list = items.map((s) => s.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  try {
    return new Intl.ListFormat(lang, { type: "disjunction" }).format(list);
  } catch {
    return list.join(", ");
  }
}

/** "a, b and c". */
export function joinAnd(items: readonly string[], lang: Lang): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  try {
    return new Intl.ListFormat(lang, { type: "conjunction" }).format(list);
  } catch {
    return list.join(", ");
  }
}

function formatPct(n: number): string {
  const v = Math.abs(Number.isFinite(n) ? n : 0);
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}

function formName(form: string, lang: Lang): string {
  return form === "4" ? say(lang, "agents.form4") : form;
}

/** A macro release as the reader reads it: the two worded names translated, codes as they are. */
export function macroLabel(event: string, lang: Lang): string {
  if (event === "Payrolls") return say(lang, "agents.macro.payrolls");
  if (event === "FOMC rate decision") return say(lang, "agents.macro.fomc");
  return event;
}

/** An "HH:mm" the reader set, on the reader's clock. */
export function timeOfDay(hhmm: string, lang: Lang): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const at = new Date(Date.UTC(2024, 0, 8, Number(m[1]), Number(m[2])));
  return new Intl.DateTimeFormat(lang, withClock({ hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })).format(at);
}

/** Forms a linked watch reads when the trigger names none (main/agents/linked.ts). */
export const LINKED_DEFAULT_FORMS: readonly string[] = ["8-K", "6-K"];

/**
 * Who a linked watch covers, as a phrase: "suppliers or customers; critical
 * links". All three relations read as the three nouns joined with "and".
 */
export function linkedWho(t: Extract<AgentTrigger, { kind: "linked" }>, lang: Lang): string {
  const rels = t.relations && t.relations.length > 0 ? t.relations : (["supplier", "customer", "competitor"] as const);
  const nouns = rels.map((r) => say(lang, `agents.linked.rel.${r}` as MessageKey));
  const relations = t.relations && t.relations.length > 0 && t.relations.length < 3 ? joinOr(nouns, lang) : joinAnd(nouns, lang);
  return say(lang, "agents.linked.who", { relations, tier: say(lang, `agents.linked.tier.${t.minTier ?? "important"}` as MessageKey) });
}

/** What a linked watch fires on, as a phrase: "results or a filing (8-K, 6-K)". */
export function linkedWhat(t: Extract<AgentTrigger, { kind: "linked" }>, lang: Lang): string {
  const forms = (t.forms && t.forms.length > 0 ? t.forms : LINKED_DEFAULT_FORMS).map((f) => formName(f, lang)).join(", ");
  return joinOr(
    t.events.map((e) => say(lang, `agents.linked.ev.${e}` as MessageKey, { forms })),
    lang,
  );
}

/** A trigger as one readable sentence, the way the reader might have said it. */
export function triggerSentence(t: AgentTrigger, lang: Lang): string {
  switch (t.kind) {
    case "earnings":
      return say(lang, t.moment === "call" ? "agents.trigger.earnings.call" : "agents.trigger.earnings.release", { ticker: t.ticker });
    case "filing":
      if (t.insiderBuysOnly) return say(lang, "agents.trigger.filing.insider", { ticker: t.ticker });
      return t.forms.length > 0
        ? say(lang, "agents.trigger.filing.forms", { ticker: t.ticker, forms: joinOr(t.forms.map((f) => formName(f, lang)), lang) })
        : say(lang, "agents.trigger.filing.any", { ticker: t.ticker });
    case "price_move":
      return say(lang, `agents.trigger.price.${t.window}` as MessageKey, { ticker: t.ticker, pct: formatPct(t.thresholdPct) });
    case "news": {
      const keywords = joinOr(t.keywords.map((k) => `"${k}"`), lang);
      if (t.ticker && t.keywords.length > 0) return say(lang, "agents.trigger.news.tickerKeywords", { ticker: t.ticker, keywords });
      if (t.ticker) return say(lang, "agents.trigger.news.ticker", { ticker: t.ticker });
      if (t.keywords.length > 0) return say(lang, "agents.trigger.news.keywords", { keywords });
      return say(lang, "agents.trigger.news.any");
    }
    case "macro":
      return t.event ? say(lang, "agents.trigger.macro.event", { event: macroLabel(t.event, lang) }) : say(lang, "agents.trigger.macro.any");
    case "linked":
      return say(lang, "agents.trigger.linked", { ticker: t.ticker, who: linkedWho(t, lang), what: linkedWhat(t, lang) });
    case "filing_changes":
      return say(lang, "agents.trigger.changes", { ticker: t.ticker, what: changesWhat(t, lang) });
    case "schedule": {
      const time = timeOfDay(t.time || "08:00", lang);
      if (t.cadence === "daily") return say(lang, "agents.trigger.schedule.daily", { time });
      if (t.cadence === "weekdays") return say(lang, "agents.trigger.schedule.weekdays", { time });
      return say(lang, "agents.trigger.schedule.weekly", { time, weekday: weekdayName(t.weekday, lang) });
    }
  }
}

/** A short noun for what the agent is waiting on: "NVDA earnings", "CPI". */
export function triggerNoun(t: AgentTrigger, lang: Lang): string {
  switch (t.kind) {
    case "earnings":
      return say(lang, t.moment === "call" ? "agents.noun.earningsCall" : "agents.noun.earnings", { ticker: t.ticker });
    case "filing":
      if (t.insiderBuysOnly) return say(lang, "agents.noun.insider", { ticker: t.ticker });
      if (t.forms.length !== 1) return say(lang, "agents.noun.filings", { ticker: t.ticker });
      return t.forms[0] === "4"
        ? say(lang, "agents.noun.form4", { ticker: t.ticker })
        : say(lang, "agents.noun.form", { ticker: t.ticker, form: t.forms[0]! });
    case "price_move":
      return say(lang, "agents.noun.price", { ticker: t.ticker });
    case "news":
      if (t.ticker) return say(lang, "agents.noun.tickerNews", { ticker: t.ticker });
      return t.keywords.length > 0 ? say(lang, "agents.noun.keywordNews", { keywords: joinOr(t.keywords, lang) }) : say(lang, "agents.noun.marketNews");
    case "macro":
      return t.event ? macroLabel(t.event, lang) : say(lang, "agents.noun.macro");
    case "linked":
      return say(lang, "agents.noun.linked", { ticker: t.ticker });
    case "filing_changes":
      return say(lang, "agents.noun.changes", { ticker: t.ticker });
    case "schedule":
      return say(lang, "agents.noun.schedule");
  }
}

/**
 * The same noun without the ticker, for a row that shows the ticker beside
 * it ("Earnings call" next to an NVDA chip). Null for kinds such a row names
 * by the agent instead (news, schedules).
 */
export function triggerNounShort(t: AgentTrigger, lang: Lang): string | null {
  switch (t.kind) {
    case "earnings":
      return say(lang, t.moment === "call" ? "agents.short.earningsCall" : "agents.short.earnings");
    case "filing":
      if (t.insiderBuysOnly) return say(lang, "agents.short.insider");
      if (t.forms.length !== 1) return say(lang, "agents.short.filings");
      return t.forms[0] === "4" ? say(lang, "agents.short.form4") : t.forms[0]!;
    case "price_move":
      return say(lang, "agents.short.price");
    case "macro":
      return t.event ? macroLabel(t.event, lang) : say(lang, "agents.noun.macro");
    case "linked":
      return say(lang, "agents.short.linked");
    case "filing_changes":
      return say(lang, "agents.short.changes");
    case "news":
    case "schedule":
      return null;
  }
}

function relativeFormat(lang: Lang, value: number, unit: Intl.RelativeTimeFormatUnit, style: "long" | "short" = "long"): string {
  return new Intl.RelativeTimeFormat(lang, { numeric: "auto", style }).format(value, unit);
}

/** Within a minute of `now`: the event is due. */
export function isDueNow(iso: string | undefined, now: number): boolean {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at - now <= MINUTE;
}

/** "in 3 days", "in 5 hours", "in 12 minutes", "tomorrow", "now", in the reader's language. */
export function countdown(iso: string | undefined, now: number, lang: Lang = "en-US"): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const d = at - now;
  if (d <= MINUTE) return relativeFormat(lang, 0, "second");
  if (d < HOUR) return relativeFormat(lang, Math.round(d / MINUTE), "minute");
  if (d < DAY) return relativeFormat(lang, Math.round(d / HOUR), "hour");
  return relativeFormat(lang, Math.round(d / DAY), "day");
}

/** "Just now", "5 min. ago", "3 hr. ago", "Yesterday", then a date. */
export function relativeTime(iso: string | undefined, now: number, lang: Lang = "en-US"): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const d = now - at;
  if (d < MINUTE) return say(lang, "agents.time.justNow");
  if (d < HOUR) return relativeFormat(lang, -Math.floor(d / MINUTE), "minute", "short");
  if (d < DAY) return relativeFormat(lang, -Math.floor(d / HOUR), "hour", "short");
  if (d < 2 * DAY) return capitalize(relativeFormat(lang, -1, "day"), lang);
  return shortDate(iso, lang);
}

/**
 * `relativeTime` for the middle of a sentence: either a phrase that stands on
 * its own ("5 min. ago", "yesterday"), or a date that the sentence's own
 * template introduces ("on Oct 1"), since that preposition differs by language.
 */
export function relativePhrase(iso: string | undefined, now: number, lang: Lang = "en-US"): { kind: "ago" | "on"; text: string } {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return { kind: "ago", text: "" };
  const d = now - at;
  if (d < MINUTE) return { kind: "ago", text: midSentence(say(lang, "agents.time.justNow"), lang) };
  if (d < 2 * DAY) {
    const text = relativeTime(iso, now, lang);
    return { kind: "ago", text: d >= DAY ? lowerFirst(text, lang) : text };
  }
  return { kind: "on", text: shortDate(iso, lang) };
}

/** A sentence that carries a relative time, picking the template that fits it. */
function withWhen(lang: Lang, iso: string | undefined, now: number, ago: MessageKey, on: MessageKey, vars?: MessageVars): string {
  const when = relativePhrase(iso, now, lang);
  return when.kind === "on" ? say(lang, on, { ...vars, date: when.text }) : say(lang, ago, { ...vars, when: when.text });
}

/** A date with no time: the month as Intl spells it. */
export function shortDate(iso: string | undefined, lang: Lang = "en-US"): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}

/** A calendar date the engine wrote as YYYY-MM-DD, read as that day wherever the reader is. */
export function calendarDate(ymd: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(at);
}

/** Weekday, date and time: for the overview and report headers. */
export function dateTime(iso: string | undefined, lang: Lang = "en-US"): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(
    lang,
    withClock({ weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  ).format(at);
}

export function clockTime(iso: string | undefined, lang: Lang = "en-US"): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(lang, withClock({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).format(at);
}

/**
 * The one line under an agent's name: what it is waiting on and when, or
 * why it is not waiting at all.
 */
export function waitingLine(agent: Agent, now: number, lang: Lang = "en-US"): string {
  if (agent.status === "paused") return say(lang, "agents.wait.paused");
  if (agent.status === "error") {
    return agent.error ? say(lang, "agents.wait.attentionError", { error: agent.error }) : say(lang, "agents.wait.attention");
  }
  if (agent.status === "completed") {
    return agent.lastFiredAt
      ? withWhen(lang, agent.lastFiredAt, now, "agents.wait.doneAgo", "agents.wait.doneOn")
      : say(lang, "agents.wait.done");
  }
  const first = agent.triggers[0];
  if (!first) return say(lang, "agents.wait.noTrigger");
  const noun = triggerNoun(first, lang);
  const when = countdown(agent.nextExpectedAt, now, lang);
  const due = isDueNow(agent.nextExpectedAt, now);
  if (first.kind === "schedule") {
    const line = !when ? triggerSentence(first, lang) : due ? say(lang, "agents.wait.writeupNow") : say(lang, "agents.wait.writeupIn", { when });
    // A digest about no one company says its topic, so the row tells what it watches.
    const topic = !agent.ticker && first.keywords && first.keywords.length > 0 ? say(lang, "agents.noun.keywordNews", { keywords: joinOr(first.keywords, lang) }) : null;
    return topic ? say(lang, "agents.wait.withTopic", { topic, line }) : line;
  }
  if (!when) return say(lang, "agents.wait.watching", { noun: lowerFirst(noun, lang) });
  return due ? say(lang, "agents.wait.dueNow", { noun }) : say(lang, "agents.wait.dueIn", { noun, when });
}

/** Waiting on something within `withinMs`: the dashboard's "coming up" list. */
export function upcoming(agents: readonly Agent[], now: number, withinMs = 14 * DAY): Agent[] {
  return agents
    .filter((a) => a.status === "active" && a.nextExpectedAt)
    .filter((a) => {
      const at = Date.parse(a.nextExpectedAt!);
      return Number.isFinite(at) && at >= now - HOUR && at - now <= withinMs;
    })
    .sort((a, b) => Date.parse(a.nextExpectedAt!) - Date.parse(b.nextExpectedAt!));
}

export function verdictLabel(verdict: AgentMetricReading["verdict"], lang: Lang): string {
  return say(lang, `agents.verdict.${verdict}` as MessageKey);
}

/** Verdict pills: tinted fills the dark theme translates to their own tints. */
export const VERDICT_PILL: Readonly<Record<AgentMetricReading["verdict"], string>> = {
  above: "bg-[#DCFCE7] text-[#166534]",
  below: "bg-[#FEE2E2] text-[#991B1B]",
  inline: "bg-[#1d1b1b]/[0.06] text-[#4b5563]",
  unclear: "bg-[#FEF3C7] text-[#92400E]",
};

/**
 * First questions for the chat, made from what the reader said they care
 * about. Each names a metric, so none of them is a generic opener.
 */
export function suggestedQuestions(agent: Agent, reports: readonly AgentReport[], lang: Lang = "en-US"): string[] {
  const out: string[] = [];
  const metrics = agent.metrics.slice(0, 3);
  const metric = (i: number) => midSentence(metrics[i]!.label, lang);
  if (reports.length > 0) {
    if (metrics[0]) out.push(say(lang, "agents.ask.compare", { metric: metric(0) }));
    if (metrics[1]) out.push(say(lang, "agents.ask.drove", { metric: metric(1) }));
    out.push(say(lang, "agents.ask.latestDiff"));
  } else {
    if (metrics[0]) out.push(say(lang, "agents.ask.lastTime", { metric: metric(0) }));
    const t = agent.triggers[0];
    if (t?.kind === "earnings") out.push(say(lang, "agents.ask.nextEarnings", { ticker: t.ticker }));
    else if (t?.kind === "macro") out.push(say(lang, "agents.ask.nextMacro", { event: macroLabel(t.event, lang) }));
    else if (t?.kind === "filing" || t?.kind === "filing_changes") out.push(say(lang, "agents.ask.lastFiling", { ticker: t.ticker }));
    out.push(say(lang, "agents.ask.cadence"));
  }
  return Array.from(new Set(out)).slice(0, 3);
}

/* ------------------------------------------------------------------ */
/* Engine lines                                                         */
/* ------------------------------------------------------------------ */

const FIELD_KEYS = new Set(["name", "brief", "ticker", "companyName", "triggers", "metrics", "instructions", "channels", "oneShot", "ends"]);

function lineVars(line: AgentLine, lang: Lang): MessageVars {
  const vars: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(line.params ?? {})) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (name === "date" && typeof value === "string") vars[name] = calendarDate(value, lang);
    else if (name === "at" && typeof value === "string") vars[name] = dateTime(value, lang);
    else if (name === "fields" && typeof value === "string") {
      vars[name] = joinAnd(
        value
          .split(",")
          .map((f) => f.trim())
          .map((f) => (FIELD_KEYS.has(f) ? say(lang, `agents.field.${f}` as MessageKey) : f)),
        lang,
      );
    } else vars[name] = value;
  }
  if (line.triggers) vars.triggers = joinAnd(line.triggers.map((t) => triggerNoun(t, lang)), lang);
  return vars;
}

/** One engine line in the reader's language, or null when this build does not know its code. */
export function sayLine(line: AgentLine, lang: Lang): string | null {
  if (!line || typeof line.code !== "string") return null;
  const base = `agents.line.${line.code}`;
  const count = line.params?.count;
  if (typeof count === "number" && hasKey(`${base}.other`)) return sayCount(lang, base, count, lineVars(line, lang));
  if (!hasKey(base)) return null;
  return say(lang, base, lineVars(line, lang));
}

/** Sentences in a row: Japanese and Chinese set them without a space. */
function sentenceGap(lang: Lang): string {
  return lang === "ja-JP" || lang === "zh-CN" ? "" : " ";
}

/**
 * Engine lines in the reader's language, falling back to the engine's own
 * English (`fallback`) when there are none or any code is unknown: an entry
 * stored before codes existed, or a code from a newer engine.
 */
export function sayLines(lines: readonly AgentLine[] | undefined, lang: Lang, fallback: string): string {
  if (!Array.isArray(lines) || lines.length === 0) return fallback;
  const parts: string[] = [];
  for (const l of lines) {
    const text = sayLine(l, lang);
    if (text === null) return fallback;
    parts.push(text);
  }
  return parts.join(sentenceGap(lang));
}

/** Plain-text paragraphs: blank lines split them, single newlines stay as line breaks. */
/** A sec.gov address in a report's text (a filing changes report names its filings). */
const SEC_URL = /https:\/\/(?:www\.)?sec\.gov\/[^\s"'<>]+/g;

/**
 * A paragraph split around the sec.gov addresses in it, so they can be links:
 * each address comes with a short label, the document's file name ("smci-20250630.htm").
 */
export function secLinkParts(text: string): Array<{ text: string; url?: string }> {
  const out: Array<{ text: string; url?: string }> = [];
  let at = 0;
  for (const m of text.matchAll(SEC_URL)) {
    const url = m[0].replace(/[.,;:)]+$/, "");
    const start = m.index ?? 0;
    if (start > at) out.push({ text: text.slice(at, start) });
    const file = url.split("#")[0]!.split("/").filter(Boolean).pop() ?? "sec.gov";
    out.push({ text: file, url });
    at = start + url.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Filters in the list's own order. */
export type StatusFilter = "all" | AgentStatus;

export function matchesQuery(agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [agent.name, agent.ticker ?? "", agent.companyName ?? "", agent.brief].some((s) => s.toLowerCase().includes(q));
}

/** Newest activity first: unread reports, then the soonest wait, then the name. */
export function sortAgents(agents: readonly Agent[]): Agent[] {
  const rank: Record<AgentStatus, number> = { error: 0, active: 1, paused: 2, completed: 3 };
  return [...agents].sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    if ((b.unread > 0 ? 1 : 0) !== (a.unread > 0 ? 1 : 0)) return (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0);
    const an = a.nextExpectedAt ? Date.parse(a.nextExpectedAt) : Infinity;
    const bn = b.nextExpectedAt ? Date.parse(b.nextExpectedAt) : Infinity;
    if (an !== bn) return an - bn;
    return a.name.localeCompare(b.name);
  });
}

/* ------------------------------------------------------------------ */
/* Create flow and first status                                          */
/* ------------------------------------------------------------------ */

/** When the daily digest goes out (main/agents/channels/digest.ts). */
export const DIGEST_TIME = "08:00";

/** The tickers an agent (or a draft) watches: its own first, then each trigger's, once each. */
export function watchedTickers(a: { ticker?: string; triggers: readonly AgentTrigger[] }): string[] {
  const out: string[] = [];
  const add = (t: string | undefined) => {
    const v = t?.trim().toUpperCase();
    if (v && !out.includes(v)) out.push(v);
  };
  add(a.ticker);
  for (const t of a.triggers) if ("ticker" in t) add(t.ticker);
  return out;
}

/** When the agent stops, as a phrase for the "Ends" row. `knownDate` is the results date when the calendar has one. */
export function endsSentence(ends: AgentEnds | undefined, lang: Lang, knownDate?: string): string {
  if (!ends) return say(lang, "agents.ends.none");
  switch (ends.kind) {
    case "date":
      return say(lang, "agents.ends.date", { date: calendarDate(ends.date, lang) });
    case "earnings":
      return knownDate
        ? say(lang, "agents.ends.earningsOn", { ticker: ends.ticker, date: calendarDate(knownDate, lang) })
        : say(lang, "agents.ends.earnings", { ticker: ends.ticker });
    case "filing":
      return say(lang, "agents.ends.filing", { ticker: ends.ticker, form: formName(ends.form, lang) });
  }
}

/** Where reports go, in one sentence: the app always, plus what the channels add. */
export function deliverySentence(channels: readonly AgentChannel[], lang: Lang): string {
  const parts: string[] = [];
  if (channels.includes("digest")) parts.push(say(lang, "agents.deliveryPart.digest", { time: timeOfDay(DIGEST_TIME, lang) }));
  if (channels.includes("desktop")) parts.push(say(lang, "agents.deliveryPart.desktop"));
  if (channels.includes("mobile_push")) parts.push(say(lang, "agents.deliveryPart.mobile"));
  return parts.length === 0 ? say(lang, "agents.deliveryLine.inApp") : say(lang, "agents.deliveryLine.inAppPlus", { parts: joinAnd(parts, lang) });
}

const NY = "America/New_York";

function nyDayKey(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * When the next check is, said the way a person would: "in 15 minutes" when
 * it is close, else "today 14:30 ET", "tomorrow 08:00 ET", a weekday within
 * the week, or a date. New York time, since that is the market's clock.
 */
export function nextCheckPhrase(iso: string | undefined, now: number, lang: Lang): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const d = at - now;
  if (d <= MINUTE) return say(lang, "agents.when.now");
  if (d < HOUR) return relativeFormat(lang, Math.round(d / MINUTE), "minute");
  const time = new Intl.DateTimeFormat(lang, withClock({ hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: NY })).format(at);
  const today = nyDayKey(now);
  const day = nyDayKey(at);
  if (day === today) return say(lang, "agents.when.todayAt", { time });
  if (day === nyDayKey(now + DAY)) return say(lang, "agents.when.tomorrowAt", { time });
  if (d < 6 * DAY) {
    const weekday = new Intl.DateTimeFormat(lang, { weekday: "long", timeZone: NY }).format(at);
    return say(lang, "agents.when.weekdayAt", { weekday, time });
  }
  return say(lang, "agents.when.dateAt", { date: calendarDate(day, lang), time });
}

/**
 * The first status line on a new agent's page, from what the engine has
 * actually done: "Watching NVDA. First check now: nothing yet. Next check:
 * tomorrow 08:00 ET." Null once the agent has reported, or when it is not
 * running; the page then shows its usual next-step line.
 */
export function firstStatusLine(agent: Agent, now: number, lang: Lang): string | null {
  if (agent.lastFiredAt || (agent.status !== "active" && agent.status !== "error")) return null;
  const parts: string[] = [];
  const tickers = watchedTickers(agent);
  const subjects = watchSubjects(agent, lang);
  if (tickers.length > 0) parts.push(say(lang, "agents.first.watching", { what: joinAnd(tickers, lang) }));
  else if (subjects.length > 0) parts.push(say(lang, "agents.first.watching", { what: joinAnd(subjects.map((s) => lowerFirst(s, lang)), lang) }));
  else parts.push(say(lang, "agents.first.watchingMarket"));
  const checked = agent.lastCheckedAt && Date.parse(agent.lastCheckedAt) > Date.parse(agent.createdAt);
  if (agent.status === "error") parts.push(say(lang, "agents.first.checkFailed"));
  else parts.push(say(lang, checked ? "agents.first.nothingYet" : "agents.first.running"));
  const next = agent.status === "active" ? nextCheckPhrase(agent.nextCheckAt, now, lang) : null;
  if (next && checked) parts.push(say(lang, "agents.first.next", { when: next }));
  return parts.join(sentenceGap(lang));
}

/** The next time a schedule fires, local, for the confirm card's "When". */
export function nextScheduleAt(t: Extract<AgentTrigger, { kind: "schedule" }>, now: number): string {
  const [hh, mm] = (t.time || "08:00").split(":").map(Number);
  const base = new Date(now);
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hh, mm, 0, 0);
    if (d.getTime() <= now) continue;
    const wd = d.getDay();
    if (t.cadence === "weekdays" && (wd === 0 || wd === 6)) continue;
    if (t.cadence === "weekly" && wd !== (t.weekday ?? 1)) continue;
    return d.toISOString();
  }
  return new Date(now + 7 * DAY).toISOString();
}

/** A date for "When", beside the trigger sentence: the results date, the next digest. Null when there is none to give. */
export function whenHint(t: AgentTrigger, draft: { nextExpectedAt?: string }, now: number, lang: Lang): string | null {
  if (t.kind === "earnings" && draft.nextExpectedAt) {
    return say(lang, "agents.when.onDate", { date: calendarDate(nyDayKey(Date.parse(draft.nextExpectedAt)), lang) });
  }
  if (t.kind === "schedule") return say(lang, "agents.when.nextAt", { at: dateTime(nextScheduleAt(t, now), lang) });
  return null;
}

/**
 * What an agent watches, as nouns, each once: "NVDA earnings", "News
 * mentioning semiconductor or supplier", "CPI". A schedule adds its topic
 * when it has one. Empty when it watches nothing in particular (a schedule
 * over the market as a whole).
 */
export function watchSubjects(a: { triggers: readonly AgentTrigger[] }, lang: Lang): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const t of a.triggers) {
    if (t.kind === "schedule") {
      if (t.keywords && t.keywords.length > 0) add(say(lang, "agents.noun.keywordNews", { keywords: joinOr(t.keywords, lang) }));
      continue;
    }
    add(triggerNoun(t, lang));
  }
  return out;
}

/** A draft as Falcon read it, for "Did we understand you?". */
export type Understanding = {
  /** Plain sentences, in order: what it watches, when it writes, what each report covers, how it arrives, when it stops. */
  lines: string[];
  /** One calm line about what the reading was unsure of, when it was. */
  note: string | null;
};

/**
 * The reading of a draft as a few plain sentences, built from what will
 * actually run (the triggers, metrics, channels and end), so what it says is
 * what the agent does: "It watches news mentioning semiconductor or supplier.
 * It writes to you every weekday at 08:00. ..."
 */
export function understanding(
  draft: Pick<AgentDraft, "ticker" | "triggers" | "metrics" | "channels" | "oneShot" | "ends" | "endsProposed" | "notes" | "nextExpectedAt">,
  lang: Lang,
): Understanding {
  const lines: string[] = [];
  const subjects = watchSubjects(draft, lang);
  lines.push(
    subjects.length > 0
      ? say(lang, "agents.understand.watches", { what: joinAnd(subjects.map((s) => lowerFirst(s, lang)), lang) })
      : say(lang, "agents.understand.watchesMarket"),
  );
  if (draft.triggers.length > 0) {
    const when = draft.triggers.map((t) => lowerFirst(triggerSentence(t, lang), lang));
    lines.push(say(lang, "agents.understand.acts", { when: joinOr([...new Set(when)], lang) }));
  }
  const metrics = draft.metrics.map((m) => m.label.trim()).filter(Boolean);
  lines.push(
    metrics.length > 0
      ? say(lang, "agents.understand.reports", { metrics: joinAnd(metrics.map((m) => midSentence(m, lang)), lang) })
      : say(lang, "agents.understand.reportsDefault"),
  );
  const parts: string[] = [];
  if (draft.channels.includes("digest")) parts.push(say(lang, "agents.deliveryPart.digest", { time: timeOfDay(DIGEST_TIME, lang) }));
  if (draft.channels.includes("desktop")) parts.push(say(lang, "agents.deliveryPart.desktop"));
  if (draft.channels.includes("mobile_push")) parts.push(say(lang, "agents.deliveryPart.mobile"));
  lines.push(parts.length > 0 ? say(lang, "agents.understand.delivery", { parts: joinAnd(parts, lang) }) : say(lang, "agents.understand.deliveryInApp"));
  const ends = draft.ends;
  const resultsDay = draft.nextExpectedAt ? nyDayKey(Date.parse(draft.nextExpectedAt)) : null;
  let endLine: string | null = null;
  if (draft.oneShot) {
    lines.push(say(lang, "agents.understand.oneShot"));
    if (ends?.kind === "date") endLine = say(lang, "agents.understand.endsDateFallback", { date: calendarDate(ends.date, lang) });
  } else if (ends) {
    switch (ends.kind) {
      case "date":
        endLine = say(lang, "agents.understand.endsDate", { date: calendarDate(ends.date, lang) });
        break;
      case "earnings":
        endLine = resultsDay
          ? say(lang, "agents.understand.endsEarningsOn", { ticker: ends.ticker, date: calendarDate(resultsDay, lang) })
          : say(lang, "agents.understand.endsEarnings", { ticker: ends.ticker });
        break;
      case "filing":
        endLine = say(lang, "agents.understand.endsFiling", { ticker: ends.ticker, form: formName(ends.form, lang) });
        break;
    }
  }
  if (endLine) lines.push(draft.endsProposed ? `${endLine}${sentenceGap(lang)}${say(lang, "agents.understand.proposed")}` : endLine);
  const first = draft.notes?.find((n) => n.trim());
  return { lines, note: first ? say(lang, "agents.understand.note", { note: first.trim() }) : null };
}

/**
 * A name for an agent made from words handed in from elsewhere (an earnings
 * row's "Create agent"), when none came with them: "NVDA earnings".
 */
export function suggestedName(brief: string, lang: Lang): string {
  const skip = new Set(["I", "A", "CEO", "CFO", "EPS", "SEC", "ET", "US", "CPI", "FOMC", "GAAP", "Q1", "Q2", "Q3", "Q4"]);
  const ticker = (brief.match(/\$?\b[A-Z]{1,5}(?:\.[A-Z])?\b/g) ?? []).map((t) => t.replace(/^\$/, "")).find((t) => !skip.has(t));
  return ticker ? say(lang, "agents.noun.earnings", { ticker }) : "";
}

