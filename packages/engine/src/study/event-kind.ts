/**
 * What kind of Item 2.02 filing an earnings event is (historical_events
 * event_kind / kind_reason). Not every 8-K under Item 2.02 ("Results of
 * Operations and Financial Condition") is a quarterly earnings release:
 * Tesla files its quarterly production and delivery numbers under it,
 * companies pre-announce preliminary results or revise guidance, retailers
 * file monthly sales, and 8-K/As re-file exhibits.
 *
 * Evidence, cheapest first:
 *   1. Timing. A reporting window runs from a quarter's end (the 10-Q / 10-K
 *      period) to that report's filing date (+3 days). A filing that is the only
 *      Item 2.02 8-K in its window is the earnings release.
 *   2. Text, for filings that share a window, fall outside every window, or are
 *      amendments: the 8-K's own Item 2.02 paragraph and exhibit list
 *      ("... released its fourth quarter vehicle production and deliveries"),
 *      and when that says nothing, the first lines of exhibit 99.
 *   3. Within a shared window, the filing whose text says earnings is the
 *      earnings release; without one, the last results-like filing before the
 *      report is.
 *
 * Pure: no fs, no network, no clock.
 */

export type EventKind = "earnings" | "preliminary" | "operational_update" | "other";
export const EVENT_KINDS: readonly EventKind[] = ["earnings", "preliminary", "operational_update", "other"];

/** What the text alone says; null when it says nothing telling. */
export type TextRead = { kind: EventKind; cue: string } | null;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[‐-―]/g, "-")
    .replace(/\s*&(?:amp;)?\s*/g, " and ")
    .replace(/\b([ap])\.\s?m\b\.?/g, "$1m")
    .replace(/\s+/g, " ");

/**
 * The part of an 8-K's text that describes its Item 2.02 and its exhibits:
 * from "Item 2.02" to the signature block (the cover page and the other items
 * before it are left out). The whole text when no Item 2.02 heading is found.
 */
export function item202Section(text: string, max = 3000): string {
  const t = text.replace(/\s+/g, " ");
  const re = /item\s*2\s*\.\s*02/gi;
  let start = -1;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    // Skip a cover-page checklist mention; the heading is followed by its title.
    if (/^\W{0,6}results\s+of\s+operations/i.test(t.slice(m.index + m[0].length, m.index + m[0].length + 40))) {
      start = m.index;
      break;
    }
    if (start < 0) start = m.index;
  }
  if (start < 0) return t.slice(0, max);
  const rest = t.slice(start);
  const end = rest.search(/\bsignatures?\b(?!\s+(of|by|on|to)\b)/i);
  return (end > 200 ? rest.slice(0, end) : rest).slice(0, max);
}

const Q = String.raw`(?:first|second|third|fourth|1st|2nd|3rd|4th|q[1-4])`;

/** Earnings-release wording: results for a quarter or year. */
const EARNINGS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\bresults (?:of operations )?for (?:its |the |our )?(?:fiscal )?(?:(?:19|20)\d\d )?(?:fiscal )?${Q} (?:fiscal )?quarter`), "results for the quarter"],
  [new RegExp(String.raw`\b${Q}[- ]quarter (?:(?:and|&) (?:full|fiscal|year-end|full-year)[- ]?(?:year )?)?(?:fiscal )?(?:(?:19|20)\d\d )?(?:financial |operating |earnings )?(?:results|earnings)\b`), "quarter results"],
  [new RegExp(String.raw`\b(?:fiscal )?(?:(?:19|20)\d\d )?${Q} (?:fiscal )?(?:(?:19|20)\d\d )?(?:financial |operating )?(?:results|earnings)\b`), "quarter results"],
  [/\b(?:results|earnings)[^.]{0,60}\b(?:quarter|three months|six months|nine months|twelve months|fiscal year|year) ended\b/, "results for the period ended"],
  [/\b(?:quarter|three months|fiscal year|year)[- ]end(?:ed|ing)?\b[^.]{0,60}\b(?:results|earnings)\b/, "results for the period ended"],
  [/\b(?:full[- ]year|fiscal year|year[- ]end|annual) (?:(?:19|20)\d\d )?(?:financial )?(?:results|earnings)\b/, "annual results"],
  [/\b(?:quarterly|interim) (?:financial )?(?:results|earnings)\b/, "quarterly results"],
  [/\bearnings (?:press )?release\b/, "earnings release"],
  // Not "... our reported financial results" (non-GAAP boilerplate).
  [/(?<!\bour )\b(?:announc|report|releas|issu)\w* (?:its |the |their )?(?:(?:unaudited|consolidated) )*(?:financial |operating )?results\b/, "announced results"],
];

/** Production, deliveries, monthly sales and traffic, operating statistics. */
const OPERATIONAL: Array<[RegExp, string]> = [
  [/\b(?:vehicle )?production(?:,| and) deliver(?:y|ies)\b/, "production and deliveries"],
  [/\bdeliver(?:y|ies) (?:and production|numbers|results|report|figures|were|totaled)\b/, "deliveries"],
  [/\bdeliver(?:s|ed) (?:approximately |about |over |nearly )?[\d,]+ (?:vehicles|cars|units|aircraft|airplanes|homes)\b/, "deliveries"],
  [/\b(?:produced|production) (?:of )?[^.]{0,40}\band delivered\b/, "production and deliveries"],
  [/\b(?:monthly|month-end) (?:sales|revenues?|traffic|operating|operational|production)\b/, "monthly figures"],
  [/\b(?:sales|revenues?|traffic|comparable sales|comp sales) (?:results )?for the (?:four|five|4|5)[- ]week\b/, "monthly sales"],
  [/\b(?:net |comparable |comp |total )?(?:sales|revenues?|traffic) (?:results )?for the (?:month|period) (?:of|ended)\b/, "monthly sales"],
  [/\bsales\b(?:[^.]|\.\d){0,80}\bfor the (?:retail |fiscal )?month\b/, "monthly sales"],
  [/\bsales\b(?:[^.]|\.\d){0,80}\b(?:four|five|4|5)[- ]weeks?\b/, "monthly sales"],
  [/\b(?:passenger |air )?traffic (?:results|statistics|figures|report)\b/, "traffic"],
  [/\boperating statistics\b/, "operating statistics"],
  [/\b(?:operational|operations|operating|production|drilling) update\b/, "operational update"],
];

/** Preliminary results, pre-announcements, guidance changes outside a results release. */
const PRELIMINARY: Array<[RegExp, string]> = [
  [/\bpreliminary\b[^.]{0,80}\b(?:results|revenues?|sales|earnings|financial (?:information|data|results)|estimates?|net income|eps|loss|cash)\b/, "preliminary results"],
  [/\b(?:expectation|expects?|expected|anticipates?) that (?:its |the company's )?(?:(?:adjusted|diluted|reported) )*(?:earnings|eps|revenues?|net sales|sales|results)\b/, "pre-announcement"],
  [/\bcomment\w* on (?:its |the )?(?:quarterly |preliminary |expected )?(?:financial|results|performance)\b/, "pre-announcement"],
  [/\b(?:selected|certain) (?:unaudited )?preliminary\b/, "preliminary results"],
  [/\bresults (?:are|is|remain) preliminary\b/, "preliminary results"],
  [/\b(?:expects|expected|anticipates) to report\b/, "expects to report"],
  [/\bestimated (?:unaudited )?(?:results|revenues?|sales|earnings)\b/, "estimated results"],
  [/\bpre-?announce/, "pre-announcement"],
  [/\bearnings considerations\b/, "pre-announcement"],
  [/\b(?:items?|charges?|factors?|impairments?)\b[^.]{0,80}\b(?:to be|expected to be|will be) (?:included|reflected|recorded) in\b/, "pre-announcement"],
  [/\bexpected to (?:negatively |positively |adversely |favorably )?(?:impact|affect)\b[^.]{0,60}\b(?:quarter|results)\b/, "pre-announcement"],
  [/\b(?:updat|revis|rais|lower|reaffirm|reiterat|withdr[ae]w|cut)\w* (?:its |the |our )?(?:previously (?:issued|announced|provided) )?(?:[a-z0-9-]+ ){0,6}?(?:guidance|outlook|forecast)\b/, "guidance update"],
  [/\b(?:announc|provid|issu|initiat|introduc)\w* (?:its |the |our )?(?:(?:19|20)\d\d |fiscal (?:year )?(?:(?:19|20)\d\d )?|full[- ]year |annual )+(?:financial )?(?:guidance|outlook)\b/, "guidance update"],
];

/** Presentations, investor days, recasts: results-related but no new period. */
const OTHER: Array<[RegExp, string]> = [
  [/\binvestor (?:day|conference|presentation|meeting)\b/, "investor day / presentation"],
  [/\b(?:analyst|investor) (?:day|meeting)\b/, "investor day / presentation"],
  [/\b(?:recast|retrospectively (?:adjusted|revised)|revised segment|re-?segment)/, "recast of past results"],
  [/\b(?:presentation|slides) (?:at|to be (?:used|presented|given) at|for) (?:the |a |an )?[^.]{0,60}\bconference\b/, "conference presentation"],
  [/\bconference\b(?! call)/, "conference presentation"],
  [/\b(?:investor|roadshow|corporate|company) presentation\b/, "investor day / presentation"],
  [/\b(?:financial|business) update\b/, "business update"],
  [/\bfireside chat\b|\bmeet(?:ing)? with investors\b/, "investor meetings"],
];

function first(text: string, rules: Array<[RegExp, string]>): string | null {
  for (const [re, cue] of rules) if (re.test(text)) return cue;
  return null;
}

/** Clauses about results still to come ("Tesla will post its financial results ...", "will release its earnings on ..."), cut from "will" to the end of the sentence. */
const FUTURE = /\b(?:will|plans? to|expects? to|intends? to|scheduled to)\s+(?:\w+\s+){0,2}?(?:post|announc|report|releas|host|discuss|issu|hold|present)\w*\b[^.]*|\bto (?:discuss|review) (?:the |its |their )?[^.]*/g;

/** "Date for Financial Results & Webcast for First Quarter 2022", "release date": a date, not results. */
const RESULTS_DATE = /\b(?:dates? (?:for|of)|release date|timing (?:for|of)|what ?:)[^.]{0,80}|\bin addition to (?:post|announc|report|releas)\w*[^,.]*|\b(?:financial )?(?:results|earnings) (?:and (?:q and a |conference )?)?(?:conference call|call|webcast)\b/g;

function withoutFuture(t: string): string {
  return t.replace(FUTURE, " ").replace(RESULTS_DATE, " ");
}

/** Results wording too loose to beat production / monthly-sales wording ("... not an indicator of quarterly financial results"). */
const WEAK_EARNINGS = new Set(["announced results", "quarterly results"]);
const STRONG_PRELIM = new Set(["preliminary results", "expects to report", "estimated results", "pre-announcement"]);

/**
 * What a filing's text says it is. `text` is the 8-K's Item 2.02 section and
 * exhibit list (item202Section) or an exhibit 99's first lines. Precedence:
 *   1. preliminary / estimated results / "expects to report" (a pre-announcement
 *      names the quarter too);
 *   2. results named for a quarter or year, read without sentences about
 *      results still to come ("Tesla will post its financial results for the
 *      third quarter ..." in a deliveries release) -> earnings, even beside
 *      monthly sales (a retailer's quarterly release quotes its month);
 *   3. production / deliveries, monthly sales or traffic -> operational_update;
 *   4. looser results wording ("announced its results") -> earnings; results
 *      named only as still to come ("will release its results on ...") -> other;
 *   5. guidance changes -> preliminary; presentations, recasts -> other.
 */
export function readKindText(text: string | null | undefined): TextRead {
  if (!text) return null;
  const t = norm(text);
  const preliminary = first(t, PRELIMINARY);
  if (preliminary && STRONG_PRELIM.has(preliminary)) return { kind: "preliminary", cue: preliminary };
  const earnings = first(withoutFuture(t), EARNINGS);
  if (earnings && !WEAK_EARNINGS.has(earnings)) return { kind: "earnings", cue: earnings };
  const operational = first(t, OPERATIONAL);
  if (operational) return { kind: "operational_update", cue: operational };
  if (earnings) return { kind: "earnings", cue: earnings };
  // Results named only as still to come: a date announcement.
  if (first(t, EARNINGS)) return { kind: "other", cue: "results date announcement" };
  if (preliminary) return { kind: "preliminary", cue: preliminary };
  const other = first(t, OTHER);
  if (other) return { kind: "other", cue: other };
  return null;
}

/* ------------------------------------------------------------------ windows */

export type PeriodicReport = { form: string; filed: string; period: string };

/** 10-Q / 10-K and their transition forms: the reports whose results a release announces. */
export function isPeriodicForm(form: string | null | undefined): boolean {
  return form === "10-Q" || form === "10-K" || form === "10-KT" || form === "10-QT" || form === "10-K405";
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Days after a 10-Q / 10-K a release still belongs to its window (some companies file the report first). */
export const WINDOW_GRACE_DAYS = 10;
/** Earnings-worded filings this close together are one release and its companions (slides, supplement). */
export const COMPANION_DAYS = 3;

/**
 * The reporting window a filing date falls in: the first periodic report
 * (by filing date) whose period ended before the date and that was filed no
 * more than WINDOW_GRACE_DAYS before it. Null outside every window.
 */
export function reportingWindow(filed: string, reports: readonly PeriodicReport[]): PeriodicReport | null {
  let best: PeriodicReport | null = null;
  for (const r of reports) {
    if (!r.period || !(r.period < filed) || !(filed <= addDays(r.filed, WINDOW_GRACE_DAYS))) continue;
    if (!best || r.filed < best.filed) best = r;
  }
  return best;
}

export type KindInput = {
  accession: string;
  form: string;
  /** EDGAR filing date (New York), YYYY-MM-DD. */
  filed: string;
  /** What the 8-K's text says (readKindText), undefined when not read. */
  text?: TextRead;
};

export type KindOut = { kind: EventKind; reason: string };

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Filings that need their text read: amendments, filings sharing a window, filings outside every window. */
export function needsText(filings: readonly KindInput[], reports: readonly PeriodicReport[]): Set<string> {
  const out = new Set<string>();
  const groups = new Map<string, KindInput[]>();
  for (const f of filings) {
    if (f.form !== "8-K") {
      out.add(f.accession);
      continue;
    }
    const w = reportingWindow(f.filed, reports);
    if (!w) {
      out.add(f.accession);
      continue;
    }
    const k = `${w.form}|${w.filed}|${w.period}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  for (const g of groups.values()) if (g.length > 1) for (const f of g) out.add(f.accession);
  return out;
}

/**
 * Event kinds for one company's Item 2.02 filings (each accession once).
 * `reports` are its 10-Q / 10-K filings. Pure.
 */
export function classifyCompany(filings: readonly KindInput[], reports: readonly PeriodicReport[]): Map<string, KindOut> {
  const out = new Map<string, KindOut>();
  const label = (r: PeriodicReport) => `${r.form} filed ${r.filed}`;
  const groups = new Map<string, { report: PeriodicReport; items: KindInput[] }>();
  const originals = filings.filter((f) => f.form === "8-K");

  for (const f of filings) {
    if (f.form !== "8-K") {
      // 8-K/A: a re-filed or corrected exhibit; the original carries the reaction.
      const orig = originals.filter((o) => o.filed <= f.filed && daysBetween(o.filed, f.filed) <= 45).sort((a, b) => (a.filed < b.filed ? 1 : -1))[0];
      if (orig) out.set(f.accession, { kind: "other", reason: `amendment (${f.form}) of the Item 2.02 8-K filed ${orig.filed}` });
      else if (f.text) out.set(f.accession, { kind: f.text.kind, reason: `${f.form} with no Item 2.02 8-K in the 45 days before; text: ${f.text.cue}` });
      else out.set(f.accession, { kind: "other", reason: `${f.form} with no Item 2.02 8-K in the 45 days before` });
      continue;
    }
    const w = reportingWindow(f.filed, reports);
    if (!w) {
      if (f.text) out.set(f.accession, { kind: f.text.kind, reason: `outside any reporting window (quarter end to its 10-Q/10-K); text: ${f.text.cue}` });
      else out.set(f.accession, { kind: "other", reason: "outside any reporting window (quarter end to its 10-Q/10-K) and its text names no results" });
      continue;
    }
    const k = `${w.form}|${w.filed}|${w.period}`;
    (groups.get(k) ?? groups.set(k, { report: w, items: [] }).get(k)!).items.push(f);
  }

  // The company's usual lag from quarter end to release (10-K and 10-Q apart), from windows with one release.
  const lags: Record<"annual" | "quarter", number[]> = { annual: [], quarter: [] };
  const span = (r: PeriodicReport) => (/^10-K/.test(r.form) ? "annual" : "quarter");
  for (const { report, items } of groups.values()) if (items.length === 1) lags[span(report)].push(daysBetween(report.period, items[0]!.filed));
  const typicalLag = (r: PeriodicReport): number | null => {
    const own = lags[span(r)];
    const xs = own.length >= 3 ? own : [...lags.annual, ...lags.quarter];
    if (xs.length < 3) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };

  for (const { report, items } of groups.values()) {
    const before = (f: KindInput) => {
      const d = daysBetween(f.filed, report.filed);
      const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
      return d >= 0 ? `${days(d)} before the ${label(report)}` : `${days(-d)} after the ${label(report)}`;
    };
    if (items.length === 1) {
      const f = items[0]!;
      // The only release in the window: the earnings release, whatever it calls itself.
      const note = f.text && f.text.kind !== "earnings" ? `; text says ${f.text.cue}` : "";
      out.set(f.accession, { kind: "earnings", reason: `only Item 2.02 8-K between the ${report.period} quarter end and its ${label(report)} (${before(f)})${note}` });
      continue;
    }
    const sorted = [...items].sort((a, b) => (a.filed < b.filed ? -1 : a.filed > b.filed ? 1 : 0));
    const said = sorted.filter((f) => f.text?.kind === "earnings");
    // No filing says earnings: of those that are not operational updates or other, the one closest to the report is the release.
    const gap = (f: KindInput) => Math.abs(daysBetween(f.filed, report.filed));
    const fallback = said.length
      ? null
      : sorted.filter((f) => f.text?.kind !== "operational_update" && f.text?.kind !== "other").reduce<KindInput | null>((best, f) => (best === null || gap(f) <= gap(best) ? f : best), null);
    // Earnings-worded filings a few days apart are one release and its companions: the first carries the reaction.
    const companionOf = new Map<string, KindInput>();
    let lead: KindInput | null = null;
    for (const f of said) {
      if (lead && daysBetween(lead.filed, f.filed) <= COMPANION_DAYS) companionOf.set(f.accession, lead);
      else lead = f;
    }
    // Several separate filings worded as results (a pre-announcement, the release, a later supplement or final
    // figures): the release is the one whose lag after the quarter end is nearest the company's usual lag;
    // without a usual lag, the first.
    const leads = said.filter((f) => !companionOf.has(f.accession));
    const usual = typicalLag(report);
    const off = (f: KindInput) => Math.abs(daysBetween(report.period, f.filed) - usual!);
    const chosen = (usual === null ? leads[0] : leads.reduce<KindInput | null>((best, f) => (best === null || off(f) < off(best) ? f : best), null)) ?? fallback;
    const timing = usual === null ? "the first" : `the one nearest the company's usual ${usual} days after the quarter end`;
    const earningsSet = new Set(chosen ? [chosen.accession] : []);
    const n = items.length;
    for (const f of sorted) {
      const lead = companionOf.get(f.accession);
      if (lead) {
        out.set(f.accession, { kind: "other", reason: `companion of the earnings release filed ${lead.filed} (text: ${f.text!.cue}); one of ${n} Item 2.02 8-Ks before the ${label(report)}` });
      } else if (earningsSet.has(f.accession)) {
        const why = f.text?.kind === "earnings" ? `text: ${f.text.cue}` : f.text ? `results filing closest to the report (text: ${f.text.cue})` : "filing closest to the report, text names nothing else";
        out.set(f.accession, { kind: "earnings", reason: `${why}; ${n} Item 2.02 8-Ks before the ${label(report)} (${before(f)})` });
      } else if (f.text?.kind === "earnings" && chosen) {
        const early = f.filed < chosen.filed;
        out.set(f.accession, {
          kind: early ? "preliminary" : "other",
          reason: `text: ${f.text.cue}, but the window's release is the one filed ${chosen.filed} (${timing}); this ${early ? "earlier filing reads as a pre-announcement" : "later filing as a re-filing, supplement or final figures"} (one of ${n} Item 2.02 8-Ks before the ${label(report)})`,
        });
      } else if (f.text) {
        out.set(f.accession, { kind: f.text.kind, reason: `text: ${f.text.cue}; one of ${n} Item 2.02 8-Ks before the ${label(report)}` });
      } else {
        out.set(f.accession, { kind: "other", reason: `one of ${n} Item 2.02 8-Ks before the ${label(report)}; its text names no results` });
      }
    }
  }
  return out;
}
