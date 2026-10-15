import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  edgarAcceptanceIso,
  edgarAcceptanceMs,
  edgarIndexConvention,
  edgarStampIsCurrent,
  edgarStampState,
  filingAcceptedMs,
  inEdgarRebuildWindow,
  nyOffsetMs,
  type EdgarIndexConvention,
} from "./edgar-time.js";

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** "YYYY-MM-DD HH:MM:SS" New York of an instant. */
function ny(ms: number | null): string {
  assert.ok(ms !== null, "expected an instant");
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** A `filings.recent` excerpt from [form, filingDate, acceptanceDateTime] rows. */
function index(rows: ReadonlyArray<readonly [string, string, string]>) {
  return { form: rows.map((r) => r[0]), filingDate: rows.map((r) => r[1]), acceptanceDateTime: rows.map((r) => r[2]) };
}

/**
 * Morning, midday and evening filings in daylight time (2026-07-14) and in
 * winter (2026-01-13): the true instant (the current day's entry, or an older
 * one of a file not rebuilt since SEC's change) and the shifted stamp (an
 * older entry of a file rebuilt since). An evening filing (after 17:30) is
 * dated the next business day.
 */
const CASES = [
  { name: "summer morning", ny: "2026-07-14 06:30:38", filingDate: "2026-07-14", current: "2026-07-14T10:30:38.000Z", old: "2026-07-14T14:30:38.000Z" },
  { name: "summer midday", ny: "2026-07-14 13:00:00", filingDate: "2026-07-14", current: "2026-07-14T17:00:00.000Z", old: "2026-07-14T21:00:00.000Z" },
  { name: "summer evening", ny: "2026-07-14 20:30:00", filingDate: "2026-07-15", current: "2026-07-15T00:30:00.000Z", old: "2026-07-15T04:30:00.000Z" },
  { name: "winter morning", ny: "2026-01-13 06:30:38", filingDate: "2026-01-13", current: "2026-01-13T11:30:38.000Z", old: "2026-01-13T16:30:38.000Z" },
  { name: "winter midday", ny: "2026-01-13 13:00:00", filingDate: "2026-01-13", current: "2026-01-13T18:00:00.000Z", old: "2026-01-13T23:00:00.000Z" },
  { name: "winter evening", ny: "2026-01-13 20:30:00", filingDate: "2026-01-14", current: "2026-01-14T01:30:00.000Z", old: "2026-01-14T06:30:00.000Z" },
] as const;

describe("edgar-time: New York's offset", () => {
  it("is -4h in daylight time and -5h in winter", () => {
    assert.equal(nyOffsetMs(Date.parse("2026-07-14T12:00:00Z")), -4 * 3_600_000);
    assert.equal(nyOffsetMs(Date.parse("2026-01-13T12:00:00Z")), -5 * 3_600_000);
  });
});

describe("edgar-time: acceptance stamps", () => {
  for (const c of CASES) {
    it(`${c.name}: an older entry follows its file's clock`, () => {
      // Read the week after: the entry is old.
      const fetchedAtMs = Date.parse(c.current) + 7 * 86_400_000;
      assert.equal(ny(edgarAcceptanceMs(c.old, { filingDate: c.filingDate, fetchedAtMs, convention: "shifted" })), c.ny);
      assert.equal(ny(edgarAcceptanceMs(c.current, { filingDate: c.filingDate, fetchedAtMs, convention: "utc" })), c.ny);
      // With the fetch time but not the file's word, an older entry is taken as shifted.
      assert.equal(ny(edgarAcceptanceMs(c.old, { filingDate: c.filingDate, fetchedAtMs })), c.ny);
    });

    it(`${c.name}: an entry of the current filing day is the true instant in any file`, () => {
      // Read half an hour after acceptance, the same New York day.
      const fetchedAtMs = Date.parse(c.current) + 30 * 60_000;
      assert.equal(edgarStampIsCurrent(c.filingDate, fetchedAtMs), true);
      for (const convention of ["shifted", "utc", null] as const) {
        assert.equal(ny(edgarAcceptanceMs(c.current, { filingDate: c.filingDate, fetchedAtMs, convention })), c.ny);
      }
      assert.equal(edgarAcceptanceIso(c.current, { filingDate: c.filingDate, fetchedAtMs }), c.current);
    });

    it(`${c.name}: a stamp without the fetch time is taken as the true instant`, () => {
      assert.equal(ny(edgarAcceptanceMs(c.current, { filingDate: c.filingDate })), c.ny);
      assert.equal(ny(edgarAcceptanceMs(c.current)), c.ny);
    });
  }

  it("an evening filing dated the next business day is current until that day has passed", () => {
    // Friday 2026-07-17 18:00 New York, dated Monday 2026-07-20, read Saturday.
    const stamp = "2026-07-17T22:00:00.000Z";
    for (const convention of ["shifted", "utc"] as const) {
      assert.equal(
        ny(edgarAcceptanceMs(stamp, { filingDate: "2026-07-20", fetchedAtMs: Date.parse("2026-07-18T15:00:00Z"), convention })),
        "2026-07-17 18:00:00",
      );
    }
  });

  it("a shifted stamp read without the fetch time is caught by EDGAR's hours when it can be", () => {
    // 20:30 New York shifted is 04:30Z: taken as true it reads 00:30, when EDGAR is closed.
    assert.equal(ny(edgarAcceptanceMs("2026-07-15T04:30:00.000Z", { filingDate: "2026-07-15" })), "2026-07-14 20:30:00");
    // 06:30 shifted is 14:30Z: both readings (10:30, 06:30) sit in EDGAR's hours, so it stays as written.
    assert.equal(ny(edgarAcceptanceMs("2026-07-14T14:30:38.000Z", { filingDate: "2026-07-14" })), "2026-07-14 10:30:38");
  });

  it("an older entry of a file whose clock is known is read by it, even at EDGAR's odd hours", () => {
    // SEC's own EFFECT notices are stamped 00:15 New York (AIRJ 9999999995-26-001957, a true-instant file).
    const ctx = { filingDate: "2026-06-11", fetchedAtMs: Date.parse("2026-10-15T21:14:55Z"), convention: "utc" as const };
    assert.equal(ny(edgarAcceptanceMs("2026-06-12T04:15:05.000Z", ctx)), "2026-06-12 00:15:05");
  });

  it("does not read what does not parse", () => {
    assert.equal(edgarAcceptanceMs("not a date"), null);
    assert.equal(edgarAcceptanceMs(""), null);
    assert.equal(edgarAcceptanceMs(null), null);
    assert.equal(edgarAcceptanceIso(undefined), null);
    assert.equal(edgarStampIsCurrent(null, Date.now()), null);
    assert.equal(edgarStampIsCurrent("2026-07-14", null), null);
  });
});

/**
 * Stamps read from data.sec.gov on the evening of 2026-10-15 (New York), each
 * against the "Accepted" line of its own -index.htm page. `file` is the clock
 * the company's whole file used for older entries that evening; the current
 * day's entries are true in both. Across filing agents (self-filed, Donnelley
 * 0001193125, Workiva 0001628280, Toppan 0001104659, ...), forms and years, a
 * file's older entries all used one clock.
 */
const OBSERVED: ReadonlyArray<{ t: string; acc: string; filingDate: string; stamp: string; accepted: string; file: EdgarIndexConvention }> = [
  { t: "NVDA", acc: "0001045810-26-000078", filingDate: "2026-09-03", stamp: "2026-09-03T16:03:56.000Z", accepted: "2026-09-03 08:03:56", file: "shifted" },
  { t: "NVDA", acc: "0001193125-26-275783", filingDate: "2026-06-18", stamp: "2026-06-19T00:00:24.000Z", accepted: "2026-06-18 16:00:24", file: "shifted" },
  { t: "NVDA", acc: "0001045810-25-000120", filingDate: "2025-06-02", stamp: "2025-05-31T04:56:29.000Z", accepted: "2025-05-30 20:56:29", file: "shifted" },
  { t: "NVDA", acc: "0001045810-23-000039", filingDate: "2023-03-08", stamp: "2023-03-09T02:12:15.000Z", accepted: "2023-03-08 16:12:15", file: "shifted" },
  { t: "AAPL", acc: "0000320193-26-000020", filingDate: "2026-07-31", stamp: "2026-07-31T14:01:02.000Z", accepted: "2026-07-31 06:01:02", file: "shifted" },
  { t: "AAPL", acc: "0001140361-26-039158", filingDate: "2026-10-08", stamp: "2026-10-09T02:30:32.000Z", accepted: "2026-10-08 18:30:32", file: "shifted" },
  { t: "MSFT", acc: "0001193125-26-380280", filingDate: "2026-09-02", stamp: "2026-09-03T00:30:24.000Z", accepted: "2026-09-02 16:30:24", file: "shifted" },
  { t: "MSFT", acc: "0001104659-23-016476", filingDate: "2023-02-09", stamp: "2023-02-09T21:27:41.000Z", accepted: "2023-02-09 11:27:41", file: "shifted" },
  { t: "JPM", acc: "0001225208-26-008053", filingDate: "2026-10-01", stamp: "2026-10-02T00:16:19.000Z", accepted: "2026-10-01 16:16:19", file: "shifted" },
  { t: "JPM", acc: "0001918704-26-031606", filingDate: "2026-10-15", stamp: "2026-10-15T20:44:20.000Z", accepted: "2026-10-15 16:44:20", file: "shifted" },
  { t: "GS", acc: "0000886982-26-000529", filingDate: "2026-10-13", stamp: "2026-10-13T15:32:56.000Z", accepted: "2026-10-13 07:32:56", file: "shifted" },
  { t: "GS", acc: "0001193125-26-423011", filingDate: "2026-10-15", stamp: "2026-10-15T21:04:33.000Z", accepted: "2026-10-15 17:04:33", file: "shifted" },
  { t: "AMKR", acc: "0001047127-23-000009", filingDate: "2023-02-22", stamp: "2023-02-23T01:43:06.000Z", accepted: "2023-02-22 15:43:06", file: "shifted" },
  { t: "AMKR", acc: "0001684564-26-000003", filingDate: "2026-10-15", stamp: "2026-10-15T20:16:38.000Z", accepted: "2026-10-15 16:16:38", file: "shifted" },
  { t: "TSM", acc: "0001628280-26-025362", filingDate: "2026-04-16", stamp: "2026-04-16T14:05:49.000Z", accepted: "2026-04-16 06:05:49", file: "shifted" },
  { t: "TSM", acc: "0001046179-26-000726", filingDate: "2026-10-15", stamp: "2026-10-15T10:40:56.000Z", accepted: "2026-10-15 06:40:56", file: "shifted" },
  { t: "NVO", acc: "0000353278-26-000023", filingDate: "2026-08-04", stamp: "2026-08-05T01:23:40.000Z", accepted: "2026-08-04 17:23:40", file: "shifted" },
  { t: "BNTX", acc: "0001193125-26-003392", filingDate: "2026-01-06", stamp: "2026-01-06T16:02:00.000Z", accepted: "2026-01-06 06:02:00", file: "shifted" },
  { t: "BABA", acc: "9999999995-25-002832", filingDate: "2025-09-04", stamp: "2025-09-05T08:15:13.000Z", accepted: "2025-09-05 00:15:13", file: "shifted" },
  { t: "DRCT", acc: "0001880613-26-000115", filingDate: "2026-10-02", stamp: "2026-10-03T00:03:25.000Z", accepted: "2026-10-02 16:03:25", file: "shifted" },
  { t: "NFLX", acc: "0001065280-26-000214", filingDate: "2026-07-30", stamp: "2026-07-30T20:05:50.000Z", accepted: "2026-07-30 16:05:50", file: "utc" },
  { t: "NFLX", acc: "0001104659-26-113405", filingDate: "2026-10-02", stamp: "2026-10-02T22:13:44.000Z", accepted: "2026-10-02 18:13:44", file: "utc" },
  { t: "TXN", acc: "0000950103-26-014118", filingDate: "2026-09-17", stamp: "2026-09-17T20:11:46.000Z", accepted: "2026-09-17 16:11:46", file: "utc" },
  { t: "TXN", acc: "0001193125-23-070157", filingDate: "2023-03-14", stamp: "2023-03-14T20:14:52.000Z", accepted: "2023-03-14 16:14:52", file: "utc" },
  { t: "TSLA", acc: "0001628280-26-064366", filingDate: "2026-10-02", stamp: "2026-10-02T13:04:26.000Z", accepted: "2026-10-02 09:04:26", file: "utc" },
  { t: "TSLA", acc: "0001193125-23-067846", filingDate: "2023-03-13", stamp: "2023-03-10T23:43:27.000Z", accepted: "2023-03-10 18:43:27", file: "utc" },
  { t: "GOOGL", acc: "0001193125-25-139948", filingDate: "2025-06-12", stamp: "2025-06-12T20:23:59.000Z", accepted: "2025-06-12 16:23:59", file: "utc" },
  { t: "KO", acc: "0001552781-26-000366", filingDate: "2026-06-25", stamp: "2026-06-25T20:19:25.000Z", accepted: "2026-06-25 16:19:25", file: "utc" },
  { t: "JD", acc: "0001193125-26-347753", filingDate: "2026-08-13", stamp: "2026-08-13T10:05:29.000Z", accepted: "2026-08-13 06:05:29", file: "utc" },
  { t: "SAP", acc: "0001104659-25-051206", filingDate: "2025-05-21", stamp: "2025-05-21T10:00:31.000Z", accepted: "2025-05-21 06:00:31", file: "utc" },
  { t: "AIRJ", acc: "0001193125-26-389855", filingDate: "2026-09-14", stamp: "2026-09-14T11:58:26.000Z", accepted: "2026-09-14 07:58:26", file: "utc" },
];

describe("edgar-time: stamps checked against EDGAR's index pages", () => {
  const fetchedAtMs = Date.parse("2026-10-15T21:15:00Z"); // 17:15 New York
  for (const o of OBSERVED) {
    it(`${o.t} ${o.acc} reads ${o.accepted} New York`, () => {
      assert.equal(ny(edgarAcceptanceMs(o.stamp, { filingDate: o.filingDate, fetchedAtMs, convention: o.file })), o.accepted);
    });
  }

  it("the yesterday rows of the first theory", () => {
    const at = Date.parse("2026-10-15T20:20:00Z");
    const read = (stamp: string, filingDate: string) => ny(edgarAcceptanceMs(stamp, { filingDate, fetchedAtMs: at, convention: "shifted" }));
    assert.equal(read("2026-10-15T19:14:31.000Z", "2026-10-15"), "2026-10-15 15:14:31"); // JPM 424B2, same day
    assert.equal(read("2026-10-14T22:19:31.000Z", "2026-10-15"), "2026-10-14 18:19:31"); // evening, dated next day
    assert.equal(read("2026-10-15T01:18:55.000Z", "2026-10-14"), "2026-10-14 17:18:55"); // the day before, rebuilt
  });
});

describe("edgar-time: a file's own clock", () => {
  const FETCHED = Date.parse("2026-10-15T21:15:00Z");

  // Real excerpts of 2026-10-15 reads (the top of each file's `recent`).
  /** NFLX: Form 4s and 144s only, newest older entry 2026-10-02: not rebuilt since SEC's change. */
  const NFLX_TOP = index([
    ["4", "2026-10-02", "2026-10-02T22:13:44Z"],
    ["4", "2026-10-02", "2026-10-02T20:06:24Z"],
    ["4", "2026-10-02", "2026-10-02T20:03:08Z"],
    ["4", "2026-09-10", "2026-09-11T00:04:49Z"],
    ["144", "2026-09-10", "2026-09-10T19:33:49Z"],
  ]);
  /** NVDA: the same kind of entries, the newest dated 2026-10-13: rebuilt since. */
  const NVDA_TOP = index([
    ["4/A", "2026-10-13", "2026-10-14T01:09:29Z"],
    ["4", "2026-10-09", "2026-10-10T01:04:09Z"],
    ["4", "2026-09-23", "2026-09-24T00:56:28Z"],
    ["144", "2026-09-21", "2026-09-22T00:22:56Z"],
    ["4", "2026-09-18", "2026-09-19T01:15:34Z"],
  ]);
  /** DRCT: newest entry 2026-10-02 yet shifted (rebuilt with no new filing); its 8-Ks say so. */
  const DRCT_TOP = index([
    ["8-K", "2026-10-02", "2026-10-03T00:03:25Z"],
    ["8-K", "2026-10-01", "2026-10-02T00:04:39Z"],
    ["8-K", "2026-08-28", "2026-08-29T00:02:36Z"],
    ["8-K", "2026-08-21", "2026-08-21T17:02:26Z"],
    ["10-Q", "2026-08-14", "2026-08-15T00:01:47Z"],
    ["8-K", "2026-08-12", "2026-08-13T00:34:42Z"],
    ["8-K", "2026-07-31", "2026-08-01T00:02:14Z"],
  ]);
  /** NFLX's 8-Ks and others: older entries as the true instant. */
  const NFLX_TELLING = index([
    ["8-K", "2026-07-16", "2026-07-16T20:03:19Z"], // 16:03 EDT release: both readings fit, no say
    ["8-K", "2026-04-23", "2026-04-22T23:13:24Z"], // 19:13 EDT, dated the next day
    ["425", "2025-12-08", "2025-12-06T00:40:12Z"], // Friday 19:40 EST, dated Monday
    ["8-K", "2025-12-05", "2025-12-05T12:31:07Z"], // 07:31 EST
    ["424B2", "2026-07-20", "2026-07-20T12:15:13Z"], // 08:15 EDT
  ]);
  /** NVDA and JPM releases: older entries shifted a second time. */
  const SHIFTED_TELLING = index([
    ["8-K", "2026-08-26", "2026-08-27T00:21:19Z"],
    ["8-K", "2026-02-25", "2026-02-26T02:31:25Z"],
    ["8-K", "2025-11-19", "2025-11-20T02:20:44Z"],
    ["8-K", "2025-08-27", "2025-08-28T00:22:14Z"],
    ["8-K", "2026-10-13", "2026-10-13T14:30:38Z"], // JPM 06:30: both readings in EDGAR's hours
  ]);

  it("tells the clock by the entries that can say", () => {
    assert.equal(edgarIndexConvention(NFLX_TELLING, FETCHED), "utc");
    assert.equal(edgarIndexConvention(SHIFTED_TELLING, FETCHED), "shifted");
    assert.equal(edgarIndexConvention(DRCT_TOP, FETCHED), "shifted");
  });

  it("otherwise by whether an older entry is dated since SEC's change", () => {
    assert.equal(edgarIndexConvention(NFLX_TOP, FETCHED), "utc");
    assert.equal(edgarIndexConvention(NVDA_TOP, FETCHED), "shifted");
    // One 16:03 release says nothing by itself: dated before the change, the file is true.
    assert.equal(edgarIndexConvention(index([["8-K", "2026-07-16", "2026-07-16T20:03:19Z"]]), FETCHED), "utc");
  });

  it("leaves the current day out: a file whose only new entry is today's is not rebuilt yet", () => {
    // AMD on 2026-10-15: a Form 144 of the day over older entries of September.
    const amd = index([
      ["144", "2026-10-15", "2026-10-15T20:22:38Z"],
      ["8-K", "2026-09-28", "2026-09-28T20:16:47Z"],
      ["4", "2026-09-17", "2026-09-17T20:21:30Z"],
    ]);
    assert.equal(edgarIndexConvention(amd, FETCHED), "utc");
    // Without the fetch time, today's entry counts as older and says rebuilt.
    assert.equal(edgarIndexConvention(amd), "shifted");
  });

  it("ignores the date-only stamps EDGAR kept until 2002", () => {
    // WEIS: 1990s entries at New York midnight read as shifted evening ones; they would outvote its 8-Ks.
    const weis = index([
      ["8-K", "2026-05-06", "2026-05-06T12:37:43Z"], // 08:37 EDT
      ["8-K", "2026-03-13", "2026-03-13T13:39:56Z"], // 09:39 EDT
      ["10-K", "2002-03-08", "2002-03-08T05:00:00Z"],
      ["DEF 14A", "2002-03-07", "2002-03-07T05:00:00Z"],
      ["SC 13G", "2002-02-19", "2002-02-19T05:00:00Z"],
      ["SC 13G/A", "2002-02-14", "2002-02-14T05:00:00Z"],
    ]);
    assert.equal(edgarIndexConvention(weis, FETCHED), "utc");
  });

  it("says nothing of a file with no entries", () => {
    assert.equal(edgarIndexConvention(undefined, FETCHED), null);
    assert.equal(edgarIndexConvention({ form: [], filingDate: [], acceptanceDateTime: [] }, FETCHED), null);
  });

  it("reads a 16:03 release of a true-instant file at 16:03, not 12:03", () => {
    const stamp = "2026-07-16T20:03:19.000Z";
    const convention = edgarIndexConvention(NFLX_TOP, FETCHED);
    assert.equal(ny(edgarAcceptanceMs(stamp, { filingDate: "2026-07-16", fetchedAtMs: FETCHED, convention })), "2026-07-16 16:03:19");
    assert.equal(ny(edgarAcceptanceMs("2026-08-27T00:21:19.000Z", { filingDate: "2026-08-26", fetchedAtMs: FETCHED, convention: "shifted" })), "2026-08-26 16:21:19");
  });
});

describe("edgar-time: the midnight window", () => {
  // 13:00 New York on 2026-07-14 (17:00Z); after the rebuild the index writes 21:00Z.
  const midday = { filingDate: "2026-07-14", trueStamp: "2026-07-14T17:00:00.000Z", shifted: "2026-07-14T21:00:00.000Z" };
  const at = (iso: string) => Date.parse(iso);

  it("marks the previous day read before 00:45 New York as ambiguous", () => {
    assert.equal(edgarStampState("2026-07-14", at("2026-07-15T04:10:00Z")), "ambiguous"); // 00:10
    assert.equal(edgarStampState("2026-07-14", at("2026-07-15T04:44:00Z")), "ambiguous"); // 00:44
    assert.equal(edgarStampState("2026-07-14", at("2026-07-15T04:46:00Z")), "old"); // 00:46
    assert.equal(edgarStampState("2026-07-13", at("2026-07-15T04:10:00Z")), "old"); // two days back
    assert.equal(edgarStampState("2026-07-15", at("2026-07-15T04:10:00Z")), "current");
    assert.equal(edgarStampIsCurrent("2026-07-14", at("2026-07-15T04:10:00Z")), false);
    // Winter: 00:10 EST is 05:10Z.
    assert.equal(edgarStampState("2026-01-13", at("2026-01-14T05:10:00Z")), "ambiguous");
    assert.equal(edgarStampState("2026-01-13", at("2026-01-14T05:50:00Z")), "old");
  });

  it("before the rebuild, takes the previous day's stamp as the true instant", () => {
    const fetchedAtMs = at("2026-07-15T04:10:00Z"); // 00:10 New York
    assert.equal(ny(edgarAcceptanceMs(midday.trueStamp, { filingDate: midday.filingDate, fetchedAtMs, convention: "shifted" })), "2026-07-14 13:00:00");
  });

  it("after the rebuild, takes it as shifted", () => {
    const fetchedAtMs = at("2026-07-15T04:35:00Z"); // 00:35 New York
    assert.equal(ny(edgarAcceptanceMs(midday.shifted, { filingDate: midday.filingDate, fetchedAtMs, convention: "shifted" })), "2026-07-14 13:00:00");
    // Winter: 13:00 EST is 18:00Z, shifted 23:00Z; read 00:35 EST.
    assert.equal(
      ny(edgarAcceptanceMs("2026-01-13T23:00:00.000Z", { filingDate: "2026-01-13", fetchedAtMs: at("2026-01-14T05:35:00Z") })),
      "2026-01-13 13:00:00",
    );
  });

  it("in a file whose older entries are still true, the previous day is true on either side", () => {
    const fetchedAtMs = at("2026-07-15T04:35:00Z"); // 00:35 New York
    assert.equal(ny(edgarAcceptanceMs(midday.trueStamp, { filingDate: midday.filingDate, fetchedAtMs, convention: "utc" })), "2026-07-14 13:00:00");
  });

  it("settles a morning stamp by EDGAR's hours on either side of the rebuild", () => {
    // 06:30:38 New York not yet rebuilt at 00:35 (a late rebuild): shifted would read 02:30.
    assert.equal(
      ny(edgarAcceptanceMs("2026-07-14T10:30:38.000Z", { filingDate: "2026-07-14", fetchedAtMs: at("2026-07-15T04:35:00Z") })),
      "2026-07-14 06:30:38",
    );
    // The limit: a stamp already shifted at 00:10 (an early rebuild) with both readings inside
    // EDGAR's hours is read by the fetch's side of the expected rebuild, here as not yet rebuilt.
    assert.equal(
      ny(edgarAcceptanceMs("2026-07-14T14:05:00.000Z", { filingDate: "2026-07-14", fetchedAtMs: at("2026-07-15T04:10:00Z") })),
      "2026-07-14 10:05:00",
    );
  });

  it("an evening filing of two days back, dated the previous day, is settled by EDGAR's hours", () => {
    // 2026-07-13 21:00 New York, dated 07-14: true 01:00Z on 07-14, shifted 05:00Z.
    const ctx = (fetched: string) => ({ filingDate: "2026-07-14", fetchedAtMs: at(fetched) });
    assert.equal(ny(edgarAcceptanceMs("2026-07-14T01:00:00.000Z", ctx("2026-07-15T04:10:00Z"))), "2026-07-13 21:00:00");
    assert.equal(ny(edgarAcceptanceMs("2026-07-14T05:00:00.000Z", ctx("2026-07-15T04:10:00Z"))), "2026-07-13 21:00:00");
  });

  it("never reads an acceptance after the fetch", () => {
    // Taken as current, 04:30Z would be after a 04:10Z fetch.
    const fetchedAtMs = at("2026-07-15T04:10:00Z");
    const ms = edgarAcceptanceMs("2026-07-15T04:30:00.000Z", { filingDate: "2026-07-15", fetchedAtMs });
    assert.ok(ms !== null && ms <= fetchedAtMs);
  });

  it("says when a day-level read should expire soon", () => {
    assert.equal(inEdgarRebuildWindow(at("2026-07-15T04:00:00Z")), true); // 00:00
    assert.equal(inEdgarRebuildWindow(at("2026-07-15T04:44:59Z")), true); // 00:44
    assert.equal(inEdgarRebuildWindow(at("2026-07-15T04:45:00Z")), false); // 00:45
    assert.equal(inEdgarRebuildWindow(at("2026-07-15T03:59:00Z")), false); // 23:59
    assert.equal(inEdgarRebuildWindow(at("2026-01-14T05:20:00Z")), true); // 00:20 EST
    assert.equal(inEdgarRebuildWindow(at("2026-01-14T04:20:00Z")), false); // 23:20 EST
    assert.equal(inEdgarRebuildWindow(Number.NaN), false);
  });
});

describe("edgar-time: filing records", () => {
  it("takes a record read at fetch time as it is", () => {
    assert.equal(ny(filingAcceptedMs({ acceptedAt: "2026-07-14T17:00:00.000Z", acceptedAtUtc: true, filedAt: "2026-07-14" })), "2026-07-14 13:00:00");
  });

  it("reads a record without the mark as SEC's stamp of its day: the true instant", () => {
    // Tracker state backfilled 2026-08-23..25 (falcon-engine seed): NVDA 8-K 0001045810-20-000145, 16:21:46 EDT.
    assert.equal(ny(filingAcceptedMs({ acceptedAt: "2020-08-19T20:21:46.000Z", filedAt: "2020-08-19" })), "2020-08-19 16:21:46");
    // A shifted evening stamp is still caught by EDGAR's hours.
    assert.equal(ny(filingAcceptedMs({ acceptedAt: "2026-07-15T04:30:00.000Z", filedAt: "2026-07-15" })), "2026-07-14 20:30:00");
    assert.equal(filingAcceptedMs({ acceptedAt: null, filedAt: "2026-07-14" }), null);
    assert.equal(filingAcceptedMs({ acceptedAt: "junk", acceptedAtUtc: true }), null);
  });
});
