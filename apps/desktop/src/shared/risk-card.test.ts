import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatRiskShare, riskCardModel, riskCardView, riskHoverView, riskSnapshotStale, type RiskCardViewInput } from "./risk-card.js";
import { paperAccountWeights } from "./portfolio-weights.js";
import type { RiskSnapshot } from "./risk-types.js";

const FIXTURE: RiskSnapshot = {
  schema_version: 1,
  computed_at: "2026-08-24T20:30:00.000Z",
  account: "paper",
  trigger: ["manual"],
  invested_fraction: 0.82,
  position_count: 4,
  score: 63,
  band: "elevated",
  components: null,
  driver: { component: "network", sentence: "NVDA and TSM share a critical supply-chain link.", contribution: 18 },
  weights: [],
  blend_weights: { concentration: 0.18, market: 0.17, volatility: 0.18, network: 0.22, event: 0.13, sharpe: 0.12 },
  degraded: [],
  graph_version: null,
  empty: false,
};

describe("risk card contract (§8)", () => {
  it("flag off → hidden, whatever the snapshot says", () => {
    assert.deepEqual(riskCardModel({ snapshot: FIXTURE, riskCardEnabled: false }), { kind: "hidden" });
    assert.deepEqual(riskCardModel(null), { kind: "hidden" });
    assert.deepEqual(riskCardModel({ snapshot: null, riskCardEnabled: true }), { kind: "hidden" });
  });

  it("empty snapshot → empty state", () => {
    const m = riskCardModel({ snapshot: { ...FIXTURE, empty: true, score: null, band: null, driver: null }, riskCardEnabled: true });
    assert.deepEqual(m, { kind: "empty", computed_at: FIXTURE.computed_at });
  });

  it("fixture snapshot → score, band, driver sentence, computed_at only", () => {
    const m = riskCardModel({ snapshot: FIXTURE, riskCardEnabled: true });
    assert.deepEqual(m, {
      kind: "score",
      score: 63,
      band: "elevated",
      sentence: "NVDA and TSM share a critical supply-chain link.",
      computed_at: "2026-08-24T20:30:00.000Z",
      concentration: null,
    });
  });
});

describe("risk card view: never a number without a real snapshot", () => {
  const EMPTY: RiskSnapshot = { ...FIXTURE, empty: true, score: null, band: null, driver: null, position_count: 0 };
  const base: RiskCardViewInput = { latest: null, status: "ready", syncFailed: false, pending: false, holdsPositions: true };
  const view = (over: Partial<RiskCardViewInput>) => riskCardView({ ...base, ...over });
  const numberIn = (v: object) => Object.values(v).some((x) => typeof x === "number");

  it("only the score view carries a number, and it is the snapshot's own", () => {
    const states: Array<Partial<RiskCardViewInput>> = [
      { latest: null, status: "loading" },
      { latest: null, status: "error" },
      { latest: null, status: "loading", pending: true },
      { latest: { snapshot: null, riskCardEnabled: true } },
      { latest: { snapshot: null, riskCardEnabled: true }, syncFailed: true },
      { latest: { snapshot: null, riskCardEnabled: true }, holdsPositions: false },
      { latest: { snapshot: EMPTY, riskCardEnabled: true } },
      { latest: { snapshot: EMPTY, riskCardEnabled: true }, holdsPositions: false },
      { latest: { snapshot: FIXTURE, riskCardEnabled: false } },
      { latest: { snapshot: null, riskCardEnabled: false } },
    ];
    for (const s of states) {
      const v = view(s);
      assert.notEqual(v.kind, "score", JSON.stringify(s));
      assert.equal(numberIn(v), false, `${JSON.stringify(s)} → ${JSON.stringify(v)}`);
    }
    const scored = view({ latest: { snapshot: FIXTURE, riskCardEnabled: true } });
    assert.equal(scored.kind, "score");
    assert.equal(scored.kind === "score" && scored.score, 63);
  });

  it("before the first read comes back: loading (header only)", () => {
    assert.deepEqual(view({ latest: null, status: "loading" }), { kind: "loading" });
  });

  it("the read failed with nothing to show: error", () => {
    assert.deepEqual(view({ latest: null, status: "error" }), { kind: "error" });
  });

  it("a later failed read keeps the last real score", () => {
    const v = view({ latest: { snapshot: FIXTURE, riskCardEnabled: true }, status: "error", syncFailed: true });
    assert.equal(v.kind, "score");
  });

  it("no snapshot yet for a held book (new user, or archived when risk went per user): calculating", () => {
    assert.deepEqual(view({ latest: { snapshot: null, riskCardEnabled: true } }), { kind: "calculating" });
  });

  it("an empty snapshot while positions are now held: calculating, not empty", () => {
    assert.deepEqual(view({ latest: { snapshot: EMPTY, riskCardEnabled: true } }), { kind: "calculating" });
  });

  it("the push or recompute failed and there is no score: error", () => {
    assert.deepEqual(view({ latest: { snapshot: null, riskCardEnabled: true }, syncFailed: true }), { kind: "error" });
  });

  it("nothing held: empty, whether or not the engine has a snapshot", () => {
    assert.deepEqual(view({ latest: { snapshot: EMPTY, riskCardEnabled: true }, holdsPositions: false }), { kind: "empty" });
    assert.deepEqual(view({ latest: { snapshot: null, riskCardEnabled: true }, holdsPositions: false }), { kind: "empty" });
  });

  it("flag off: off, whatever the snapshot says", () => {
    assert.deepEqual(view({ latest: { snapshot: FIXTURE, riskCardEnabled: false } }), { kind: "off" });
  });

  it("a demo toggle in flight dims a real score, and reads as calculating without one", () => {
    const v = view({ latest: { snapshot: FIXTURE, riskCardEnabled: true }, pending: true });
    assert.equal(v.kind === "score" && v.pending, true);
    assert.deepEqual(view({ latest: { snapshot: null, riskCardEnabled: true }, pending: true }), { kind: "calculating" });
  });
});

describe("riskSnapshotStale", () => {
  const EMPTY: RiskSnapshot = { ...FIXTURE, empty: true, score: null, band: null, driver: null };
  it("no snapshot at all is stale", () => {
    assert.equal(riskSnapshotStale({ snapshot: null, riskCardEnabled: true }, 3), true);
    assert.equal(riskSnapshotStale({ snapshot: null, riskCardEnabled: true }, 0), true);
  });
  it("empty while holding, or scored while holding nothing, is stale", () => {
    assert.equal(riskSnapshotStale({ snapshot: EMPTY, riskCardEnabled: true }, 2), true);
    assert.equal(riskSnapshotStale({ snapshot: FIXTURE, riskCardEnabled: true }, 0), true);
  });
  it("a snapshot that matches the book is not", () => {
    assert.equal(riskSnapshotStale({ snapshot: FIXTURE, riskCardEnabled: true }, 4), false);
    assert.equal(riskSnapshotStale({ snapshot: EMPTY, riskCardEnabled: true }, 0), false);
  });
  it("flag off, a demo snapshot, or no read: never asks for a recompute", () => {
    assert.equal(riskSnapshotStale({ snapshot: null, riskCardEnabled: false }, 3), false);
    assert.equal(riskSnapshotStale({ snapshot: EMPTY, riskCardEnabled: true, demo: true }, 3), false);
    assert.equal(riskSnapshotStale(null, 3), false);
  });
});

describe("the dashboard risk card source", () => {
  const card = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer/components/dashboard/OpportunitiesPanel.tsx"),
    "utf8",
  );
  it("has no placeholder or fallback score", () => {
    assert.doesNotMatch(card, /PLACEHOLDER/);
    assert.doesNotMatch(card, /\?\?\s*\d+/, "no `?? <number>` fallback");
    assert.doesNotMatch(card, /\b72\b/);
  });
  it("prints a number only from the score view", () => {
    assert.match(card, /const score = view\.score;/);
    assert.match(card, /if \(view\.kind !== "score"\)/);
  });
});

describe("risk card: a hovered position (riskHoverView)", () => {
  // 3,000 NVDA + 2,000 TSM + 5,000 cash: NVDA is 30% of the account, TSM 20%.
  const book = paperAccountWeights(
    {
      cash: 5000,
      positions: {
        NVDA: { symbol: "NVDA", shares: 15, costUsd: 2500 },
        TSM: { symbol: "TSM", shares: 20, costUsd: 1800 },
      },
    },
    { NVDA: 200, TSM: 100 },
  );
  const NOW = Date.parse("2026-08-24T20:30:00.000Z");
  const scored: RiskSnapshot = {
    ...FIXTURE,
    weights: [
      { ticker: "NVDA", weight: 0.6, market_value: 3000, side: "long" },
      { ticker: "TSM", weight: 0.4, market_value: 2000, side: "long" },
    ],
    components: { volatility: { score: 59, port_vol_daily_pct: 2.062, spy_vol_daily_pct: 1, systematic_share: 0.5 } } as RiskSnapshot["components"],
    positions: [
      {
        ticker: "NVDA",
        side: "long",
        account_weight: 0.3,
        beta: 2,
        daily_vol_pct: 3,
        risk_share: 0.6471,
        earnings: { due_at: "2026-08-26T20:00:00.000Z", sessions_until: 2 },
        correlation: null,
      },
      {
        ticker: "TSM",
        side: "long",
        account_weight: 0.2,
        beta: 1.05,
        daily_vol_pct: 2,
        risk_share: 0.0529,
        earnings: null,
        correlation: { ticker: "NVDA", value: 0.614, sessions: 89 },
      },
    ],
  };

  it("nothing hovered, or no scored snapshot: the card stays on the portfolio", () => {
    assert.equal(riskHoverView(scored, null, book, NOW), null);
    assert.equal(riskHoverView(null, "NVDA", book, NOW), null);
    assert.equal(riskHoverView({ ...scored, empty: true, score: null }, "NVDA", book, NOW), null);
    assert.equal(riskHoverView(scored, "AAPL", book, NOW), null, "neither held nor in the snapshot");
  });

  it("with per-position metrics: the share of risk and the factual lines, in order", () => {
    const v = riskHoverView(scored, "nvda", book, NOW)!;
    assert.equal(v.ticker, "NVDA");
    assert.equal(v.share, "65%");
    assert.equal(v.shareFrac, 0.6471);
    assert.deepEqual(v.lines, [
      { kind: "weight", value: "30.0%" },
      { kind: "beta", value: "2.00" },
      { kind: "volatility", value: "3.0%", portfolio: "2.1%" },
      { kind: "earnings", due_at: "2026-08-26T20:00:00.000Z" },
    ]);
  });

  it("at most four lines: the correlation follows when there is room", () => {
    const v = riskHoverView(scored, "TSM", book, NOW)!;
    assert.equal(v.share, "5.3%");
    assert.deepEqual(
      v.lines.map((l) => l.kind),
      ["weight", "beta", "volatility", "correlation"],
    );
    assert.deepEqual(v.lines[3], { kind: "correlation", ticker: "NVDA", value: "0.61" });
  });

  it("the weight is the Positions card's own, on the live prints, not the snapshot's", () => {
    const moved = paperAccountWeights(
      { cash: 5000, positions: { NVDA: { symbol: "NVDA", shares: 15, costUsd: 2500 }, TSM: { symbol: "TSM", shares: 20, costUsd: 1800 } } },
      { NVDA: 300, TSM: 100 },
    );
    assert.deepEqual(riskHoverView(scored, "NVDA", moved, NOW)!.lines[0], { kind: "weight", value: "39.1%" });
  });

  it("an older snapshot without per-position metrics: the weight line alone, no share, no made-up figures", () => {
    const legacy = { ...scored, positions: undefined };
    const v = riskHoverView(legacy, "NVDA", book, NOW)!;
    assert.equal(v.share, null);
    assert.equal(v.shareFrac, null);
    assert.deepEqual(v.lines, [{ kind: "weight", value: "30.0%" }]);
  });

  it("nulls in the metrics drop their lines; an earnings date since passed is dropped too", () => {
    const sparse: RiskSnapshot = {
      ...scored,
      positions: [{ ...scored.positions![0], beta: null, daily_vol_pct: null, risk_share: null }],
    };
    const later = Date.parse("2026-08-28T12:00:00.000Z");
    assert.deepEqual(riskHoverView(sparse, "NVDA", book, later)!.lines, [{ kind: "weight", value: "30.0%" }]);
    assert.equal(riskHoverView(sparse, "NVDA", book, later)!.share, null);
  });

  it("a hedging short reads as a negative share, and the arc stays at zero", () => {
    const hedged: RiskSnapshot = { ...scored, positions: [{ ...scored.positions![1], risk_share: -0.042 }] };
    const v = riskHoverView(hedged, "TSM", book, NOW)!;
    assert.equal(v.share, "-4.2%");
    assert.equal(v.shareFrac, 0);
  });

  it("formatRiskShare: a tenth under 10%, whole percent above, never a negative zero", () => {
    assert.equal(formatRiskShare(0.38), "38%");
    assert.equal(formatRiskShare(0.0849), "8.5%");
    assert.equal(formatRiskShare(-0.0001), "0.0%");
    assert.equal(formatRiskShare(1), "100%");
  });
});
