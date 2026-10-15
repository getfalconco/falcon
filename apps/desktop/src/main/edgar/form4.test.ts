import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { footnoteSaysPlan, parseOwnershipXml, roleOf, roleText } from "./form4";
import { form4Xml } from "./form4-fixtures";

describe("Form 4 reader", () => {
  it("reads reporters, purchase and sale lines in document order", () => {
    const doc = parseOwnershipXml(
      form4Xml({
        ownerName: "Smith John &amp; Co",
        title: "EVP, Chief Financial Officer",
        lines: [
          { code: "P", date: "2026-10-01", shares: 1_000, price: 41.5, after: 6_000 },
          { code: "S", date: "2026-10-02", shares: 200, price: 43, after: 5_800 },
        ],
      }),
    );
    assert.ok(doc);
    assert.equal(doc.issuerSymbol, "EXMP");
    assert.equal(doc.reporters.length, 1);
    assert.equal(doc.reporters[0]!.name, "Smith John & Co");
    assert.equal(doc.reporters[0]!.cik, "0009000001");
    assert.equal(roleOf(doc.reporters[0]), "cfo");
    assert.equal(roleText(doc.reporters[0]), "EVP, Chief Financial Officer");
    assert.deepEqual(
      doc.lines.map((l) => [l.code, l.date, l.shares, l.price, l.acquiredDisposed, l.sharesAfter, l.derivative]),
      [
        ["P", "2026-10-01", 1000, 41.5, "A", 6000, false],
        ["S", "2026-10-02", 200, 43, "D", 5800, false],
      ],
    );
    assert.equal(doc.aff10b5One, false);
    assert.ok(doc.lines.every((l) => !l.plan));
  });

  it("keeps derivative lines apart from the non-derivative ones", () => {
    const doc = parseOwnershipXml(
      form4Xml({
        lines: [{ code: "M", date: "2026-10-01", shares: 5_000, price: 50, after: 9_000 }],
        derivative: [{ code: "M", date: "2026-10-01", shares: 5_000, price: 0, ad: "D", after: 15_000 }],
      }),
    );
    assert.ok(doc);
    assert.deepEqual(
      doc.lines.map((l) => [l.code, l.derivative]),
      [
        ["M", false],
        ["M", true],
      ],
    );
  });

  it("marks a line made under a Rule 10b5-1 plan, from the form's box or the line's footnote", () => {
    const boxed = parseOwnershipXml(form4Xml({ aff10b5One: true, lines: [{ code: "S", date: "2026-10-01", shares: 10 }] }));
    assert.equal(boxed!.lines[0]!.plan, true);

    const footnoted = parseOwnershipXml(
      form4Xml({
        lines: [
          { code: "S", date: "2026-10-01", shares: 10, footnotes: ["F1"] },
          { code: "S", date: "2026-10-01", shares: 10, footnotes: ["F2"] },
        ],
        footnotes: {
          F1: "The sales reported on this Form 4 were effected pursuant to a Rule 10b5-1 trading plan adopted by the reporting person on May 1, 2026.",
          F2: "The price reported is a weighted average price.",
        },
      }),
    );
    assert.deepEqual(
      footnoted!.lines.map((l) => l.plan),
      [true, false],
    );
    assert.equal(footnoted!.footnotes.F2, "The price reported is a weighted average price.");
  });

  it("does not read a footnote that denies a plan as one", () => {
    assert.equal(footnoteSaysPlan("These shares were not sold pursuant to a Rule 10b5-1 trading plan."), false);
    assert.equal(footnoteSaysPlan("Intended to satisfy the affirmative defense of Rule 10b5-1(c)."), true);
    assert.equal(footnoteSaysPlan("Weighted average price between $10.00 and $10.50."), false);
  });

  it("reads holdings rows and the indirect owner", () => {
    const doc = parseOwnershipXml(
      form4Xml({
        lines: [{ code: "P", date: "2026-10-01", shares: 100, after: 300, ownership: "I", nature: "By Trust" }],
        holdings: [{ shares: 4_000, ownership: "D" }],
      }),
    );
    assert.equal(doc!.lines[0]!.ownership, "I");
    assert.equal(doc!.lines[0]!.nature, "By Trust");
    assert.deepEqual(doc!.holdings.map((h) => [h.shares, h.ownership, h.derivative]), [[4000, "D", false]]);
  });

  it("reads roles from titles and boxes", () => {
    const r = (officerTitle: string | null, extra: Partial<{ isDirector: boolean; isOfficer: boolean; isTenPercentOwner: boolean; otherText: string | null }> = {}) => ({
      cik: null,
      name: "x",
      isDirector: false,
      isOfficer: officerTitle !== null,
      isTenPercentOwner: false,
      officerTitle,
      otherText: null as string | null,
      ...extra,
    });
    assert.equal(roleOf(r("President and CEO")), "ceo");
    assert.equal(roleOf(r("Chief Executive Officer and Chief Financial Officer")), "ceo");
    assert.equal(roleOf(r("Principal Financial Officer")), "cfo");
    assert.equal(roleOf(r("General Counsel")), "officer");
    assert.equal(roleOf(r(null, { isDirector: true })), "director");
    assert.equal(roleOf(r(null, { isTenPercentOwner: true })), "owner10");
    assert.equal(roleOf(r(null)), "other");
    // Officers who tick "Other" and type their title there.
    assert.equal(roleOf(r(null, { otherText: "President, Latin America OU" })), "officer");
    assert.equal(roleOf(r(null, { otherText: "Member of 10% group" })), "other");
  });

  it("reads a trimmed copy without the table and owner wrappers", () => {
    const doc = parseOwnershipXml(
      `<ownershipDocument><rptOwnerName>Jane Doe</rptOwnerName><officerTitle>CFO</officerTitle><nonDerivativeTransaction><transactionDate><value>2026-10-10</value></transactionDate><transactionCode>S</transactionCode><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>50</value></transactionPricePerShare></nonDerivativeTransaction></ownershipDocument>`,
    );
    assert.deepEqual(doc!.reporters.map((r) => [r.name, roleOf(r)]), [["Jane Doe", "cfo"]]);
    assert.deepEqual(doc!.lines.map((l) => [l.code, l.shares, l.price, l.derivative]), [["S", 100, 50, false]]);
  });

  it("returns null for anything that is not an ownership document", () => {
    assert.equal(parseOwnershipXml("<html><body>Form 4</body></html>"), null);
  });
});
