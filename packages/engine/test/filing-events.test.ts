import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StudySummary } from "../src/study/abnormal.ts";
import { byAccession, dedupeByIssuer, delistedAfter, hasItem402, headerParties, oneSidedPIn, parseMasterIndex, passesBar, subjectOf13D } from "../src/study/filing-events.ts";

const MASTER = `Description:           Master Index of EDGAR Dissemination Feed
CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
1000683|BLONDER TONGUE LABORATORIES INC|SC 13D|2019-05-02|edgar/data/1000683/0001137439-19-000157.txt
1054061|WILLIAMS JAMES H /NJ/|SC 13D|2019-05-02|edgar/data/1054061/0001137439-19-000157.txt
1000683|BLONDER TONGUE LABORATORIES INC|SC 13D/A|2019-05-09|edgar/data/1000683/0001137439-19-000170.txt
0000320193|APPLE INC|NT 10-K|2019-06-28|edgar/data/320193/0000320193-19-000001.txt
320193|APPLE INC|NT 10-K/A|2019-06-29|edgar/data/320193/0000320193-19-000002.txt
`;

describe("events-v1 samples (src/study/filing-events.ts)", () => {
  it("reads exact form types from a master index, amendments left out", () => {
    const rows = parseMasterIndex(MASTER, new Set(["SC 13D", "NT 10-K"]));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[2], { cik: "320193", name: "APPLE INC", form: "NT 10-K", date: "2019-06-28", accession: "0000320193-19-000001" });
    const acc = byAccession(rows);
    assert.deepEqual(acc.get("0001137439-19-000157")!.map((r) => r.cik), ["1000683", "1054061"]);
  });

  it("finds a 13D's subject company from the CIKs it lists", () => {
    const listed = new Set(["1000683", "320193"]);
    const has = (c: string) => listed.has(c);
    assert.deepEqual(subjectOf13D(["1000683", "1054061"], has), { kind: "subject", cik: "1000683" });
    assert.deepEqual(subjectOf13D(["1000683"], has), { kind: "self_filed" });
    assert.deepEqual(subjectOf13D(["1000683", "1000683"], has), { kind: "self_filed" });
    assert.deepEqual(subjectOf13D(["5", "6"], has), { kind: "no_listed_cik" });
    assert.deepEqual(subjectOf13D(["1000683", "320193", "7"], has), { kind: "ambiguous", ciks: ["1000683", "320193"] });
  });

  it("reads SUBJECT COMPANY and FILED BY from an SEC header", () => {
    const h = `<SEC-HEADER>
SUBJECT COMPANY:
	COMPANY DATA:
		COMPANY CONFORMED NAME:			TARGET CORP
		CENTRAL INDEX KEY:			0000027419
FILED BY:
	COMPANY DATA:
		COMPANY CONFORMED NAME:			HOLDER INC
		CENTRAL INDEX KEY:			0000320193
</SEC-HEADER>`;
    assert.deepEqual(headerParties(h), { subject: "27419", filers: ["320193"] });
    assert.deepEqual(headerParties("nothing"), { subject: null, filers: [] });
  });

  it("keeps one event per issuer per 30 days", () => {
    const r = dedupeByIssuer([
      { issuer: "1", date: "2020-03-31" },
      { issuer: "1", date: "2020-04-15" },
      { issuer: "2", date: "2020-04-15" },
      { issuer: "1", date: "2020-05-01" },
      { issuer: "1", date: "2020-05-16" },
    ]);
    assert.deepEqual(r.kept, [
      { issuer: "1", date: "2020-03-31" },
      { issuer: "2", date: "2020-04-15" },
      { issuer: "1", date: "2020-05-01" },
    ]);
    assert.equal(r.dropped, 2);
  });

  it("delisted later, item 4.02", () => {
    assert.equal(delistedAfter(["2018-01-02", "2021-06-01"], "2020-01-01"), true);
    assert.equal(delistedAfter(["2018-01-02"], "2020-01-01"), false);
    assert.equal(delistedAfter(undefined, "2020-01-01"), false);
    assert.equal(hasItem402(["4.01", "4.02", "9.01"]), true);
    assert.equal(hasItem402(["4.01"]), false);
    assert.equal(hasItem402(null), false);
  });
});

describe("events-v1 pass bar", () => {
  const summary = (mean: number, tDate: number, tTwo: number, n = 500): StudySummary => ({
    n,
    g: 400,
    mean,
    median: mean,
    positive: 0.5,
    byDate: { mean, se: 1, t: tDate, df: 399, p: 0 },
    twoWay: { mean, se: 1, t: tTwo, df: 120, p: 0, firms: 300, months: 121 },
    bootstrapP: null,
  });

  it("one-sided p in the expected direction", () => {
    assert.ok(oneSidedPIn(-2.5, 120, -1) < 0.01);
    assert.ok(oneSidedPIn(-2.5, 120, 1) > 0.99);
    assert.ok(Math.abs(oneSidedPIn(2.2165, 137, 1) - 0.014) < 0.001); // F7's registered p
  });

  it("a negative family passes on a reliably negative mean, fails on the other sign or noise", () => {
    assert.equal(passesBar(summary(-2, -3, -2.5), -1).pass, true);
    assert.equal(passesBar(summary(2, 3, 2.5), -1).pass, false);
    const weak = passesBar(summary(-0.5, -2, -1.2), -1);
    assert.equal(weak.pass, false);
    assert.ok(weak.why.some((w) => /two-way/.test(w)));
    assert.ok(passesBar(summary(-2, -3, -2.5, 99), -1).why.some((w) => /n 99/.test(w)));
    assert.equal(passesBar(summary(0.96, 2.99, 2.2165), 1).pass, true); // F7 itself
    assert.equal(passesBar(null, 1).pass, false);
  });
});
