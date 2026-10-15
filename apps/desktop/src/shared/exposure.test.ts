import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeExposure,
  disclosedShare,
  exposurePct,
  exposureRequestKey,
  headlineOf,
  nameKey,
  parseExposureRequest,
  sharePct,
  type ExposureEdge,
  type ExposureHoldingInput,
  type SharedDependency,
} from "./exposure";

function edge(root: string, other: string | null, over: Partial<ExposureEdge> = {}): ExposureEdge {
  return {
    root_ticker: root,
    counterparty_ticker: other,
    counterparty_id: other ?? `name:${(over.counterparty_name ?? "unnamed").toLowerCase()}`,
    counterparty_name: other ?? "Unnamed",
    counterparty_type: "public_company",
    category: "supplier",
    strength: 0.6,
    strength_tier: "important",
    confidence: 0.95,
    evidence_quote: "We depend on the company for our wafers.",
    source_url: `https://www.sec.gov/Archives/edgar/data/1/000000000026000001/${root.toLowerCase()}-20251231.htm`,
    accession_number: "0000000000-26-000001",
    filing_date: "2026-02-25",
    ...over,
  };
}

const book = (...rows: Array<[string, number, boolean?]>): ExposureHoldingInput[] =>
  rows.map(([ticker, weight, fund]) => ({ ticker, weight, fund: fund ?? false }));

describe("disclosedShare", () => {
  it("reads the field, then a strength that is not its tier's default", () => {
    assert.equal(disclosedShare(edge("AMKR", "AAPL", { disclosed_revenue_dependency_pct: 29.8 })), 29.8);
    assert.equal(disclosedShare(edge("AMKR", "AAPL", { strength: 0.298, strength_tier: "critical" })), 29.8);
    assert.equal(disclosedShare(edge("AMKR", "AAPL", { strength: 1, strength_tier: "critical" })), null);
    assert.equal(disclosedShare(edge("AMKR", "AAPL", { strength: 0.6, strength_tier: "important" })), null);
    assert.equal(disclosedShare(edge("AMKR", "AAPL", { strength: 1, strength_tier: "critical", strength_basis: "disclosed" })), 100);
    assert.equal(disclosedShare(edge("AMKR", "AAPL", { strength: 0.298, strength_tier: "critical", strength_basis: "classified" })), null);
  });
});

describe("nameKey", () => {
  it("meets a legal name and its short form", () => {
    assert.equal(nameKey("Samsung Electronics Co., Ltd."), nameKey("Samsung Electronics"));
    assert.equal(nameKey("The Boeing Company"), "name:boeing");
  });
});

describe("computeExposure: shared dependencies", () => {
  const edges = [
    edge("NVDA", "TSM", { strength_tier: "critical", strength: 1 }),
    edge("AMD", "TSM"),
    edge("AAPL", "TSM", { strength_tier: "marginal", strength: 0.3 }),
    edge("NVDA", null, { counterparty_id: "name:samsung electronics", counterparty_name: "Samsung Electronics Co., Ltd." }),
    edge("AMD", null, { counterparty_id: "name:samsung electronics", counterparty_name: "Samsung" }),
    edge("NVDA", "INTC", { category: "competitor" }),
    edge("AMD", "INTC", { category: "competitor" }),
  ];

  it("weights each holding by its strongest link and ranks by exposed weight", () => {
    const s = computeExposure(edges, { scope: "account", holdings: book(["NVDA", 0.3], ["AMD", 0.2], ["AAPL", 0.1]) });
    const tsm = s.shared[0]!;
    assert.equal(tsm.key, "TSM");
    // 0.3 x 1 + 0.2 x 0.6 + 0.1 x 0.3
    assert.ok(Math.abs(tsm.exposure - 0.45) < 1e-9);
    assert.ok(Math.abs(tsm.linkedWeight - 0.6) < 1e-9);
    assert.deepEqual(tsm.via.map((v) => v.ticker), ["NVDA", "AMD", "AAPL"]);
    assert.equal(tsm.tier, "critical");
    assert.equal(tsm.source.filer, "NVDA");
    assert.equal(s.shared[1]!.key, "name:samsung electronics");
    assert.equal(s.shared[1]!.ticker, null);
    assert.equal(s.shared[1]!.listed, false);
  });

  it("leaves competitors, single links, shorts and low confidence out", () => {
    const s = computeExposure(
      [...edges, edge("NVDA", "MU", { confidence: 0.7 }), edge("AMD", "MU", { confidence: 0.7 }), edge("NVDA", "FN")],
      { scope: "account", holdings: book(["NVDA", 0.3], ["AMD", -0.2]) },
    );
    assert.deepEqual(s.shared, []);
  });

  it("drops links a filing does not carry", () => {
    const s = computeExposure(
      [edge("NVDA", "TSM", { source_url: "https://example.com/x" }), edge("AMD", "TSM", { accession_number: null })],
      { scope: "account", holdings: book(["NVDA", 0.3], ["AMD", 0.2]) },
    );
    assert.deepEqual(s.shared, []);
  });

  it("counts a link only the other company's filing carries at the marginal factor, flipped to the holding's side", () => {
    const s = computeExposure(
      [edge("HPE", "NVDA", { strength_tier: "critical", strength: 1 }), edge("HPE", "AMD", { strength_tier: "critical", strength: 1 })],
      { scope: "account", holdings: book(["NVDA", 0.4], ["AMD", 0.2]) },
    );
    const hpe = s.shared[0]!;
    assert.equal(hpe.key, "HPE");
    assert.ok(Math.abs(hpe.exposure - 0.6 * 0.3) < 1e-9);
    // HPE names them as suppliers, so from their side HPE is a customer.
    assert.deepEqual(hpe.via.map((v) => [v.relation, v.own, v.tier]), [
      ["customer", false, "marginal"],
      ["customer", false, "marginal"],
    ]);
    assert.equal(hpe.source.filer, "HPE");
  });

  it("joins a name id to the ticker another edge gives it", () => {
    const s = computeExposure(
      [
        edge("NVDA", "HNHPF", { counterparty_id: "name:hon hai precision industry", counterparty_name: "Hon Hai" }),
        edge("AVGO", null, { counterparty_id: "name:hon hai precision industry", counterparty_name: "Hon Hai Precision Industry Co., Ltd." }),
      ],
      { scope: "account", holdings: book(["NVDA", 0.2], ["AVGO", 0.2]) },
    );
    assert.equal(s.shared.length, 1);
    assert.equal(s.shared[0]!.ticker, "HNHPF");
  });

  it("fills the form and names from the options", () => {
    const s = computeExposure([edge("HPE", "NVDA"), edge("HPE", "AMD")], { scope: "account", holdings: book(["NVDA", 0.3], ["AMD", 0.3]) }, {
      formOf: (t) => (t === "HPE" ? "10-K" : null),
      nameOf: (t) => (t === "HPE" ? "Hewlett Packard Enterprise" : null),
      isListed: () => false,
    });
    assert.equal(s.shared[0]!.name, "Hewlett Packard Enterprise");
    assert.equal(s.shared[0]!.source.form, "10-K");
    assert.equal(s.shared[0]!.listed, false);
  });
});

describe("computeExposure: customers, overlaps, gaps", () => {
  const edges = [
    edge("AMKR", "AAPL", { category: "customer", strength: 0.298, strength_tier: "critical" }),
    edge("AMKR", "QCOM", { category: "customer", strength: 0.111, strength_tier: "critical" }),
    edge("AMKR", "INTC", { category: "customer", strength: 0.06, strength_tier: "important" }),
    edge("CAH", "CVS", { category: "customer", strength: 0.28, strength_tier: "critical" }),
    edge("NVDA", "TSM"),
    edge("NVDA", "UMC"),
    edge("NVDA", "GFS"),
    edge("AMD", "TSM"),
    edge("AMD", "UMC"),
    edge("AMD", "GFS"),
    edge("QCOM", "TSM"),
    edge("QCOM", "AMD"),
    edge("QCOM", "NVDA"),
  ];
  const s = computeExposure(edges, {
    scope: "account",
    holdings: book(["AMKR", 0.05], ["CAH", 0.05], ["NVDA", 0.2], ["AMD", 0.1], ["QCOM", 0.1], ["ZZZ", 0.07], ["SPY", 0.2, true]),
  });

  it("lists holdings with a disclosed customer at a tenth of revenue or more", () => {
    assert.deepEqual(
      s.customers.map((c) => [c.ticker, c.customers.map((x) => [x.ticker, x.share])]),
      [
        ["AMKR", [["AAPL", 29.8], ["QCOM", 11.1]]],
        ["CAH", [["CVS", 28]]],
      ],
    );
    assert.equal(s.customers[0]!.source.filer, "AMKR");
  });

  it("pairs the holdings that share the most names, not counting each other", () => {
    // QCOM is held too: its filing names both as suppliers, so it is a customer they share.
    assert.deepEqual(s.overlaps[0]!.shared.map((x) => x.key).sort(), ["GFS", "QCOM", "TSM", "UMC"]);
    assert.deepEqual([s.overlaps[0]!.a, s.overlaps[0]!.b], ["AMD", "NVDA"]);
    assert.ok(s.overlaps.every((o) => o.shared.length >= 2));
  });

  it("lists the companies without a filing of their own, never a fund", () => {
    assert.deepEqual(s.gaps, [{ ticker: "ZZZ", weight: 0.07 }]);
    assert.equal(s.companies, 6);
    assert.equal(s.covered, 5);
    assert.ok(Math.abs(s.gapWeight - 0.07) < 1e-9);
  });
});

describe("headlineOf", () => {
  const row = (name: string, exposure: number) => ({ name, exposure }) as SharedDependency;
  it("quotes the highest threshold any company passes", () => {
    assert.deepEqual(headlineOf([row("TSMC", 0.58), row("Samsung", 0.31)]), { count: 1, threshold: 0.5, name: "TSMC", exposure: 0.58 });
    assert.deepEqual(headlineOf([row("A", 0.45), row("B", 0.41), row("C", 0.42)]), { count: 3, threshold: 0.4, name: null, exposure: null });
    assert.equal(headlineOf([row("A", 0.2), row("B", 0.1)]), null);
    assert.equal(headlineOf([]), null);
  });
});

describe("formatting and the request", () => {
  it("prints whole points from ten, one decimal under", () => {
    assert.equal(exposurePct(0.582), "58%");
    assert.equal(exposurePct(0.0421), "4.2%");
    assert.equal(exposurePct(0.0001), "<0.1%");
    assert.equal(exposurePct(0), "0%");
    assert.equal(sharePct(29.8), "29.8%");
    assert.equal(sharePct(17), "17%");
  });

  it("accepts a well formed request and nothing else", () => {
    assert.deepEqual(parseExposureRequest({ scope: "account", holdings: [{ ticker: " nvda ", weight: 0.2 }] }), {
      scope: "account",
      holdings: [{ ticker: "NVDA", weight: 0.2, fund: false }],
    });
    assert.equal(parseExposureRequest({ scope: "all", holdings: [] }), null);
    assert.equal(parseExposureRequest({ scope: "account", holdings: [{ ticker: "NVDA", weight: Number.NaN }] }), null);
    assert.equal(parseExposureRequest({ scope: "account", holdings: [{ ticker: "<script>", weight: 0.1 }] }), null);
    assert.equal(parseExposureRequest(null), null);
  });

  it("keys a request by scope and tenth-of-a-point weights, in any order", () => {
    const a = exposureRequestKey({ scope: "account", holdings: book(["NVDA", 0.20001], ["AMD", 0.1]) });
    const b = exposureRequestKey({ scope: "account", holdings: book(["AMD", 0.1], ["NVDA", 0.2]) });
    assert.equal(a, b);
    assert.notEqual(a, exposureRequestKey({ scope: "watchlist", holdings: book(["AMD", 0.1], ["NVDA", 0.2]) }));
  });
});
