import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems } from "../../../shared/copy-rules";
import { parseTradingViewRow, type EconomicEvent } from "../../../shared/economic-calendar";
import type { MessageKey, TFunction } from "../../lib/i18n";
import type { LanguageCode } from "../../lib/i18n/languages";
import { translate } from "../../lib/i18n/translate";
import { eventOnDay, economicToCal, isImportant, scopeEvents, speechDone, userEventToCal, withHoldings, corporateToCal, type CalEvent } from "./calendar-model";
import { besideTitle, countryName, econLines, markOf, underTitle, type Say } from "./econ-lines";
import { buildMarketEvents } from "./market-events";
import { parsePrefs } from "./calendar-prefs";

const tIn = (language: LanguageCode): TFunction => ((key: MessageKey, params?: Record<string, string | number>) => translate(language, key, params)) as TFunction;
const sayIn = (language: LanguageCode): Say => (key, params) => translate(language, key as MessageKey, params);

function tv(row: Record<string, unknown>): EconomicEvent {
  const e = parseTradingViewRow({ currency: "USD", importance: 1, ...row });
  assert.ok(e, JSON.stringify(row));
  return e;
}

/** The week of 2026-10-12, as the economic calendar printed it. */
const PPI = tv({ id: "ppi", title: "PPI MoM", country: "US", actual: null, previous: 0.4, forecast: 0.5, unit: "%", date: "2026-10-15T12:30:00.000Z" });
const CORE_PPI = tv({ id: "core-ppi", title: "Core PPI MoM", country: "US", actual: null, previous: 0.2, forecast: 0.3, unit: "%", date: "2026-10-15T12:30:00.000Z" });
const RETAIL = tv({ id: "retail", title: "Retail Sales MoM", country: "US", actual: null, previous: 1.2, forecast: 0.3, unit: "%", date: "2026-10-15T12:30:00.000Z" });
const ZEW = tv({ id: "zew", title: "ZEW Economic Sentiment Index", country: "DE", previous: 34.7, currency: "EUR", date: "2026-10-20T09:00:00.000Z" });
const EU_LOW = tv({ id: "eu-low", title: "Construction Output YoY", country: "EU", previous: 1.1, unit: "%", currency: "EUR", importance: -1, date: "2026-10-16T09:00:00.000Z" });
const JP_HIGH = tv({ id: "jp", title: "Inflation Rate YoY", country: "JP", previous: 2.7, unit: "%", currency: "JPY", date: "2026-10-16T23:30:00.000Z" });
const TR_CPI = tv({ id: "tr-cpi", title: "Inflation Rate YoY", country: "TR", previous: 29.73, forecast: 28.9, unit: "%", currency: "TRY", importance: 0, date: "2026-11-03T07:00:00.000Z" });
const TR_LOW = tv({ id: "tr-low", title: "Foreign Exchange Reserves", country: "TR", previous: 64.57, unit: "$", scale: "B", currency: "TRY", importance: -1, date: "2026-10-15T11:30:00.000Z" });
const LAGARDE = tv({ id: "lagarde", title: "ECB President Lagarde Speech", country: "EU", currency: "EUR", date: "2026-10-14T08:30:00.000Z" });
/** 23:30 in New York on the 15th: already the 16th in Istanbul and Tokyo. */
const LATE_CHAIR = tv({ id: "chair", title: "Fed Chair Warsh Speech", country: "US", date: "2026-10-16T03:30:00.000Z" });

const NOW = new Date("2026-10-14T14:00:00.000Z");

function market(economic: EconomicEvent[] | null) {
  return buildMarketEvents({ from: "2026-10-14", to: "2026-10-16", briefing: null, corporate: [], sectorOf: () => null, now: NOW, economic, t: tIn("en-US") });
}

describe("economic calendar rows on the Calendar tab", () => {
  it("carries the country, its figures and the source; a timed row is a half hour block", () => {
    const row = economicToCal(TR_CPI, tIn("en-US"));
    assert.equal(row.id, "e:tv:tr-cpi");
    assert.equal(row.country, "TR");
    assert.deepEqual(row.figures, { actual: null, forecast: 28.9, previous: 29.73, unit: "%", scale: null });
    assert.equal(row.importance, 2);
    assert.equal(row.allDay, false);
    assert.equal(row.endMs! - row.startMs!, 30 * 60_000);
    assert.equal(row.sourceLabel, "From TradingView's economic calendar.");
    assert.equal(row.kindLabel, "Release");
    assert.equal(row.type, "macro");
    assert.equal(economicToCal(tv({ id: "fed", title: "Fed Interest Rate Decision", country: "US", previous: 4, unit: "%", date: "2026-10-28T18:00:00.000Z" })).type, "fed");
  });

  it("gives a speech no figures, and 'Completed' once its time has passed", () => {
    const row = economicToCal(LAGARDE, tIn("en-US"));
    assert.equal(row.speech, true);
    assert.equal(row.figures, null);
    assert.equal(row.kindLabel, "Speech");
    const before = Date.parse("2026-10-14T08:00:00Z");
    const after = Date.parse("2026-10-14T08:31:00Z");
    assert.equal(speechDone(row, before), false);
    assert.equal(speechDone(row, after), true);
    assert.equal(econLines(row, before, sayIn("en-US"), "en-US").completed, null);
    assert.equal(econLines(row, after, sayIn("en-US"), "en-US").completed, "Completed");
    assert.equal(econLines(row, after, sayIn("tr-TR"), "tr-TR").completed, "Tamamlandı");
    assert.equal(besideTitle(econLines(row, after, sayIn("en-US"), "en-US")), "Completed");
  });

  it("writes the figures beside and under the title, in the reader's words and numbers", () => {
    const row = economicToCal(PPI);
    const en = econLines(row, NOW.getTime(), sayIn("en-US"), "en-US");
    assert.equal(besideTitle(en), "Forecast 0.5%");
    assert.equal(underTitle(en), "Previous 0.4%");
    const tr = econLines(row, NOW.getTime(), sayIn("tr-TR"), "tr-TR");
    assert.equal(besideTitle(tr), "Beklenti %0,5");
    assert.equal(underTitle(tr), "Önceki %0,4");
    const out = econLines({ ...row, figures: { ...row.figures!, actual: 1.3 } }, NOW.getTime(), sayIn("en-US"), "en-US");
    assert.equal(besideTitle(out), "Forecast 0.5%");
    assert.equal(underTitle(out), "Actual 1.3% · Previous 0.4%");
    const reserves = econLines(economicToCal(TR_LOW), NOW.getTime(), sayIn("en-US"), "en-US");
    assert.equal(underTitle(reserves), "Previous $64.57B");
  });

  it("puts a flag on releases and the company's logo on its dates", () => {
    assert.deepEqual(markOf(economicToCal(TR_CPI)), { ticker: null, country: "TR" });
    assert.deepEqual(markOf(economicToCal(LAGARDE)), { ticker: null, country: "EU" });
    const earnings = corporateToCal({ id: "earn:NVDA:2026-11-19", kind: "earnings", ticker: "NVDA", date: "2026-11-19", title: "NVDA earnings report", detail: null, estimated: false }, () => null);
    assert.deepEqual(markOf(earnings), { ticker: "NVDA", country: null });
    const mine = userEventToCal({ id: "ue_1", title: "Review", all_day: true, date: "2026-10-15", end_date: "2026-10-15", start_at: null, end_at: null, ticker: "NVDA", sector: null, color: "blue", notes: "", created_at: "", updated_at: "" }, () => null);
    assert.deepEqual(markOf(mine), { ticker: null, country: null });
    assert.equal(countryName("EU", "tr-TR", "Euro Bölgesi"), "Euro Bölgesi");
    assert.equal(countryName("DE", "en-US", "Euro area"), "Germany");
  });
});

describe("the curated US schedule with the economic calendar", () => {
  it("is unchanged without it, and the curated rows carry the US flag", () => {
    const { events } = market(null);
    const ppi = events.find((e) => e.id === "m:macro:2026-10-15:PPI");
    assert.ok(ppi);
    assert.equal(ppi.country, "US");
    assert.equal(ppi.figures, undefined);
  });

  it("gives a curated release the headline's figures, lists the headline once, and ties the rest of its slot to it", () => {
    const { events } = market([PPI, CORE_PPI, RETAIL, ZEW, LAGARDE]);
    const ppi = events.find((e) => e.id === "m:macro:2026-10-15:PPI")!;
    assert.deepEqual(ppi.figures, { actual: null, forecast: 0.5, previous: 0.4, unit: "%", scale: null });
    const retail = events.find((e) => e.id === "m:macro:2026-10-15:RETAIL")!;
    assert.equal(retail.figures?.forecast, 0.3);
    assert.equal(events.some((e) => e.id === "e:tv:ppi"), false);
    assert.equal(events.some((e) => e.id === "e:tv:retail"), false);
    assert.equal(events.find((e) => e.id === "e:tv:core-ppi")?.slotOf, "m:macro:2026-10-15:PPI");
    assert.ok(events.find((e) => e.id === "e:tv:zew"));
    assert.ok(events.find((e) => e.id === "e:tv:lagarde"));
  });
});

describe("Important and All", () => {
  const held = new Set(["NVDA"]);
  const watch = new Set(["TSM"]);
  const corp = (ticker: string): CalEvent =>
    corporateToCal({ id: `earn:${ticker}:2026-10-15`, kind: "earnings", ticker, date: "2026-10-15", title: `${ticker} earnings report`, detail: null, estimated: false }, () => null);
  const { events: base } = market([PPI, CORE_PPI, ZEW, EU_LOW, JP_HIGH, TR_CPI, TR_LOW, LAGARDE]);
  const all = withHoldings([...base, corp("NVDA"), corp("TSM"), corp("AAPL")], held, watch, true);
  const ids = (list: CalEvent[]) => new Set(list.map((e) => e.id));

  it("keeps the reader's names and drops other companies' dates", () => {
    const shown = ids(scopeEvents(all, "important", "TR"));
    assert.ok(shown.has("m:earn:NVDA:2026-10-15"));
    assert.ok(shown.has("m:earn:TSM:2026-10-15"));
    assert.equal(shown.has("m:earn:AAPL:2026-10-15"), false);
  });

  it("keeps high-impact US and European releases, and the region's from medium up", () => {
    const shown = ids(scopeEvents(all, "important", "TR"));
    assert.ok(shown.has("m:macro:2026-10-15:PPI"));
    assert.ok(shown.has("e:tv:zew"));
    assert.ok(shown.has("e:tv:lagarde"));
    assert.ok(shown.has("e:tv:tr-cpi"));
    assert.equal(shown.has("e:tv:tr-low"), false);
    assert.equal(shown.has("e:tv:eu-low"), false);
    assert.equal(shown.has("e:tv:jp"), false, "Japan is in All, not in Important");
    assert.equal(shown.has("e:tv:core-ppi"), false, "the curated PPI row already stands for its slot");
  });

  it("has no region's extra rows without a region", () => {
    assert.equal(ids(scopeEvents(all, "important", null)).has("e:tv:tr-cpi"), false);
  });

  it("keeps everything under All, and the reader's own events under both", () => {
    assert.equal(scopeEvents(all, "all", "TR").length, all.length);
    const mine = userEventToCal({ id: "ue_2", title: "Call", all_day: false, date: null, end_date: null, start_at: "2026-10-15T09:00:00.000Z", end_at: "2026-10-15T10:00:00.000Z", ticker: null, sector: null, color: "violet", notes: "", created_at: "", updated_at: "" }, () => null);
    assert.equal(isImportant(mine, null), true);
  });

  it("remembers the choice, Important by default", () => {
    assert.equal(parsePrefs({}).scope, "important");
    assert.equal(parsePrefs({ scope: "all" }).scope, "all");
    assert.equal(parsePrefs({ scope: "everything" }).scope, "important");
  });
});

describe("days in the reader's zone", () => {
  it("files a release late in New York under the next day further east, across midnight", () => {
    const chair = economicToCal(LATE_CHAIR);
    assert.equal(eventOnDay(chair, "2026-10-15", "America/New_York"), true);
    assert.equal(eventOnDay(chair, "2026-10-16", "America/New_York"), false);
    assert.equal(eventOnDay(chair, "2026-10-16", "Europe/Istanbul"), true);
    assert.equal(eventOnDay(chair, "2026-10-15", "Europe/Istanbul"), false);
    // Tokyo's 08:30 on the 17th is the 16th's evening in New York and London.
    const jp = economicToCal(JP_HIGH);
    assert.equal(eventOnDay(jp, "2026-10-17", "Asia/Tokyo"), true);
    assert.equal(eventOnDay(jp, "2026-10-17", "Europe/London"), true);
    assert.equal(eventOnDay(jp, "2026-10-16", "America/New_York"), true);
  });

  it("keeps a row with no hour on its date in every zone", () => {
    const vote = economicToCal(tv({ id: "vote", title: "Midterm Elections", country: "US", date: "2026-11-03T00:00:00.000Z" }));
    assert.equal(vote.allDay, true);
    for (const zone of ["America/Los_Angeles", "Europe/Istanbul", "Pacific/Auckland"]) assert.equal(eventOnDay(vote, "2026-11-03", zone), true, zone);
  });
});

describe("the economic calendar's copy", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  it("follows the house copy rules", () => {
    // "Forecast" names the provider's published consensus, as the reader asked; the risk-word list is not applied to these labels.
    for (const file of ["econ-lines.ts", "Flag.tsx", "EventBlocks.tsx", "EventDetails.tsx", "CalendarSidebar.tsx", "../briefing/CalendarRail.tsx", "../dashboard/CalendarCard.tsx", "../settings/RegionZoneRows.tsx", "../settings/PickerModal.tsx"]) {
      const src = fs.readFileSync(path.join(HERE, file), "utf8");
      assert.deepEqual(copyProblems(src, { jsxText: true }), [], file);
    }
  });
});
