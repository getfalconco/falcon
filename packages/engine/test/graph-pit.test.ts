import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphEdge } from "../src/graph.ts";
import { accessionFromUrl, annualFilings, buildPit, edgesAsOf, sameLink, type FilingLink, type FilingRead } from "../src/graph/pit.ts";

const edge = (p: Partial<GraphEdge>): GraphEdge => ({
  id: `${p.from}:${p.category}:${p.to}`,
  from: "NVDA",
  to: "TSM",
  toName: "Taiwan Semiconductor Manufacturing Company",
  category: "supplier",
  tier: "important",
  disclosedSharePct: null,
  quote: "We use TSMC to make our chips.",
  form: "10-K",
  filedAt: "2026-02-25",
  url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm",
  origin: "test",
  ...p,
});

const link = (p: Partial<FilingLink>): FilingLink => ({ to: "TSM", toName: "TSMC", category: "supplier", tier: "marginal", disclosedSharePct: null, quote: "TSMC makes our GPUs.", ...p });

const read = (filedAt: string, links: FilingLink[], p: Partial<FilingRead> = {}): FilingRead => ({
  form: "10-K",
  accession: `0001045810-${filedAt.slice(2, 4)}-000001`,
  filedAt,
  url: `https://example.test/${filedAt}`,
  ok: true,
  links,
  ...p,
});

test("accessionFromUrl reads the accession folder", () => {
  assert.equal(accessionFromUrl("https://www.sec.gov/Archives/edgar/data/6281/000000628125000153/adi-20251101.htm"), "0000006281-25-000153");
  assert.equal(accessionFromUrl("https://example.com/x.htm"), null);
});

test("annualFilings keeps annual forms since the date, oldest first, once each", () => {
  const blocks = [
    { accessionNumber: ["a3", "a2", "q1", "a1"], filingDate: ["2020-02-20", "2019-02-21", "2019-05-01", "2013-03-01"], form: ["10-K", "10-K/A", "10-Q", "10-K"], primaryDocument: ["x.htm", "y.htm", "z.htm", "w.htm"] },
    { accessionNumber: ["a2"], filingDate: ["2019-02-21"], form: ["10-K/A"], primaryDocument: ["y.htm"] },
  ];
  const got = annualFilings("0001045810", blocks, "2014-01-01");
  assert.deepEqual(got.map((f) => [f.accession, f.form]), [["a2", "10-K/A"], ["a3", "10-K"]]);
  assert.equal(got[1]!.url, "https://www.sec.gov/Archives/edgar/data/1045810/a3/x.htm");
});

test("sameLink: same relation and ticker, or the name when the old read did not resolve", () => {
  const e = edge({});
  assert.ok(sameLink(e, link({})));
  assert.ok(!sameLink(e, link({ category: "customer" })));
  assert.ok(!sameLink(e, link({ to: "INTC" })));
  assert.ok(sameLink(e, link({ to: null, toName: "Taiwan Semiconductor Manufacturing Company Limited" })));
  assert.ok(!sameLink(e, link({ to: null, toName: "Samsung" })));
});

test("buildPit: first seen is the earliest report holding the link; gaps do not end it", () => {
  const e = edge({});
  const reads = {
    NVDA: [
      read("2014-03-13", []),
      read("2016-03-17", [link({})]),
      read("2017-03-01", []), // a miss in the middle
      read("2018-02-28", [link({ tier: "important" })]),
      read("2026-02-25", [link({ tier: "important" })], { accession: "0001045810-26-000021" }),
    ],
  };
  const [p] = buildPit([e], reads);
  assert.equal(p!.firstSeen.filedAt, "2016-03-17");
  assert.equal(p!.lastSeen.filedAt, "2026-02-25");
  assert.equal(p!.endedAt, null);
  assert.equal(p!.seenIn, 3);
  assert.equal(p!.checkedIn, 4);
  assert.equal(p!.basis, "history");
  assert.equal(p!.current, true);
});

test("buildPit: a filer without history is dated by the edge's own filing", () => {
  const [p] = buildPit([edge({})], {});
  assert.equal(p!.firstSeen.filedAt, "2026-02-25");
  assert.equal(p!.firstSeen.accession, "0001045810-26-000021");
  assert.equal(p!.basis, "source");
  assert.equal(p!.seenIn, 1);
});

test("buildPit: a failed read is not absence, an amendment does not end a link", () => {
  const e = edge({ filedAt: "2018-02-28", url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581018000010/x.htm" });
  const reads = {
    NVDA: [
      read("2017-03-01", [link({})]),
      read("2018-02-28", [link({})], { accession: "0001045810-18-000010" }),
      read("2018-04-01", [], { form: "10-K/A", accession: "amend" }),
      read("2019-02-21", [], { ok: false, accession: "failed" }),
    ],
  };
  const [p] = buildPit([e], reads);
  assert.equal(p!.firstSeen.filedAt, "2017-03-01");
  assert.equal(p!.endedAt, null);
  // The next original report that reads fine and lacks it ends it.
  reads.NVDA.push(read("2020-02-20", []));
  const [q] = buildPit([e], reads);
  assert.equal(q!.endedAt, "2020-02-20");
});

test("buildPit: links only older reports state come out as not current, with their end", () => {
  const reads = {
    NVDA: [read("2015-03-12", [link({ to: "ARM", toName: "ARM Holdings", category: "competitor" }), link({})]), read("2016-03-17", [link({})]), read("2026-02-25", [link({})], { accession: "0001045810-26-000021" })],
  };
  const out = buildPit([edge({})], reads);
  const old = out.find((x) => x.to === "ARM")!;
  assert.equal(old.current, false);
  assert.equal(old.firstSeen.filedAt, "2015-03-12");
  assert.equal(old.endedAt, "2016-03-17");
  assert.equal(out.find((x) => x.to === "TSM")!.firstSeen.filedAt, "2015-03-12");
});

test("edgesAsOf: known when first seen on or before the date, not after it ends", () => {
  const es = [
    { id: "a", firstSeen: { filedAt: "2016-03-17" }, endedAt: null },
    { id: "b", firstSeen: { filedAt: "2018-06-30" }, endedAt: null },
    { id: "c", firstSeen: { filedAt: "2018-07-01" }, endedAt: null },
    { id: "d", firstSeen: { filedAt: "2015-03-12" }, endedAt: "2017-03-01" },
    { id: "e", firstSeen: { filedAt: "2015-03-12" }, endedAt: "2019-02-21" },
  ];
  assert.deepEqual(edgesAsOf(es, "2018-06-30").map((e) => e.id), ["a", "b", "e"]);
  assert.deepEqual(edgesAsOf(es, "2018-06-30", true).map((e) => e.id), ["a", "b", "d", "e"]);
});
