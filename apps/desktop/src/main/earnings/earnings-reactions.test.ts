import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { barsFrom, computeReaction, type Bar } from "./earnings-reactions";
import type { YahooQuarter } from "./earnings-sources";

/** Weekday closes from `start`, each 1% above the last unless `moves` says otherwise. */
function bars(start: string, count: number, moves: Record<string, number> = {}): Bar[] {
  const out: Bar[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  let c = 100;
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const ymd = d.toISOString().slice(0, 10);
      if (out.length > 0) c = c * (1 + (moves[ymd] ?? 0.01));
      out.push({ d: ymd, c });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function q(reportedYmd: string, reportedAt: string | null = null): YahooQuarter {
  return { periodEnd: null, fiscalQuarter: null, reportedAt, reportedYmd, epsActual: 1, epsEstimate: 1, revenueActual: null };
}

describe("reaction figures", () => {
  it("reads an after-the-close release on the next session, and one before the open on the same day", () => {
    const series = bars("2026-01-02", 220, { "2026-02-26": 0.08, "2026-05-07": -0.05 });
    const r = computeReaction(
      series,
      [
        // NVDA-style, 16:20 New York: the move is the next session's.
        q("2026-02-25", "2026-02-25T21:20:00.000Z"),
        // JPM-style, 06:30 New York: the same session.
        q("2026-05-07", "2026-05-07T10:30:00.000Z"),
      ],
      "2026-10-15",
    );
    assert.deepEqual(
      r.moves.map((m) => [m.date, m.reactionDay, Math.round(m.move * 1000) / 1000]),
      [
        ["2026-02-25", "2026-02-26", 0.08],
        ["2026-05-07", "2026-05-07", -0.05],
      ],
    );
    // Mean size of the two: (8% + 5%) / 2.
    assert.equal(Math.round(r.usualMove! * 1000) / 1000, 0.065);
  });

  it("needs two reports on record for a usual move", () => {
    const series = bars("2026-01-02", 220, { "2026-05-07": -0.05 });
    assert.equal(computeReaction(series, [q("2026-05-07", "2026-05-07T10:30:00.000Z")], "2026-10-15").usualMove, null);
  });

  it("does not count a session still under way into the usual move", () => {
    const series = bars("2026-01-02", 210, { "2026-07-16": 0.04, "2026-04-16": -0.02, "2026-10-15": -0.03 });
    const today = series[series.length - 1]!.d;
    const r = computeReaction(series, [q("2026-04-16", "2026-04-16T06:00:00.000Z"), q("2026-07-16", "2026-07-16T06:00:00.000Z"), q(today, `${today}T06:08:00.000Z`)], today);
    assert.equal(Math.round(r.usualMove! * 1000) / 1000, 0.03, "4% and 2%, today's move left out");
    assert.equal(r.moves.at(-1)!.reactionDay, today, "today's move is listed for the reported row");
  });

  it("takes the normal daily move from closed sessions, report sessions left out", () => {
    const series = bars("2026-01-02", 120, { "2026-05-07": -0.3 });
    const r = computeReaction(series, [q("2026-05-07", "2026-05-07T10:30:00.000Z")], "2026-12-31");
    assert.equal(Math.round(r.normalDailyMove! * 10_000) / 10_000, 0.01);
    assert.equal(r.asOf, series[series.length - 1]!.d);
  });

  it("leaves out a quarter without a release date and answers empty figures without closes", () => {
    const r = computeReaction([], [{ ...q("2026-05-07"), reportedYmd: null }], "2026-10-15");
    assert.deepEqual(r, { usualMove: null, moves: [], normalDailyMove: null, asOf: null });
  });

  it("dates daily bars by New York's calendar", () => {
    // Yahoo stamps a daily equity bar at the open, 13:30 UTC in summer.
    assert.deepEqual(barsFrom([{ t: Date.parse("2026-10-14T13:30:00Z"), v: 10 }, { t: Date.parse("2026-10-15T13:30:00Z"), v: 11 }]), [
      { d: "2026-10-14", c: 10 },
      { d: "2026-10-15", c: 11 },
    ]);
  });
});
