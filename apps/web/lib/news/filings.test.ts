import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCikMap,
  buildHeadline,
  filingDocumentText,
  filingId,
  genericLead,
  htmlBlocks,
  indexDaysToRead,
  itemLead,
  itemNumber,
  lastSentenceEnd,
  parseAcceptance,
  parseAtom,
  parseFormIndex,
  parseHeader,
  pickDocuments,
  pressRelease,
  schedule13d,
  sentenceClip,
  taggedCiks,
} from "./filings";

const HEADER = `<html><body><pre>
&lt;SEC-HEADER&gt;0001493152-26-050606.hdr.sgml : 20261109
&lt;ACCEPTANCE-DATETIME&gt;20261109063034
ACCESSION NUMBER:		0001493152-26-050606
CONFORMED SUBMISSION TYPE:	8-K
ITEM INFORMATION:		Entry into a Material Definitive Agreement
ITEM INFORMATION:		Completion of Acquisition or Disposition of Assets
ITEM INFORMATION:		Unregistered Sales of Equity Securities
ITEM INFORMATION:		Regulation FD Disclosure
ITEM INFORMATION:		Financial Statements and Exhibits

FILER:

	COMPANY DATA:
		COMPANY CONFORMED NAME:			ABEONA THERAPEUTICS INC.
		CENTRAL INDEX KEY:			0000318306
&lt;/SEC-HEADER&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;8-K
&lt;SEQUENCE&gt;1
&lt;FILENAME&gt;form8-k.htm
&lt;DESCRIPTION&gt;8-K
&lt;/DOCUMENT&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-10.1
&lt;SEQUENCE&gt;2
&lt;FILENAME&gt;ex10-1.htm
&lt;DESCRIPTION&gt;EX-10.1
&lt;/DOCUMENT&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-99.1
&lt;SEQUENCE&gt;3
&lt;FILENAME&gt;ex99-1.htm
&lt;DESCRIPTION&gt;PRESS RELEASE
&lt;/DOCUMENT&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;GRAPHIC
&lt;SEQUENCE&gt;4
&lt;FILENAME&gt;logo.jpg
&lt;/DOCUMENT&gt;
</pre></body></html>`;

const RELEASE = `<DOCUMENT>
<TYPE>EX-99.1
<TEXT>
<HTML><BODY>
<P><B>Exhibit 99.1</B></P>
<P><IMG SRC="logo.jpg"></P>
<P><B>Abeona Therapeutics<SUP>&reg;</SUP> Acquires Phase 3-Ready
APT-1011 and Enters Into Agreement for $30 Million Private Placement</B></P>
<P><I>&ndash; Adds a once-daily oral therapy candidate &ndash;</I></P>
<P>CLEVELAND, November 9, 2026 &ndash; Abeona Therapeutics Inc. (Nasdaq: ABEO) today announced the acquisition of APT-1011, a product
candidate for eosinophilic esophagitis, and entered into a securities purchase agreement for a $30 million private placement financing.
The acquisition has no upfront cash consideration.</P>
<P>Forward-Looking Statements: this press release contains forward-looking statements that are not guarantees of anything at all, as usual.</P>
</BODY></HTML>`;

const EIGHT_K = `<?xml version='1.0' encoding='ASCII'?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><head><title>8-K</title></head><body>
<div style="display:none"><ix:header><ix:hidden>hidden facts</ix:hidden></ix:header></div>
<p>UNITED STATES</p><p>FORM 8-K</p>
<p>Check the appropriate box below if the Form 8-K filing is intended to simultaneously satisfy the filing obligation of the registrant.</p>
<p>Item 1.01. Entry into a Material Definitive Agreement.</p>
<p>Asset Purchase Agreement</p>
<p>On November 6, 2026, Abeona Therapeutics Inc. (the &#8220;Company&#8221;) entered into an Asset Purchase Agreement with Ellodi Pharmaceuticals, L.P.</p>
<p>Item 3.02. Unregistered Sales of Equity Securities.</p>
<p>The information in Item 1.01 is incorporated herein by reference.</p>
<p>SIGNATURES</p><p>Pursuant to the requirements of the Securities Exchange Act of 1934, the registrant has duly caused this report to be signed.</p>
</body></html>`;

test("accession ids and EDGAR times", () => {
  assert.equal(filingId("0001493152-26-050606"), 1_149_315_226_050_606);
  assert.equal(filingId("bad"), null);
  assert.ok(Number.isSafeInteger(filingId("0002099999-26-999999")!));
  // 06:30:34 ET in November (EST, UTC-5).
  assert.equal(parseAcceptance("20261109063034")!.toISOString(), "2026-11-09T11:30:34.000Z");
  // July is EDT (UTC-4).
  assert.equal(parseAcceptance("20260701160000")!.toISOString(), "2026-07-01T20:00:00.000Z");
  assert.deepEqual(indexDaysToRead("2026-11-23", 3, new Set(["2026-11-20"])), []);
  assert.deepEqual(indexDaysToRead("2026-11-25", 4, new Set()), ["2026-11-24", "2026-11-23"]);
});

test("8-K item titles to numbers", () => {
  assert.equal(itemNumber("Unregistered Sales of Equity Securities"), "3.02");
  assert.equal(itemNumber("Departure of Directors or Certain Officers; Election of Directors"), "5.02");
  assert.equal(itemNumber("Item 2.02: Results of Operations"), "2.02");
  assert.equal(itemNumber("Something else"), null);
});

test("filing header: time, items, parties, documents", () => {
  const h = parseHeader(HEADER);
  assert.equal(h.form, "8-K");
  assert.equal(h.acceptedAt!.toISOString(), "2026-11-09T11:30:34.000Z");
  assert.deepEqual(h.items, ["1.01", "2.01", "3.02", "7.01", "9.01"]);
  assert.deepEqual(h.parties, [{ role: "FILER", name: "ABEONA THERAPEUTICS INC.", cik: "318306" }]);
  const docs = pickDocuments("8-K", "https://www.sec.gov/Archives/edgar/data/318306/000149315226050606/", h.documents);
  assert.deepEqual(
    docs.map((d) => [d.type, d.url.split("/").pop()]),
    [
      ["8-K", "form8-k.htm"],
      ["EX-99.1", "ex99-1.htm"],
    ],
  );
  assert.deepEqual(taggedCiks("SCHEDULE 13D", [{ role: "SUBJECT COMPANY", cik: "1" }, { role: "FILED BY", cik: "2" }]), ["1"]);
  assert.deepEqual(taggedCiks("425", [{ role: "SUBJECT COMPANY", cik: "1" }, { role: "FILED BY", cik: "2" }]), ["1", "2"]);
});

test("press release title and lead, 8-K item text, headline", () => {
  const pr = pressRelease(htmlBlocks(RELEASE));
  assert.equal(pr.title, "Abeona Therapeutics® Acquires Phase 3-Ready APT-1011 and Enters Into Agreement for $30 Million Private Placement");
  assert.match(pr.lead!, /^CLEVELAND, November 9, 2026 – Abeona Therapeutics Inc\. \(Nasdaq: ABEO\) today announced/);
  assert.match(itemLead(htmlBlocks(EIGHT_K))!, /^On November 6, 2026, Abeona Therapeutics Inc\./);
  const headline = buildHeadline({ ticker: "ABEO", company: "ABEONA THERAPEUTICS INC.", form: "8-K", items: ["1.01", "2.01", "3.02", "7.01", "9.01"], title: pr.title });
  assert.equal(
    headline,
    "ABEO 8-K: Entry into a Material Agreement; Completion of an Acquisition or Disposition; Unregistered Sale of Equity Securities. Abeona Therapeutics® Acquires Phase 3-Ready APT-1011 and Enters Into Agreement for $30 Million Private Placement",
  );
  assert.doesNotMatch(headline, /[—–]/);
  assert.equal(buildHeadline({ ticker: "XYZ", company: "XYZ Corp", form: "424B5", items: [] }), "XYZ 424B5: Prospectus Supplement for an Offering (XYZ Corp)");
  assert.equal(buildHeadline({ ticker: "ABEO", company: "x", form: "SCHEDULE 13D/A", items: [], holder: "Some Fund LP", percent: 6.1 }), "ABEO 13D/A: Some Fund LP amends its stake filing (6.1%)");
});

test("filing text: iXBRL 8-K starts at its first item and stops at signatures", () => {
  const text = filingDocumentText(EIGHT_K, { form: "8-K", primary: true });
  assert.match(text, /^Item 1\.01\. Entry into a Material Definitive Agreement\./);
  assert.match(text, /Item 3\.02/);
  assert.doesNotMatch(text, /hidden facts|Check the appropriate box|Pursuant to the requirements/);
});

test("Schedule 13D XML", () => {
  const xml = `<?xml version="1.0"?><edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13D"><formData><coverPageHeader><securitiesClassTitle>Common Stock</securitiesClassTitle><dateOfEvent>10/15/2026</dateOfEvent><issuerInfo><issuerName>ABEONA THERAPEUTICS INC.</issuerName></issuerInfo></coverPageHeader>
  <reportingPersons><reportingPersonInfo><reportingPersonName>Russell Trust</reportingPersonName><aggregateAmountOwned>3479963</aggregateAmountOwned><percentOfClass>6.1</percentOfClass></reportingPersonInfo></reportingPersons>
  <items1To7><item4><transactionPurpose>The Reporting Persons became concerned about governance &amp; execution. They may seek board representation.</transactionPurpose></item4></items1To7></formData></edgarSubmission>`;
  const d = schedule13d(xml);
  assert.deepEqual(d.holders, ["Russell Trust"]);
  assert.equal(d.percent, 6.1);
  assert.match(d.purpose!, /governance & execution/);
  assert.match(filingDocumentText(xml, { form: "SCHEDULE 13D", primary: true }), /Russell Trust: 3,479,963 shares, 6\.1% of the class[\s\S]*Item 4\. Purpose of transaction/);
});

test("prospectus lead skips the cover page", () => {
  const blocks = htmlBlocks(
    `<p>Approximate date of commencement of proposed sale to the public: from time to time after this registration statement becomes effective as determined by market conditions.</p>` +
      `<p>This prospectus relates to the resale of up to 9,000,000 shares of our common stock by the selling stockholders named herein, issued in our private placement.</p>`,
  );
  assert.match(genericLead(blocks)!, /^This prospectus relates to the resale/);
});

test("feeds, daily indexes and the CIK map", () => {
  const atom = `<feed><entry><title>8-K - MOBIX LABS, INC (0001855467) (Filer)</title><summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-11-20 &lt;br&gt;Item 3.03: Material Modifications &lt;br&gt;Item 9.01: Exhibits</summary><updated>2026-11-20T17:30:44-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="8-K"/><id>urn:tag:sec.gov,2008:accession-number=0001493152-26-053579</id></entry></feed>`;
  assert.deepEqual(parseAtom(atom), [
    { accession: "0001493152-26-053579", form: "8-K", cik: "1855467", company: "MOBIX LABS, INC", role: "Filer", acceptedAt: new Date("2026-11-20T22:30:44Z"), items: ["3.03", "9.01"] },
  ]);
  const idx = [
    "SCHEDULE 13D/A   SOME  HOLDINGS  INC                                     123456      20261120    edgar/data/123456/0000950170-26-000001.txt",
    "4                ABEONA THERAPEUTICS INC.                                  318306      20261120    edgar/data/318306/0001493152-26-000002.txt",
    "8-K              ABEONA THERAPEUTICS INC.                                  318306      20261120    edgar/data/318306/0001493152-26-050606.txt",
  ].join("\n");
  assert.deepEqual(parseFormIndex(idx), [
    { form: "SCHEDULE 13D/A", company: "SOME  HOLDINGS  INC", cik: "123456", date: "2026-11-20", accession: "0000950170-26-000001" },
    { form: "8-K", company: "ABEONA THERAPEUTICS INC.", cik: "318306", date: "2026-11-20", accession: "0001493152-26-050606" },
  ]);
  const map = buildCikMap(
    { fields: ["cik", "name", "ticker", "exchange"], data: [[318306, "ABEONA THERAPEUTICS INC.", "ABEO", "Nasdaq"], [1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"], [1, "Otc Co", "OTCC", "OTC"]] },
    new Set(["ABEO", "BRK.B"]),
  );
  assert.deepEqual(map, { "318306": ["ABEONA THERAPEUTICS INC.", ["ABEO"]], "1067983": ["BERKSHIRE HATHAWAY INC", ["BRK.B"]] });
});

test("sentence ends skip abbreviations", () => {
  const s = "Pursuant to this prospectus supplement, LiveOne, Inc. (the Company) is offering 40,000 shares to Mr. Smith in the U.S. market. The offering closes Friday.";
  assert.equal(sentenceClip(s, 140).text, "Pursuant to this prospectus supplement, LiveOne, Inc. (the Company) is offering 40,000 shares to Mr. Smith in the U.S. market.");
  assert.equal(lastSentenceEnd("No end here"), -1);
});
