import test from "node:test";
import assert from "node:assert/strict";
import { blankSpec, runChecked, validateSpec, type RunResultV2, type StrategySpecV2 } from "../src/index";
import { evidenceLabel, hindsightSignals, intentSaysTodaysList, type HindsightCap } from "../src/audit/tiers";
import type { Bar } from "../src/data/types";
import { sessions, specData, walkBars } from "./v2-helpers";

const dates = sessions("2015-01-01", 2000);
const NOW = new Date(`${dates.at(-1)}T21:00:00Z`);
const period = { start: dates[300]!, end: dates.at(-1)! };

// ---------------------------------------------------------------------------
// The label cap (pure).

const passing = { insufficient: false, t: 3, costsPass: true, delayPass: true, nullPct: 99, dsr: 0.99, listUniverse: true, activeVsEw: 10 };
const cap = (listExcessPct: number | null, edgePct: number | null): HindsightCap => ({ listExcessPct, edgePct, someText: "SOME", thinText: "THIN", noteText: "NOTE" });

test("label cap: without a confirmed hindsight list a passing result is Strong evidence", () => {
  assert.equal(evidenceLabel(passing).level, "consistent");
  assert.equal(evidenceLabel({ ...passing, hindsight: null }).level, "consistent");
});

test("label cap: a hindsight list caps Strong at Some when the rules add more over the list than the list adds over SPY", () => {
  const r = evidenceLabel({ ...passing, hindsight: cap(5.3, 24.5) });
  assert.equal(r.level, "some");
  assert.deepEqual(r.reasons, ["SOME"]);
});

test("label cap: Weak when the list itself adds at least as much over SPY as the rules add over the list", () => {
  assert.equal(evidenceLabel({ ...passing, hindsight: cap(6, 6) }).level, "thin");
  assert.deepEqual(evidenceLabel({ ...passing, hindsight: cap(8, 3) }).reasons, ["THIN"]);
  // A list that lagged SPY but was still made later (late listings) caps at Some.
  assert.equal(evidenceLabel({ ...passing, hindsight: cap(-2, 1) }).level, "some");
  // No list curve (event studies): capped at Some.
  assert.equal(evidenceLabel({ ...passing, hindsight: cap(null, null) }).level, "some");
});

test("label cap: never raises a label; Weak keeps its reasons and adds the hindsight note; too few trades is untouched", () => {
  const weak = evidenceLabel({ ...passing, costsPass: false, hindsight: cap(2, 10) });
  assert.equal(weak.level, "thin");
  assert.deepEqual(weak.reasons, ["With trading costs doubled, the gain disappears.", "NOTE"]);
  assert.deepEqual(evidenceLabel({ ...passing, costsPass: false, hindsight: cap(9, 1) }).reasons.at(-1), "THIN");
  const few = evidenceLabel({ ...passing, insufficient: true, insufficientText: "FEW", hindsight: cap(9, 1) });
  assert.deepEqual(few, { level: "insufficient", reasons: ["FEW"] });
});

// ---------------------------------------------------------------------------
// The detector (pure parts).

test("hindsight signals: a list chosen today is suspect; late listings, a winners' list or the wording confirm it", () => {
  const base = { listChosenToday: true, yearsBack: 10, tickers: 250, late: [] as string[], intentTell: false, listExcessPct: 0.5 };
  assert.deepEqual([hindsightSignals(base).suspect, hindsightSignals(base).confirmed], [true, false]);
  assert.equal(hindsightSignals({ ...base, listExcessPct: 5.3 }).confirmed, true);
  assert.equal(hindsightSignals({ ...base, late: Array.from({ length: 18 }, (_, i) => `T${i}`) }).confirmed, true);
  // One late listing in a long list is not enough.
  assert.equal(hindsightSignals({ ...base, late: ["PLTR"] }).confirmed, false);
  assert.equal(hindsightSignals({ ...base, late: ["A", "B", "C"], tickers: 250 }).confirmed, false);
  assert.equal(hindsightSignals({ ...base, intentTell: true }).confirmed, true);
  // Not a list chosen today, a single ticker, or a test that starts less than a year ago: not suspect.
  assert.equal(hindsightSignals({ ...base, listChosenToday: false, listExcessPct: 9 }).suspect, false);
  assert.equal(hindsightSignals({ ...base, tickers: 1, listExcessPct: 9 }).confirmed, false);
  assert.equal(hindsightSignals({ ...base, yearsBack: 0.8, listExcessPct: 9 }).confirmed, false);
});

test("hindsight wording: today's index members and today's largest companies, not ranking words or tickers", () => {
  for (const s of [
    "Top 3 momentum names from today's S&P 500",
    "the current Nasdaq 100 constituents, weekly rotation",
    "Rank the 250 largest companies by 3-month return",
    "the biggest US stocks",
    "top 100 companies by market cap",
    "S&P 500 members with RSI below 30",
  ])
    assert.ok(intentSaysTodaysList(s), s);
  for (const s of [
    "Every Tuesday purchase previous 3 month's top 3 gainers. With %10 trailing stop\nAAPL, NVDA, NOW, ALL, ON, CURRENT",
    "Buy the top 3 stocks by momentum each month",
    "Hold SPY while it is above its 200-day average",
    "the largest gainers of the week",
  ])
    assert.ok(!intentSaysTodaysList(s), s);
});

// ---------------------------------------------------------------------------
// Planted: a winners' list with late listings, a top-2 momentum rotation.

function run(spec: StrategySpecV2, bars: Record<string, Bar[]>): RunResultV2 {
  const c = validateSpec(spec, NOW);
  assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.issues));
  return runChecked(c as never, { data: specData(bars), now: NOW });
}

function rotation(tickers: string[], intent = ""): StrategySpecV2 {
  return {
    ...blankSpec(),
    intent,
    params: { lookback: { type: "int", value: 63, min: 21, max: 252, step: 21 } },
    universe: { kind: "static", tickers },
    portfolio: { mode: "rank", score: "ret(close, $lookback)", order: "desc", select: { n: 2 }, filter: null, weighting: "equal" },
    rebalance: "monthly",
    period,
  };
}

/** 20 names: four steady winners (drift `win`), the rest drifting at `rest`; six listed after the test starts. */
function winnersList(win: number, rest: number, vol: number): { names: string[]; bars: Record<string, Bar[]> } {
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 50, { volume: 9e7 }) };
  const names: string[] = [];
  for (let i = 0; i < 20; i++) {
    const t = `W${String.fromCharCode(65 + i)}`;
    names.push(t);
    bars[t] = walkBars(dates, 60 + i, { drift: i < 4 ? win : rest, vol, volume: 3e7, from: i >= 14 ? 600 + i * 40 : 0 });
  }
  return { names, bars };
}

function assertConfirmed(r: RunResultV2) {
  const c14 = r.quality.checks.find((c) => c.id === 14)!;
  assert.equal(c14.status, "warn");
  const h = r.quality.values.hindsight!;
  assert.equal(h.confirmed, "yes");
  assert.equal(h.late_listed, 6);
  assert.ok((h.list_vs_spy_pct as number) > 2, `list vs SPY ${h.list_vs_spy_pct}`);
  assert.ok(c14.plain!.includes("chosen today") && c14.plain!.includes("held equally"), c14.plain);
  assert.ok(r.quality.label.reasons.some((s) => s.includes("picked with hindsight")), r.quality.label.reasons.join(" "));
  // Plain-language copy: information only.
  for (const s of [c14.plain!, c14.detail, ...r.quality.label.reasons]) assert.ok(!/should|recommend|undervalued|opportunit|—/i.test(s), s);
  // Every other check passes, so without check 14 this would be Strong evidence.
  assert.deepEqual(r.quality.checks.filter((c) => c.status === "warn").map((c) => c.id).filter((id) => ![12, 14, 15].includes(id)), []);
}

test("planted: a winners' list with late listings, rules adding more than the list: Some evidence, not Strong", () => {
  const { names, bars } = winnersList(0.001, -0.0002, 0.008);
  const r = run(rotation(names), bars);
  assertConfirmed(r);
  const h = r.quality.values.hindsight!;
  assert.ok((h.rules_vs_list_pct as number) > (h.list_vs_spy_pct as number));
  assert.equal(r.quality.label.level, "some");
});

test("planted: a winners' list where most of the gain over SPY is the list itself: Weak evidence", () => {
  const { names, bars } = winnersList(0.0025, 0.0006, 0.012);
  const r = run(rotation(names), bars);
  assertConfirmed(r);
  const h = r.quality.values.hindsight!;
  assert.ok((h.rules_vs_list_pct as number) <= (h.list_vs_spy_pct as number));
  assert.equal(r.quality.label.level, "thin");
  assert.ok(r.quality.label.reasons[0]!.startsWith("Most of the gain over SPY comes from the list itself"));
});

test("planted: a list that did not beat SPY, all listed at the start, is suspect but not capped", () => {
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 70, { drift: 0.0004, volume: 9e7 }) };
  const names = ["AA", "BB", "CC", "DD", "EE", "FF"];
  names.forEach((t, i) => (bars[t] = walkBars(dates, 80 + i, { drift: 0.0002, vol: 0.012, volume: 3e7 })));
  const r = run(rotation(names), bars);
  assert.equal(r.quality.checks.find((c) => c.id === 14)!.status, "warn");
  assert.equal(r.quality.values.hindsight!.confirmed, "no");
  assert.ok(!r.quality.label.reasons.some((s) => s.includes("picked with hindsight")));
});

test("planted: the wording alone confirms a list as today's", () => {
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 70, { drift: 0.0004, volume: 9e7 }) };
  const names = ["AA", "BB", "CC", "DD", "EE", "FF"];
  names.forEach((t, i) => (bars[t] = walkBars(dates, 80 + i, { drift: 0.0002, vol: 0.012, volume: 3e7 })));
  const r = run(rotation(names, "Monthly, the top 2 by 3-month return from today's S&P 500 members: AA, BB, CC, DD, EE, FF"), bars);
  assert.equal(r.quality.values.hindsight!.confirmed, "yes");
});
