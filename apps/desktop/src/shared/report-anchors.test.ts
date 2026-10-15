import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearReportAnchor, quarterDay, quarterDistance } from "./report-anchors";

describe("report anchors", () => {
  it("counts days into the calendar quarter, around the quarter", () => {
    assert.equal(quarterDay("2026-01-01"), 0);
    assert.equal(quarterDay("2026-04-22"), 21);
    assert.equal(quarterDay("2026-10-15"), 14);
    assert.equal(quarterDistance(89, 1), 3);
  });

  it("passes dates near a confirmed report day and drops the rest", () => {
    const near = nearReportAnchor([
      { reportedAt: "2026-04-22T20:05:00.000Z", reportedYmd: "2026-04-22", epsActual: 0.41 },
      { reportedAt: null, reportedYmd: "2026-07-22", epsActual: 0.33 },
      // Not reported yet: no anchor.
      { reportedAt: null, reportedYmd: "2026-10-02", epsActual: null },
    ]);
    assert.equal(near("2025-10-22"), true);
    assert.equal(near("2026-01-28"), true);
    assert.equal(near("2026-10-02"), false);
  });

  it("passes everything with fewer than two confirmed reports", () => {
    const near = nearReportAnchor([{ reportedAt: null, reportedYmd: "2026-07-22", epsActual: 0.33 }]);
    assert.equal(near("2026-10-02"), true);
  });
});
