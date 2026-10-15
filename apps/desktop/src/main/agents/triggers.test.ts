import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTrigger } from "../../shared/agent-types";
import { EMPTY_STATE, type AgentEngineState } from "./store";
import { agentFixture, fakeSources, filing } from "./test-fakes";
import { checkTrigger, filingMs, formMatches, resolveMacro, triggerSignature, type TriggerCheck, type TriggerContext } from "./triggers";
import { filingsFromSubmissions } from "./edgar";
import { HOUR_MS, MINUTE_MS, nyInstant, nyParts } from "./time";
import type { AgentDataSources } from "./sources";

/**
 * Trigger rules against a fixed clock and fake data. 2026-11-19 is a
 * Thursday; New York is on EST (UTC-5), so 21:20Z is 16:20 ET, after the close.
 */

function ctx(now: string, sources: Partial<AgentDataSources> = {}, state: Partial<AgentEngineState> = {}, agentOver = {}): TriggerContext {
  return {
    agent: agentFixture(agentOver),
    state: { ...EMPTY_STATE, firedKeys: [], lastFiredByTrigger: {}, ...state },
    sources: fakeSources(sources),
    now: new Date(now),
  };
}

function waiting(c: TriggerCheck): Extract<TriggerCheck, { status: "waiting" }> {
  assert.equal(c.status, "waiting", JSON.stringify(c));
  return c as Extract<TriggerCheck, { status: "waiting" }>;
}

function firedEvent(c: TriggerCheck) {
  assert.equal(c.status, "fired", JSON.stringify(c));
  return (c as Extract<TriggerCheck, { status: "fired" }>).event;
}

const earnings: AgentTrigger = { kind: "earnings", ticker: "NVDA", moment: "release" };
const dates = { earningsDates: async () => ({ dates: ["2026-08-27", "2026-11-19"], estimated: false }) };

describe("time helpers", () => {
  it("converts New York wall time across DST", () => {
    assert.equal(nyInstant("2026-11-19", "08:00").toISOString(), "2026-11-19T13:00:00.000Z");
    assert.equal(nyInstant("2026-07-15", "08:30").toISOString(), "2026-07-15T12:30:00.000Z");
    assert.deepEqual(nyParts(new Date("2026-11-19T21:20:00Z")), { ymd: "2026-11-19", hour: 16, minute: 20, weekday: 4 });
  });
});

describe("earnings trigger", () => {
  it("waits, checking twice a day, while the date is far off", async () => {
    const w = waiting(await checkTrigger(earnings, ctx("2026-11-01T15:00:00Z", dates)));
    assert.equal(w.nextCheckMs, 12 * HOUR_MS);
    assert.equal(w.nextExpectedAt, "2026-11-19T13:00:00.000Z");
    assert.match(w.detail, /2026-11-19/);
  });

  it("checks EDGAR every 10 minutes on the day and snapshots consensus", async () => {
    const c = ctx("2026-11-19T18:00:00Z", { ...dates, consensus: async () => ({ lines: ["Current quarter: EPS estimate 1.25."], readAt: "2026-11-19T18:00:00.000Z" }) });
    const w = waiting(await checkTrigger(earnings, c));
    assert.equal(w.nextCheckMs, 10 * MINUTE_MS);
    assert.deepEqual(c.state.consensus?.NVDA?.lines, ["Current quarter: EPS estimate 1.25."]);
    assert.equal(c.state.earnings?.NVDA?.date, "2026-11-19");
  });

  it("fires on an 8-K with item 2.02, and only once", async () => {
    const release = filing();
    const event = firedEvent(await checkTrigger(earnings, ctx("2026-11-19T21:30:00Z", { ...dates, filings: async () => [release] })));
    assert.deepEqual(event.keys, [`earnings:NVDA:${release.accession}`]);
    assert.equal(event.filings?.[0]?.accession, release.accession);
    const again = waiting(await checkTrigger(earnings, ctx("2026-11-19T21:40:00Z", { ...dates, filings: async () => [release] }, { firedKeys: event.keys })));
    assert.match(again.note, /reported/);
  });

  it("ignores an older quarter's results filing", async () => {
    const old = filing({ accession: "0001045810-26-000050", filedAt: "2026-08-27", acceptedAt: "2026-08-27T20:20:00.000Z" });
    waiting(await checkTrigger(earnings, ctx("2026-11-19T21:30:00Z", { ...dates, filings: async () => [old] })));
  });

  it("waits for the call when asked to, then fires", async () => {
    const call: AgentTrigger = { kind: "earnings", ticker: "NVDA", moment: "call" };
    const src = { ...dates, filings: async () => [filing()] };
    const w = waiting(await checkTrigger(call, ctx("2026-11-19T21:30:00Z", src)));
    assert.match(w.note, /call/);
    firedEvent(await checkTrigger(call, ctx("2026-11-20T00:30:00Z", src)));
  });

  it("falls back to headlines a day after the date when EDGAR has nothing", async () => {
    const news = async () => [
      { id: "n1", title: "Nvidia reports third-quarter results above estimates", url: "https://example.com/a", publishedAt: "2026-11-19T21:35:00.000Z" },
      { id: "n2", title: "Chip stocks mixed", url: "https://example.com/b", publishedAt: "2026-11-19T21:36:00.000Z" },
    ];
    const event = firedEvent(await checkTrigger(earnings, ctx("2026-11-20T15:00:00Z", { ...dates, news })));
    assert.equal(event.news?.length, 1);
    assert.deepEqual(event.keys, ["earnings:NVDA:2026-11-19:news"]);
  });
});

describe("filing trigger", () => {
  const forms: AgentTrigger = { kind: "filing", ticker: "NVDA", forms: ["8-K"] };

  it("matches amendments and schedule spellings", () => {
    assert.equal(formMatches("8-K/A", ["8-K"]), true);
    assert.equal(formMatches("SCHEDULE 13D/A", ["SC 13D"]), true);
    assert.equal(formMatches("10-Q", ["8-K"]), false);
  });

  it("fires for a filing made after the agent was created, never for older ones", async () => {
    const fresh = filing({ accession: "a-new", items: ["7.01"], acceptedAt: "2026-11-12T13:00:00.000Z", filedAt: "2026-11-12" });
    const before = filing({ accession: "a-old", acceptedAt: "2026-11-01T13:00:00.000Z", filedAt: "2026-11-01" });
    const event = firedEvent(await checkTrigger(forms, ctx("2026-11-12T15:00:00Z", { filings: async () => [fresh, before] })));
    assert.deepEqual(event.keys, ["filing:a-new"]);
    waiting(await checkTrigger(forms, ctx("2026-11-12T15:20:00Z", { filings: async () => [fresh, before] }, { firedKeys: event.keys })));
  });

  it("with insiderBuysOnly, counts open-market purchases and consumes the rest", async () => {
    const t: AgentTrigger = { kind: "filing", ticker: "NVDA", forms: ["4"], insiderBuysOnly: true };
    const sale = filing({ form: "4", accession: "f4-sale", items: [], acceptedAt: "2026-11-12T13:00:00.000Z" });
    const buy = filing({ form: "4", accession: "f4-buy", items: [], acceptedAt: "2026-11-12T14:00:00.000Z" });
    const c = ctx("2026-11-12T15:00:00Z", {
      filings: async () => [buy, sale],
      insiderTxn: async (f) => ({ insiderName: "Doe", role: "CFO", code: f.accession === "f4-buy" ? "P" : "S", shares: 100, price: 10, value: 1000, direction: f.accession === "f4-buy" ? "acquired" : "disposed", date: "2026-11-11", plan10b51: false }),
    });
    const event = firedEvent(await checkTrigger(t, c));
    assert.deepEqual(event.keys, ["filing:f4-buy"]);
    assert.ok(c.state.firedKeys.includes("filing:f4-sale"));
  });
});

describe("price move trigger", () => {
  const t: AgentTrigger = { kind: "price_move", ticker: "TSLA", thresholdPct: 5, window: "1d" };
  const quote = (pct: number) => async (s: string) => ({ symbol: s, price: 200, changePct: pct, regularChangePct: pct, previousClose: 190, session: "regular" as const, asOf: "2026-11-19T17:00:00.000Z" });

  it("fires past the threshold, once per day", async () => {
    const event = firedEvent(await checkTrigger(t, ctx("2026-11-19T17:00:00Z", { quote: quote(-6.2) })));
    assert.deepEqual(event.keys, ["price:TSLA:1d:2026-11-19"]);
    assert.match(event.title, /-6\.2%/);
    waiting(await checkTrigger(t, ctx("2026-11-19T17:05:00Z", { quote: quote(-7) }, { firedKeys: event.keys })));
  });

  it("waits under the threshold and polls every 5 minutes in session", async () => {
    const w = waiting(await checkTrigger(t, ctx("2026-11-19T17:00:00Z", { quote: quote(2) })));
    assert.equal(w.nextCheckMs, 5 * MINUTE_MS);
    // The timeline note does not carry the moving number, so repeated checks coalesce.
    assert.doesNotMatch(w.note, /2\.0/);
  });

  it("does not poll on a weekend", async () => {
    let asked = false;
    const w = waiting(await checkTrigger(t, ctx("2026-11-21T17:00:00Z", { quote: async (s) => { asked = true; return quote(9)(s); } })));
    assert.equal(asked, false);
    assert.match(w.note, /closed/);
  });

  it("measures 5 sessions from daily closes, with a cooldown", async () => {
    const t5: AgentTrigger = { kind: "price_move", ticker: "TSLA", thresholdPct: 8, window: "5d" };
    const closes = async () => [100, 101, 103, 104, 107, 110].map((close, i) => ({ date: `2026-11-1${i + 2}`, close }));
    const event = firedEvent(await checkTrigger(t5, ctx("2026-11-19T17:00:00Z", { dailyCloses: closes })));
    assert.match(event.title, /\+10\.0%/);
    const w = waiting(await checkTrigger(t5, ctx("2026-11-19T18:00:00Z", { dailyCloses: closes }, { lastFiredByTrigger: { [triggerSignature(t5)]: "2026-11-19T17:00:00.000Z" } })));
    assert.match(w.note, /Paused for 3 days/);
  });
});

describe("news trigger", () => {
  const t: AgentTrigger = { kind: "news", ticker: "AMZN", keywords: ["antitrust", "ftc"] };
  const items = async () => [
    { id: "1", title: "FTC widens Amazon antitrust case", url: "https://example.com/1", publishedAt: "2026-11-19T14:00:00.000Z" },
    { id: "2", title: "Amazon opens a new warehouse", url: "https://example.com/2", publishedAt: "2026-11-19T14:05:00.000Z" },
    { id: "3", title: "Old antitrust story", url: "https://example.com/3", publishedAt: "2026-11-01T14:00:00.000Z" },
  ];

  it("fires on new matching headlines only", async () => {
    const event = firedEvent(await checkTrigger(t, ctx("2026-11-19T15:00:00Z", { news: items })));
    assert.equal(event.news?.length, 1);
    assert.equal(event.news?.[0]?.id, "1");
  });

  it("reports at most every 2 hours", async () => {
    const w = waiting(await checkTrigger(t, ctx("2026-11-19T15:00:00Z", { news: items }, { lastFiredByTrigger: { [triggerSignature(t)]: "2026-11-19T14:30:00.000Z" } })));
    assert.equal(w.nextCheckMs, 90 * MINUTE_MS);
  });
});

describe("macro trigger", () => {
  const t: AgentTrigger = { kind: "macro", event: "CPI" };
  const cal = { macroEvents: () => [{ date: "2026-11-13", timeEt: "08:30", code: "CPI", title: "Consumer Price Index", period: "October 2026", importance: 3 as const }] };

  it("maps a reader's words to calendar codes", () => {
    assert.deepEqual(resolveMacro("inflation print")?.codes, ["CPI"]);
    assert.deepEqual(resolveMacro("Fed decision")?.codes, ["FOMC", "FOMC_PRESSER"]);
    assert.equal(resolveMacro("weather"), null);
  });

  it("waits for the release, then for coverage, then fires", async () => {
    const before = waiting(await checkTrigger(t, ctx("2026-11-12T15:00:00Z", cal)));
    assert.equal(before.nextExpectedAt, "2026-11-13T13:30:00.000Z");
    const noCoverage = waiting(await checkTrigger(t, ctx("2026-11-13T13:40:00Z", cal)));
    assert.match(noCoverage.note, /Waiting for coverage/);
    const event = firedEvent(
      await checkTrigger(
        t,
        ctx("2026-11-13T14:00:00Z", { ...cal, marketNews: async () => [{ id: "c", title: "CPI rose 0.3% in October", url: "https://example.com/c", publishedAt: "2026-11-13T13:35:00.000Z" }] }),
      ),
    );
    assert.deepEqual(event.keys, ["macro:CPI:2026-11-13"]);
    assert.equal(event.news?.length, 1);
  });

  it("says when the calendar has no such release", async () => {
    const w = waiting(await checkTrigger({ kind: "macro", event: "Gold auction" }, ctx("2026-11-12T15:00:00Z", cal)));
    assert.match(w.detail, /2026-12-31/);
  });
});

describe("schedule trigger", () => {
  const t: AgentTrigger = { kind: "schedule", cadence: "weekdays", time: "08:00" };

  it("fires once per occurrence, local time", async () => {
    const now = new Date(2026, 10, 19, 8, 30).toISOString();
    const event = firedEvent(await checkTrigger(t, ctx(now)));
    assert.equal(event.occurrence, new Date(2026, 10, 19, 8, 0).toISOString());
    const w = waiting(await checkTrigger(t, ctx(now, {}, { firedKeys: event.keys })));
    assert.equal(w.nextExpectedAt, new Date(2026, 10, 20, 8, 0).toISOString());
  });

  it("skips weekends and occurrences before the agent existed", async () => {
    const saturday = new Date(2026, 10, 21, 9, 0).toISOString();
    const w = waiting(await checkTrigger(t, ctx(saturday)));
    assert.equal(w.nextExpectedAt, new Date(2026, 10, 23, 8, 0).toISOString());
    waiting(await checkTrigger(t, ctx(new Date(2026, 10, 19, 8, 30).toISOString(), {}, {}, { createdAt: new Date(2026, 10, 19, 8, 15).toISOString() })));
  });
});

/**
 * EDGAR's submissions index stamps an older entry of a file SEC rebuilt since
 * 2026-10-03 with the true instant plus New York's offset, and an entry of the
 * current filing day (or of a file not rebuilt since) with the true UTC
 * instant (research/edgar-time.ts). The reader stores the true instant, so the
 * trigger's timing (after the agent was made, the call three hours on) holds.
 * Morning, midday and evening filings in daylight time and in winter; an
 * evening filing is dated the next business day.
 */
describe("EDGAR acceptance stamps", () => {
  const CASES = [
    { name: "summer 06:30", filedAt: "2026-07-14", old: "2026-07-14T14:30:38.000Z", current: "2026-07-14T10:30:38.000Z" },
    { name: "summer 13:00", filedAt: "2026-07-14", old: "2026-07-14T21:00:00.000Z", current: "2026-07-14T17:00:00.000Z" },
    { name: "summer 20:30", filedAt: "2026-07-15", old: "2026-07-15T04:30:00.000Z", current: "2026-07-15T00:30:00.000Z" },
    { name: "winter 06:30", filedAt: "2026-01-13", old: "2026-01-13T16:30:38.000Z", current: "2026-01-13T11:30:38.000Z" },
    { name: "winter 13:00", filedAt: "2026-01-13", old: "2026-01-13T23:00:00.000Z", current: "2026-01-13T18:00:00.000Z" },
    { name: "winter 20:30", filedAt: "2026-01-14", old: "2026-01-14T06:30:00.000Z", current: "2026-01-14T01:30:00.000Z" },
  ];
  const read = (stamp: string, filedAt: string, fetchedAtMs: number) =>
    filingsFromSubmissions("0001045810", { form: ["8-K"], filingDate: [filedAt], acceptanceDateTime: [stamp], items: ["2.02,9.01"], accessionNumber: ["a-1"], primaryDocument: ["d.htm"] }, fetchedAtMs)[0]!;
  /** The same entry read on 2026-10-15 from a file rebuilt since SEC's change (a Form 4 dated 10-13). */
  const readRebuilt = (stamp: string, filedAt: string) =>
    filingsFromSubmissions(
      "0001045810",
      {
        form: ["4", "8-K"],
        filingDate: ["2026-10-13", filedAt],
        acceptanceDateTime: ["2026-10-14T01:09:29.000Z", stamp],
        items: ["", "2.02,9.01"],
        accessionNumber: ["a-0", "a-1"],
        primaryDocument: ["f4.xml", "d.htm"],
      },
      Date.parse("2026-10-15T21:15:00Z"),
    )[1]!;

  for (const c of CASES) {
    it(`${c.name}: the true instant, read the same day or a week later`, () => {
      const trueMs = Date.parse(c.current);
      assert.equal(filingMs(read(c.current, c.filedAt, trueMs + 20 * MINUTE_MS)), trueMs);
      assert.equal(filingMs(read(c.current, c.filedAt, trueMs + 7 * 24 * HOUR_MS)), trueMs);
      assert.equal(filingMs(readRebuilt(c.old, c.filedAt)), trueMs);
      // A raw stamp without the mark (kept from a read before the change) is the true instant.
      assert.equal(filingMs(filing({ filedAt: c.filedAt, acceptedAt: c.current, acceptedAtUtc: undefined })), trueMs);
    });
  }

  it("a filing accepted before the agent was made does not fire it", async () => {
    // 06:30 New York; read as UTC the old stamp (14:30Z) is 10:30, after an agent made at 08:00.
    const t: AgentTrigger = { kind: "filing", ticker: "NVDA", forms: ["8-K"] };
    const before = readRebuilt("2026-07-14T14:30:38.000Z", "2026-07-14");
    waiting(await checkTrigger(t, ctx("2026-07-21T14:00:00Z", { filings: async () => [before] }, {}, { createdAt: "2026-07-14T12:00:00.000Z" })));
  });

  it("the call write-up waits three hours from a same-day 16:05 release", async () => {
    const call: AgentTrigger = { kind: "earnings", ticker: "NVDA", moment: "call" };
    // 16:05 New York on 2026-11-19 (EST) is 21:05Z; read 21:10Z the stamp is the true instant.
    const release = { ...read("2026-11-19T21:05:00.000Z", "2026-11-19", Date.parse("2026-11-19T21:10:00Z")), accession: "0001045810-26-000101" };
    const src = { earningsDates: async () => ({ dates: ["2026-11-19"], estimated: false }), filings: async () => [release] };
    const w = waiting(await checkTrigger(call, ctx("2026-11-19T21:10:00Z", src)));
    assert.equal(w.nextExpectedAt, "2026-11-20T00:05:00.000Z");
  });
});
