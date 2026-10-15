import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDemoBriefing } from "../../../shared/briefing-demo";
import { resolveBriefingWindow, type BriefingReport, type HeldEarnings } from "../../../shared/briefing-types";
import type { CalendarCorporateEvent, UserCalendarEvent } from "../../../shared/calendar-events";
import { translate } from "../../lib/i18n/translate";
import type { TFunction } from "../../lib/i18n";
import type { LanguageCode } from "../../lib/i18n/languages";
import { storeFailure } from "../../../shared/calendar-events";
import { DEFAULT_FILTERS, categoriesToList, corporateToCal, filterEvents, timedSegments, userEventToCal, wordCorporate } from "./calendar-model";
import { buildMarketEvents } from "./market-events";
import { failureMessage } from "./sector-labels";

const tIn = (language: LanguageCode): TFunction => (key, vars) => translate(language, key, vars);

/** Saturday 2026-09-26, 08:00 ET: the report is for Monday the 28th. */
const SATURDAY = new Date("2026-09-26T12:00:00.000Z");

function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function briefing(overrides: Partial<BriefingReport> = {}): BriefingReport {
  const window = resolveBriefingWindow(SATURDAY);
  const built = buildDemoBriefing(stream(7), window, [{ symbol: "NVDA", shares: 10, cost_usd: 1000 }], 5000);
  return { ...built, demo: false, generated_at: SATURDAY.toISOString(), window, ...overrides };
}

const sectorOf = (t: string) => (t === "NVDA" ? "Technology" : t === "JPM" ? "Financials" : null);

function corporate(id: string, overrides: Partial<CalendarCorporateEvent> = {}): CalendarCorporateEvent {
  return { id, kind: "earnings", ticker: "JPM", date: "2026-10-13", title: "JPM earnings report", detail: null, estimated: true, ...overrides };
}

describe("buildMarketEvents", () => {
  it("lists the curated macro calendar without a report", () => {
    // 2026-10-14 is a CPI day in the curated file's October.
    const { events } = buildMarketEvents({ from: "2026-10-12", to: "2026-10-16", briefing: null, corporate: null, sectorOf, now: SATURDAY });
    assert.ok(events.length > 0);
    for (const e of events) {
      assert.equal(e.origin, "market");
      if (e.type === "macro" || e.type === "fed") assert.equal(e.category, "Market-wide");
    }
    const timed = events.filter((e) => !e.allDay);
    assert.ok(timed.every((e) => e.startMs !== null && e.endMs !== null && e.endMs > e.startMs));
  });

  it("marks a weekday market holiday and leaves weekends empty", () => {
    // Thanksgiving, Thursday 2026-11-26, and the weekend after it.
    const { events } = buildMarketEvents({ from: "2026-11-26", to: "2026-11-29", briefing: null, corporate: [], sectorOf, now: SATURDAY });
    const closed = events.filter((e) => e.title === "US markets closed");
    assert.deepEqual(closed.map((e) => e.startDate), ["2026-11-26"]);
    assert.equal(events.some((e) => e.startDate === "2026-11-28" || e.startDate === "2026-11-29"), false);
  });

  it("files earnings under the company's sector and keeps the report's row over the provider's", () => {
    const due: HeldEarnings = { ticker: "NVDA", due_ymd: "2026-09-30", timing: "bmo", sessions_until: 2, fiscal_period: null, confirmed: true, source: "tracker" };
    const b = briefing({ earnings_next: [due], held_coverage: [{ ticker: "NVDA", coverage: "tracked" }] });
    const { events } = buildMarketEvents({
      from: "2026-09-28",
      to: "2026-10-31",
      briefing: b,
      corporate: [
        // The provider's projection for the same name inside the report's reach: left out.
        corporate("earn:NVDA:2026-10-01", { ticker: "NVDA", date: "2026-10-01", title: "NVDA earnings report" }),
        // A followed name the report knows nothing of: kept, under its sector.
        corporate("earn:JPM:2026-10-13"),
        corporate("div:JPM:2026-10-06", { kind: "ex_dividend", date: "2026-10-06", title: "JPM ex-dividend date", estimated: false }),
        // Outside the range asked for.
        corporate("earn:JPM:2027-01-13", { date: "2027-01-13" }),
      ],
      sectorOf,
      now: SATURDAY,
    });
    const earnings = events.filter((e) => e.type === "earnings");
    assert.deepEqual(earnings.map((e) => `${e.tickers[0]}:${e.startDate}`).sort(), ["JPM:2026-10-13", "NVDA:2026-09-30"]);
    assert.equal(earnings.find((e) => e.tickers[0] === "NVDA")?.category, "Technology");
    assert.equal(earnings.find((e) => e.tickers[0] === "JPM")?.color, "teal");
    assert.equal(events.find((e) => e.id === "m:div:JPM:2026-10-06")?.type, "corporate");
  });

  it("falls back to the report's corporate events when the provider list is missing", () => {
    const b = briefing({
      corporate_events: [
        { id: "div:NVDA:2026-10-01", kind: "dividend", date: "2026-10-01", sessions_until: 3, ticker: "NVDA", index: null, title: "NVDA ex-dividend date", detail: "x", affects_held: ["NVDA"], certainty: "confirmed", source: "yahoo_calendar" },
      ],
    });
    const { events } = buildMarketEvents({ from: "2026-09-28", to: "2026-10-02", briefing: b, corporate: null, sectorOf, now: SATURDAY });
    assert.ok(events.some((e) => e.id === "m:div:NVDA:2026-10-01"));
  });
});

const userTimed: UserCalendarEvent = {
  id: "ue_abcdef12",
  title: "Late call",
  all_day: false,
  date: null,
  end_date: null,
  start_at: "2026-10-12T03:00:00.000Z", // 23:00 ET on the 11th
  end_at: "2026-10-12T05:00:00.000Z", // 01:00 ET on the 12th
  ticker: "NVDA",
  sector: null,
  color: "pink",
  notes: "",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

describe("events on the grid", () => {
  it("cuts a timed event at midnight in the viewing zone", () => {
    const e = userEventToCal(userTimed, sectorOf);
    assert.equal(e.category, "Technology");
    const segs = timedSegments(e, ["2026-10-11", "2026-10-12"], "America/New_York");
    assert.deepEqual(
      segs.map((s) => [s.ymd, s.start, s.end, s.continuesBefore, s.continuesAfter]),
      [
        ["2026-10-11", 23 * 60, 1440, false, true],
        ["2026-10-12", 0, 60, true, false],
      ],
    );
    // The same event in UTC sits on one day.
    assert.equal(timedSegments(e, ["2026-10-11", "2026-10-12"], "UTC").length, 1);
  });

  it("filters by type, category and watchlist", () => {
    const { events } = buildMarketEvents({
      from: "2026-10-12",
      to: "2026-10-16",
      briefing: null,
      corporate: [corporate("earn:JPM:2026-10-13"), corporate("earn:NVDA:2026-10-14", { ticker: "NVDA", date: "2026-10-14" })],
      sectorOf,
      now: SATURDAY,
    });
    const mine = userEventToCal({ ...userTimed, ticker: null }, sectorOf);
    const all = [...events, mine];

    const noMacro = filterEvents(all, { ...DEFAULT_FILTERS, hiddenTypes: ["macro"] }, new Set());
    assert.equal(noMacro.some((e) => e.type === "macro"), false);
    assert.ok(noMacro.includes(mine));

    const noTech = filterEvents(all, { ...DEFAULT_FILTERS, hiddenCategories: ["Technology"] }, new Set());
    assert.equal(noTech.some((e) => e.tickers.includes("NVDA")), false);
    assert.ok(noTech.includes(mine), "an event without a sector is not hidden by a sector");

    const watched = filterEvents(all, { ...DEFAULT_FILTERS, watchlistOnly: true }, new Set(["JPM"]));
    assert.equal(watched.some((e) => e.tickers.includes("NVDA")), false);
    assert.ok(watched.some((e) => e.tickers.includes("JPM")));
    assert.ok(watched.some((e) => e.category === "Market-wide"));

    assert.deepEqual(categoriesToList(all, ["Energy"]), ["Market-wide", "Technology", "Energy", "Financials"]);
  });
});

describe("corporate rows in the reader's language", () => {
  const exDiv = corporate("div:JPM:2026-10-06", {
    kind: "ex_dividend",
    date: "2026-10-06",
    title: "JPM ex-dividend date",
    detail: "$0.26 per share. Indicated annual rate $1.04 per share. Shares held before this date carry the payment.",
    estimated: false,
    words: {
      title: { code: "exDividend", params: { ticker: "JPM" } },
      detail: [{ code: "perShare", params: { amount: 0.26 } }, { code: "indicatedRate", params: { amount: 1.04 } }, { code: "heldBefore" }],
    },
  });

  it("keeps main's English without words, and says the same from the codes in English", () => {
    const plain = corporateToCal(exDiv, sectorOf);
    assert.equal(plain.title, "JPM ex-dividend date");
    assert.equal(plain.kindLabel, "Dividend");
    assert.equal(plain.timeLine, "All day");
    assert.equal(plain.sourceLabel, "Date from the data provider.");
    const worded = corporateToCal(exDiv, sectorOf, { t: tIn("en-US"), locale: "en-US" });
    assert.equal(worded.title, plain.title);
    assert.equal(worded.detail, plain.detail);
    assert.equal(worded.kindLabel, plain.kindLabel);
    assert.equal(worded.sourceLabel, plain.sourceLabel);
  });

  it("words titles, details, labels and amounts in Turkish", () => {
    const e = corporateToCal(exDiv, sectorOf, { t: tIn("tr-TR"), locale: "tr-TR" });
    assert.equal(e.title, "JPM temettü hak kesim tarihi");
    assert.match(e.detail ?? "", /^Hisse başına \$0,26\. Belirtilen yıllık oran hisse başına \$1,04\./);
    assert.equal(e.kindLabel, "Temettü");
    assert.equal(e.timeLine, "Tüm gün");
    assert.equal(e.sourceLabel, "Tarih veri sağlayıcıdan.");
  });

  it("formats an earnings window's dates in the reader's locale", () => {
    const words = {
      title: { code: "earnings" as const, params: { ticker: "JPM" } },
      detail: [{ code: "earningsWindow" as const, params: { from: "2026-10-28", to: "2026-11-03" } }],
    };
    assert.match(wordCorporate(words, { t: tIn("en-US"), locale: "en-US" })?.detail ?? "", /from Oct 28 to Nov 3;/);
    assert.match(wordCorporate(words, { t: tIn("de-DE"), locale: "de-DE" })?.detail ?? "", /vom 28\. Okt\. bis 3\. Nov\./);
    assert.equal(wordCorporate(words, { t: tIn("ja-JP"), locale: "ja-JP" })?.title, "JPM 決算発表");
  });

  it("names a split by its ratio and reads it as price history", () => {
    const split = corporate("split:JPM:2026-09-02", {
      kind: "split",
      date: "2026-09-02",
      title: "JPM 1-for-10 reverse split",
      words: { title: { code: "reverseSplit", params: { ticker: "JPM", num: 1, den: 10 } }, detail: [{ code: "splitHistory" }] },
    });
    assert.equal(corporateToCal(split, sectorOf, { t: tIn("en-US"), locale: "en-US" }).title, "JPM 1-for-10 reverse split");
    const fr = corporateToCal(split, sectorOf, { t: tIn("fr-FR"), locale: "fr-FR" });
    assert.equal(fr.title, "Regroupement d'actions 1 pour 10 de JPM");
    assert.equal(fr.kindLabel, "Division");
    assert.equal(fr.sourceLabel, "Lu dans l'historique des cours du fournisseur.");
  });

  it("keeps the English whole when a code is one this build does not know", () => {
    const odd = { ...exDiv, words: { title: exDiv.words!.title, detail: [{ code: "somethingNew" as never }] } };
    const e = corporateToCal(odd, sectorOf, { t: tIn("tr-TR"), locale: "tr-TR" });
    assert.equal(e.title, "JPM ex-dividend date");
    assert.equal(e.detail, exDiv.detail);
    assert.equal(e.kindLabel, "Temettü");
  });

  it("reads a row without codes back from its English title", () => {
    const tr = { t: tIn("tr-TR"), locale: "tr-TR" };
    const earn = corporateToCal(corporate("earn:JPM:2026-10-13", { detail: "Date estimated by the data provider; the company has not confirmed it." }), sectorOf, tr);
    assert.equal(earn.title, "JPM bilanço açıklaması");
    assert.equal(earn.detail, "Tarih veri sağlayıcının tahmini; şirket henüz doğrulamadı.");
    const split = corporateToCal(corporate("split:JPM:2026-09-02", { kind: "split", title: "JPM 4-for-1 split", detail: "Something the engine says." }), sectorOf, tr);
    assert.equal(split.title, "JPM hisse bölünmesi (4:1)");
    assert.equal(split.detail, "Something the engine says.", "an unknown detail stays as written");
    const odd = corporateToCal(corporate("x:JPM:2026-09-02", { title: "JPM investor day" }), sectorOf, tr);
    assert.equal(odd.title, "JPM investor day");
  });

  it("words the corporate rows buildMarketEvents passes through", () => {
    const { events } = buildMarketEvents({
      from: "2026-10-05",
      to: "2026-10-07",
      briefing: null,
      corporate: [exDiv],
      sectorOf,
      now: SATURDAY,
      text: { t: (key, vars) => translate("tr-TR", key, vars), locale: "tr-TR" },
      t: tIn("tr-TR"),
    });
    assert.equal(events.find((e) => e.id === "m:div:JPM:2026-10-06")?.title, "JPM temettü hak kesim tarihi");
  });

  it("labels the reader's own events in their language", () => {
    assert.equal(userEventToCal(userTimed, sectorOf).kindLabel, "My event");
    assert.equal(userEventToCal(userTimed, sectorOf, tIn("tr-TR")).kindLabel, "Etkinliğim");
  });
});

describe("store failures in the reader's language", () => {
  it("words the store's codes, validation codes main sent back, and keeps English for anything else", () => {
    const tr = tIn("tr-TR");
    assert.equal(failureMessage(tr, storeFailure("full")), "Takvim dolu. Önce bazı eski etkinlikleri silin.");
    assert.equal(failureMessage(tIn("en-US"), storeFailure("missing")), "That event no longer exists.");
    assert.equal(storeFailure("saveFailed").error, "The event could not be saved right now.");
    assert.equal(
      failureMessage(tr, { error: "Keep the title under 120 characters.", code: "titleTooLong", params: { max: 120 } }),
      "Başlığı 120 karakterin altında tutun.",
    );
    assert.equal(failureMessage(tr, { error: "Something else went wrong." }), "Something else went wrong.");
  });
});
