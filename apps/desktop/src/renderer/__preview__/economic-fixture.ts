import { MACRO_CALENDAR } from "../../shared/calendar-types";
import {
  parseEconomicRequest,
  parseTradingViewRow,
  type EconomicCalendarResult,
  type EconomicEvent,
} from "../../shared/economic-calendar";
import { REGION_KEY } from "../lib/region";
import { TIME_ZONE_KEY } from "../lib/time-zone";

/**
 * The economic calendar for the calendar harnesses, without a provider: the
 * curated US releases near the scene get their headline row (so the curated
 * rows show forecast and previous figures), and a handful of other countries'
 * releases and speeches are laid around the scene day, shaped as TradingView
 * answers them. A row whose time is behind the scene clock carries its actual.
 *
 *   ?region=TR          the reader's region (Settings, General), kept like a pick
 *   ?tz=Europe/Istanbul the reader's time zone, kept like a pick
 *   ?econ=error         the economic calendar does not answer
 *   ?econ=partial       only the fallback answered
 */

const HEADLINE: Record<string, { title: string; unit?: string; scale?: string; forecast: number; previous: number; actual: number }> = {
  CPI: { title: "Inflation Rate YoY", unit: "%", forecast: 3.6, previous: 3.4, actual: 3.7 },
  PPI: { title: "PPI MoM", unit: "%", forecast: 0.5, previous: 0.4, actual: 1.3 },
  RETAIL: { title: "Retail Sales MoM", unit: "%", forecast: 0.3, previous: 1.2, actual: 0.8 },
  NFP: { title: "Non Farm Payrolls", scale: "K", forecast: 56, previous: 21, actual: 162 },
  PCE: { title: "Core PCE Price Index MoM", unit: "%", forecast: 0.2, previous: 0.1, actual: 0.2 },
  GDP: { title: "GDP Growth Rate QoQ Adv", unit: "%", forecast: 1.8, previous: 2.2, actual: 2.0 },
  JOLTS: { title: "JOLTs Job Openings", scale: "M", forecast: 7.3, previous: 7.182, actual: 7.271 },
  HOUSING_STARTS: { title: "Housing Starts", scale: "M", forecast: 1.31, previous: 1.275, actual: 1.29 },
  NEW_HOME_SALES: { title: "New Home Sales", scale: "M", forecast: 0.62, previous: 0.607, actual: 0.63 },
  DURABLES: { title: "Durable Goods Orders MoM", unit: "%", forecast: 0.5, previous: 1.1, actual: 0.2 },
  UMICH_PRELIM: { title: "Michigan Consumer Sentiment Prel", forecast: 51, previous: 51.7, actual: 52.4 },
  UMICH_FINAL: { title: "Michigan Consumer Sentiment Final", forecast: 52, previous: 52.4, actual: 52.1 },
  FOMC: { title: "Fed Interest Rate Decision", unit: "%", forecast: 4, previous: 4, actual: 4 },
};

/** The instant a New York wall clock names on a date: EDT first, EST when that reads back wrong. */
function nyInstant(ymd: string, hhmm: string): number {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  const edt = Date.UTC(y!, mo! - 1, d!, h! + 4, m!);
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(new Date(edt));
  return Number(hour) % 24 === h ? edt : edt + 3_600_000;
}

const DAY = 86_400_000;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function economicFixture(sceneMs: number): EconomicEvent[] {
  const rows: Record<string, unknown>[] = [];
  const lo = utcDay(sceneMs - 45 * DAY);
  const hi = utcDay(sceneMs + 45 * DAY);
  for (const e of MACRO_CALENDAR.events) {
    if (e.date < lo || e.date > hi || !e.time_et) continue;
    const h = HEADLINE[e.code];
    if (!h) continue;
    const ms = nyInstant(e.date, e.time_et);
    rows.push({ id: `cur-${e.date}-${e.code}`, title: h.title, country: "US", unit: h.unit, scale: h.scale, currency: "USD", importance: 1, date: new Date(ms).toISOString(), forecast: h.forecast, previous: h.previous, actual: ms <= sceneMs ? h.actual : null });
    if (e.code === "CPI") rows.push({ id: `cur-${e.date}-CORE`, title: "Core Inflation Rate YoY", country: "US", unit: "%", currency: "USD", importance: 1, date: new Date(ms).toISOString(), forecast: 2.5, previous: 2.4, actual: ms <= sceneMs ? 2.6 : null });
  }

  const day0 = Date.parse(`${utcDay(sceneMs)}T00:00:00Z`);
  const at = (days: number, hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return day0 + days * DAY + (h! * 60 + m!) * 60_000;
  };
  const add = (id: string, country: string, title: string, when: number, importance: number, figures: { forecast?: number; previous?: number; actual?: number; unit?: string; scale?: string; currency?: string } = {}) => {
    rows.push({
      id,
      title,
      country,
      date: new Date(when).toISOString(),
      importance,
      currency: figures.currency ?? "USD",
      unit: figures.unit,
      scale: figures.scale,
      forecast: figures.forecast ?? null,
      previous: figures.previous ?? null,
      actual: when <= sceneMs ? (figures.actual ?? null) : null,
    });
  };
  add("eu-cpi", "EU", "Inflation Rate YoY Final", at(0, "09:00"), 1, { forecast: 2.2, previous: 2.2, actual: 2.2, unit: "%", currency: "EUR" });
  add("eu-lagarde", "EU", "ECB President Lagarde Speech", at(0, "08:30"), 1, { currency: "EUR" });
  add("de-zew", "DE", "ZEW Economic Sentiment Index", at(2, "09:00"), 1, { forecast: 38.5, previous: 34.7, currency: "EUR" });
  add("de-ppi", "DE", "PPI MoM", at(1, "06:00"), -1, { forecast: 0.1, previous: -0.2, unit: "%", currency: "EUR" });
  add("fr-cpi", "FR", "Inflation Rate YoY Final", at(-1, "06:45"), 0, { forecast: 1.1, previous: 1.1, actual: 1.2, unit: "%", currency: "EUR" });
  add("it-trade", "IT", "Balance of Trade", at(0, "08:00"), -1, { previous: 7.5, actual: 8.24, unit: "€", scale: "B", currency: "EUR" });
  add("gb-cpi", "GB", "Inflation Rate YoY", at(3, "06:00"), 1, { forecast: 3.9, previous: 3.8, unit: "%", currency: "GBP" });
  add("gb-bailey", "GB", "BoE Gov Bailey Speech", at(1, "14:00"), 0, { currency: "GBP" });
  add("jp-cpi", "JP", "Inflation Rate YoY", at(0, "23:30"), 1, { forecast: 2.6, previous: 2.7, unit: "%", currency: "JPY" });
  add("cn-gdp", "CN", "GDP Growth Rate YoY", at(3, "02:00"), 1, { forecast: 4.8, previous: 5.2, unit: "%", currency: "CNY" });
  add("ca-cpi", "CA", "Inflation Rate YoY", at(4, "12:30"), 1, { forecast: 2.1, previous: 1.9, unit: "%", currency: "CAD" });
  add("ch-trade", "CH", "Balance of Trade", at(1, "06:00"), -1, { previous: 4.6, unit: "CHF", scale: "B", currency: "CHF" });
  add("au-jobs", "AU", "Employment Change", at(2, "00:30"), 1, { forecast: 22, previous: 24.5, scale: "K", currency: "AUD" });
  add("us-chair", "US", "Fed Chair Warsh Speech", at(0, "17:00"), 1);
  add("us-claims", "US", "Initial Jobless Claims", at(-1, "12:30"), 0, { forecast: 199, previous: 197, actual: 203, scale: "K" });
  add("tr-cpi", "TR", "Inflation Rate YoY", at(1, "07:00"), 0, { forecast: 28.9, previous: 29.73, unit: "%", currency: "TRY" });
  add("tr-cpi-mom", "TR", "Inflation Rate MoM", at(1, "07:00"), 0, { forecast: 2.3, previous: 1.84, unit: "%", currency: "TRY" });
  add("tr-rate", "TR", "TCMB Interest Rate Decision", at(6, "11:00"), 0, { forecast: 36, previous: 37, unit: "%", currency: "TRY" });
  add("tr-reserves", "TR", "Foreign Exchange Reserves", at(0, "11:30"), -1, { previous: 60.33, actual: 64.57, unit: "$", scale: "B", currency: "TRY" });
  return rows.map((r) => parseTradingViewRow(r)).filter((e): e is EconomicEvent => e !== null);
}

/** The bridge method, answering from the fixture for the range and countries asked about. */
export function economicBridge(sceneMs: () => number, mode: string | null) {
  return async (request: unknown): Promise<EconomicCalendarResult> => {
    await new Promise((r) => setTimeout(r, 250));
    if (mode === "error") return { ok: false, error: "unavailable" };
    const parsed = parseEconomicRequest(request);
    if (!parsed) return { ok: false, error: "invalid_request" };
    const wanted = new Set(parsed.countries);
    const lo = Date.parse(`${parsed.from}T00:00:00Z`) - DAY;
    const hi = Date.parse(`${parsed.to}T00:00:00Z`) + 2 * DAY;
    const events = economicFixture(sceneMs()).filter((e) => wanted.has(e.country) && Date.parse(e.at) >= lo && Date.parse(e.at) < hi);
    return { ok: true, events, sources: [{ id: "tradingview", ok: mode !== "partial" }], stale: false, partial: mode === "partial" };
  };
}

/** ?region= and ?tz= kept the way a pick in Settings would keep them. */
export function applyReaderParams(params: URLSearchParams): void {
  try {
    const region = params.get("region");
    if (region) localStorage.setItem(REGION_KEY, region.toUpperCase());
    const tz = params.get("tz");
    if (tz) localStorage.setItem(TIME_ZONE_KEY, tz);
  } catch {
    /* harness only */
  }
}
