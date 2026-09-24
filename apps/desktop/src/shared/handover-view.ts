/**
 * The handover popup's view: a briefing report turned into the few lines the
 * popup draws.
 *
 * The popup is deliberately simple — an introduction, a short summary per kind
 * of thing that happened (news, earnings, the rest), and the time and date
 * along the bottom. Everything that decides WHAT goes in it lives here, pure,
 * so the component is only layout and the rules can be tested without a DOM.
 *
 * The report already sorts its stories most consequential first; this keeps
 * that order and only buckets them. When a bucket has no story (a thin night,
 * or a report built while the model was unreachable), it falls back to the raw
 * evidence the stories are made from, so the popup still says something true
 * instead of showing an empty heading.
 */

import { MONTH_ABBR, WEEKDAY_ABBR, maskDollarAmounts } from "./briefing-view";
import type { BriefingReport, HeldFiling, MarketHeadline, Story } from "./briefing-types";

export type HandoverKind = "news" | "earnings" | "other";

export type HandoverItem = {
  id: string;
  /** What the line is about: "AMZN", "GRMN", "Markets". Null when nothing names it. */
  subject: string | null;
  /** The company the line is about, when there is exactly one to open. */
  ticker: string | null;
  /** The one sentence shown before "See more". */
  summary: string;
  /** Shown after "See more": how it moved, in the report's own words. Null when there is nothing more. */
  detail: string | null;
  /** Also after "See more": what it means for the reader's own book. */
  meaning: string | null;
  url: string | null;
};

export type HandoverSection = {
  kind: HandoverKind;
  title: string;
  items: HandoverItem[];
};

export type HandoverView = {
  intro: string;
  /** The report's one- or two-sentence lead, when it has one worth showing. */
  lead: string | null;
  /** Only the sections that have something in them, in the popup's fixed order. */
  sections: HandoverSection[];
  /** "9:04 AM ET" — the time the popup is looked at, on the market's clock. */
  time: string;
  /** "Thu Sep 24" — the session this handover is for. */
  date: string;
  /** Nothing to report at all: the popup says so rather than drawing empty headings. */
  empty: boolean;
};

/** How many lines each section shows before the popup would stop being a glance. */
export const ITEMS_PER_SECTION = 3;

export const HANDOVER_INTRO = "This is what happened when you were away";

const SECTION_TITLES: Record<HandoverKind, string> = {
  news: "News",
  earnings: "Earnings",
  other: "Other",
};

const SECTION_ORDER: HandoverKind[] = ["news", "earnings", "other"];

/**
 * A story's scope, read as the popup's kind. The engine's "release" scope is a
 * scheduled macro print (a rate decision, CPI), not a company's results: a
 * company that reported arrives as a "name" story resting on its 8-K, so it is
 * the filing that moves a name story under Earnings.
 */
function kindOf(story: Story, reported: ReadonlySet<string>): HandoverKind {
  if (story.scope !== "name") return "other";
  return tickersOf(story.tickers).some((t) => reported.has(t)) ? "earnings" : "news";
}

function clean(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function tickersOf(tickers: readonly string[] | undefined): string[] {
  return [...new Set((tickers ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean))];
}

function subjectOf(tickers: readonly string[] | undefined, fallback: string | null): string | null {
  const named = tickersOf(tickers);
  if (named.length === 0) return fallback;
  // Two names read fine on one line; past that the line becomes a list.
  return named.length <= 2 ? named.join(", ") : `${named.slice(0, 2).join(", ")} +${named.length - 2}`;
}

/** What an unnamed line is about: the tape as a whole, or a scheduled macro print. */
const SCOPE_SUBJECT: Partial<Record<Story["scope"], string>> = { market: "Markets", release: "Macro" };

function soleTicker(tickers: readonly string[] | undefined): string | null {
  const named = tickersOf(tickers);
  return named.length === 1 ? named[0]! : null;
}

function fromStory(story: Story): HandoverItem | null {
  const summary = clean(story.what);
  if (!summary) return null;
  return {
    id: story.id,
    subject: subjectOf(story.tickers, SCOPE_SUBJECT[story.scope] ?? null),
    ticker: soleTicker(story.tickers),
    summary,
    detail: clean(story.reaction),
    meaning: clean(story.meaning),
    url: null,
  };
}

function fromHeadline(h: MarketHeadline): HandoverItem | null {
  const summary = clean(h.title);
  if (!summary) return null;
  return {
    id: `headline:${h.id}`,
    subject: subjectOf(h.related, clean(h.source)),
    ticker: soleTicker(h.related),
    summary,
    detail: clean(h.source) ? `Reported by ${clean(h.source)}.` : null,
    meaning: null,
    url: clean(h.url),
  };
}

/**
 * An earnings release as the SEC sees it: an 8-K under Item 2.02, "Results of
 * Operations". The same rule the engine's stories use (`RESULTS_FILING` in
 * briefing/stories.ts), so a name the report says "reported results" is the
 * name this files under Earnings.
 */
export function isEarningsFiling(f: HeldFiling): boolean {
  if (f.kind !== "filing") return false;
  return /\b2\.02\b|\bresults\b/i.test(f.label ?? "");
}

function fromFiling(f: HeldFiling): HandoverItem | null {
  const ticker = clean(f.ticker)?.toUpperCase();
  if (!ticker) return null;
  return {
    id: `filing:${ticker}:${f.filed_at}`,
    subject: ticker,
    ticker,
    summary: `${ticker} released its quarterly results.`,
    detail: `Filed with the SEC: ${clean(f.label) ?? "8-K"}.`,
    meaning: null,
    url: clean(f.url),
  };
}

function dedupe(items: HandoverItem[]): HandoverItem[] {
  const seen = new Set<string>();
  const out: HandoverItem[] = [];
  for (const item of items) {
    const key = item.summary.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const NY_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "9:04 AM ET". The market's clock, labelled, so it reads right from any timezone. */
export function etTimeLabel(now: Date): string {
  if (!Number.isFinite(now.getTime())) return "";
  return `${NY_TIME.format(now)} ET`;
}

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "Thu Sep 24" for the New York calendar day `now` falls on: the footer's date before a report has arrived. */
export function etDateLabel(now: Date): string {
  if (!Number.isFinite(now.getTime())) return "";
  const parts = Object.fromEntries(NY_DATE.formatToParts(now).map((p) => [p.type, p.value]));
  return sessionDateLabel(`${parts.year}-${parts.month}-${parts.day}`);
}

/** "Thu Sep 24" from a NY calendar date "2026-09-24"; the input unchanged if it will not parse. */
export function sessionDateLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!m) return ymd ?? "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Noon UTC: far enough from midnight that no timezone flips the weekday.
  const dow = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
  if (mo < 1 || mo > 12 || !Number.isFinite(dow)) return ymd;
  return `${WEEKDAY_ABBR[dow]} ${MONTH_ABBR[mo - 1]} ${d}`;
}

function masking(item: HandoverItem, masked: boolean): HandoverItem {
  if (!masked) return item;
  const prose = (text: string | null) => (text === null ? null : maskDollarAmounts(text));
  return { ...item, summary: maskDollarAmounts(item.summary), detail: prose(item.detail), meaning: prose(item.meaning) };
}

/**
 * The contract keeps dollars out of every sentence; `masked` (the privacy
 * switch) still runs the same backstop the full briefing does, so a figure
 * that slipped into the prose never reaches a masked screen.
 */
export function handoverView(report: BriefingReport, now: Date, masked: boolean): HandoverView {
  const buckets: Record<HandoverKind, HandoverItem[]> = { news: [], earnings: [], other: [] };
  const results = (report.overnight?.filings ?? []).filter(isEarningsFiling);
  const reported = new Set(results.map((f) => clean(f.ticker)?.toUpperCase()).filter((t): t is string => !!t));
  const told = new Set<string>();

  for (const story of report.stories ?? []) {
    const item = fromStory(story);
    if (!item) continue;
    buckets[kindOf(story, reported)].push(item);
    for (const t of tickersOf(story.tickers)) told.add(t);
  }

  // A bucket with no story falls back to the evidence stories are built from,
  // so a thin night or a model outage still leaves something true on screen.
  if (buckets.news.length === 0) {
    for (const h of report.headlines ?? []) {
      const item = fromHeadline(h);
      if (item) buckets.news.push(item);
    }
  }
  // A company that filed results but has no story of its own still belongs
  // under Earnings: that is the one line the reader opened the app for.
  for (const f of results) {
    const item = fromFiling(f);
    if (!item || told.has(item.ticker!)) continue;
    told.add(item.ticker!);
    buckets.earnings.push(item);
  }

  const lead = clean(report.narrative?.text);
  const sections: HandoverSection[] = [];
  for (const kind of SECTION_ORDER) {
    const items = dedupe(buckets[kind])
      .slice(0, ITEMS_PER_SECTION)
      .map((item) => masking(item, masked));
    if (items.length > 0) sections.push({ kind, title: SECTION_TITLES[kind], items });
  }

  return {
    intro: HANDOVER_INTRO,
    lead: lead === null ? null : masked ? maskDollarAmounts(lead) : lead,
    sections,
    time: etTimeLabel(now),
    date: sessionDateLabel(report.window?.target_session_ymd ?? ""),
    empty: sections.length === 0,
  };
}
