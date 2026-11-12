/**
 * Event detection v0: earnings releases and monthly revenue reports of the
 * watched companies, from EDGAR (8-K item 2.02 and its EX-99.1; a foreign
 * filer's 6-K), with the EPS surprise from Yahoo Finance when it has it.
 *
 * Summaries are built from the documents, never written freely: the EPS
 * line from Yahoo's figures, the revenue and outlook lines quoted from the
 * release. Nothing is filled in that the sources do not say.
 */

import type { RippleEvent, Source } from "@falcon/ripple";
import { NAMES } from "./universe.ts";
import { cikForTicker, documentText, filingDocuments, recentFilings, type Filing } from "./sec.ts";
import { clip, sentences } from "./text.ts";
import { quarterReportedOn, yahooEarnings, yahooQuoteUrl, type EarningsQuarterRead } from "./yahoo.ts";

export type DetectedEvent = {
  event: RippleEvent;
  /** Size of the news for ranking: EPS surprise % or year-over-year revenue change %. */
  magnitudePct: number | null;
  /** The company is being acquired: its own results move its price little. */
  pendingAcquisition: boolean;
  filing: Filing;
  /**
   * What kind of event this is for the history of past ones (src/history.ts),
   * and which way it went: the sign of the EPS surprise, or of the change in
   * monthly revenue from a year earlier. Null for kinds history does not cover
   * yet (a 6-K quarterly release), or a sign the sources do not give.
   */
  basis: EventBasis | null;
};

export type EventBasis = {
  /** "earnings": an 8-K item 2.02 release; "monthly_revenue": a Taiwan monthly revenue 6-K. */
  kind: "earnings" | "monthly_revenue";
  sign: Sign | null;
};

/** Which way a number went: 1 above (a beat, growth), -1 below, 0 exactly level. */
export type Sign = 1 | -1 | 0;

export function signOf(n: number | null | undefined): Sign | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

export type ReleaseRead = {
  title: string;
  revenue: string | null;
  outlook: string | null;
  guidanceSuspended: string | null;
  pendingAcquisition: string | null;
};

const MONEY = /\$\s?\d[\d,]*(\.\d+)?\s?(million|billion|thousand)?/i;
const BOILERPLATE = /forward-looking|Private Securities|safe harbor|non-GAAP financial measures? (is|are) defined|reconcil|conference call|webcast|presentation|investor relations/i;

function cleanLine(s: string): string {
  return s.replace(/^[•●▪‣\-*\s]+/, "").replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** Bullet glyphs on their own line belong to the line after them. */
function joinBullets(text: string): string {
  return text.replace(/(^|\n)[•●▪]\s*\n/g, "$1• ");
}

/**
 * The lines of an earnings release a summary needs: the revenue headline,
 * the outlook for the next period, and whether guidance is suspended or the
 * company is being acquired. Pure.
 */
export function readRelease(rawText: string): ReleaseRead {
  const text = joinBullets(rawText);
  const lines = text.split("\n").map(cleanLine).filter(Boolean);
  const titleAt = lines.findIndex((l) => /(reports?|announces?|results)/i.test(l) && l.length < 160 && !/^EX-|^EXHIBIT/i.test(l));
  let title = titleAt >= 0 ? lines[titleAt]! : (lines[0] ?? "");
  // A headline broken over two lines ("... RESULTS FOR" / "SECOND QUARTER ...").
  if (titleAt >= 0 && /\b(for|of|the|and|to|in)$/i.test(title) && lines[titleAt + 1]) title = `${title} ${lines[titleAt + 1]}`;
  if (title === title.toUpperCase()) title = title.toLowerCase().replace(/(^|\s)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  const all = sentences(text).map(cleanLine);
  const head = all.slice(0, Math.max(40, Math.floor(all.length * 0.35)));

  const revenueScore = (s: string): number => {
    if (!/\b(revenues?|net sales)\b/i.test(s) || !MONEY.test(s) || BOILERPLATE.test(s)) return -1;
    // The revenue figure itself, not a margin "of revenue".
    const stated =
      /\b(revenues?|net sales)\b[^.$]{0,40}\$\s?\d/i.test(s) || /\$\s?[\d,.]+\s?(million|billion)\s+(in |of )?(total )?(revenues?|net sales)/i.test(s);
    if (!stated || /^(EBITDA|gross|operating|net income|non-GAAP|GAAP)\b/i.test(s)) return -1;
    if (/nine months|year-to-date|full[- ]year|fiscal year 20\d\d (revenue|net sales)|first half/i.test(s)) return -1;
    let score = 0;
    if (/%/.test(s)) score += 2;
    if (/(year[- ]over[- ]year|year-ago|from the (same|prior)|compared to|as compared|sequential)/i.test(s)) score += 2;
    if (/(record|quarter)/i.test(s)) score += 1;
    if (s.length > 320) score -= 2;
    return score;
  };
  let revenue: string | null = null;
  let best = 0;
  for (const s of head) {
    const sc = revenueScore(s);
    if (sc > best) {
      best = sc;
      revenue = s;
    }
  }

  let outlook: string | null = null;
  let outlookScore = 2;
  for (const s of all) {
    if (BOILERPLATE.test(s) || /provided on|previously (announced|provided)|was (GAAP |non-GAAP )?(EPS|net sales)/i.test(s)) continue;
    if (!/\b(revenues?|net sales|sales)\b/i.test(s)) continue;
    if (!(MONEY.test(s) || /\d+(\.\d+)?\s?%/.test(s))) continue;
    let score = 0;
    if (/\b(we|company|management|\w+) (expects?|anticipates?)\b|\bexpects? (revenue|net sales)|is expected to be|are expected to be|in the range of|guidance (for|of)\b/i.test(s)) score += 3;
    else if (/\b(expects?|outlook|forecasts?)\b/i.test(s)) score += 1;
    if (/\b(December|March|June|September|fourth|first|second|third|next) (fiscal )?quarter|quarter ending|fiscal (first|second|third|fourth) quarter/i.test(s)) score += 2;
    if (/(exceed\w*|above|below|beat|high end of|low end of)[^.]{0,60}guidance|guidance[^.]{0,20}\b(was|were)\b/i.test(s)) score -= 4;
    if (s.length > 360) score -= 1;
    if (score > outlookScore) {
      outlookScore = score;
      outlook = s;
    }
  }
  // A table under "the Company expects the following:" (Onto and others).
  if (!outlook) {
    const at = lines.findIndex((l) => /expects the following/i.test(l));
    if (at >= 0) {
      const row = lines.slice(at + 1, at + 12).find((l) => /^revenue/i.test(l) && MONEY.test(l));
      if (row) outlook = `${lines[at]} ${row}`;
    }
  }
  const suspended = all.find((s) => /suspend\w* (providing )?(forward-looking )?(financial )?guidance|not (be )?providing (financial )?guidance/i.test(s)) ?? null;
  const acquisition =
    all.find(
      (s) =>
        /(pending|proposed|announced) (acquisition|merger|transaction)|definitive agreement under which|agreed to acquire|to be acquired by/i.test(s) &&
        !/Private Securities|safe harbor/i.test(s),
    ) ?? null;
  return {
    title: cleanLine(title),
    revenue: revenue ? clip(revenue, 300) : null,
    outlook: outlook ? clip(outlook, 300) : null,
    guidanceSuspended: suspended ? clip(suspended, 240) : null,
    pendingAcquisition: acquisition ? clip(acquisition, 300) : null,
  };
}

export type MonthlyRevenue = {
  month: string;
  /** The release's own sentence when it has one (TSMC writes one). */
  sentence: string | null;
  yoyPct: number | null;
  momPct: number | null;
};

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

/** A Taiwan-style monthly revenue report (TSMC, ASE, UMC). Pure. */
export function readMonthlyRevenue(text: string): MonthlyRevenue | null {
  const flat = text.replace(/\s+/g, " ");
  // TSMC: "revenue for October 2026 was approximately NT$586.89 billion, an increase of 14.7 percent from September 2026 and an increase of 59.7 percent from October 2025."
  // Until early 2022: "revenues for January 2022 were approximately ...".
  const tsmc = new RegExp(
    `revenues? for (${MONTHS}) (\\d{4}) (?:was|were) approximately (NT\\$[\\d,.]+ (?:billion|million)), an? (increase|decrease) of ([\\d.]+) percent from (${MONTHS}) \\d{4} and an? (increase|decrease) of ([\\d.]+) percent from (${MONTHS}) \\d{4}\\.`,
    "i",
  ).exec(flat);
  if (tsmc) {
    const sign = (w: string) => (/decrease/i.test(w) ? -1 : 1);
    return {
      month: `${tsmc[1]} ${tsmc[2]}`,
      sentence: tsmc[0].replace(/^revenue/, "Revenue"),
      momPct: sign(tsmc[4]!) * Number(tsmc[5]),
      yoyPct: sign(tsmc[7]!) * Number(tsmc[8]),
    };
  }
  // ASE: a "Net Revenues" row of three NT$ figures, then sequential and year-over-year changes.
  const ase = /announces its unaudited consolidated net revenues for (\w+) (\d{4})[\s\S]*?Net Revenues \|? ?([\d,]+) \|? ?([\d,]+) \|? ?([\d,]+) \|? ?([+-]?[\d.]+)% \|? ?([+-]?[\d.]+)%/i.exec(flat);
  if (ase) {
    const month = `${ase[1]![0]!.toUpperCase()}${ase[1]!.slice(1).toLowerCase()} ${ase[2]}`;
    return {
      month,
      sentence: `Consolidated net revenues for ${month} were NT$${ase[3]} million, ${ase[6]}% from the month before and ${ase[7]}% from a year earlier.`,
      momPct: Number(ase[6]),
      yoyPct: Number(ase[7]),
    };
  }
  // UMC: "Sales volume ... October Net sales 25,197,532 21,294,974 3,902,558 18.33%"
  const umc = new RegExp(`for the period of (${MONTHS}) (\\d{4})[\\s\\S]*?(${MONTHS}) \\|? ?Net sales \\|? ?([\\d,]+) \\|? ?([\\d,]+) \\|? ?(-?[\\d,]+) \\|? ?(-?[\\d.]+)%`, "i").exec(flat);
  if (umc) {
    return {
      month: `${umc[1]} ${umc[2]}`,
      sentence: `Net sales for ${umc[1]} ${umc[2]} were NT$${umc[4]} thousand against NT$${umc[5]} thousand a year earlier, a change of ${umc[7]}%.`,
      momPct: null,
      yoyPct: Number(umc[7]),
    };
  }
  return null;
}

const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The Taiwan date a monthly revenue release went out, from its own text:
 * TSMC's and ASE's dateline ("HSINCHU, Taiwan, R.O.C. - Nov. 10, 2023 -",
 * "Taipei, Taiwan, R.O.C., November 10, 2026 -") or UMC's "Announcement on
 * 2026/11/05: October Revenue". The 6-K can reach EDGAR a business day or
 * more later. Null when the text gives none. Pure.
 */
export function revenueReleaseDate(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  const umc = /Announcement on (\d{4})\/(\d{2})\/(\d{2}): [A-Za-z]+ (?:revenue|net sales|sales)/i.exec(flat);
  if (umc) return `${umc[1]}-${umc[2]}-${umc[3]}`;
  const dl = /(?:Hsinchu|Taipei|Taiwan),? (?:Taiwan,? )?R\.?O\.?C\.?\s*[,\-–—]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(flat);
  if (!dl) return null;
  const month = MONTH_ABBR.indexOf(dl[1]!.toLowerCase()) + 1;
  const day = Number(dl[2]);
  if (month < 1 || day < 1 || day > 31) return null;
  return `${dl[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fmtUsd(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${Math.abs(n).toFixed(1)}%`;
}

function periodLabel(q: EarningsQuarterRead): string {
  if (!q.periodEnd) return q.fiscalQuarter;
  const d = new Date(`${q.periodEnd}T12:00:00Z`);
  return `the quarter ended ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

/** "NVIDIA reported EPS of $1.30 for the quarter ended ..., 4.2% above the $1.25 consensus." Pure. */
export function epsSentence(name: string, q: EarningsQuarterRead): string | null {
  if (q.epsActual === null || q.epsEstimate === null || q.surprisePct === null) return null;
  const side = q.surprisePct > 0 ? "above" : q.surprisePct < 0 ? "below" : "in line with";
  const pct = q.surprisePct === 0 ? "" : `${fmtPct(q.surprisePct)} `;
  return `${name} reported EPS of ${fmtUsd(q.epsActual)} for ${periodLabel(q)}, ${pct}${side} the ${fmtUsd(q.epsEstimate)} consensus estimate.`;
}

function nyDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

async function earningsEvent(ticker: string, f: Filing): Promise<DetectedEvent | null> {
  const docs = await filingDocuments(f);
  const ex = docs.find((d) => /^EX-99(\.1)?$/i.test(d.type) && /\.html?$/i.test(d.url)) ?? docs.find((d) => /^EX-99/i.test(d.type) && /\.html?$/i.test(d.url));
  const docUrl = ex?.url ?? f.url;
  const text = await documentText(docUrl);
  if (f.form === "6-K" && !/(financial results|reports? (results|.*quarter)|quarter(ly)? results|results for the (first|second|third|fourth))/i.test(text.slice(0, 3000))) {
    return null;
  }
  const release = readRelease(text);
  const name = NAMES[ticker] ?? f.companyName;
  const occurredAt = f.acceptedAt ?? `${f.filedAt}T12:00:00.000Z`;
  const quarters = await yahooEarnings(ticker);
  const q = quarterReportedOn(quarters, nyDate(occurredAt));
  const eps = q ? epsSentence(name, q) : null;

  const summaryParts = [eps, release.revenue ? `The release says: "${release.revenue.replace(/"/g, "'")}"` : null].filter(Boolean) as string[];
  if (summaryParts.length === 0) return null;
  const facts = [...new Set([release.outlook, release.guidanceSuspended, release.pendingAcquisition].filter((x): x is string => Boolean(x)))];
  const surprise = q?.surprisePct ?? null;
  const headline =
    surprise !== null
      ? `${name} quarterly EPS ${surprise === 0 ? "in line with" : `${fmtPct(surprise)} ${surprise > 0 ? "above" : "below"}`} consensus`
      : `${name} reports quarterly results`;
  const sources: Source[] = [];
  if (q && surprise !== null) {
    sources.push({ title: `${name} earnings estimates and actuals`, url: yahooQuoteUrl(ticker), publisher: "Yahoo Finance" });
  }
  const event: RippleEvent = {
    id: `${ticker}-${f.accession}`,
    ticker,
    companyName: name,
    kind: surprise !== null ? "earnings_surprise" : release.outlook ? "guidance" : "filing",
    headline,
    occurredAt,
    summary: summaryParts.join(" "),
    source: {
      title: `${f.form}${ex ? `, ${ex.type}` : ""}: ${clip(release.title || "Earnings release", 120)}`,
      url: docUrl,
      publisher: "SEC EDGAR",
      publishedAt: occurredAt,
    },
    ...(facts.length ? { facts } : {}),
    ...(sources.length ? { sources } : {}),
  };
  const basis: EventBasis | null = f.form === "8-K" ? { kind: "earnings", sign: signOf(surprise) } : null;
  return { event, magnitudePct: surprise, pendingAcquisition: Boolean(release.pendingAcquisition), filing: f, basis };
}

/**
 * The monthly revenue report a 6-K carries, the document it is in, and the
 * Taiwan date it went out when the text says; null when it is not one.
 */
export async function filingMonthlyRevenue(
  f: Pick<Filing, "indexUrl">,
): Promise<{ report: MonthlyRevenue; url: string; releasedOn: string | null } | null> {
  const docs = await filingDocuments(f);
  for (const d of docs.filter((x) => /\.html?$/i.test(x.url))) {
    const text = await documentText(d.url);
    const report = readMonthlyRevenue(text);
    if (report && report.yoyPct !== null && report.sentence) return { report, url: d.url, releasedOn: revenueReleaseDate(text) };
  }
  return null;
}

async function monthlyRevenueEvent(ticker: string, f: Filing): Promise<DetectedEvent | null> {
  const found = await filingMonthlyRevenue(f);
  if (!found) return null;
  const { report: m, url } = found;
  const name = NAMES[ticker] ?? f.companyName;
  const occurredAt = f.acceptedAt ?? `${f.filedAt}T12:00:00.000Z`;
  const yoy = m.yoyPct!;
  const dir = yoy >= 0 ? "up" : "down";
  const event: RippleEvent = {
    id: `${ticker}-${f.accession}`,
    ticker,
    companyName: name,
    kind: "filing",
    headline: `${name} ${m.month.split(" ")[0]} revenue ${dir} ${fmtPct(yoy)} from a year earlier`,
    occurredAt,
    summary: `${name} filed its monthly revenue report for ${m.month}. ${m.sentence}`,
    source: { title: `6-K: ${name} ${m.month} revenue report`, url, publisher: "SEC EDGAR", publishedAt: occurredAt },
  };
  return { event, magnitudePct: yoy, pendingAcquisition: false, filing: f, basis: { kind: "monthly_revenue", sign: signOf(yoy) } };
}

export type DetectOptions = {
  tickers: string[];
  sinceMs: number;
  untilMs: number;
  log?: (line: string) => void;
  /** Filled with what could not be read (a ticker, a filing); the run goes on without it. */
  problems?: SourceProblem[];
};

export type SourceProblem = {
  ticker: string;
  /** "ticker": the company could not be checked at all; "filing": one filing could not be read. */
  scope: "ticker" | "filing";
  message: string;
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Events of the watched companies accepted by EDGAR inside the window,
 * newest first. A company or filing that cannot be read is logged, added to
 * `problems` and skipped; it never stops the others.
 */
export async function detectEvents(opts: DetectOptions): Promise<DetectedEvent[]> {
  const out: DetectedEvent[] = [];
  const log = opts.log ?? (() => undefined);
  const problem = (p: SourceProblem) => {
    opts.problems?.push(p);
    log(`  ${p.ticker}: ${p.message}`);
  };
  for (const ticker of opts.tickers) {
    let cik: string | null;
    try {
      cik = await cikForTicker(ticker);
    } catch (err) {
      problem({ ticker, scope: "ticker", message: `SEC ticker list unreadable (${errText(err)})` });
      continue;
    }
    if (!cik) {
      log(`  ${ticker}: not in SEC's ticker list, skipped`);
      continue;
    }
    let filings: Filing[];
    try {
      filings = await recentFilings(cik);
    } catch (err) {
      problem({ ticker, scope: "ticker", message: `submissions unreadable (${errText(err)})` });
      continue;
    }
    for (const f of filings) {
      const at = Date.parse(f.acceptedAt ?? `${f.filedAt}T12:00:00Z`);
      if (!(at >= opts.sinceMs && at <= opts.untilMs)) continue;
      try {
        let ev: DetectedEvent | null = null;
        if (f.form === "8-K" && f.items.includes("2.02")) ev = await earningsEvent(ticker, f);
        else if (f.form === "6-K") ev = (await monthlyRevenueEvent(ticker, f)) ?? (await earningsEvent(ticker, f));
        if (ev) {
          out.push(ev);
          log(`  ${ticker}: ${ev.event.headline} (${f.form} ${f.filedAt})`);
        }
      } catch (err) {
        problem({ ticker, scope: "filing", message: `${f.form} ${f.accession} unreadable (${errText(err)})` });
      }
    }
  }
  return out.sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt));
}
