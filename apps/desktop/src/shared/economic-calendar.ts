/**
 * The economic calendar: releases, central bank decisions and speeches for the
 * major economies and the reader's own region, with the provider's forecast,
 * previous and actual figures.
 *
 * Two sources, both free and keyless, read by the main process
 * (main/calendar/economic-calendar.ts):
 *
 *   TradingView's economic calendar (economic-calendar.tradingview.com), the
 *     main one: every country, an importance per row, figures with their unit
 *     and scale. Turkey's CPI and the CBRT decision carry a forecast there.
 *   Forex Factory's weekly file (nfs.faireconomy.media), the fallback: this
 *     week only, the majors only (by currency), forecast and previous but no
 *     actual. Read only when the first one does not answer.
 *
 * Everything here is pure: the parsers that turn either source's row into one
 * `EconomicEvent`, the request check, how a figure is written in the reader's
 * locale, and how a live row is matched to the curated US schedule's own row
 * (`macro:<date>:<CODE>`), so CPI is listed once with its forecast rather
 * than twice. Lives in `shared/` and is compiled for main too: no DOM.
 */

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/** Always asked for: the US, the euro area and its three largest members, and the other major economies. */
export const MAJOR_COUNTRIES = ["US", "EU", "DE", "GB", "FR", "IT", "JP", "CN", "CA", "CH", "AU"] as const;

/**
 * Countries a reader can name as their region (Settings, General). Each has a
 * bundled flag; a country outside the list adds nothing beyond the majors.
 */
export const REGION_CHOICES = [
  "US", "GB", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "CH", "SE", "NO", "DK", "FI", "PL", "PT", "IE", "GR", "CZ", "HU",
  "TR", "RU", "JP", "CN", "HK", "KR", "TW", "IN", "ID", "SG", "AU", "NZ", "CA", "MX", "BR", "ZA", "SA", "AE", "IL",
] as const;

/** Every code a request may name: the region choices and the euro area. */
export const KNOWN_COUNTRIES: ReadonlySet<string> = new Set<string>([...REGION_CHOICES, "EU"]);

/** Where "Important" keeps high-impact releases: the US and the major European economies. */
export const IMPORTANT_COUNTRIES: ReadonlySet<string> = new Set(["US", "EU", "DE", "FR", "IT", "GB"]);

/** The countries the calendar asks for: the majors, and the reader's region when it is another one. */
export function economicCountries(region: string | null | undefined): string[] {
  const out: string[] = [...MAJOR_COUNTRIES];
  const r = typeof region === "string" ? region.toUpperCase() : "";
  if (r && KNOWN_COUNTRIES.has(r) && !out.includes(r)) out.push(r);
  return out;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export type EconomicScale = "K" | "M" | "B" | "T";

export type EconomicSource = "tradingview" | "forexfactory";

export type EconomicEvent = {
  id: string;
  /** ISO 3166 alpha-2, or "EU" for the euro area. */
  country: string;
  /** The provider's English title ("Inflation Rate YoY", "ECB President Lagarde Speech"). */
  title: string;
  /** The instant, UTC ISO. For an all-day row, midnight UTC of its date. */
  at: string;
  /** A row the provider gives no time for (a summit, an election): drawn on its UTC date. */
  allDay: boolean;
  /** 3 high, 2 medium, 1 low. */
  importance: 1 | 2 | 3;
  /** A speech, testimony or press conference: no figures, and "Completed" once its time has passed. */
  speech: boolean;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  /** "%", a currency code ("USD", "TRY"), or a short unit as the provider wrote it; null for a bare number. */
  unit: string | null;
  scale: EconomicScale | null;
  /** "Sep", "Q3", "Oct/09"; null when the provider gives none. */
  period: string | null;
  source: EconomicSource;
};

export type EconomicFigures = Pick<EconomicEvent, "actual" | "forecast" | "previous" | "unit" | "scale">;

export type EconomicCalendarRequest = {
  /** First and last UTC date wanted, "YYYY-MM-DD", both included. */
  from: string;
  to: string;
  countries: string[];
};

export type EconomicSourceStatus = { id: EconomicSource; ok: boolean };

export type EconomicCalendarResult =
  | {
      ok: true;
      events: EconomicEvent[];
      /** Which source answered for the range; a failed one is listed with ok false. */
      sources: EconomicSourceStatus[];
      /** Some of the rows are from an earlier read, kept because the source did not answer now. */
      stale: boolean;
      /** Only this week could be read (the fallback answered, the main source did not). */
      partial: boolean;
    }
  | { ok: false; error: "invalid_request" | "unavailable" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** A request reaches at most this far: the month view's six weeks and a margin. */
export const MAX_REQUEST_DAYS = 70;

function ymdMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`);
}

export function parseEconomicRequest(raw: unknown): EconomicCalendarRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.from !== "string" || typeof r.to !== "string" || !YMD.test(r.from) || !YMD.test(r.to)) return null;
  const from = ymdMs(r.from);
  const to = ymdMs(r.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || (to - from) / 86_400_000 > MAX_REQUEST_DAYS) return null;
  if (!Array.isArray(r.countries)) return null;
  const countries = [...new Set(r.countries.filter((c): c is string => typeof c === "string").map((c) => c.toUpperCase()))].filter((c) =>
    KNOWN_COUNTRIES.has(c),
  );
  if (countries.length === 0 || countries.length > 24) return null;
  return { from: r.from, to: r.to, countries: countries.sort() };
}

// ---------------------------------------------------------------------------
// Speeches
// ---------------------------------------------------------------------------

const SPEECH = /\b(speech|speaks|speak|testimony|testifies|press conference|remarks|hearing|parliamentary|semiannual monetary policy report|lecture|interview)\b/i;

/**
 * A row where someone talks rather than a number comes out. Decided on the
 * title, and only for a row without figures: "Monthly Budget Statement" and
 * "CB Leading Index" carry numbers and are releases.
 */
export function isSpeechTitle(title: string, figures?: Partial<EconomicFigures>): boolean {
  if (figures && (figures.actual != null || figures.forecast != null || figures.previous != null)) return false;
  return SPEECH.test(title);
}

// ---------------------------------------------------------------------------
// TradingView
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₺": "TRY", "₹": "INR", "₩": "KRW", R$: "BRL" };

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/**
 * The provider's unit as one of ours: "%" stays, a currency symbol becomes the
 * row's currency code ("$" on a US row is USD, on a Canadian row CAD), a code
 * stays a code, anything else is kept short as written.
 */
function tvUnit(unit: unknown, currency: unknown): string | null {
  const u = cleanText(unit, 12);
  if (!u) return null;
  if (u === "%") return "%";
  const cur = typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : null;
  if (u in CURRENCY_SYMBOL) {
    // "$" is the provider's word for "the local currency" on some rows (Canada, Australia); the row's own currency says which.
    if (u === "$" && cur && cur !== "USD" && ["CAD", "AUD", "NZD", "SGD", "HKD", "MXN", "TWD"].includes(cur)) return cur;
    return CURRENCY_SYMBOL[u]!;
  }
  if (/^[A-Z]{3}$/.test(u)) return u;
  return u;
}

function tvScale(v: unknown): EconomicScale | null {
  return v === "K" || v === "M" || v === "B" || v === "T" ? v : null;
}

function tvImportance(v: unknown): 1 | 2 | 3 {
  return v === 1 ? 3 : v === 0 ? 2 : 1;
}

/** Midnight UTC with nothing to report: a day-long event the provider has no hour for. */
function midnightUtc(iso: string): boolean {
  return /T00:00(:00(\.0+)?)?Z$/.test(iso);
}

/** One row of TradingView's answer, or null when it cannot be read or is for a country we did not ask about. */
export function parseTradingViewRow(raw: unknown): EconomicEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const country = typeof r.country === "string" ? r.country.toUpperCase() : "";
  if (!KNOWN_COUNTRIES.has(country)) return null;
  const title = cleanText(r.title, 140);
  const id = typeof r.id === "string" || typeof r.id === "number" ? String(r.id).slice(0, 64) : null;
  const at = typeof r.date === "string" ? r.date : null;
  if (!title || !id || !at || !Number.isFinite(Date.parse(at))) return null;
  const figures = { actual: finite(r.actual), forecast: finite(r.forecast), previous: finite(r.previous) };
  const iso = new Date(Date.parse(at)).toISOString();
  const noFigures = figures.actual === null && figures.forecast === null && figures.previous === null;
  return {
    id: `tv:${id}`,
    country,
    title,
    at: iso,
    allDay: noFigures && midnightUtc(iso),
    importance: tvImportance(r.importance),
    speech: isSpeechTitle(title, figures),
    ...figures,
    unit: tvUnit(r.unit, r.currency),
    scale: tvScale(r.scale),
    period: cleanText(r.period, 16),
    source: "tradingview",
  };
}

/** The whole answer: `{ status: "ok", result: [...] }`. Null when it is not that shape. */
export function parseTradingViewAnswer(raw: unknown): EconomicEvent[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.result)) return null;
  const out: EconomicEvent[] = [];
  for (const row of r.result) {
    const e = parseTradingViewRow(row);
    if (e) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forex Factory
// ---------------------------------------------------------------------------

const FF_CURRENCY_COUNTRY: Readonly<Record<string, string>> = {
  USD: "US",
  EUR: "EU",
  GBP: "GB",
  JPY: "JP",
  CNY: "CN",
  CAD: "CA",
  CHF: "CH",
  AUD: "AU",
  NZD: "NZ",
};

/** The euro rows name their member state in the title: "German Final CPI m/m". */
const FF_EURO_MEMBER: ReadonlyArray<[RegExp, string]> = [
  [/^German\b/, "DE"],
  [/^French\b/, "FR"],
  [/^Italian\b/, "IT"],
  [/^Spanish\b/, "ES"],
];

/**
 * "0.6%", "-34.7B", "23.8K", "98.1", "3.80|1.6" (an auction's two numbers,
 * read as the first): the value, its unit and its scale. Null for an empty or
 * unreadable cell.
 */
export function parseFigureText(text: unknown): { value: number; unit: "%" | null; scale: EconomicScale | null } | null {
  if (typeof text !== "string") return null;
  const first = text.split("|")[0]!.trim().replace(/,/g, "");
  const m = /^([+-]?\d+(?:\.\d+)?)\s*(%|K|M|B|T)?$/i.exec(first);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const tail = m[2]?.toUpperCase();
  return { value, unit: tail === "%" ? "%" : null, scale: tail && tail !== "%" ? (tail as EconomicScale) : null };
}

function ffImportance(v: unknown): 1 | 2 | 3 {
  return v === "High" ? 3 : v === "Medium" ? 2 : 1;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

/** One row of the weekly file, or null (a bank holiday, an "All" row, an unreadable one). */
export function parseForexFactoryRow(raw: unknown): EconomicEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.impact === "Holiday") return null;
  const currency = typeof r.country === "string" ? r.country.toUpperCase() : "";
  let country = FF_CURRENCY_COUNTRY[currency];
  const title = cleanText(r.title, 140);
  if (!country || !title || typeof r.date !== "string") return null;
  if (country === "EU") for (const [re, member] of FF_EURO_MEMBER) if (re.test(title)) country = member;
  const ms = Date.parse(r.date);
  if (!Number.isFinite(ms)) return null;
  const forecast = parseFigureText(r.forecast);
  const previous = parseFigureText(r.previous);
  const actual = parseFigureText(r.actual);
  const lead = actual ?? forecast ?? previous;
  const figures = { actual: actual?.value ?? null, forecast: forecast?.value ?? null, previous: previous?.value ?? null };
  const at = new Date(ms).toISOString();
  return {
    id: `ff:${country}:${at}:${slug(title)}`,
    country,
    title,
    at,
    allDay: false,
    importance: ffImportance(r.impact),
    speech: isSpeechTitle(title, figures),
    ...figures,
    unit: lead?.unit ?? null,
    scale: lead?.scale ?? null,
    period: null,
    source: "forexfactory",
  };
}

export function parseForexFactoryAnswer(raw: unknown): EconomicEvent[] | null {
  if (!Array.isArray(raw)) return null;
  const out: EconomicEvent[] = [];
  for (const row of raw) {
    const e = parseForexFactoryRow(row);
    if (e) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Figures in the reader's locale
// ---------------------------------------------------------------------------

const SCALE_FACTOR: Readonly<Record<EconomicScale, number>> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** The decimals the provider wrote, at most three: 0.3 stays 0.3, 29.73 stays 29.73, 4 stays 4. */
function decimalsOf(value: number): number {
  const s = String(Math.abs(value));
  if (s.includes("e")) return 2;
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : Math.min(3, s.length - dot - 1);
}

/** The significant digits the provider wrote, between one and six: 7.271 has four, 199 three, 0.05 one. */
function significantDigits(value: number): number {
  const digits = String(Math.abs(value)).replace(/e.*$/, "").replace(".", "").replace(/^0+/, "");
  return Math.min(6, Math.max(1, digits.length));
}

function format(locale: string, options: Intl.NumberFormatOptions, value: number): string {
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return new Intl.NumberFormat("en-US", options).format(value);
  }
}

/**
 * One figure as the reader writes numbers: "0.3%" / "%0,3", "199K" / "199 B",
 * "-$118.8B" / "-118,8 Mr $". The provider's own precision is kept.
 */
export function formatEconomicFigure(value: number, unit: string | null, scale: EconomicScale | null, locale: string): string {
  const d = decimalsOf(value);
  const digits = { minimumFractionDigits: d, maximumFractionDigits: d };
  if (unit === "%") return format(locale, { style: "percent", ...digits }, value / 100);
  const scaled = scale ? value * SCALE_FACTOR[scale] : value;
  // A scaled figure is written compactly with the digits the provider gave: 1025B is 1.025T, not 1T.
  const compact: Intl.NumberFormatOptions = scale ? { notation: "compact", maximumSignificantDigits: significantDigits(value) } : digits;
  if (unit && /^[A-Z]{3}$/.test(unit)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: unit, currencyDisplay: "narrowSymbol", ...compact }).format(scaled);
    } catch {
      return `${format(locale, compact, scaled)} ${unit}`;
    }
  }
  const number = format(locale, compact, scaled);
  return unit ? `${number} ${unit}` : number;
}

// ---------------------------------------------------------------------------
// The curated US schedule
// ---------------------------------------------------------------------------

/**
 * The curated schedule's codes and the live rows that are the same release:
 * `headline` is the one whose figures the curated row shows, `family` every
 * row printed in the same slot for the same release (core, m/m and y/y).
 */
export const CURATED_RELEASES: Readonly<Record<string, { headline: RegExp; family: RegExp }>> = {
  CPI: { headline: /^Inflation Rate YoY$/i, family: /^(Core )?Inflation Rate|^CPI\b|^Core CPI\b/i },
  PPI: { headline: /^PPI MoM$/i, family: /^(Core )?PPI\b|^Producer Price/i },
  RETAIL: { headline: /^Retail Sales MoM$/i, family: /^Retail Sales\b/i },
  NFP: { headline: /^Non Farm Payrolls$/i, family: /^Non Farm Payrolls$|^Unemployment Rate$|^Average Hourly Earnings|^Participation Rate$|^Average Weekly Hours$|Payrolls$|^U-6/i },
  PCE: { headline: /^Core PCE Price Index MoM$/i, family: /PCE|^Personal (Income|Spending)/i },
  GDP: { headline: /^GDP Growth Rate QoQ/i, family: /^GDP\b|^Core PCE Prices|^Real Consumer Spending/i },
  JOLTS: { headline: /^JOLTs Job Openings$/i, family: /^JOLTs/i },
  HOUSING_STARTS: { headline: /^Housing Starts$/i, family: /^Housing Starts|^Building Permits/i },
  NEW_HOME_SALES: { headline: /^New Home Sales$/i, family: /^New Home Sales/i },
  DURABLES: { headline: /^Durable Goods Orders MoM$/i, family: /^Durable Goods/i },
  UMICH_PRELIM: { headline: /^Michigan Consumer Sentiment/i, family: /^Michigan\b/i },
  UMICH_FINAL: { headline: /^Michigan Consumer Sentiment/i, family: /^Michigan\b/i },
  FOMC: { headline: /^Fed Interest Rate Decision$/i, family: /^Fed Interest Rate Decision$|^FOMC Economic Projections$|^Interest Rate Projection/i },
  FOMC_PRESSER: { headline: /^(Fed|FOMC) Press Conference$/i, family: /^(Fed|FOMC) Press Conference$/i },
};

/** Curated rows that are someone speaking. */
export const CURATED_SPEECH_CODES: ReadonlySet<string> = new Set(["FOMC_PRESSER"]);

/** "macro:2026-10-15:PPI" (or the Calendar tab's "m:macro:..."): the curated code, else null. */
export function curatedCode(id: string): string | null {
  const m = /(?:^|:)macro:\d{4}-\d{2}-\d{2}:([A-Z_]+)$/.exec(id);
  return m ? m[1]! : null;
}

/** How far apart the curated clock and the provider's may be and still be the same release. */
const SAME_SLOT_MS = 45 * 60_000;

export type CuratedMatch = { headline: EconomicEvent | null; family: Set<string> };

/**
 * The live rows that are the curated release `code` at `atMs`: US rows in the
 * same slot whose title is the release's. The headline is the first family
 * row its own pattern names; when no row is the headline (a provider that
 * words it differently) there is none, and the curated row shows no figures.
 */
export function matchCurated(code: string, atMs: number, events: readonly EconomicEvent[]): CuratedMatch {
  const spec = CURATED_RELEASES[code];
  const family = new Set<string>();
  let headline: EconomicEvent | null = null;
  if (!spec || !Number.isFinite(atMs)) return { headline, family };
  for (const e of events) {
    if (e.country !== "US") continue;
    const ms = Date.parse(e.at);
    if (!Number.isFinite(ms) || Math.abs(ms - atMs) > SAME_SLOT_MS) continue;
    if (!spec.family.test(e.title) && !spec.headline.test(e.title)) continue;
    family.add(e.id);
    if (!headline && spec.headline.test(e.title)) headline = e;
  }
  return { headline, family };
}

/**
 * A series is known by its country and title: what its past rows said of the
 * unit and the scale holds for the next one, which the provider often prints
 * bare until it is released.
 */
export function seriesKey(e: Pick<EconomicEvent, "country" | "title">): string {
  return `${e.country}|${e.title.toLowerCase()}`;
}

export type SeriesTraits = { unit: string | null; scale: EconomicScale | null };

/** A rate or a change is a percentage even when the row does not say so. */
const PERCENT_TITLE = /\b(YoY|MoM|QoQ|Rate)\b/i;

/**
 * Rows with neither a unit nor a scale get their series' own from `known`,
 * or "%" when the title names a rate or a change. A row that carries either is
 * left as it is. Returns new rows; the input is not touched.
 */
export function fillTraits(events: readonly EconomicEvent[], known: ReadonlyMap<string, SeriesTraits>): EconomicEvent[] {
  return events.map((e) => {
    if (e.unit !== null || e.scale !== null || e.speech) return e;
    if (e.actual === null && e.forecast === null && e.previous === null) return e;
    const learned = known.get(seriesKey(e));
    if (learned && (learned.unit !== null || learned.scale !== null)) return { ...e, unit: learned.unit, scale: learned.scale };
    return PERCENT_TITLE.test(e.title) ? { ...e, unit: "%" } : e;
  });
}

export function figuresOf(e: EconomicEvent): EconomicFigures | null {
  if (e.actual === null && e.forecast === null && e.previous === null) return null;
  return { actual: e.actual, forecast: e.forecast, previous: e.previous, unit: e.unit, scale: e.scale };
}

/**
 * For the dashboard card: each curated row's figures, by the row's id, from
 * the live rows. Rows without a match are left out.
 */
export function curatedFigures(
  items: ReadonlyArray<{ id: string; at: string | null }>,
  events: readonly EconomicEvent[],
): Map<string, EconomicFigures> {
  const out = new Map<string, EconomicFigures>();
  for (const item of items) {
    const code = curatedCode(item.id);
    if (!code || !item.at) continue;
    const { headline } = matchCurated(code, Date.parse(item.at), events);
    const figures = headline ? figuresOf(headline) : null;
    if (figures) out.set(item.id, figures);
  }
  return out;
}
