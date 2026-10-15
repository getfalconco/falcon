import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createSecLimiter } from "../research/sec-fetch.js";
import { fetchSubmissions, olderSubmissionPages, type SubmissionsPageRef } from "./sources.js";

/**
 * A heavy filer's submissions index (JPM: a year of structured-note 424B2s in
 * `filings.recent`, its earlier 10-K and releases in older pages).
 */

const CIK = "0000019617";
const FILES: SubmissionsPageRef[] = [
  { name: `CIK${CIK}-submissions-001.json`, filingFrom: "2025-02-14", filingTo: "2025-10-13" },
  { name: `CIK${CIK}-submissions-002.json`, filingFrom: "2001-01-01", filingTo: "2025-02-13" },
];

const RECENT = {
  form: ["424B2", "8-K", "424B2"],
  filingDate: ["2026-10-15", "2026-07-14", "2026-05-01"],
  acceptanceDateTime: ["2026-10-15T15:00:00.000Z", "2026-07-14T14:45:00.000Z", "2026-05-01T15:00:00.000Z"],
  items: ["", "2.02,9.01", ""],
  accessionNumber: ["a-1", "a-2", "a-3"],
  primaryDocument: ["n1.htm", "k2.htm", "n3.htm"],
};

/** Not rebuilt since SEC's change: true instants (three 06:30 New York filings say so). */
const PAGE_1 = {
  form: ["424B2", "8-K", "8-K", "8-K", "10-K"],
  filingDate: ["2025-10-13", "2025-04-11", "2025-03-11", "2025-03-04", "2025-02-14"],
  acceptanceDateTime: [
    "2025-10-13T15:00:00.000Z",
    "2025-04-11T10:30:00.000Z",
    "2025-03-11T10:30:00.000Z",
    "2025-03-04T11:30:00.000Z",
    "2025-02-14T21:05:00.000Z",
  ],
  items: ["", "2.02,9.01", "7.01", "8.01", ""],
  accessionNumber: ["b-1", "b-2", "b-3", "b-4", "b-5"],
  primaryDocument: ["n.htm", "k.htm", "k.htm", "k.htm", "10k.htm"],
};

describe("olderSubmissionPages", () => {
  it("lists the pages reaching the day asked for, newest first", () => {
    assert.deepEqual(olderSubmissionPages([...FILES].reverse(), "2025-01-01"), [FILES[0]!.name, FILES[1]!.name]);
    assert.deepEqual(olderSubmissionPages(FILES, "2025-03-01"), [FILES[0]!.name]);
    assert.deepEqual(olderSubmissionPages(FILES, "2025-10-14"), []);
    assert.deepEqual(olderSubmissionPages([{ name: "x/../y.json" }], "2025-01-01"), []);
  });
});

describe("fetchSubmissions with older pages", () => {
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
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.endsWith(`/submissions/CIK${CIK}.json`)) return json({ filings: { recent: RECENT, files: FILES } });
      if (url.endsWith(FILES[0]!.name!)) return json(PAGE_1);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    g[LIMITER] = realLimiter;
  });

  it("reads only `filings.recent` when no day is asked for", async () => {
    requested.length = 0;
    const { filings } = await fetchSubmissions(CIK);
    assert.deepEqual(
      filings.map((f) => f.form),
      ["8-K"],
    );
    assert.equal(requested.length, 1);
  });

  it("adds the tracked forms of the pages reaching `since`, each stamp by its own page's clock", async () => {
    requested.length = 0;
    const { filings } = await fetchSubmissions(CIK, { since: "2025-03-01" });
    assert.deepEqual(
      filings.map((f) => `${f.form} ${f.filedAt}`),
      ["8-K 2026-07-14", "8-K 2025-04-11", "8-K 2025-03-11", "8-K 2025-03-04", "10-K 2025-02-14"],
    );
    assert.equal(filings[1]!.acceptedAt, "2025-04-11T10:30:00.000Z");
    assert.equal(requested.length, 2);
  });

  it("stops at a page that cannot be read and keeps what came before", async () => {
    const { filings } = await fetchSubmissions(CIK, { since: "2020-01-01" });
    assert.equal(filings.filter((f) => f.form === "10-K").length, 1);
  });
});
