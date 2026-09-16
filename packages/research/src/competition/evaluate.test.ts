import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSignal, type BookState, type CompetitionSignal } from "./evaluate.js";
import { PAPER_COMPETITION_POLICY, addWeekdays } from "./policy.js";

function now(): Date {
  return new Date("2026-08-22T16:00:00.000Z");
}

function book(partial: Partial<BookState> = {}): BookState {
  return {
    now: now(),
    runStartedAt: new Date("2026-08-22T03:00:00.000Z"),
    runActive: true,
    cash: 10_000,
    equity: 10_000,
    openTickers: new Set(),
    openCount: 0,
    ...partial,
  };
}

function signal(partial: Partial<CompetitionSignal> = {}): CompetitionSignal {
  return {
    id: "s1",
    terminal_ticker: "NVDA",
    direction: "positive",
    magnitude: "medium",
    path_confidence: 0.7,
    priced_in_status: "not yet reflected",
    generated_at: "2026-08-22T15:00:00.000Z",
    ...partial,
  };
}

describe("evaluateSignal", () => {
  it("takes an open-window signal the product would show", () => {
    const d = evaluateSignal(signal(), book());
    assert.deepEqual(d, { action: "take" });
  });

  it("skips below the 0.55 confidence used on open-signal cards", () => {
    const d = evaluateSignal(signal({ path_confidence: 0.54 }), book());
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.reason, "below_min_confidence");
  });

  it("skips priced-in / low / unclear the same way the UI hides them", () => {
    assert.equal(
      evaluateSignal(signal({ priced_in_status: "likely priced in" }), book()).action,
      "skip",
    );
    assert.equal(evaluateSignal(signal({ magnitude: "low" }), book()).action, "skip");
    assert.equal(evaluateSignal(signal({ direction: "unclear" }), book()).action, "skip");
  });

  it("allows shorts when longOnly is false", () => {
    const d = evaluateSignal(signal({ direction: "negative" }), book());
    assert.deepEqual(d, { action: "take" });
  });

  it("rejects a signal older than 24h", () => {
    const d = evaluateSignal(
      signal({ generated_at: "2026-08-21T15:00:00.000Z" }),
      book(),
    );
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.reason, "stale_for_ui_window");
  });

  it("blocks duplicate ticker and max positions", () => {
    const dup = evaluateSignal(signal(), book({ openTickers: new Set(["NVDA"]) }));
    assert.equal(dup.action, "skip");
    const max = evaluateSignal(
      signal(),
      book({ openCount: PAPER_COMPETITION_POLICY.maxConcurrentPositions }),
    );
    assert.equal(max.action, "skip");
    if (max.action === "skip") assert.equal(max.reason, "max_positions");
  });
});

describe("addWeekdays", () => {
  it("skips Saturday and Sunday", () => {
    const friday = new Date("2026-08-21T14:00:00.000Z");
    const exit = addWeekdays(friday, 5);
    assert.equal(exit.toISOString().slice(0, 10), "2026-08-28");
  });
});
