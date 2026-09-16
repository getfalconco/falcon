/**
 * §9 layer 1 — composite pattern golden vectors (§2 pattern table).
 *
 * Expected tag sets and bonus values are computed by hand from the table and
 * pinned as constants.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QuantContext, TrackerMessage } from "../tracker/types.js";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import { compositeBonus, deriveCompositeTags } from "./tags.js";
import {
  driftEvent,
  filingItem,
  filingOverdue,
  gapEvent,
  insiderCluster,
  newsBurst,
  newsItem,
  quant,
  scheduledEvent,
  silenceAnomaly,
  unexplainedMove,
  volumeAnomaly,
} from "./test-fixtures.js";
import type { CompositeTag } from "./types.js";

const CONFIG = DEFAULT_BASE_CONFIG;
const WINDOW_START = "2026-08-21T13:00:00.000Z";
const AT = "2026-08-21T20:15:00.000Z";

function tagsOf(
  messages: TrackerMessage[],
  overrides: { windowStart?: string; quantContext?: QuantContext | null } = {},
): CompositeTag[] {
  return deriveCompositeTags(
    {
      messages,
      windowStart: overrides.windowStart ?? WINDOW_START,
      quantContext: overrides.quantContext === undefined ? quant() : overrides.quantContext,
    },
    CONFIG,
  );
}

// ---------------------------------------------------------------------------
// Direction-sensitive insider patterns
// ---------------------------------------------------------------------------

describe("§2 direction-sensitive insider tags", () => {
  const cases: Array<{
    cluster: "buy" | "sell";
    drift: "up" | "down";
    expected: CompositeTag[];
  }> = [
    { cluster: "buy", drift: "up", expected: ["silent_accumulation"] },
    { cluster: "buy", drift: "down", expected: ["insider_divergence"] },
    { cluster: "sell", drift: "up", expected: ["insider_divergence"] },
    // A sell cluster drifting down is merely consistent — the table gives it no tag.
    { cluster: "sell", drift: "down", expected: [] },
  ];

  for (const { cluster, drift, expected } of cases) {
    it(`insider_cluster(${cluster}) + drift_event(${drift}) -> [${expected.join(", ")}]`, () => {
      const messages = [
        insiderCluster("c1", AT, { direction: cluster }),
        driftEvent("d1", AT, { direction: drift }),
      ];
      assert.deepEqual(tagsOf(messages), expected);
    });
  }

  it("insider_confirmation: insider_cluster + unexplained_move, direction-independent", () => {
    for (const direction of ["buy", "sell"] as const) {
      const messages = [
        insiderCluster("c1", AT, { direction }),
        unexplainedMove("u1", AT, { direction: "down" }),
      ];
      assert.deepEqual(tagsOf(messages), ["insider_confirmation"]);
    }
  });

  it("standalone_insider_cluster fires alone above the conviction threshold", () => {
    // The PFE case: 3 open-market buys, ~$2.96M, no partner measurement.
    const alone = [insiderCluster("c1", AT, { insider_count: 3, total_notional: 2_960_110 })];
    assert.deepEqual(tagsOf(alone), ["standalone_insider_cluster"]);
  });

  it("standalone_insider_cluster respects the notional threshold", () => {
    const thin = [insiderCluster("c1", AT, { insider_count: 3, total_notional: 999_999 })];
    assert.deepEqual(tagsOf(thin), []);
    const atThreshold = [insiderCluster("c1", AT, { insider_count: 3, total_notional: 1_000_000 })];
    assert.deepEqual(tagsOf(atThreshold), ["standalone_insider_cluster"]);
  });

  it("standalone_insider_cluster still applies alongside a partner tag", () => {
    // "Standalone" describes what it does not require, not what it excludes.
    const withPartner = [
      insiderCluster("c1", AT, { insider_count: 3, total_notional: 2_960_110 }),
      unexplainedMove("u1", AT),
    ];
    assert.deepEqual(tagsOf(withPartner), [
      "insider_confirmation",
      "standalone_insider_cluster",
    ]);
  });

  it("insider_distribution needs a sell cluster, not a buy one", () => {
    const sell = [insiderCluster("c1", AT, { direction: "sell" }), newsBurst("b1", AT)];
    assert.deepEqual(tagsOf(sell), ["insider_distribution"]);
    const buy = [insiderCluster("c1", AT, { direction: "buy" }), newsBurst("b1", AT)];
    assert.deepEqual(tagsOf(buy), []);
  });
});

// ---------------------------------------------------------------------------
// The remaining rows
// ---------------------------------------------------------------------------

describe("§2 pattern table rows", () => {
  it("unexplained_activity: unexplained_move + volume_anomaly", () => {
    assert.deepEqual(tagsOf([unexplainedMove("u1", AT), volumeAnomaly("v1", AT)]), [
      "unexplained_activity",
    ]);
  });

  it("disclosure_risk fires on either component", () => {
    assert.deepEqual(tagsOf([filingOverdue("o1", AT), unexplainedMove("u1", AT)]), [
      "disclosure_risk",
    ]);
    assert.deepEqual(tagsOf([filingOverdue("o1", AT), volumeAnomaly("v1", AT)]), [
      "disclosure_risk",
    ]);
    assert.deepEqual(tagsOf([filingOverdue("o1", AT)]), []);
  });

  it("pre_earnings_silence: silence_anomaly + earnings due within 14 days", () => {
    const withinScheduled = [
      silenceAnomaly("s1", AT),
      scheduledEvent("e1", AT, "2026-08-31T20:30:00.000Z"), // 10 days out
    ];
    assert.deepEqual(tagsOf(withinScheduled), ["pre_earnings_silence"]);

    const beyond = [
      silenceAnomaly("s1", AT),
      scheduledEvent("e1", AT, "2026-09-15T20:30:00.000Z"), // 25 days out
    ];
    assert.deepEqual(tagsOf(beyond), []);

    // The scheduled_event usually fired days earlier in its own incident, so
    // the silence payload's own due date is accepted too.
    const fromPayload = [
      silenceAnomaly("s1", AT, { next_earnings_due_at: "2026-08-28T20:30:00.000Z" }),
    ];
    assert.deepEqual(tagsOf(fromPayload), ["pre_earnings_silence"]);

    const payloadDisabled = mergeBaseConfig({
      tags: { ...CONFIG.tags, preEarningsSilenceUsesSilencePayload: false },
    });
    assert.deepEqual(
      deriveCompositeTags(
        { messages: fromPayload, windowStart: WINDOW_START, quantContext: quant() },
        payloadDisabled,
      ),
      [],
    );
  });

  it("volume_without_price needs a computable move_zscore below the threshold", () => {
    const volume = [volumeAnomaly("v1", AT)];
    assert.deepEqual(tagsOf(volume, { quantContext: quant({ move_zscore: 0.3 }) }), [
      "volume_without_price",
    ]);
    assert.deepEqual(tagsOf(volume, { quantContext: quant({ move_zscore: 0.5 }) }), []);
    // Null is "not computable", never zero (§1) — no tag.
    assert.deepEqual(tagsOf(volume, { quantContext: quant({ move_zscore: null }) }), []);
  });

  it("event_gap: a gap with an 8-K or the earnings_window flag", () => {
    const withEightK = [gapEvent("g1", AT), filingItem("f1", AT, { item_codes: ["8.01"] })];
    assert.deepEqual(tagsOf(withEightK), ["event_gap"]);

    const withFlag = [gapEvent("g1", AT, {}, { context_flags: ["earnings_window"] })];
    assert.deepEqual(tagsOf(withFlag), ["event_gap"]);

    assert.deepEqual(tagsOf([gapEvent("g1", AT)]), []);
  });

  it("earnings_surprise needs all three components on the same NY day", () => {
    const complete = [
      scheduledEvent("e1", AT, "2026-08-21T20:30:00.000Z"),
      gapEvent("g1", AT),
      filingItem("f1", AT, { item_codes: ["2.02"] }),
    ];
    assert.deepEqual(tagsOf(complete), ["earnings_surprise", "event_gap"]);

    const dueTomorrow = [
      scheduledEvent("e1", AT, "2026-08-24T20:30:00.000Z"),
      gapEvent("g1", AT),
      filingItem("f1", AT, { item_codes: ["2.02"] }),
    ];
    assert.deepEqual(tagsOf(dueTomorrow), ["event_gap"]);

    const wrongItemCode = [
      scheduledEvent("e1", AT, "2026-08-21T20:30:00.000Z"),
      gapEvent("g1", AT),
      filingItem("f1", AT, { item_codes: ["8.01"] }),
    ];
    assert.deepEqual(tagsOf(wrongItemCode), ["event_gap"]);
  });

  // B4: burst only. Baseline news flow is noise; a burst is the signal.
  it("explained_move: unexplained_move + news_burst -> tag, -15 applied", () => {
    const withBurst = [unexplainedMove("u1", AT, { residual_zscore: 2.5 }), newsBurst("b1", AT)];
    assert.deepEqual(tagsOf(withBurst), ["explained_move"]);
    assert.equal(compositeBonus(tagsOf(withBurst), CONFIG), -15);
  });

  it("explained_move: unexplained_move + 5 routine news_item -> NO tag, score intact", () => {
    // A 6-7 article/day ticker has >= 3 news in almost every open incident;
    // under the old rule every revived unexplained_move ate -15 on arrival.
    const withFiveNews = [
      unexplainedMove("u1", AT, { residual_zscore: 2.5 }),
      newsItem("n1", AT),
      newsItem("n2", AT),
      newsItem("n3", AT),
      newsItem("n4", AT),
      newsItem("n5", AT),
    ];
    assert.deepEqual(tagsOf(withFiveNews), []);
    assert.equal(compositeBonus(tagsOf(withFiveNews), CONFIG), 0);
  });
});

// ---------------------------------------------------------------------------
// Multi-tag and composite_bonus
// ---------------------------------------------------------------------------

describe("§3 composite_bonus", () => {
  // insider_confirmation +15, disclosure_risk +15, unexplained_activity +8 = 38 -> capped at 30.
  const STACKED = [
    insiderCluster("c1", AT, { direction: "buy" }),
    unexplainedMove("u1", AT),
    volumeAnomaly("v1", AT),
    filingOverdue("o1", AT),
  ];
  const EXPECTED_TAGS: CompositeTag[] = [
    "insider_confirmation",
    "disclosure_risk",
    "unexplained_activity",
  ];

  it("emits tags in the canonical order", () => {
    assert.deepEqual(tagsOf(STACKED), EXPECTED_TAGS);
  });

  it("caps positive contributions at +30", () => {
    assert.equal(compositeBonus(tagsOf(STACKED), CONFIG), 30);
  });

  it("applies explained_move outside the positive cap", () => {
    const withBurst = [...STACKED, newsBurst("b1", AT)];
    assert.deepEqual(tagsOf(withBurst), [...EXPECTED_TAGS, "explained_move"]);
    assert.equal(compositeBonus(tagsOf(withBurst), CONFIG), 15); // min(38, 30) - 15
  });

  it("event_gap carries no weight", () => {
    assert.equal(compositeBonus(["event_gap"], CONFIG), 0);
  });

  it("an untagged incident scores no bonus", () => {
    assert.equal(compositeBonus([], CONFIG), 0);
  });
});
