import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filerFromHeader, percentOfClass, purposeAmended, subjectCikFromHeader } from "./schedule13";
import { isStale } from "./freshness";
import { buildScope } from "./scope";
import { nyWallMs } from "../../shared/earnings-time";

const HEADER = `<html><body><pre>
&lt;SEC-HEADER&gt;0001193125-26-000001.hdr.sgml : 20261010
ACCESSION NUMBER:		0001193125-26-000001
CONFORMED SUBMISSION TYPE:	SC 13D
SUBJECT COMPANY:

	COMPANY DATA:
		COMPANY CONFORMED NAME:			EXAMPLE CORP
		CENTRAL INDEX KEY:			0001234567

FILED BY:

	COMPANY DATA:
		COMPANY CONFORMED NAME:			Example Partners LP
		CENTRAL INDEX KEY:			0001999999
</pre></body></html>`;

const OLD_13D = `<html><body>
<p>CUSIP No. 123456789</p>
<table><tr><td>1</td><td>NAMES OF REPORTING PERSONS</td><td>Example Partners LP</td></tr>
<tr><td>13</td><td>PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (11)</td><td>8.4%</td></tr></table>
<p>Item 4. Purpose of Transaction</p>
<p>The Reporting Persons acquired the Shares because they believe the Shares are undervalued. The Reporting Persons intend to engage with the Board regarding a sale of the company and board composition.</p>
<p>Item 5. Interest in Securities of the Issuer</p>
</body></html>`;

const AMENDMENT_NO_ITEM4 = `<html><body>
<p>Amendment No. 2</p>
<p>Item 5. Interest in Securities of the Issuer</p><p>Rows updated.</p>
</body></html>`;

const AMENDMENT_UNCHANGED = `<p>Item 4. Purpose of Transaction</p><p>Not amended.</p><p>Item 5. Interest in Securities of the Issuer</p>`;

const NEW_13G_XML = `<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13g">
  <formData>
    <coverPageHeaderReportingPersonDetails>
      <reportingPersonName>Example Fund Advisors</reportingPersonName>
      <reportingPersonBeneficiallyOwnedAggregateNumberOfShares>5200000</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
      <classPercent>6.1</classPercent>
    </coverPageHeaderReportingPersonDetails>
  </formData>
</edgarSubmission>`;

const NEW_13D_A_XML = `<edgarSubmission><formData><items1To7><item4><transactionPurpose>The Reporting Persons delivered a letter to the Issuer nominating three candidates for election to the Board at the annual meeting.</transactionPurpose></item4></items1To7></formData></edgarSubmission>`;

// As EDGAR's XML schedules put it (from a SCHEDULE 13D/A filed 2026-09-02): Item 4 present, not amended.
const XML_ITEM4_NOT_AMENDED = `<items1To7><item4><transactionPurpose>"Item 4. Purpose of Transaction." of the Schedule 13D is not being amended by this Amendment No. 6.</transactionPurpose></item4><item5><percentageOfClassSecurities>Item 5 is hereby amended and restated.</percentageOfClassSecurities></item5></items1To7>`;
const XML_ITEM4_SUPPLEMENTED = `<item4><transactionPurpose>Item 4 of the Schedule 13D is hereby amended and supplemented by adding the following: On October 1, 2026, the Reporting Persons delivered a letter to the Board requesting a review of strategic alternatives.</transactionPurpose></item4>`;

describe("13D and 13G documents", () => {
  it("reads the filer from the SEC header", () => {
    assert.equal(filerFromHeader(HEADER), "Example Partners LP");
    assert.equal(filerFromHeader("<pre>nothing here</pre>"), null);
    assert.equal(subjectCikFromHeader(HEADER), "0001234567");
    assert.equal(subjectCikFromHeader("<pre>nothing here</pre>"), null);
  });

  it("reads the percent of class, in the old layout and the XML one", () => {
    assert.equal(percentOfClass(OLD_13D), 8.4);
    assert.equal(percentOfClass(NEW_13G_XML), 6.1);
    assert.equal(percentOfClass("<p>no cover page</p>"), null);
  });

  it("tells an amendment that restates Item 4 from one that does not", () => {
    assert.equal(purposeAmended(OLD_13D), true);
    assert.equal(purposeAmended(NEW_13D_A_XML), true);
    assert.equal(purposeAmended(AMENDMENT_NO_ITEM4), false);
    assert.equal(purposeAmended(AMENDMENT_UNCHANGED), false);
    assert.equal(purposeAmended(XML_ITEM4_NOT_AMENDED), false);
    assert.equal(purposeAmended(XML_ITEM4_SUPPLEMENTED), true);
  });
});

describe("when a company's list is read again", () => {
  const H = 60 * 60_000;
  it("every three hours on a business day", () => {
    const wed = nyWallMs("2026-10-14", 12, 0);
    assert.equal(isStale(null, wed), true);
    assert.equal(isStale(wed - 2 * H, wed), false);
    assert.equal(isStale(wed - 3 * H, wed), true);
  });

  it("once on a closed day, after a read made on the business day before", () => {
    const fri = nyWallMs("2026-10-16", 15, 0);
    const sat = nyWallMs("2026-10-17", 10, 0);
    const sun = nyWallMs("2026-10-18", 10, 0);
    assert.equal(isStale(fri, sat), true);
    assert.equal(isStale(sat, sun), false);
    assert.equal(isStale(sat, nyWallMs("2026-10-19", 9, 0)), true);
  });
});

describe("scope", () => {
  const edge = (root: string, counterparty: string, category: string, tier = "critical", confidence = 0.9) => ({
    root_ticker: root,
    counterparty_ticker: counterparty,
    category,
    strength_tier: tier,
    confidence,
    evidence_quote: "quote",
    source_url: "https://www.sec.gov/Archives/x.htm",
    accession_number: "0000000000-26-000001",
  });

  it("adds filing-linked companies of the reader's names, from the reader's side", () => {
    const scope = buildScope(["NVDA"], ["MSFT"], [
      edge("NVDA", "TSM", "supplier"),
      edge("SMCI", "NVDA", "supplier"),
      edge("MSFT", "NVDA", "supplier"),
      edge("AMD", "NVDA", "competitor", "important"),
      edge("NVDA", "XYZ", "supplier", "marginal"),
      edge("NVDA", "LOW", "supplier", "critical", 0.5),
    ]);
    assert.deepEqual(
      scope.map((s) => [s.ticker, s.scope, s.via ? `${s.via.relation} of ${s.via.holding}` : null]),
      [
        ["NVDA", "held", null],
        ["MSFT", "watchlist", null],
        ["SMCI", "linked", "customer of NVDA"],
        ["TSM", "linked", "supplier of NVDA"],
        ["AMD", "linked", "competitor of NVDA"],
      ],
    );
  });

  it("caps linked companies per name and in all", () => {
    const edges = ["A", "B", "C", "D", "E"].map((t) => edge("NVDA", t, "supplier"));
    assert.equal(buildScope(["NVDA"], [], edges).length, 1 + 3);
    assert.equal(buildScope(["NVDA"], [], edges, { perName: 5, maxLinked: 2 }).length, 1 + 2);
  });
});
