import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { FilingRef } from "../agents/sources";
import { nyWallMs } from "../../shared/earnings-time";
import { form4Xml } from "../edgar/form4-fixtures";
import { FIRST_LOOK_DOCS, FORGET_COMPANY_MS, KEEP_FILINGS_DAYS, createInsidersService } from "./insiders-service";

const NOW = nyWallMs("2026-10-15", 12, 0);
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-insiders-"));
  dirs.push(d);
  return d;
}

function ref(cik: string, form: string, accession: string, filedAt: string): FilingRef {
  return { cik, form, accession, filedAt, acceptedAt: null, items: [], primaryDocument: "xslF345X05/doc.xml", url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/doc.xml` };
}

const LISTS: Record<string, FilingRef[]> = {
  NVDA: [
    ref("0001045810", "4", "a1", "2026-10-02"),
    ref("0001045810", "4", "a2", "2026-10-07"),
    ref("0001045810", "4", "a3", "2026-10-08"),
    ref("0001045810", "10-Q", "q1", "2026-08-27"),
    ref("0001045810", "4", "old", "2026-03-01"),
    // NVIDIA as the owner of another company's shares: listed in its index, not about it.
    ref("0001045810", "4", "owner", "2026-10-09"),
    ref("0001045810", "SCHEDULE 13G", "g-other", "2026-10-09"),
  ],
  TSM: [ref("0001046179", "SC 13D", "d1", "2026-10-12")],
};

const DOCS: Record<string, string> = {
  a1: form4Xml({ issuerCik: "0001045810", ownerCik: "1", ownerName: "Huang", title: "President and CEO", lines: [{ code: "P", date: "2026-10-01", shares: 10_000, price: 120, after: 1_000_000 }] }),
  a2: form4Xml({ issuerCik: "0001045810", ownerCik: "2", ownerName: "Kress", title: "EVP and CFO", lines: [{ code: "P", date: "2026-10-06", shares: 2_000, price: 118, after: 50_000 }] }),
  a3: form4Xml({ issuerCik: "0001045810", ownerCik: "3", ownerName: "Director A", director: true, aff10b5One: true, lines: [{ code: "S", date: "2026-10-07", shares: 5_000, price: 121 }] }),
  owner: form4Xml({ issuerCik: "0001999999", ownerCik: "1045810", ownerName: "NVIDIA CORP", tenPercent: true, lines: [{ code: "P", date: "2026-10-08", shares: 1_000_000, price: 10, after: 9_000_000 }] }),
  "g-other-index-headers.html":
    "<pre>SUBJECT COMPANY:\n COMPANY DATA:\n  COMPANY CONFORMED NAME: OTHER CO\n  CENTRAL INDEX KEY: 0001999999\nFILED BY:\n COMPANY DATA:\n  COMPANY CONFORMED NAME: NVIDIA CORP\n  CENTRAL INDEX KEY: 0001045810\n</pre>",
  d1: `<p>PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (11)</p><p>6.0%</p>`,
  "d1-index-headers.html": "<pre>FILED BY:\n COMPANY DATA:\n  COMPANY CONFORMED NAME: Example Partners LP\n</pre>",
};

function fakes() {
  const reads: string[] = [];
  return {
    reads,
    deps: {
      filings: async (ticker: string) => {
        reads.push(`list:${ticker}`);
        return LISTS[ticker] ?? [];
      },
      file: async (f: FilingRef, name: string | null) => {
        const key = name ?? f.accession;
        reads.push(`file:${key}`);
        return DOCS[key] ?? null;
      },
      graphEdges: async () => [
        {
          root_ticker: "NVDA",
          counterparty_ticker: "TSM",
          category: "supplier",
          strength_tier: "critical",
          confidence: 0.95,
          evidence_quote: "TSMC manufactures our GPUs",
          source_url: "https://www.sec.gov/Archives/edgar/data/1045810/x.htm",
          accession_number: "0001045810-26-000010",
        },
      ],
      now: () => NOW,
      sessionGapMs: 0,
      backgroundGapMs: 0,
    },
  };
}

describe("insiders service", () => {
  it("reads the scope in the background, then answers from what it read", async () => {
    const dir = tmp();
    const { deps, reads } = fakes();
    const service = createInsidersService({ dir, ...deps });
    const first = await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    assert.equal(first.companies, 2);
    assert.ok(first.pending > 0);
    await service.idle();
    const second = await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    assert.equal(second.pending, 0);
    assert.deepEqual(
      second.events.map((e) => [e.ticker, e.kind, e.scope, e.via?.relation ?? null]),
      [
        ["NVDA", "purchase_cluster", "held", null],
        ["TSM", "activist_13d", "linked", "supplier"],
      ],
    );
    assert.equal(second.events[1]!.filing!.filer, "Example Partners LP");
    assert.equal(second.events[1]!.filing!.percent, 6);
    // Old filings and other forms are never fetched; a schedule about another company is dropped after its header.
    assert.ok(!reads.includes("file:old") && !reads.includes("file:q1") && !reads.includes("file:g-other"));
    assert.ok(reads.includes("file:g-other-index-headers.html"));

    // A new service on the same folder reads nothing again within three hours.
    const again = fakes();
    const restarted = createInsidersService({ dir, ...again.deps });
    const third = await restarted.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    await restarted.idle();
    assert.deepEqual(again.reads, []);
    assert.equal(third.events.length, 2);
  });

  it("waits for a focused company's first read", async () => {
    const { deps } = fakes();
    const service = createInsidersService({ dir: tmp(), ...deps });
    const answer = await service.activity({ focus: "NVDA", held: [], watchlist: [] });
    assert.equal(answer.pending, 0);
    assert.deepEqual(answer.events.map((e) => [e.kind, e.scope, e.insiders]), [["purchase_cluster", "focus", 2]]);
  });

  it("stops at its read budget and carries on in the next session by itself", async () => {
    const { deps, reads } = fakes();
    const service = createInsidersService({ dir: tmp(), ...deps, budget: 2 });
    const first = await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    assert.ok(first.pending > 0);
    await service.idle();
    const done = await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    assert.equal(done.pending, 0);
    for (const key of ["file:a1", "file:a2", "file:a3", "file:d1"]) assert.ok(reads.includes(key), key);
  });

  it("reads newest first, own names before linked ones, and older filings after every first look", async () => {
    const dir = tmp();
    const reads: string[] = [];
    const day = (n: number) => new Date(Date.parse("2026-10-14T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);
    const many = Array.from({ length: FIRST_LOOK_DOCS + 5 }, (_, i) => ref("0000000001", "4", `big${i}`, day(i)));
    // A Form 4 just outside the window, listed last: never fetched.
    many.push(ref("0000000001", "4", "big-old", day(KEEP_FILINGS_DAYS + 1)));
    const lists: Record<string, FilingRef[]> = {
      BIG: [...many].reverse(),
      WAT: [ref("0000000002", "4", "w1", day(3))],
      LNK: [ref("0000000003", "4", "l1", day(2))],
    };
    const service = createInsidersService({
      dir,
      filings: async (t) => {
        reads.push(`list:${t}`);
        return lists[t] ?? [];
      },
      file: async (f) => {
        reads.push(f.accession);
        return null;
      },
      graphEdges: async () => [
        { root_ticker: "BIG", counterparty_ticker: "LNK", category: "supplier", strength_tier: "critical", confidence: 0.95, evidence_quote: "q", source_url: "https://www.sec.gov/x", accession_number: "0000000001-26-000001" },
      ],
      now: () => NOW,
      sessionGapMs: 0,
      backgroundGapMs: 0,
    });
    await service.activity({ focus: null, held: ["BIG"], watchlist: ["WAT"] });
    await service.idle();
    const docs = reads.filter((r) => !r.startsWith("list:"));
    // BIG's newest FIRST_LOOK_DOCS, newest first; then the watchlist; then BIG's older ones; then the linked company.
    assert.deepEqual(docs.slice(0, FIRST_LOOK_DOCS), Array.from({ length: FIRST_LOOK_DOCS }, (_, i) => `big${i}`));
    assert.deepEqual(docs.slice(FIRST_LOOK_DOCS), ["w1", "big40", "big41", "big42", "big43", "big44", "l1"]);
    assert.ok(reads.indexOf("list:LNK") > reads.indexOf("big44"));
    assert.ok(!reads.includes("big-old"));
  });

  it("does not keep a company pending on a document that cannot be read", async () => {
    const { deps, reads } = fakes();
    const service = createInsidersService({ dir: tmp(), ...deps, file: async (f, name) => (f.accession === "a2" && name === null ? (reads.push("file:a2"), null) : deps.file(f, name)) });
    await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    await service.idle();
    const answer = await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    await service.idle();
    assert.equal(answer.pending, 0);
    assert.equal(reads.filter((r) => r === "file:a2").length, 1);
  });

  it("does not ask again soon for a list that failed", async () => {
    const { deps, reads } = fakes();
    const service = createInsidersService({
      dir: tmp(),
      ...deps,
      filings: async (t) => {
        reads.push(`list:${t}`);
        throw new Error("503");
      },
    });
    await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    await service.idle();
    await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    await service.idle();
    assert.equal(reads.filter((r) => r === "list:NVDA").length, 1);
  });
});

describe("insiders disk pruning", () => {
  it("drops an issuer's reads of filings its list no longer keeps", async () => {
    const dir = tmp();
    const { deps } = fakes();
    const service = createInsidersService({ dir, ...deps });
    await service.activity({ focus: "NVDA", held: ["NVDA"], watchlist: [] });
    const docsFile = path.join(dir, "docs", "0001045810.json");
    const before = JSON.parse(fs.readFileSync(docsFile, "utf8")) as { form4: Record<string, unknown> };
    assert.ok("a1" in before.form4);

    // Months later the October Form 4s have left the list; a new one came in.
    const later = NOW + (KEEP_FILINGS_DAYS + 10) * 86_400_000;
    const next = fakes();
    const reread = createInsidersService({
      dir,
      ...next.deps,
      now: () => later,
      filings: async (ticker: string) => (ticker === "NVDA" ? [ref("0001045810", "4", "a1", "2027-01-20")] : []),
    });
    await reread.activity({ focus: "NVDA", held: ["NVDA"], watchlist: [] });
    const after = JSON.parse(fs.readFileSync(docsFile, "utf8")) as { form4: Record<string, unknown> };
    assert.deepEqual(Object.keys(after.form4), ["a1"]);
  });

  it("forgets companies not read in a month, and their reads", async () => {
    const dir = tmp();
    const { deps } = fakes();
    const service = createInsidersService({ dir, ...deps });
    await service.activity({ focus: null, held: ["NVDA"], watchlist: [] });
    await service.idle();
    assert.ok(fs.existsSync(path.join(dir, "docs", "0001046179.json")));

    // The reader dropped NVDA (and so its supplier TSM); a month on, another name is read.
    const later = NOW + FORGET_COMPANY_MS + 86_400_000;
    const next = fakes();
    const other = createInsidersService({ dir, ...next.deps, now: () => later });
    await other.activity({ focus: "AAPL", held: ["AAPL"], watchlist: [] });
    await new Promise((r) => setTimeout(r, 20));
    const companies = JSON.parse(fs.readFileSync(path.join(dir, "companies.json"), "utf8")) as { companies: Record<string, unknown> };
    assert.deepEqual(Object.keys(companies.companies), ["AAPL"]);
    assert.ok(!fs.existsSync(path.join(dir, "docs", "0001046179.json")));
    assert.ok(!fs.existsSync(path.join(dir, "docs", "0001045810.json")));
  });
});
