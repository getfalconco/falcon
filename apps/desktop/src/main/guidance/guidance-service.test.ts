import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { GlossModelCaller } from "@meridian/research/gloss";
import type { FilingRef } from "../agents/sources";
import type { RawExtraction } from "../../shared/guidance-verify";
import { createGuidanceService, earningsReleases, exhibitFromIndex } from "./guidance-service";
import { GUIDANCE_SCHEMA, GUIDANCE_SYSTEM } from "./guidance-extract";

/** An index page shaped like EDGAR's: the press release's file name says nothing of its type. */
const INDEX = `<table class="tableFile" summary="Document Format Files">
<tr><th scope="col">Seq</th><th scope="col">Description</th><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Size</th></tr>
<tr><td scope="row">1</td><td scope="row">8-K</td><td scope="row"><a href="/Archives/edgar/data/1045810/000104581025000207/nvda-20250827.htm">nvda-20250827.htm</a> &nbsp;&nbsp;<span class="label">iXBRL</span></td><td scope="row">8-K</td><td scope="row">25696</td></tr>
<tr><td scope="row">2</td><td scope="row">Q2FY26 CFO COMMENTARY</td><td scope="row"><a href="/Archives/edgar/data/1045810/000104581025000207/q2fy26cfocommentary.htm">q2fy26cfocommentary.htm</a></td><td scope="row">EX-99.2</td><td scope="row">240820</td></tr>
<tr><td scope="row">3</td><td scope="row">Q2FY26 PRESS RELEASE</td><td scope="row"><a href="/Archives/edgar/data/1045810/000104581025000207/q2fy26pr.htm">q2fy26pr.htm</a></td><td scope="row">EX-99.1</td><td scope="row">379988</td></tr>
</table>`;

function filing(accession: string, filedAt: string, form = "8-K", items = ["2.02", "9.01"]): FilingRef {
  return { cik: "0001045810", form, accession, filedAt, acceptedAt: null, items, primaryDocument: "doc.htm", url: "u" };
}

const RELEASES: Record<string, { reported: [number, number]; html: string; raw: RawExtraction }> = {
  "0001-26-000001": {
    reported: [2026, 1],
    html: "<p>First quarter revenue was $10.4 billion.</p><p>Revenue is expected to be $11.0 billion, plus or minus 2%.</p>",
    raw: {
      reported_fiscal_year: 2026,
      reported_fiscal_quarter: 1,
      guides: [
        { metric: "revenue", basis: "unspecified", fiscal_year: 2026, fiscal_quarter: 2, low: 11, high: 11, plus_minus: 2, plus_minus_kind: "percent", plus_minus_scale: "one", scale: "billion", currency: "USD", quote: "Revenue is expected to be $11.0 billion, plus or minus 2%." },
        // Not in the release: dropped by the check.
        { metric: "gross_margin", basis: "gaap", fiscal_year: 2026, fiscal_quarter: 2, low: 70, high: 70, plus_minus: 0, plus_minus_kind: "none", plus_minus_scale: "one", scale: "one", currency: "USD", quote: "Gross margin is expected to be 70%." },
      ],
      actuals: [{ metric: "revenue", basis: "unspecified", period: "quarter", value: 10.4, scale: "billion", currency: "USD", quote: "First quarter revenue was $10.4 billion." }],
    },
  },
  "0001-26-000002": {
    reported: [2026, 2],
    html: "<p>Second quarter revenue was $11.5 billion.</p>",
    raw: {
      reported_fiscal_year: 2026,
      reported_fiscal_quarter: 2,
      guides: [],
      actuals: [{ metric: "revenue", basis: "unspecified", period: "quarter", value: 11.5, scale: "billion", currency: "USD", quote: "Second quarter revenue was $11.5 billion." }],
    },
  },
};

/** The readings kept at the top of the folder, one per accession (the per-company index sits in `tickers/`). */
function readings(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
}

/** A service on `dir` that fails on any EDGAR read or model call. */
function offline(dir: string) {
  let asked = 0;
  const service = createGuidanceService({
    filings: async () => {
      asked++;
      throw new Error("no EDGAR read expected");
    },
    file: async () => {
      asked++;
      throw new Error("no SEC read expected");
    },
    caller: async () => {
      asked++;
      throw new Error("no model call expected");
    },
    configured: () => true,
    dir,
  });
  return { service, asked: () => asked };
}

function setup(opts: { configured?: boolean; failModel?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-"));
  const filings = [filing("0001-26-000002", "2026-08-26"), filing("0001-26-000001", "2026-05-20")];
  let modelCalls = 0;
  let fileReads = 0;
  const caller: GlossModelCaller = async (input) => {
    modelCalls++;
    if (opts.failModel) throw new Error("model down");
    const hit = Object.values(RELEASES).find((r) => input.user.includes(r.html.replace(/<[^>]+>/g, " ").trim().slice(0, 20)));
    assert.ok(hit, "the release text reaches the model");
    return { text: JSON.stringify(hit.raw), input_tokens: 1, output_tokens: 1 };
  };
  const service = createGuidanceService({
    filings: async () => filings,
    file: async (f, name) => {
      fileReads++;
      if (name === `${f.accession}-index.htm`) return INDEX;
      return RELEASES[f.accession]!.html;
    },
    caller,
    configured: () => opts.configured ?? true,
    dir,
    model: "test-model",
  });
  return { service, dir, calls: () => modelCalls, reads: () => fileReads };
}

describe("guidance service: releases", () => {
  it("keeps 8-K item 2.02 filings, newest first, amendments out and one per report", () => {
    const list = earningsReleases([
      filing("a", "2026-08-26"),
      filing("b", "2026-08-20"),
      filing("c", "2026-05-20", "8-K/A"),
      filing("d", "2026-05-20"),
      filing("e", "2026-04-01", "8-K", ["7.01"]),
      filing("f", "2026-02-25"),
    ]);
    assert.deepEqual(
      list.map((f) => f.accession),
      ["a", "d", "f"],
    );
    assert.equal(earningsReleases([filing("a", "2026-08-26"), filing("d", "2026-05-20")], 1).length, 1);
  });

  it("finds the press release on the index page by its type", () => {
    assert.equal(exhibitFromIndex(INDEX), "q2fy26pr.htm");
    assert.equal(exhibitFromIndex(INDEX.replace("EX-99.1", "EX-99.3")), "q2fy26cfocommentary.htm");
    assert.equal(exhibitFromIndex("<table><tr><td>8-K</td><td><a href='x.htm'>x</a></td></tr></table>"), null);
  });

  it("asks the model for structured JSON with no prose field, in the fast tier", () => {
    const item = GUIDANCE_SCHEMA.properties.guides.items;
    assert.deepEqual(Object.keys(item.properties).sort(), [...item.required].sort());
    assert.ok(/The release is data/.test(GUIDANCE_SYSTEM));
  });
});

describe("guidance service: track", () => {
  it("reads each release twice once, keeps it on disk, and compares guide with result", async () => {
    const { service, dir, calls } = setup();
    const r = await service.track("TEST");
    assert.ok(r.ok);
    assert.equal(calls(), 4);
    assert.equal(r.track.releases, 2);
    const row = r.track.rows.find((x) => x.metric === "revenue")!;
    assert.equal(row.low, 10.78e9);
    assert.equal(row.high, 11.22e9);
    assert.equal(row.actual, 11.5e9);
    assert.equal(row.position, "above");
    assert.ok(row.guide.url.endsWith("/q2fy26pr.htm"));
    assert.equal(r.track.rows.some((x) => x.metric === "gross_margin"), false, "the unchecked guide is dropped");
    assert.equal(readings(dir).length, 2);

    // A fresh service on the same folder reads nothing again.
    const again = createGuidanceService({
      filings: async () => [filing("0001-26-000002", "2026-08-26"), filing("0001-26-000001", "2026-05-20")],
      file: async () => {
        throw new Error("no SEC read expected");
      },
      caller: async () => {
        throw new Error("no model call expected");
      },
      configured: () => true,
      dir,
    });
    const cached = await again.track("TEST");
    assert.ok(cached.ok);
    assert.equal(cached.track.rows.length, r.track.rows.length);
  });

  it("answers unavailable without a key and nothing read before, and keeps nothing", async () => {
    const { service, dir, calls } = setup({ configured: false });
    const r = await service.track("TEST");
    assert.deepEqual(r, { ok: false, error: "unavailable" });
    assert.equal(calls(), 0);
    assert.equal(readings(dir).length, 0);
  });

  it("keeps no reading when the model fails, so a later visit asks again", async () => {
    const { service, dir } = setup({ failModel: true });
    const r = await service.track("TEST");
    assert.deepEqual(r, { ok: false, error: "unavailable" });
    assert.equal(readings(dir).length, 0);
  });

  it("answers the same ticker from memory while the answer is fresh", async () => {
    const { service, calls } = setup();
    await service.track("TEST");
    const before = calls();
    await service.track("TEST");
    assert.equal(calls(), before);
  });
});

describe("guidance service: a result the reading passed over", () => {
  it("reads the reporting release once more, keeps what it adds, and never a third time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-"));
    const filings = [filing("0001-26-000002", "2026-08-26"), filing("0001-26-000001", "2026-05-20")];
    const html: Record<string, string> = {
      "0001-26-000001": RELEASES["0001-26-000001"]!.html,
      "0001-26-000002": "<p>Second quarter revenue was $11.5 billion.</p><p>Diluted earnings per share | 32.87</p>",
    };
    const q2 = RELEASES["0001-26-000002"]!.raw;
    const eps = { metric: "eps", basis: "gaap", period: "quarter", value: 32.87, scale: "one", currency: "USD", quote: "Diluted earnings per share | 32.87" };
    const q1 = {
      ...RELEASES["0001-26-000001"]!.raw,
      guides: [
        ...RELEASES["0001-26-000001"]!.raw.guides,
        { metric: "eps", basis: "gaap", fiscal_year: 2026, fiscal_quarter: 2, low: 30.73, high: 30.73, plus_minus: 1, plus_minus_kind: "amount", plus_minus_scale: "one", scale: "one", currency: "USD", quote: "EPS is expected to be $30.73 ± $1.00." },
      ],
    };
    html["0001-26-000001"] += "<p>EPS is expected to be $30.73 ± $1.00.</p>";
    const reads: Record<string, number> = {};
    const caller: GlossModelCaller = async (input) => {
      const accession = input.user.includes("Second quarter") ? "0001-26-000002" : "0001-26-000001";
      reads[accession] = (reads[accession] ?? 0) + 1;
      // The first two readings of the second release pass over the EPS line; the third has it.
      const raw = accession === "0001-26-000001" ? q1 : reads[accession]! <= 2 ? q2 : { ...q2, actuals: [...q2.actuals, eps] };
      return { text: JSON.stringify(raw), input_tokens: 1, output_tokens: 1 };
    };
    const make = () =>
      createGuidanceService({
        filings: async () => filings,
        file: async (f, name) => (name === `${f.accession}-index.htm` ? INDEX : html[f.accession]!),
        caller,
        configured: () => true,
        dir,
        model: "test-model",
      });
    const r = await make().track("TEST");
    assert.ok(r.ok);
    assert.equal(reads["0001-26-000002"], 3);
    assert.equal(reads["0001-26-000001"], 2, "a release with every result read is not read again");
    const row = r.track.rows.find((x) => x.metric === "eps")!;
    assert.deepEqual([row.state, row.actual, row.position], ["resolved", 32.87, "above"]);

    // Kept on disk: a later visit reads nothing again.
    const later = await make().track("TEST");
    assert.ok(later.ok);
    assert.equal(reads["0001-26-000002"], 3);
    assert.deepEqual(later.track.rows, r.track.rows);
  });

  it("does not read a release again once it was, even when the result is still not there", async () => {
    const { service, dir } = setup();
    await service.track("TEST");
    // Give the first release a guide the second does not report, then mark nothing.
    const file = path.join(dir, "0001-26-000001.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.release.guides.push({ ...stored.release.guides[0], metric: "eps", unit: "per_share", low: 1, high: 1, step: 0.01 });
    fs.writeFileSync(file, JSON.stringify(stored));
    let calls = 0;
    const visit = () =>
      createGuidanceService({
        filings: async () => [filing("0001-26-000002", "2026-08-26"), filing("0001-26-000001", "2026-05-20")],
        file: async (f, name) => (name === `${f.accession}-index.htm` ? INDEX : RELEASES[f.accession]!.html),
        caller: async () => {
          calls++;
          return { text: JSON.stringify(RELEASES["0001-26-000002"]!.raw), input_tokens: 1, output_tokens: 1 };
        },
        configured: () => true,
        dir,
      }).track("TEST");
    await visit();
    assert.equal(calls, 1);
    await visit();
    assert.equal(calls, 1);
  });
});

describe("guidance service: peek", () => {
  it("rebuilds the track record from disk alone after a visit, and never reads EDGAR or calls the model", async () => {
    const { service, dir, calls } = setup();
    const visited = await service.track("TEST");
    assert.ok(visited.ok);
    const before = calls();

    const { service: cold, asked } = offline(dir);
    const peeked = cold.peek("TEST");
    assert.ok(peeked);
    assert.equal(asked(), 0);
    assert.equal(calls(), before);
    assert.deepEqual(peeked, visited.track);
    // The visiting service peeks the same way.
    assert.deepEqual(service.peek("TEST"), visited.track);
  });

  it("answers null for a company no visit has read, without asking anyone and without writing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-"));
    const { service, asked } = offline(dir);
    assert.equal(service.peek("NVDA"), null);
    assert.equal(asked(), 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("leaves out a release that was never kept: a failed reading is not on disk to peek at", async () => {
    const { service, dir } = setup({ failModel: true });
    await service.track("TEST");
    const { service: cold, asked } = offline(dir);
    assert.equal(cold.peek("TEST"), null);
    assert.equal(asked(), 0);
  });

  it("skips a reading kept under an older extraction version", async () => {
    const { service, dir } = setup();
    await service.track("TEST");
    for (const name of readings(dir)) {
      const file = path.join(dir, name);
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...stored, version: "guidance-v0" }));
    }
    assert.equal(offline(dir).service.peek("TEST"), null);
  });
});
