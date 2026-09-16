import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fastPathTrigger, isFastPathTrigger } from "./propagation-fast-path.js";

/** The live mapped set (`base/config.ts` → routing.mapped8kItemCodes). */
const MAPPED = ["2.02", "1.01", "5.02", "1.05", "8.01"];

const filing = (item_codes: string[]) => ({ type: "filing_item" as const, payload: { item_codes } });

describe("fast-path trigger (§ event-driven propagation)", () => {
  it("an earnings 8-K fires — the case Wednesday depends on", () => {
    assert.deepEqual(fastPathTrigger(filing(["2.02", "9.01"]), MAPPED), {
      kind: "filing",
      itemCodes: ["2.02"],
    });
  });

  it("every mapped item code fires, and only the mapped ones", () => {
    for (const code of MAPPED) assert.ok(isFastPathTrigger(filing([code]), MAPPED), code);
    // 9.01 (exhibits) and 7.01 (Reg FD) are not routed to propagation.
    assert.equal(isFastPathTrigger(filing(["9.01"]), MAPPED), false);
    assert.equal(isFastPathTrigger(filing(["7.01", "9.01"]), MAPPED), false);
    assert.equal(isFastPathTrigger(filing([]), MAPPED), false);
  });

  it("a gap fires; Base's event_gap composite decides whether it becomes a run", () => {
    assert.deepEqual(fastPathTrigger({ type: "gap_event", payload: { gap_z: -7.3 } }, MAPPED), { kind: "gap" });
  });

  it("news never fires — it only reaches propagation through a Classifier verdict", () => {
    assert.equal(isFastPathTrigger({ type: "news_item", payload: { headline: "NVDA beats" } }, MAPPED), false);
    for (const type of ["insider_filing", "scheduled_event", "volume_anomaly", "drift_event", "news_burst"] as const) {
      assert.equal(isFastPathTrigger({ type, payload: {} }, MAPPED), false, type);
    }
  });

  it("a malformed payload is not a trigger rather than a crash", () => {
    assert.equal(isFastPathTrigger({ type: "filing_item", payload: {} }, MAPPED), false);
    assert.equal(isFastPathTrigger({ type: "filing_item", payload: { item_codes: "2.02" } }, MAPPED), false);
    assert.equal(isFastPathTrigger({ type: "filing_item", payload: { item_codes: [null, 2.02] } }, MAPPED), false);
  });

  it("the mapped set is config: an install that drops 8.01 stops firing on it", () => {
    assert.equal(isFastPathTrigger(filing(["8.01"]), ["2.02"]), false);
  });
});
