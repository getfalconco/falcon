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

import { maskDollarAmounts } from "./briefing-view";
import { ENGLISH, formatterFor, weekdayDateLabel, ymdNoonUtc, type BriefingKey, type BriefingText } from "./briefing-text";
import { MAX_BRIEFING_FACTS, type BriefingFact, type BriefingReport, type HeldFiling, type MarketHeadline, type Story } from "./briefing-types";
import { isTradingDay } from "./calendar-days";
import { figureText } from "./guidance-view";

export type HandoverKind = "news" | "earnings" | "filings" | "other";

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
  /** Shown on hover over a line that opens its source directly: the form, the date, where it opens. */
  hint?: string | null;
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
  /**
   * "Thu Sep 24": the session this handover is for, beside the time. On a day
   * the market does not open (a weekend, a holiday) it is New York's own date
   * instead: the footer reads as the clock, and "Mon" under a Sunday's time
   * would call Monday today. The handover is still Monday's.
   */
  date: string;
  /** Nothing to report at all: the popup says so rather than drawing empty headings. */
  empty: boolean;
};

/** How many lines each section shows before the popup would stop being a glance. */
export const ITEMS_PER_SECTION = 3;

/** The heading in English; the popup itself reads `briefing.handover.intro` in the reader's language. */
export const HANDOVER_INTRO = ENGLISH.t("briefing.handover.intro");

const SECTION_TITLES: Record<HandoverKind, BriefingKey> = {
  news: "briefing.handover.section.news",
  earnings: "briefing.handover.section.earnings",
  filings: "briefing.handover.section.filings",
  other: "briefing.handover.section.other",
};

const SECTION_ORDER: HandoverKind[] = ["news", "earnings", "filings", "other"];

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
const SCOPE_SUBJECT: Partial<Record<Story["scope"], BriefingKey>> = {
  market: "briefing.handover.subject.markets",
  release: "briefing.handover.subject.macro",
};

function soleTicker(tickers: readonly string[] | undefined): string | null {
  const named = tickersOf(tickers);
  return named.length === 1 ? named[0]! : null;
}

function fromStory(story: Story, text: BriefingText): HandoverItem | null {
  const summary = clean(story.what);
  if (!summary) return null;
  const scope = SCOPE_SUBJECT[story.scope];
  return {
    id: story.id,
    subject: subjectOf(story.tickers, scope ? text.t(scope) : null),
    ticker: soleTicker(story.tickers),
    summary,
    detail: clean(story.reaction),
    meaning: clean(story.meaning),
    url: null,
  };
}

function fromHeadline(h: MarketHeadline, text: BriefingText): HandoverItem | null {
  const summary = clean(h.title);
  if (!summary) return null;
  return {
    id: `headline:${h.id}`,
    subject: subjectOf(h.related, clean(h.source)),
    ticker: soleTicker(h.related),
    summary,
    detail: clean(h.source) ? text.t("briefing.handover.reportedBy", { source: clean(h.source)! }) : null,
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

function fromFiling(f: HeldFiling, text: BriefingText): HandoverItem | null {
  const ticker = clean(f.ticker)?.toUpperCase();
  if (!ticker) return null;
  return {
    id: `filing:${ticker}:${f.filed_at}`,
    subject: ticker,
    ticker,
    summary: text.t("briefing.handover.resultsReleased", { ticker }),
    detail: text.t("briefing.handover.filedWithSec", { form: clean(f.label) ?? "8-K" }),
    meaning: null,
    url: clean(f.url),
  };
}

// ---------------------------------------------------------------------------
// Filings and insiders
// ---------------------------------------------------------------------------

type RedFlagFact = Extract<BriefingFact, { kind: "red_flag" }>;
type InsiderFact = Extract<BriefingFact, { kind: "insider" }>;
type LinkedFact = Extract<BriefingFact, { kind: "linked_report" }>;
type GuidanceResultFact = Extract<BriefingFact, { kind: "guidance_result" }>;
type GuidanceFact = GuidanceResultFact | Extract<BriefingFact, { kind: "guidance_revision" }>;

const RED_FLAG_KEYS: Record<RedFlagFact["flag"], BriefingKey> = {
  restatement: "briefing.facts.restatement",
  auditor_change: "briefing.facts.auditorChange",
  auditor_name: "briefing.facts.auditorName",
  going_concern: "briefing.facts.goingConcern",
  material_weakness: "briefing.facts.materialWeakness",
  late_filing: "briefing.facts.lateFiling",
};

const INSIDER_KEYS: Record<InsiderFact["event"], BriefingKey> = {
  purchase_cluster: "briefing.facts.insider.purchaseCluster",
  sale_cluster: "briefing.facts.insider.saleCluster",
  large_purchase: "briefing.facts.insider.largePurchase",
  unplanned_sale: "briefing.facts.insider.unplannedSale",
  large_unplanned_sale: "briefing.facts.insider.largeUnplannedSale",
  activist_13d: "briefing.facts.insider.activist13d",
  activist_13d_amendment: "briefing.facts.insider.activist13dAmendment",
  new_holder_13g: "briefing.facts.insider.newHolder13g",
};

const ROLE_KEYS: Record<NonNullable<InsiderFact["role"]>, BriefingKey> = {
  ceo: "briefing.facts.role.ceo",
  cfo: "briefing.facts.role.cfo",
  officer: "briefing.facts.role.officer",
  director: "briefing.facts.role.director",
  owner10: "briefing.facts.role.owner10",
  other: "briefing.facts.role.other",
};

const RELATION_KEYS: Record<LinkedFact["relation"], BriefingKey> = {
  supplier: "briefing.facts.linked.supplier",
  customer: "briefing.facts.linked.customer",
  competitor: "briefing.facts.linked.competitor",
};

const TIME_KEYS: Partial<Record<LinkedFact["time"], BriefingKey>> = {
  bmo: "briefing.facts.time.bmo",
  amc: "briefing.facts.time.amc",
  dmh: "briefing.facts.time.dmh",
};

const GUIDANCE_METRIC_KEYS: Record<GuidanceFact["metric"], BriefingKey> = {
  revenue: "briefing.facts.guidance.metric.revenue",
  gross_margin: "briefing.facts.guidance.metric.gross_margin",
  operating_expenses: "briefing.facts.guidance.metric.operating_expenses",
  operating_income: "briefing.facts.guidance.metric.operating_income",
  operating_margin: "briefing.facts.guidance.metric.operating_margin",
  eps: "briefing.facts.guidance.metric.eps",
  net_income: "briefing.facts.guidance.metric.net_income",
  tax_rate: "briefing.facts.guidance.metric.tax_rate",
  other_income: "briefing.facts.guidance.metric.other_income",
  ebitda: "briefing.facts.guidance.metric.ebitda",
  capex: "briefing.facts.guidance.metric.capex",
  free_cash_flow: "briefing.facts.guidance.metric.free_cash_flow",
};

const GUIDANCE_BASIS_KEYS: Partial<Record<GuidanceFact["basis"], BriefingKey>> = {
  gaap: "briefing.facts.guidance.basis.gaap",
  non_gaap: "briefing.facts.guidance.basis.non_gaap",
  both: "briefing.facts.guidance.basis.both",
};

const GUIDANCE_RESULT_KEYS: Record<GuidanceResultFact["position"], { range: BriefingKey; point: BriefingKey }> = {
  above: { range: "briefing.facts.guidance.above", point: "briefing.facts.guidance.pointAbove" },
  inside: { range: "briefing.facts.guidance.inside", point: "briefing.facts.guidance.pointInside" },
  below: { range: "briefing.facts.guidance.below", point: "briefing.facts.guidance.pointBelow" },
};

/** "Revenue", "EPS (non-GAAP)": the figure and, when the release labels it, its basis. */
function guidanceMetricText(fact: GuidanceFact, text: BriefingText): string {
  const name = text.t(GUIDANCE_METRIC_KEYS[fact.metric] ?? "briefing.facts.guidance.metric.revenue");
  const basis = GUIDANCE_BASIS_KEYS[fact.basis];
  return basis ? text.t(basis, { metric: name }) : name;
}

/** "Q3 FY2027", "FY2027": the period as the company numbers it. */
function guidancePeriodText(fact: GuidanceFact, text: BriefingText): string {
  return fact.fiscal_quarter === null
    ? text.t("briefing.facts.guidance.period.year", { fy: fact.fiscal_year })
    : text.t("briefing.facts.guidance.period.quarter", { q: fact.fiscal_quarter, fy: fact.fiscal_year });
}

/** A guide as printed: one figure, or "$45.0B to $47.0B". */
function guidanceRangeText(fact: GuidanceFact, low: number, high: number, text: BriefingText): string {
  const lowText = figureText(low, fact.unit, fact.currency, text.locale);
  return low === high ? lowText : text.t("briefing.facts.guidance.range", { low: lowText, high: figureText(high, fact.unit, fact.currency, text.locale) });
}

function guidanceTitle(fact: GuidanceFact, text: BriefingText): string {
  const vars = {
    metric: guidanceMetricText(fact, text),
    period: guidancePeriodText(fact, text),
    guide: guidanceRangeText(fact, fact.low, fact.high, text),
  };
  if (fact.kind === "guidance_result") {
    const keys = GUIDANCE_RESULT_KEYS[fact.position];
    if (!keys) return "";
    return text.t(fact.low === fact.high ? keys.point : keys.range, { ...vars, actual: figureText(fact.actual, fact.unit, fact.currency, text.locale) });
  }
  const prior = guidanceRangeText(fact, fact.prior_low, fact.prior_high, text);
  return text.t(fact.revision === "raised" ? "briefing.facts.guidance.raised" : "briefing.facts.guidance.cut", { ...vars, prior });
}

/** The read-through module's minimum: under it a pair carries its count and no figure. */
const MIN_MEASURED = 3;

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, options);
    } catch {
      format = new Intl.NumberFormat("en-US", options);
    }
    numberFormats.set(key, format);
  }
  return format;
}

/** A figure stated in percent ("18" is 18%), in the reader's language. */
function percentText(value: number, text: BriefingText): string {
  return numberFormat(text.locale, { style: "percent", maximumFractionDigits: 1 }).format(value / 100);
}

/** An insider trade total as filed: "$2.5M". */
function usdText(value: number, text: BriefingText): string {
  return numberFormat(text.locale, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function nextDay(ymd: string): string | null {
  const at = ymdNoonUtc(ymd);
  return at ? new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10) : null;
}

/** "today", "tomorrow", or the weekday and date, on New York's calendar. */
function whenText(date: string, today: string | null, text: BriefingText): string {
  if (today !== null && date === today) return text.t("briefing.facts.when.today");
  if (today !== null && date === nextDay(today)) return text.t("briefing.facts.when.tomorrow");
  return weekdayDateLabel(date, text);
}

function measuredText(fact: LinkedFact, text: BriefingText): string {
  if (fact.sample >= MIN_MEASURED && fact.with_it !== null && fact.avg_abs_move_pct !== null) {
    return text.t("briefing.facts.measured", {
      holding: fact.ticker,
      with: fact.with_it,
      count: fact.sample,
      avg: percentText(fact.avg_abs_move_pct, text),
    });
  }
  if (fact.sample <= 0) return text.t("briefing.facts.measuredNone");
  if (fact.sample === 1) return text.t("briefing.facts.measuredOne");
  return text.t("briefing.facts.measuredFew", { count: fact.sample });
}

/**
 * The one line a fact is shown as: what the record says, in the reader's
 * language. `today` is New York's calendar day, for "reports today".
 */
export function factTitle(fact: BriefingFact, text: BriefingText = ENGLISH, today: string | null = null): string {
  const form = fact.form ?? "";
  switch (fact.kind) {
    case "red_flag":
      return text.t(RED_FLAG_KEYS[fact.flag], { form, name: fact.name ?? "", previous: fact.previous ?? "" });
    case "insider": {
      const role = text.t(ROLE_KEYS[fact.role ?? "other"]);
      const filer = clean(fact.filer) ?? text.t("briefing.facts.insider.filerUnknown");
      const line = text.t(INSIDER_KEYS[fact.event], { count: fact.insiders, role, filer });
      // A 13D or 13G states a stake, not a trade: no value goes beside it.
      const traded = !fact.event.startsWith("activist") && fact.event !== "new_holder_13g";
      return traded && fact.value_usd !== null && fact.value_usd > 0
        ? text.t("briefing.facts.insider.withValue", { text: line, value: usdText(fact.value_usd, text) })
        : line;
    }
    case "linked_report": {
      const time = TIME_KEYS[fact.time];
      const day = whenText(fact.date, today, text);
      const when = time ? text.t("briefing.facts.whenAt", { when: day, time: text.t(time) }) : day;
      const head = text.t(RELATION_KEYS[fact.relation], { counterparty: fact.counterparty, holding: fact.ticker, when });
      return `${head} · ${measuredText(fact, text)}`;
    }
    case "risk_factor":
      return fact.count > 1 ? text.t("briefing.facts.riskNewMany", { count: fact.count, form }) : text.t("briefing.facts.riskNew", { form });
    case "counterparty_named":
      return text.t(fact.role === "customer" ? "briefing.facts.customerNamed" : "briefing.facts.supplierNamed", { name: fact.name, form });
    case "share_change": {
      const vars = {
        name: fact.name,
        pct: percentText(fact.pct, text),
        previous: fact.previous_pct === null ? "" : percentText(fact.previous_pct, text),
      };
      const receivables = fact.basis === "receivables";
      if (fact.previous_pct === null) return text.t(receivables ? "briefing.facts.shareNew.receivables" : "briefing.facts.shareNew.revenue", vars);
      return text.t(receivables ? "briefing.facts.share.receivables" : "briefing.facts.share.revenue", vars);
    }
    case "guidance_result":
    case "guidance_revision":
      return guidanceTitle(fact, text);
    default:
      return "";
  }
}

/**
 * What hovering a fact line says: the filing it rests on and where a click
 * takes the reader. A new risk factor also shows its first heading, verbatim,
 * so the line itself stays one title.
 */
export function factHint(fact: BriefingFact, text: BriefingText = ENGLISH): string {
  const parts: string[] = [];
  const heading = fact.kind === "risk_factor" ? clean(fact.heading) : null;
  if (heading) parts.push(`“${heading}”`);
  if (fact.kind === "linked_report") {
    // The measured line again: the end of the title is what a narrow popup cuts.
    parts.push(measuredText(fact, text));
    if (fact.url) parts.push(text.t("briefing.facts.openLink", { counterparty: fact.counterparty, holding: fact.ticker }));
    return parts.join("\n");
  }
  if (fact.form) parts.push(text.t("briefing.facts.filed", { form: fact.form, date: weekdayDateLabel(fact.date, text) }));
  if (fact.url) parts.push(text.t("briefing.facts.open"));
  return parts.join("\n");
}

function fromFact(fact: BriefingFact, text: BriefingText, today: string | null): HandoverItem | null {
  const ticker = clean(fact.ticker)?.toUpperCase();
  const summary = clean(factTitle(fact, text, today));
  if (!ticker || !summary) return null;
  return {
    id: `fact:${fact.id}`,
    subject: ticker,
    ticker,
    summary,
    detail: null,
    meaning: null,
    url: clean(fact.url),
    hint: factHint(fact, text) || null,
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

/**
 * "9:04 AM ET", "09:04 ET". The market's clock, labelled, so it reads right
 * from any timezone; in the reader's language and on the reader's 12 or 24
 * hour choice.
 */
export function etTimeLabel(now: Date, text: BriefingText = ENGLISH): string {
  if (!Number.isFinite(now.getTime())) return "";
  const base: Intl.DateTimeFormatOptions = { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" };
  const options = text.clock ? text.clock(base) : base;
  return text.t("briefing.time.et", { time: formatterFor(text.locale, options).format(now) });
}

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "Thu Sep 24" for the New York calendar day `now` falls on: the footer's date before a report has arrived. */
export function etDateLabel(now: Date, text: BriefingText = ENGLISH): string {
  if (!Number.isFinite(now.getTime())) return "";
  const parts = Object.fromEntries(NY_DATE.formatToParts(now).map((p) => [p.type, p.value]));
  return sessionDateLabel(`${parts.year}-${parts.month}-${parts.day}`, text);
}

function nyDateOf(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) return null;
  const parts = Object.fromEntries(NY_DATE.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The footer's date: the report's session, unless the clock is on a day the
 * market does not open, which is shown as itself (`HandoverView.date`).
 */
export function footerDateLabel(report: BriefingReport, now: Date, text: BriefingText = ENGLISH): string {
  const today = nyDateOf(now);
  if (today && !isTradingDay(today)) return sessionDateLabel(today, text);
  return sessionDateLabel(report.window?.target_session_ymd ?? "", text);
}

/** "Thu Sep 24" from a NY calendar date "2026-09-24", in the reader's language; the input unchanged if it will not parse. */
export function sessionDateLabel(ymd: string, text: BriefingText = ENGLISH): string {
  return weekdayDateLabel(ymd, text);
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
export function handoverView(report: BriefingReport, now: Date, masked: boolean, text: BriefingText = ENGLISH): HandoverView {
  const buckets: Record<HandoverKind, HandoverItem[]> = { news: [], earnings: [], filings: [], other: [] };
  const results = (report.overnight?.filings ?? []).filter(isEarningsFiling);
  const reported = new Set(results.map((f) => clean(f.ticker)?.toUpperCase()).filter((t): t is string => !!t));
  const told = new Set<string>();

  for (const story of report.stories ?? []) {
    const item = fromStory(story, text);
    if (!item) continue;
    buckets[kindOf(story, reported)].push(item);
    for (const t of tickersOf(story.tickers)) told.add(t);
  }

  // A bucket with no story falls back to the evidence stories are built from,
  // so a thin night or a model outage still leaves something true on screen.
  if (buckets.news.length === 0) {
    for (const h of report.headlines ?? []) {
      const item = fromHeadline(h, text);
      if (item) buckets.news.push(item);
    }
  }
  // A company that filed results but has no story of its own still belongs
  // under Earnings: that is the one line the reader opened the app for.
  for (const f of results) {
    const item = fromFiling(f, text);
    if (!item || told.has(item.ticker!)) continue;
    told.add(item.ticker!);
    buckets.earnings.push(item);
  }

  // Filings and insiders arrive ranked and capped by the engine; their order
  // is kept as it is, and two names with the same record are two lines.
  const today = nyDateOf(now);
  for (const fact of report.research_facts?.facts ?? []) {
    const item = fromFact(fact, text, today);
    if (item) buckets.filings.push(item);
  }

  const lead = clean(report.narrative?.text);
  const sections: HandoverSection[] = [];
  for (const kind of SECTION_ORDER) {
    const items = (kind === "filings" ? buckets.filings.slice(0, MAX_BRIEFING_FACTS) : dedupe(buckets[kind]).slice(0, ITEMS_PER_SECTION)).map((item) =>
      masking(item, masked),
    );
    if (items.length > 0) sections.push({ kind, title: text.t(SECTION_TITLES[kind]), items });
  }

  return {
    intro: text.t("briefing.handover.intro"),
    lead: lead === null ? null : masked ? maskDollarAmounts(lead) : lead,
    sections,
    time: etTimeLabel(now, text),
    date: footerDateLabel(report, now, text),
    empty: sections.length === 0,
  };
}
