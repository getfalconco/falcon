import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en, ja, tr } from "../renderer/lib/i18n/messages/areas/briefing";
import { ENGLISH, type BriefingText } from "./briefing-text";
import { AGENDA_HORIZON_DAYS, countdownSentence, daysBetween, personalAgenda, whenWords } from "./calendar-agenda";
import type { CalendarCorporateEvent } from "./calendar-events";
import type { HeldEarnings } from "./calendar-types";
import { copyProblems } from "./copy-rules";

function textFor(table: Partial<Record<keyof typeof en, string>>, locale: string): BriefingText {
  return {
    locale,
    t: (key, vars) =>
      (table[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => (vars && name in vars ? String(vars[name]) : whole)),
  };
}

const TODAY = "2026-10-10";

function corp(kind: CalendarCorporateEvent["kind"], ticker: string, date: string, extra: Partial<CalendarCorporateEvent> = {}): CalendarCorporateEvent {
  return { id: `${kind}:${ticker}:${date}`, kind, ticker, date, title: `${ticker} ${kind}`, detail: null, estimated: false, ...extra };
}

function earn(ticker: string, due: string, timing: HeldEarnings["timing"], confirmed = true): HeldEarnings {
  return { ticker, due_ymd: due, timing, sessions_until: 0, fiscal_period: null, confirmed, source: "tracker" };
}

describe("countdown wording", () => {
  it("counts calendar days between NY dates", () => {
    assert.equal(daysBetween("2026-10-10", "2026-10-22"), 12);
    assert.equal(daysBetween("2026-10-31", "2026-11-02"), 2);
    assert.equal(daysBetween("2026-10-10", "nope"), null);
  });

  it("says today, tomorrow, and in N days", () => {
    assert.equal(whenWords(0), "today");
    assert.equal(whenWords(1), "tomorrow");
    assert.equal(whenWords(12), "in 12 days");
    assert.equal(countdownSentence("earnings", "NVDA", 12), "NVDA reports in 12 days");
    assert.equal(countdownSentence("earnings", "NVDA", 0, ENGLISH, { beforeOpen: true }), "NVDA reports today, before the open");
    assert.equal(countdownSentence("ex_dividend", "XOM", 1), "XOM goes ex-dividend tomorrow");
    assert.equal(countdownSentence("dividend_payment", "XOM", 4), "XOM pays its dividend in 4 days");
    assert.equal(countdownSentence("split", "NVDA", 3, ENGLISH, { ratio: { num: 10, den: 1, reverse: false } }), "NVDA 10-for-1 split in 3 days");
    assert.equal(countdownSentence("split", "NVDA", 3), null, "a split without its ratio is not worded");
  });

  it("is translated, with the language's plural rule", () => {
    const trText = textFor(tr, "tr-TR");
    assert.equal(countdownSentence("earnings", "NVDA", 12, trText), "NVDA 12 gün sonra bilanço açıklıyor");
    assert.equal(whenWords(0, trText), "bugün");
    const jaText = textFor(ja, "ja-JP");
    assert.equal(countdownSentence("ex_dividend", "XOM", 2, jaText), "XOM の配当落ち日は2日後");
  });

  it("keeps the agenda copy within the house rules", () => {
    const table = Object.entries(en)
      .filter(([key]) => key.startsWith("briefing.agenda."))
      .map(([, text]) => JSON.stringify(text))
      .join("\n");
    assert.ok(table.length > 0);
    assert.deepEqual(copyProblems(table, { riskWords: true }), []);
  });
});

describe("personal agenda", () => {
  it("lists held names first, then the watchlist, each by date, with the report's hour preferred", () => {
    const agenda = personalAgenda({
      today: TODAY,
      held: ["NVDA", "XOM"],
      watchlist: ["LLY"],
      corporate: [
        corp("earnings", "LLY", "2026-10-11"),
        corp("earnings", "NVDA", "2026-10-23", { estimated: true }),
        corp("ex_dividend", "XOM", "2026-10-14"),
        corp("dividend_payment", "XOM", "2026-10-30"),
        corp("ex_dividend", "XOM", "2026-09-01"),
      ],
      earnings: [earn("NVDA", "2026-10-22", "amc_or_unspecified")],
    });
    assert.deepEqual(
      agenda.rows.map((r) => [r.tier, r.text]),
      [
        ["held", "XOM goes ex-dividend in 4 days"],
        ["held", "NVDA reports in 12 days"],
        ["held", "XOM pays its dividend in 20 days"],
        ["watchlist", "LLY reports tomorrow"],
      ],
    );
    const nvda = agenda.rows.find((r) => r.ticker === "NVDA")!;
    assert.equal(nvda.date, "2026-10-22", "the report's date wins over the provider's");
    assert.equal(nvda.detail, "After the close, or at an hour not yet announced.");
    assert.equal(agenda.note, null);
  });

  it("leaves a held name's earnings inside the report's reach to the report, as the Calendar tab's grid does", () => {
    const agenda = personalAgenda({
      today: TODAY,
      held: ["JPM", "AAPL"],
      watchlist: ["MSFT"],
      corporate: [corp("earnings", "JPM", "2026-10-13"), corp("earnings", "AAPL", "2026-11-12"), corp("earnings", "MSFT", "2026-10-14")],
      earnings: [],
      reportSession: "2026-10-12",
    });
    assert.deepEqual(agenda.rows.map((r) => r.ticker), ["AAPL", "MSFT"], "JPM is in reach and the report lists none; MSFT is not held");
  });

  it("words today's report with its hour when the hour is known", () => {
    const agenda = personalAgenda({ today: TODAY, held: ["JPM"], watchlist: [], corporate: [], earnings: [earn("JPM", TODAY, "bmo")] });
    assert.equal(agenda.rows[0]!.text, "JPM reports today, before the open");
    assert.equal(agenda.rows[0]!.dateLabel, "today");
    assert.equal(agenda.rows[0]!.detail, null);
  });

  it("says an unconfirmed date is estimated", () => {
    const agenda = personalAgenda({ today: TODAY, held: ["AAPL"], watchlist: [], corporate: [corp("earnings", "AAPL", "2026-10-29", { estimated: true })] });
    assert.equal(agenda.rows[0]!.detail, "Date estimated by the data provider.");
    assert.equal(agenda.rows[0]!.estimated, true);
  });

  it("stops at the horizon and never lists a past date", () => {
    const agenda = personalAgenda({
      today: TODAY,
      held: ["AAPL"],
      watchlist: [],
      corporate: [corp("earnings", "AAPL", "2026-12-30"), corp("ex_dividend", "AAPL", "2026-10-09")],
    });
    assert.deepEqual(agenda.rows, []);
    assert.equal(agenda.note, `No dates on file for your positions in the next ${AGENDA_HORIZON_DAYS} days.`);
  });

  it("falls back to the watchlist, with a note, when nothing is held", () => {
    const agenda = personalAgenda({ today: TODAY, held: [], watchlist: ["MSFT"], corporate: [corp("earnings", "MSFT", "2026-10-26")] });
    assert.deepEqual(agenda.rows.map((r) => [r.tier, r.text]), [["watchlist", "MSFT reports in 16 days"]]);
    assert.equal(agenda.note, "You hold no positions, so this lists your watchlist and the market.");
  });

  it("says the list is the market's alone when nothing is held or followed", () => {
    const agenda = personalAgenda({ today: TODAY, held: [], watchlist: [], corporate: [corp("earnings", "MSFT", "2026-10-26")] });
    assert.deepEqual(agenda.rows, []);
    assert.equal(agenda.note, "You hold no positions and follow no names, so this lists market dates only.");
  });
});
