import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { livePricedIn, targetPricedIn } from "./propagation-progress";
import type { PropagationTarget } from "./propagation-run-types";

/**
 * Built from the real AVGO row that started this: reference close 364.03 on the
 * event day, a 0.50% called move, direction unclear, and a stored reading taken
 * at 368.45 on 2026-08-21 that then sat unchanged for days while the price on
 * screen kept moving.
 */
function avgo(over: Partial<PropagationTarget["pricing"]> = {}): PropagationTarget {
  return {
    target: "AVGO",
    ticker: "AVGO",
    label: "Broadcom",
    tracked: true,
    relationship: { role: "supplier", tier: "important", subtype: null, evidence_via: "filing" },
    transmission: { tier: "weak", direction: "unclear" },
    mechanism: "",
    stage2: null,
    pricing: {
      status: "partial",
      realized_resid_pct: 0.003,
      realized_raw_pct: 0.0121,
      expected_pct: 0.005,
      basis: "residual",
      reference_close_ts: "2026-08-20T20:00:00.000Z",
      reference_close: 364.03,
      last_price: 368.45,
      last_price_ts: "2026-08-21T20:00:00.000Z",
      sessions_elapsed: 1,
      ratio: 0.6,
      note: null,
      ...over,
    },
  } as unknown as PropagationTarget;
}

describe("livePricedIn", () => {
  it("moves with the quote instead of sitting at the stored ratio", () => {
    const t = avgo();
    // What the card was stuck showing.
    assert.equal(Math.round((targetPricedIn(t) ?? 0) * 100), 60);

    // 360.54 — the price the card was showing beside that stuck 60%.
    const live = livePricedIn(t, 360.54);
    assert.ok(live != null);
    // (360.54/364.03 − 1) = −0.959%; unclear direction compares magnitude.
    assert.ok(Math.abs(live - 0.00959 / 0.005) < 0.01, `got ${live}`);
    assert.ok(Math.round(live * 100) > 60, "it is no longer 60%");
  });

  it("reads zero at the base price and one at exactly the called move", () => {
    const t = avgo();
    assert.equal(livePricedIn(t, 364.03), 0);
    // A 0.50% move up from the base is the whole of the called move.
    const atTarget = livePricedIn(t, 364.03 * 1.005);
    assert.ok(atTarget != null && Math.abs(atTarget - 1) < 1e-9);
  });

  it("respects the called direction — the wrong way reads negative", () => {
    const t = avgo();
    (t as { transmission: { tier: string; direction: string } }).transmission = {
      tier: "weak",
      direction: "positive",
    };
    const down = livePricedIn(t, 364.03 * 0.995);
    assert.ok(down != null && down < 0, `expected negative, got ${down}`);
    const up = livePricedIn(t, 364.03 * 1.005);
    assert.ok(up != null && Math.abs(up - 1) < 1e-9);
  });

  it("stands aside once the window has closed", () => {
    assert.equal(livePricedIn(avgo({ status: "stale" }), 400), null);
  });

  it("stands aside without a base price, a called move, or a quote", () => {
    assert.equal(livePricedIn(avgo({ reference_close: null }), 360), null);
    assert.equal(livePricedIn(avgo({ expected_pct: null }), 360), null);
    assert.equal(livePricedIn(avgo(), null), null);
    assert.equal(livePricedIn(avgo(), 0), null);
  });
});
