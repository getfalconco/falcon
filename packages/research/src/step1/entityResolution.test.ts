import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLOCKED_NAMES,
  counterpartyKey,
  isNotTheListedEntity,
  isRefusedCounterpartyName,
  isTradableKind,
  NOT_THE_LISTED_ENTITY,
  ordinaryListings,
  preferredListing,
  resolveCounterparty,
  secTitleKey,
  type SecTickerLookup,
} from "./entityResolution.js";

/**
 * A slice of the real SEC company_tickers.json, kept verbatim (titles included)
 * because every guard in the resolver exists for a specific pair of real rows —
 * "tencent music entertainment" against a bare "Tencent", GEHC against GEV.
 */
const SEC: SecTickerLookup[] = [
  { ticker: "AMZN", title: "AMAZON COM INC" },
  { ticker: "DELL", title: "Dell Technologies Inc." },
  { ticker: "CSCO", title: "CISCO SYSTEMS INC" },
  { ticker: "LLY", title: "ELI LILLY & Co" },
  { ticker: "CVX", title: "CHEVRON CORP" },
  { ticker: "TTE", title: "TotalEnergies SE" },
  { ticker: "AGCO", title: "AGCO CORP /DE" },
  { ticker: "ASML", title: "ASML HOLDING NV" },
  { ticker: "ASMLF", title: "ASML HOLDING NV" },
  { ticker: "GEHC", title: "GE HealthCare Technology Inc." },
  { ticker: "GEV", title: "GE Vernova Inc." },
  { ticker: "TME", title: "Tencent Music Entertainment Group" },
  { ticker: "TCMEF", title: "Tencent Music Entertainment Group" },
  { ticker: "WAB", title: "WESTINGHOUSE AIR BRAKE TECHNOLOGIES CORP" },
  { ticker: "MUFG", title: "MITSUBISHI UFJ FINANCIAL GROUP INC" },
  { ticker: "SNY", title: "Sanofi" },
  { ticker: "HPE", title: "Hewlett Packard Enterprise Co" },
  { ticker: "HPE-PC", title: "Hewlett Packard Enterprise Co" },
  { ticker: "MSFT", title: "MICROSOFT CORP" },
  { ticker: "NVDA", title: "NVIDIA CORP" },
];

describe("resolveCounterparty", () => {
  it("pins trade names and acronyms through the alias table", () => {
    assert.equal(resolveCounterparty("Google", SEC).ticker, "GOOGL");
    assert.equal(resolveCounterparty("AWS", SEC).ticker, "AMZN");
    assert.equal(resolveCounterparty("Amazon Web Services", SEC).ticker, "AMZN");
    assert.equal(resolveCounterparty("BMS", SEC).ticker, "BMY");
    assert.equal(resolveCounterparty("IBM", SEC).ticker, "IBM");
    assert.equal(resolveCounterparty("Google", SEC).method, "alias");
  });

  it("matches an exact normalized SEC title", () => {
    const r = resolveCounterparty("NVIDIA Corporation", SEC);
    assert.equal(r.ticker, "NVDA");
    assert.equal(r.method, "exact");
  });

  it("follows a forward prefix when the continuation is generic", () => {
    // "amazon" → "amazon com"; "dell" → "dell technologies"; "cisco" → "cisco systems".
    // These are the names the old exact-only matcher lost.
    assert.equal(resolveCounterparty("Amazon", SEC).ticker, "AMZN");
    assert.equal(resolveCounterparty("Dell", SEC).ticker, "DELL");
    assert.equal(resolveCounterparty("Cisco", SEC).ticker, "CSCO");
  });

  it("refuses a forward prefix whose continuation distinguishes the company", () => {
    // Tencent Holdings is not Tencent Music Entertainment, and Westinghouse
    // Electric is not Westinghouse Air Brake. A wrong ticker here would produce
    // a confident signal about the wrong company.
    const tencent = resolveCounterparty("Tencent", SEC);
    assert.notEqual(tencent.ticker, "TME");
    const westinghouse = resolveCounterparty("Westinghouse", SEC);
    assert.equal(westinghouse.ticker, null);
    assert.equal(westinghouse.rejected, "blocked");
  });

  it("collapses share-class noise but never two distinct companies", () => {
    // ASML + ASMLF is one issuer quoted twice.
    assert.equal(resolveCounterparty("ASML Holding NV", SEC).ticker, "ASML");
    // GE HealthCare and GE Vernova are two companies. Collapsing share classes
    // must never collapse them into one — the resolver buckets by title first,
    // so a query reaching both issuers resolves to neither.
    assert.equal(resolveCounterparty("GE Vernova", SEC).ticker, "GEV");
    assert.equal(resolveCounterparty("GE HealthCare", SEC).ticker, "GEHC");
    // (The alias table pins a bare "GE" to GE itself, so ambiguity never surfaces.)
    assert.equal(resolveCounterparty("GE", SEC).ticker, "GE");
  });

  it("maps a subsidiary onto its listed parent", () => {
    const chevron = resolveCounterparty("Chevron U.S.A. Inc.", SEC);
    assert.equal(chevron.ticker, "CVX");
    assert.equal(chevron.method, "prefix_subsidiary");
    assert.equal(resolveCounterparty("TotalEnergies EP Canada Ltd.", SEC).ticker, "TTE");
  });

  it("refuses a joint venture that looks like a subsidiary", () => {
    // "Sanofi Pasteur MSD" was an MSD/Sanofi JV; reverse prefix would hand it to SNY.
    const jv = resolveCounterparty("Sanofi Pasteur MSD", SEC);
    assert.equal(jv.ticker, null);
    assert.equal(jv.rejected, "blocked");
  });

  it("refuses a name that spans several unrelated issuers", () => {
    const mitsubishi = resolveCounterparty("Mitsubishi", SEC);
    assert.equal(mitsubishi.ticker, null);
    assert.equal(mitsubishi.rejected, "blocked");
    // The qualified forms still resolve.
    assert.equal(resolveCounterparty("Mitsubishi Electric", SEC).ticker, "MIELY");
  });

  it("returns null rather than guessing on an unknown name", () => {
    const r = resolveCounterparty("Genevant Sciences", SEC);
    assert.equal(r.ticker, null);
    assert.equal(r.method, null);
  });

  it("ignores an empty or punctuation-only name", () => {
    assert.equal(resolveCounterparty("", SEC).ticker, null);
    assert.equal(resolveCounterparty("  ---  ", SEC).ticker, null);
  });
});

describe("preferredListing", () => {
  it("drops foreign-ordinary and ADR lines when an ordinary symbol exists", () => {
    assert.equal(preferredListing(["ASML", "ASMLF"]), "ASML");
    assert.equal(preferredListing(["BABA", "BABAF", "BBAAY"]), "BABA");
  });

  it("drops preferred/class lines carrying a dot or dash", () => {
    assert.equal(preferredListing(["HPE", "HPE-PC"]), "HPE");
  });

  it("prefers the common line over a preferred series", () => {
    // SMCIP / MCHPP are preferred series appended to the common symbol.
    assert.equal(preferredListing(["SMCI", "SMCIP"]), "SMCI");
    assert.equal(preferredListing(["MCHP", "MCHPP"]), "MCHP");
  });

  it("prefers the ADR when only foreign lines exist", () => {
    // ABB and Hitachi trade in the US only as ADRs; the …F ordinary does not.
    assert.equal(preferredListing(["ABBNY", "ABLZF"]), "ABBNY");
    assert.equal(preferredListing(["HTHIY", "HTHIF"]), "HTHIY");
    assert.equal(preferredListing(["TCEHY"]), "TCEHY");
  });

  it("returns null for an empty set", () => {
    assert.equal(preferredListing([]), null);
    assert.deepEqual(ordinaryListings([]), []);
  });
});

describe("secTitleKey", () => {
  it("strips the SEC state-of-incorporation marker", () => {
    // "QUALCOMM INC/DE" would otherwise normalize to "qualcomm inc de", whose
    // trailing "de" blocks the "inc" strip and hides the company from itself.
    assert.equal(secTitleKey("QUALCOMM INC/DE"), "qualcomm");
    assert.equal(secTitleKey("NORTHROP GRUMMAN CORP /DE/"), "northrop grumman");
    assert.equal(secTitleKey("AGCO CORP /DE"), "agco");
  });

  it("strips a leading 'the' so it matches the same name without it", () => {
    assert.equal(secTitleKey("BOEING CO"), "boeing");
    assert.equal(counterpartyKey("The Boeing Company"), "boeing");
  });

  it("strips foreign legal forms normalizeCompanyName does not know", () => {
    assert.equal(secTitleKey("EQUINOR ASA"), "equinor");
    assert.equal(secTitleKey("Wallbox N.V."), "wallbox");
  });
});

describe("isTradableKind", () => {
  it("admits only public companies as propagation targets", () => {
    assert.equal(isTradableKind("public_company"), true);
    for (const kind of ["private_company", "government", "product", "commodity", "other"]) {
      assert.equal(isTradableKind(kind), false, `${kind} must not be tradable`);
    }
    assert.equal(isTradableKind(null), false);
    assert.equal(isTradableKind(undefined), false);
  });
});

describe("BLOCKED_NAMES", () => {
  it("is stored in normalized form so lookups can hit", () => {
    for (const name of BLOCKED_NAMES) {
      assert.equal(name, name.toLowerCase(), `${name} must be lowercase`);
      assert.ok(!/[^\w\s]/.test(name), `${name} must be punctuation-free`);
    }
  });
});

describe("parents, affiliates and listed subsidiaries", () => {
  /** Real SEC rows each refusal below exists for. */
  const ROWS: SecTickerLookup[] = [
    ...SEC,
    { ticker: "PCCYF", title: "PETROCHINA CO LTD" },
    { ticker: "PTCCY", title: "PETROCHINA CO LTD" },
    { ticker: "SNPMF", title: "CHINA PETROLEUM & CHEMICAL CORP" },
    { ticker: "JD", title: "JD.com, Inc." },
    { ticker: "HTHIY", title: "HITACHI LTD" },
    { ticker: "VERX", title: "Vertex, Inc." },
    { ticker: "VRTX", title: "VERTEX PHARMACEUTICALS INC / MA" },
    { ticker: "CRCE", title: "Circle Energy, Inc./NV" },
    { ticker: "XRPN", title: "Evernorth Holdings Inc." },
    { ticker: "TSM", title: "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD" },
  ];

  it("keeps a state-owned parent off its listed subsidiary's ticker", () => {
    for (const name of ["China National Petroleum Corporation", "CNPC", "Sinopec", "China National Offshore Oil Corporation"]) {
      const r = resolveCounterparty(name, ROWS);
      assert.equal(r.ticker, null, name);
      assert.equal(r.rejected, "blocked", name);
    }
    // The listed company itself still resolves.
    assert.equal(resolveCounterparty("PetroChina", ROWS).ticker, "PCCYF");
  });

  it("keeps an affiliate or JV off the listed parent the subsidiary rule would pick", () => {
    assert.equal(resolveCounterparty("JD Technology", ROWS).ticker, null);
    assert.equal(resolveCounterparty("Chevron Phillips Chemical Company LLC", ROWS).ticker, null);
    assert.equal(resolveCounterparty("Hitachi Construction Machinery Co., Ltd.", ROWS).ticker, null);
    // Wholly owned subsidiaries keep mapping onto the parent.
    assert.equal(resolveCounterparty("Chevron U.S.A. Inc.", ROWS).ticker, "CVX");
    assert.equal(resolveCounterparty("Hitachi Energy", ROWS).ticker, "HTHIY");
    assert.equal(resolveCounterparty("JD.com", ROWS).ticker, "JD");
  });

  it("refuses names whose obvious match is a different company", () => {
    // Vertex the drug maker vs Vertex, Inc. (tax software); Circle vs Circle Energy;
    // Evernorth (Cigna) vs Evernorth Holdings; a country vs a company named after it.
    for (const name of ["Vertex", "Circle", "Evernorth", "Taiwan", "China"]) {
      assert.equal(resolveCounterparty(name, ROWS).ticker, null, name);
    }
    assert.equal(resolveCounterparty("Vertex Pharmaceuticals Incorporated", ROWS).ticker, "VRTX");
    assert.equal(resolveCounterparty("Evernorth Health Services", ROWS).ticker, "CI");
  });

  it("isRefusedCounterpartyName agrees with the resolver and lets aliases through", () => {
    assert.equal(isRefusedCounterpartyName("China National Petroleum Corporation"), true);
    assert.equal(isRefusedCounterpartyName("CNPC"), true);
    assert.equal(isRefusedCounterpartyName("JD Technology"), true);
    assert.equal(isRefusedCounterpartyName("Mitsubishi"), true);
    assert.equal(isRefusedCounterpartyName("Mitsubishi Electric"), false);
    assert.equal(isRefusedCounterpartyName("PetroChina"), false);
    assert.equal(isRefusedCounterpartyName(""), false);
    // Only the parent / affiliate table clears a stored ticker; a blocked name keeps one.
    assert.equal(isNotTheListedEntity("CNPC"), true);
    assert.equal(isNotTheListedEntity("Sinopec"), true);
    assert.equal(isNotTheListedEntity("Vertex"), false);
    assert.equal(isNotTheListedEntity("PetroChina"), false);
  });

  it("stores the table in normalized form", () => {
    for (const name of Object.keys(NOT_THE_LISTED_ENTITY)) {
      assert.equal(counterpartyKey(name), name, `${name} must be a counterpartyKey`);
    }
  });
});
