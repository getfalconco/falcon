import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createSecLimiter } from "@meridian/research/sec-fetch";
import {
  filingHistory,
  filingsFromSubmissions,
  olderPagesFor,
  pruneKept,
  releaseCount,
  SUBMISSIONS_KEEP_MAX,
  SUBMISSIONS_KEEP_MS,
  type SubmissionsPageRef,
  type SubmissionsRecent,
} from "./edgar";
import type { FilingRef } from "./sources";

describe("pruneKept (the kept EDGAR submissions indexes)", () => {
  const NOW = Date.parse("2026-10-16T12:00:00Z");

  it("drops indexes older than a day and keeps the rest", () => {
    const map = new Map([
      ["old", { at: NOW - SUBMISSIONS_KEEP_MS - 1 }],
      ["edge", { at: NOW - SUBMISSIONS_KEEP_MS }],
      ["fresh", { at: NOW - 60_000 }],
    ]);
    pruneKept(map, NOW);
    assert.deepEqual([...map.keys()], ["edge", "fresh"]);
  });

  it("keeps at most the cap, the oldest going first", () => {
    const map = new Map<string, { at: number }>();
    for (let i = 0; i < SUBMISSIONS_KEEP_MAX + 5; i++) map.set(`c${i}`, { at: NOW - (SUBMISSIONS_KEEP_MAX + 5 - i) * 1000 });
    pruneKept(map, NOW);
    assert.equal(map.size, SUBMISSIONS_KEEP_MAX);
    assert.equal(map.keys().next().value, "c5");
    assert.ok(map.has(`c${SUBMISSIONS_KEEP_MAX + 4}`));
  });
});

// ---------------------------------------------------------------------------
// Heavy filers: `filings.recent` full of structured-note 424B2s, the reports in older pages.
// ---------------------------------------------------------------------------

type Row = [form: string, filingDate: string, acceptance: string, items?: string];

function columns(rows: Row[], prefix: string): SubmissionsRecent {
  return {
    form: rows.map((r) => r[0]),
    filingDate: rows.map((r) => r[1]),
    acceptanceDateTime: rows.map((r) => r[2]),
    items: rows.map((r) => r[3] ?? ""),
    accessionNumber: rows.map((_, i) => `${prefix}-${String(i).padStart(6, "0")}`),
    primaryDocument: rows.map((r, i) => `${r[0].toLowerCase().replace(/[^a-z0-9]/g, "")}${i}.htm`),
  };
}

/** n pricing supplements, forty a day back from `from`, accepted mid-morning (they vote for no clock). */
function notes(n: number, from: string): Row[] {
  const start = Date.parse(`${from}T15:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(start - Math.floor(i / 40) * 86_400_000).toISOString().slice(0, 10);
    return ["424B2", day, `${day}T15:00:00.000Z`] as Row;
  });
}

const JPM_CIK = "0000019617";
const FETCHED = Date.parse("2026-10-16T14:00:00Z");

/** JPM's shape: `recent` is a year of 424B2s with a 10-Q, a release and a Form 4 past the first thousand; no 10-K. */
const RECENT = columns(
  [
    ...notes(1200, "2026-10-15"),
    ["4", "2026-08-20", "2026-08-20T21:00:00.000Z"],
    ["10-Q", "2026-08-01", "2026-08-01T20:00:00.000Z"],
    ["8-K", "2026-07-14", "2026-07-14T14:45:00.000Z", "2.02,9.01"], // shifted, like the rest of this file: true 10:45Z (06:45 EDT)
    ["FWP", "2026-06-01", "2026-06-01T15:00:00.000Z"],
    ...notes(300, "2026-05-01"),
  ],
  "0001918704-26",
);

/**
 * Page 1, rebuilt since SEC's change: its stamps are shifted (true instant
 * plus New York's offset). Three after-close filings dated their own day say
 * so: read as UTC they would be 20:05 New York, past the 17:30 cutoff.
 */
const PAGE_1 = columns(
  [
    ...notes(200, "2025-10-13"),
    ["8-K", "2025-04-11", "2025-04-12T00:05:00.000Z", "2.02,9.01"], // true 2025-04-11T20:05Z (16:05 EDT)
    ["8-K", "2025-03-11", "2025-03-12T00:05:00.000Z", "7.01"],
    ["8-K", "2025-03-04", "2025-03-05T02:05:00.000Z", "8.01"], // true 2025-03-04T21:05Z (16:05 EST)
    ["10-K", "2025-02-14", "2025-02-15T02:05:00.000Z"], // true 2025-02-14T21:05Z (16:05 EST)
  ],
  "0000019617-25",
);

/** Page 2, not rebuilt since: the true instant. Three 06:30 New York filings say so (shifted they would be 01:30). */
const PAGE_2 = columns(
  [
    ...notes(100, "2025-01-31"),
    ["8-K", "2025-01-15", "2025-01-15T11:30:00.000Z", "2.02,9.01"],
    ["8-K", "2024-12-10", "2024-12-10T11:30:00.000Z", "7.01"],
    ["8-K", "2024-11-12", "2024-11-12T11:30:00.000Z", "8.01"],
    ["10-K", "2024-02-16", "2024-02-16T21:05:00.000Z"],
  ],
  "0000019617-24",
);

const FILES: SubmissionsPageRef[] = [
  { name: `CIK${JPM_CIK}-submissions-001.json`, filingCount: 204, filingFrom: "2025-02-14", filingTo: "2025-10-13" },
  { name: `CIK${JPM_CIK}-submissions-002.json`, filingCount: 104, filingFrom: "2024-02-16", filingTo: "2025-01-31" },
  { name: `CIK${JPM_CIK}-submissions-003.json`, filingCount: 2000, filingFrom: "2001-01-01", filingTo: "2024-02-15" },
];

describe("filingsFromSubmissions (a heavy filer's newest page)", () => {
  it("keeps every form among the newest thousand, and past them all but 424B and FWP filings", () => {
    const list = filingsFromSubmissions(JPM_CIK, RECENT, FETCHED);
    assert.equal(list.slice(0, 1000).filter((f) => f.form === "424B2").length, 1000);
    assert.equal(list.length, 1003);
    assert.deepEqual(
      list.slice(1000).map((f) => f.form),
      ["4", "10-Q", "8-K"],
    );
    assert.deepEqual(list[1002]!.items, ["2.02", "9.01"]);
  });

  it("keeps no offering paperwork from an older page", () => {
    const list = filingsFromSubmissions(JPM_CIK, PAGE_1, FETCHED, 0);
    assert.deepEqual(
      list.map((f) => f.form),
      ["8-K", "8-K", "8-K", "10-K"],
    );
  });

  it("reads each page's stamps by that page's own clock", () => {
    const shifted = filingsFromSubmissions(JPM_CIK, PAGE_1, FETCHED, 0);
    assert.equal(shifted[0]!.acceptedAt, "2025-04-11T20:05:00.000Z");
    assert.equal(shifted[3]!.acceptedAt, "2025-02-14T21:05:00.000Z");
    const utc = filingsFromSubmissions(JPM_CIK, PAGE_2, FETCHED, 0);
    assert.equal(utc[0]!.acceptedAt, "2025-01-15T11:30:00.000Z");
    assert.equal(utc[3]!.acceptedAt, "2024-02-16T21:05:00.000Z");
    assert.ok(shifted.every((f) => f.acceptedAtUtc) && utc.every((f) => f.acceptedAtUtc));
  });
});

describe("olderPagesFor", () => {
  it("lists the pages reaching the day asked for, newest first", () => {
    assert.deepEqual(olderPagesFor([...FILES].reverse(), "2025-01-01"), [FILES[0]!.name, FILES[1]!.name]);
    assert.deepEqual(olderPagesFor(FILES, "2025-10-14"), []);
    assert.deepEqual(olderPagesFor([{ name: "../../x.json", filingTo: "2026-01-01" }], "2025-01-01"), []);
    assert.deepEqual(olderPagesFor(undefined, "2025-01-01"), []);
  });
});

describe("releaseCount", () => {
  const ref = (form: string, filedAt: string, items: string[] = []): FilingRef => ({
    cik: JPM_CIK,
    form,
    accession: `${form}-${filedAt}`,
    filedAt,
    acceptedAt: null,
    items,
    primaryDocument: null,
    url: "",
  });

  it("counts item 2.02 releases, two within twenty days as one", () => {
    const list = [
      ref("8-K", "2026-07-14", ["2.02"]),
      ref("8-K", "2026-07-02", ["2.02", "9.01"]),
      ref("8-K", "2026-04-14", ["2.02"]),
      ref("8-K", "2026-03-01", ["7.01"]),
      ref("6-K", "2026-01-14", ["2.02"]),
    ];
    assert.equal(releaseCount(list), 2);
    assert.equal(releaseCount([]), 0);
  });
});

describe("filingHistory with older pages (JPM's shape)", () => {
  const LIMITER = Symbol.for("meridian.secLimiter");
  const g = globalThis as unknown as Record<symbol, unknown>;
  const realFetch = globalThis.fetch;
  const realLimiter = g[LIMITER];
  const requested: string[] = [];

  before(() => {
    g[LIMITER] = createSecLimiter({ minGapMs: 0, maxInFlight: 8 });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/files/company_tickers.json")) return json({ 0: { cik_str: 19617, ticker: "JPM", title: "JPMORGAN CHASE & CO" } });
      if (url.endsWith(`/submissions/CIK${JPM_CIK}.json`)) return json({ cik: JPM_CIK, filings: { recent: RECENT, files: FILES } });
      if (url.endsWith(FILES[0]!.name!)) return json(PAGE_1);
      if (url.endsWith(FILES[1]!.name!)) return json(PAGE_2);
      if (url.endsWith(FILES[2]!.name!)) return json(columns(notes(10, "2024-02-15"), "0000019617-23"));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    g[LIMITER] = realLimiter;
  });

  const pageReads = () => requested.filter((u) => /-submissions-\d+\.json$/.test(u)).map((u) => u.slice(-8, -5));

  it("reads no older page without a need: the 10-Q and the release past the thousandth entry are there", async () => {
    requested.length = 0;
    const list = await filingHistory("JPM");
    assert.ok(list.some((f) => f.form === "10-Q"));
    assert.ok(list.some((f) => f.form === "4"));
    assert.ok(!list.some((f) => f.form === "10-K"));
    assert.deepEqual(pageReads(), []);
  });

  it("reads the newest page for the latest 10-K and stops there", async () => {
    requested.length = 0;
    const list = await filingHistory("JPM", { since: "2023-01-01", enough: (l) => l.some((f) => f.form === "10-K") });
    assert.equal(list.find((f) => f.form === "10-K")?.filedAt, "2025-02-14");
    assert.deepEqual(pageReads(), ["001"]);
  });

  it("reads on for the annual report before it, never a page wholly before `since`", async () => {
    requested.length = 0;
    const list = await filingHistory("JPM", { since: "2024-02-16", enough: (l) => l.filter((f) => f.form === "10-K").length >= 2 });
    assert.deepEqual(
      list.filter((f) => f.form === "10-K").map((f) => f.filedAt),
      ["2025-02-14", "2024-02-16"],
    );
    // Page 001 is kept from the read before; 003 ends before `since`.
    assert.deepEqual(pageReads(), ["002"]);
    // Newest first across the pages: the index, then page 001, then page 002.
    const days = list.map((f) => f.filedAt);
    assert.deepEqual(days, [...days].sort((a, b) => b.localeCompare(a)));
  });

  it("covers a window of releases with `since` alone, each stamp read by its own page's clock", async () => {
    const list = await filingHistory("JPM", { since: "2024-06-01" });
    assert.equal(releaseCount(list), 3);
    assert.deepEqual(
      list.filter((f) => f.items.includes("2.02")).map((f) => f.acceptedAt),
      ["2026-07-14T10:45:00.000Z", "2025-04-11T20:05:00.000Z", "2025-01-15T11:30:00.000Z"],
    );
  });
});
