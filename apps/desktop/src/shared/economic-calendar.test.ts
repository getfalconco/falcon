import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAJOR_COUNTRIES,
  curatedCode,
  curatedFigures,
  economicCountries,
  fillTraits,
  formatEconomicFigure,
  isSpeechTitle,
  matchCurated,
  parseEconomicRequest,
  parseFigureText,
  parseForexFactoryAnswer,
  parseForexFactoryRow,
  parseTradingViewAnswer,
  parseTradingViewRow,
  seriesKey,
  type EconomicEvent,
} from "./economic-calendar";

/** Rows shaped as TradingView's calendar answers them (October 2026). */
const TV = {
  usCpi: { id: "394001", title: "Inflation Rate YoY", country: "US", indicator: "Inflation Rate", period: "Sep", actual: 3.7, previous: 3.4, forecast: 3.6, unit: "%", currency: "USD", importance: 1, date: "2026-10-14T12:30:00.000Z" },
  usCoreCpi: { id: "394002", title: "Core Inflation Rate YoY", country: "US", period: "Sep", actual: 2.6, previous: 2.4, forecast: 2.5, unit: "%", currency: "USD", importance: 1, date: "2026-10-14T12:30:00.000Z" },
  usPpi: { id: "394100", title: "PPI MoM", country: "US", period: "Sep", actual: null, previous: 0.4, forecast: 0.5, unit: "%", currency: "USD", importance: 1, date: "2026-10-15T12:30:00.000Z" },
  trCpi: { id: "500001", title: "Inflation Rate YoY", country: "TR", period: "Sep", actual: 29.73, previous: 31.51, forecast: 30.3, unit: "%", currency: "TRY", importance: 0, date: "2026-10-05T07:00:00.000Z" },
  trRate: { id: "500002", title: "TCMB Interest Rate Decision", country: "TR", period: "", actual: null, previous: 37, forecast: null, unit: "%", currency: "TRY", importance: 0, date: "2026-10-22T11:00:00.000Z" },
  euSpeech: { id: "600001", title: "ECB President Lagarde Speech", country: "EU", period: "", actual: null, previous: null, forecast: null, currency: "EUR", importance: 1, date: "2026-10-14T08:30:00.000Z" },
  usChair: { id: "600002", title: "Fed Chair Warsh Speech", country: "US", actual: null, previous: null, forecast: null, currency: "USD", importance: 1, date: "2026-10-16T03:30:00.000Z" },
  usNfp: { id: "700001", title: "Non Farm Payrolls", country: "US", actual: 162, previous: 21, forecast: 56, scale: "K", currency: "USD", importance: 1, date: "2026-09-04T12:30:00.000Z" },
  usTrade: { id: "700002", title: "Balance of Trade", country: "US", actual: -88.6, previous: -71.2, forecast: -90, unit: "$", scale: "B", currency: "USD", importance: 0, date: "2026-09-03T12:30:00.000Z" },
  usSummit: { id: "700003", title: "Midterm Elections", country: "US", actual: null, previous: null, forecast: null, currency: "USD", importance: 1, date: "2026-11-03T00:00:00.000Z" },
  deZew: { id: "700004", title: "ZEW Economic Sentiment Index", country: "DE", actual: null, previous: 34.7, forecast: null, currency: "EUR", importance: 1, date: "2026-10-20T09:00:00.000Z" },
  brazil: { id: "800001", title: "Inflation Rate YoY", country: "AR", actual: 1, previous: 1, forecast: 1, unit: "%", currency: "ARS", importance: 1, date: "2026-10-14T12:30:00.000Z" },
};

function tv(row: Record<string, unknown>): EconomicEvent {
  const e = parseTradingViewRow(row);
  assert.ok(e, JSON.stringify(row));
  return e;
}

describe("economic calendar: countries", () => {
  it("always asks for the US, the euro area, its largest members and the other majors", () => {
    assert.deepEqual([...MAJOR_COUNTRIES], ["US", "EU", "DE", "GB", "FR", "IT", "JP", "CN", "CA", "CH", "AU"]);
    assert.deepEqual(economicCountries(null), [...MAJOR_COUNTRIES]);
  });

  it("adds the reader's region once, and only one the calendar covers", () => {
    assert.deepEqual(economicCountries("TR"), [...MAJOR_COUNTRIES, "TR"]);
    assert.deepEqual(economicCountries("tr"), [...MAJOR_COUNTRIES, "TR"]);
    assert.deepEqual(economicCountries("DE"), [...MAJOR_COUNTRIES]);
    assert.deepEqual(economicCountries("AR"), [...MAJOR_COUNTRIES]);
  });

  it("checks a request: dates, its reach and the countries", () => {
    assert.deepEqual(parseEconomicRequest({ from: "2026-10-01", to: "2026-11-10", countries: ["us", "TR", "XX", "TR"] }), { from: "2026-10-01", to: "2026-11-10", countries: ["TR", "US"] });
    assert.equal(parseEconomicRequest({ from: "2026-10-10", to: "2026-10-01", countries: ["US"] }), null);
    assert.equal(parseEconomicRequest({ from: "2026-01-01", to: "2026-12-31", countries: ["US"] }), null);
    assert.equal(parseEconomicRequest({ from: "2026-10-01", to: "2026-10-02", countries: ["XX"] }), null);
    assert.equal(parseEconomicRequest({ from: "Oct 1", to: "2026-10-02", countries: ["US"] }), null);
    assert.equal(parseEconomicRequest(null), null);
  });
});

describe("economic calendar: TradingView rows", () => {
  it("reads a release with its figures, unit, importance and period", () => {
    const e = tv(TV.usCpi);
    assert.equal(e.id, "tv:394001");
    assert.equal(e.country, "US");
    assert.equal(e.at, "2026-10-14T12:30:00.000Z");
    assert.equal(e.importance, 3);
    assert.deepEqual([e.actual, e.forecast, e.previous, e.unit, e.scale, e.period], [3.7, 3.6, 3.4, "%", null, "Sep"]);
    assert.equal(e.speech, false);
    assert.equal(e.allDay, false);
  });

  it("reads Turkey's CPI with its forecast, and the CBRT decision", () => {
    const cpi = tv(TV.trCpi);
    assert.deepEqual([cpi.country, cpi.forecast, cpi.previous, cpi.actual, cpi.importance], ["TR", 30.3, 31.51, 29.73, 2]);
    const rate = tv(TV.trRate);
    assert.deepEqual([rate.title, rate.previous, rate.forecast, rate.unit], ["TCMB Interest Rate Decision", 37, null, "%"]);
  });

  it("maps importance 1, 0 and -1 to high, medium and low", () => {
    assert.equal(tv({ ...TV.usCpi, importance: 1 }).importance, 3);
    assert.equal(tv({ ...TV.usCpi, importance: 0 }).importance, 2);
    assert.equal(tv({ ...TV.usCpi, importance: -1 }).importance, 1);
  });

  it("writes a currency symbol as the currency, and keeps the scale", () => {
    const trade = tv(TV.usTrade);
    assert.deepEqual([trade.unit, trade.scale], ["USD", "B"]);
    const nfp = tv(TV.usNfp);
    assert.deepEqual([nfp.unit, nfp.scale], [null, "K"]);
  });

  it("marks speeches, and a row with no hour and nothing to report as all-day", () => {
    assert.equal(tv(TV.euSpeech).speech, true);
    assert.equal(tv(TV.usChair).speech, true);
    assert.equal(tv(TV.usChair).allDay, false);
    assert.equal(tv(TV.usSummit).allDay, true);
    assert.equal(tv(TV.usSummit).speech, false);
  });

  it("drops rows for countries outside the calendar and rows it cannot read", () => {
    assert.equal(parseTradingViewRow(TV.brazil), null);
    assert.equal(parseTradingViewRow({ ...TV.usCpi, date: "soon" }), null);
    assert.equal(parseTradingViewRow({ ...TV.usCpi, title: "" }), null);
    assert.equal(parseTradingViewRow("row"), null);
    assert.deepEqual(parseTradingViewAnswer({ status: "ok", result: [TV.usCpi, TV.brazil, null] })?.map((e) => e.id), ["tv:394001"]);
    assert.equal(parseTradingViewAnswer({ status: "error" }), null);
  });
});

describe("economic calendar: speeches", () => {
  it("knows a speech by its title, and never a row with figures", () => {
    for (const title of ["Fed Chair Warsh Speech", "ECB President Lagarde Speaks", "BoE Gov Bailey Testimony", "Fed Press Conference", "BoJ Governor Remarks"]) {
      assert.equal(isSpeechTitle(title), true, title);
    }
    for (const title of ["CPI y/y", "Monthly Budget Statement", "Fed Interest Rate Decision", "Beige Book"]) assert.equal(isSpeechTitle(title), false, title);
    assert.equal(isSpeechTitle("Fed Chair Speaks", { previous: 1 }), false);
  });
});

describe("economic calendar: Forex Factory rows", () => {
  it("reads the country from the currency, and a euro member from the title", () => {
    const de = parseForexFactoryRow({ title: "German Final CPI m/m", country: "EUR", date: "2026-10-13T02:00:00-04:00", impact: "Low", forecast: "0.6%", previous: "0.6%" });
    assert.ok(de);
    assert.deepEqual([de.country, de.at, de.forecast, de.previous, de.unit, de.importance, de.source], ["DE", "2026-10-13T06:00:00.000Z", 0.6, 0.6, "%", 1, "forexfactory"]);
    assert.equal(parseForexFactoryRow({ title: "French Final CPI m/m", country: "EUR", date: "2026-10-15T02:45:00-04:00", impact: "Low" })?.country, "FR");
    assert.equal(parseForexFactoryRow({ title: "Italian Trade Balance", country: "EUR", date: "2026-10-16T06:00:00-04:00", impact: "Low" })?.country, "IT");
    assert.equal(parseForexFactoryRow({ title: "Final CPI y/y", country: "EUR", date: "2026-10-16T05:00:00-04:00", impact: "Low" })?.country, "EU");
    assert.equal(parseForexFactoryRow({ title: "CPI y/y", country: "CNY", date: "2026-10-13T21:30:00-04:00", impact: "Low" })?.country, "CN");
  });

  it("reads impact and speeches, and skips holidays and the 'All' rows", () => {
    const chair = parseForexFactoryRow({ title: "Fed Chairman Warsh Speaks", country: "USD", date: "2026-10-15T23:30:00-04:00", impact: "High", forecast: "", previous: "" });
    assert.deepEqual([chair?.importance, chair?.speech, chair?.forecast], [3, true, null]);
    assert.equal(parseForexFactoryRow({ title: "Bank Holiday", country: "JPY", date: "2026-10-11T19:00:00-04:00", impact: "Holiday" }), null);
    assert.equal(parseForexFactoryRow({ title: "IMF Meetings", country: "All", date: "2026-10-12T10:15:00-04:00", impact: "Low" }), null);
    assert.equal(parseForexFactoryAnswer({ not: "a list" }), null);
  });

  it("reads the cells' figures, units and scales", () => {
    assert.deepEqual(parseFigureText("0.6%"), { value: 0.6, unit: "%", scale: null });
    assert.deepEqual(parseFigureText("-34.7B"), { value: -34.7, unit: null, scale: "B" });
    assert.deepEqual(parseFigureText("23.8K"), { value: 23.8, unit: null, scale: "K" });
    assert.deepEqual(parseFigureText("98.1"), { value: 98.1, unit: null, scale: null });
    assert.deepEqual(parseFigureText("3.80|1.6"), { value: 3.8, unit: null, scale: null });
    assert.equal(parseFigureText(""), null);
    assert.equal(parseFigureText("n/a"), null);
    const claims = parseForexFactoryRow({ title: "Unemployment Claims", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "Medium", forecast: "199K", previous: "197K" });
    assert.deepEqual([claims?.forecast, claims?.previous, claims?.unit, claims?.scale], [199, 197, null, "K"]);
  });
});

describe("economic calendar: figures in the reader's locale", () => {
  it("writes a percentage as the reader does: 0.3% and %0,3", () => {
    assert.equal(formatEconomicFigure(0.3, "%", null, "en-US"), "0.3%");
    assert.equal(formatEconomicFigure(0.3, "%", null, "tr-TR"), "%0,3");
    assert.equal(formatEconomicFigure(29.73, "%", null, "tr-TR"), "%29,73");
    assert.equal(formatEconomicFigure(4, "%", null, "en-US"), "4%");
    assert.equal(formatEconomicFigure(-0.3, "%", null, "en-US"), "-0.3%");
  });

  it("keeps the provider's digits on a scaled figure", () => {
    assert.equal(formatEconomicFigure(199, null, "K", "en-US"), "199K");
    assert.equal(formatEconomicFigure(7.271, null, "M", "en-US"), "7.271M");
    assert.equal(formatEconomicFigure(1025, null, "B", "en-US"), "1.025T");
    assert.equal(formatEconomicFigure(-118.8, "USD", "B", "en-US"), "-$118.8B");
  });

  it("writes a bare number with its decimals", () => {
    assert.equal(formatEconomicFigure(54.6, null, null, "en-US"), "54.6");
    assert.equal(formatEconomicFigure(54.6, null, null, "de-DE"), "54,6");
  });
});

describe("economic calendar: series traits", () => {
  it("gives a bare future row its series' unit and scale, or % for a rate", () => {
    const housing = tv({ id: "1", title: "Housing Starts", country: "US", previous: 1.275, currency: "USD", importance: 1, date: "2026-10-20T12:30:00.000Z" });
    const trCpi = tv({ id: "2", title: "Inflation Rate YoY", country: "TR", previous: 29.73, currency: "TRY", importance: 0, date: "2026-11-03T07:00:00.000Z" });
    const confidence = tv({ id: "3", title: "Consumer Confidence", country: "TR", previous: 91.9, currency: "TRY", importance: 0, date: "2026-10-22T07:00:00.000Z" });
    const known = new Map([[seriesKey({ country: "US", title: "Housing Starts" }), { unit: null, scale: "M" as const }]]);
    const [h, c, k] = fillTraits([housing, trCpi, confidence], known);
    assert.deepEqual([h!.unit, h!.scale], [null, "M"]);
    assert.deepEqual([c!.unit, c!.scale], ["%", null]);
    assert.deepEqual([k!.unit, k!.scale], [null, null]);
  });
});

describe("economic calendar: the curated US schedule", () => {
  const live = [tv(TV.usCpi), tv(TV.usCoreCpi), tv(TV.usPpi), tv(TV.euSpeech), tv({ ...TV.usCpi, id: "x", country: "DE" })];

  it("reads the code off a curated row's id", () => {
    assert.equal(curatedCode("macro:2026-10-15:PPI"), "PPI");
    assert.equal(curatedCode("m:macro:2026-10-14:CPI"), "CPI");
    assert.equal(curatedCode("m:macro:2026-10-28:FOMC_PRESSER"), "FOMC_PRESSER");
    assert.equal(curatedCode("earn:NVDA:2026-11-19"), null);
  });

  it("finds the headline and the family in the same slot, US rows only", () => {
    const m = matchCurated("CPI", Date.parse("2026-10-14T12:30:00Z"), live);
    assert.equal(m.headline?.id, "tv:394001");
    assert.deepEqual([...m.family].sort(), ["tv:394001", "tv:394002"]);
    assert.equal(matchCurated("CPI", Date.parse("2026-10-15T12:30:00Z"), live).headline, null);
    assert.equal(matchCurated("NOPE", Date.parse("2026-10-14T12:30:00Z"), live).headline, null);
  });

  it("gives the dashboard card each curated row's figures", () => {
    const figures = curatedFigures(
      [
        { id: "macro:2026-10-14:CPI", at: "2026-10-14T12:30:00.000Z" },
        { id: "macro:2026-10-15:PPI", at: "2026-10-15T12:30:00.000Z" },
        { id: "opex:monthly:2026-10-16", at: null },
      ],
      live,
    );
    assert.deepEqual(figures.get("macro:2026-10-14:CPI"), { actual: 3.7, forecast: 3.6, previous: 3.4, unit: "%", scale: null });
    assert.deepEqual(figures.get("macro:2026-10-15:PPI"), { actual: null, forecast: 0.5, previous: 0.4, unit: "%", scale: null });
    assert.equal(figures.size, 2);
  });
});
