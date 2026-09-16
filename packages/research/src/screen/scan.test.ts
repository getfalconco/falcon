import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SCREEN_CONFIG } from "./config.js";
import { emptyStoreState } from "./lifecycle.js";
import { runScreenScan } from "./scan.js";
import { ScreenConfigStore, ScreenFindingsStore } from "./store.js";
import { R2_FLOOR, SESSION, barsFrom, cfg, synthetic, tickerInput } from "./test-fixtures.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-screen-"));
}

/** MSTR: quiet-accumulation trigger. NVDA: plain synthetic. SHRT: 20 sessions. LAG: last bar missing. */
function universe() {
  const s = synthetic({ n: 300, seed: 3 });
  const flatTail = [0.001, -0.001, 0.0005, -0.0005, 0.001];
  const volumes = s.days.map((_, i) => (i >= 295 ? [2.0, 1.0, 2.5, 1.0, 1.8][i - 295] * 1_000_000 : 1_000_000));
  const mstr = barsFrom({ days: s.days, returns: [...s.tickerReturns.slice(0, 294), ...flatTail], volumes });
  const nvda = synthetic({ n: 300, seed: 21 }).ticker;
  const shrt = synthetic({ n: 20, seed: 5 }).ticker;
  const lag = synthetic({ n: 300, seed: 8 }).ticker.slice(0, -1);
  return {
    bench: s.bench,
    inputs: [tickerInput("MSTR", mstr), tickerInput("NVDA", nvda), tickerInput("SHRT", shrt), tickerInput("LAG", lag)],
  };
}

describe("screen/scan — the daily batch", () => {
  it("evaluates every enabled pattern × ticker, records degraded entries, creates findings", () => {
    const u = universe();
    const r = runScreenScan({ session: SESSION, now: "2026-08-21T21:10:00.000Z", trigger: "manual", inputs: u.inputs, benchBars: u.bench, r2Floor: R2_FLOOR, config: cfg(), state: emptyStoreState() });
    assert.equal(r.scan.session, SESSION);
    assert.equal(r.scan.tickers_scanned, 4);
    assert.equal(r.scan.evaluations, 16);
    assert.ok(r.scan.new >= 1);
    const mstr = r.state.findings.find((f) => f.ticker === "MSTR" && f.pattern === "quiet_accumulation");
    assert.ok(mstr, "MSTR quiet_accumulation finding");
    assert.equal(mstr.state, "new");
    assert.equal(mstr.day_count, 1);
    assert.equal(mstr.sessions_view.length, 5);
    // SHRT: one degraded entry per pattern (history); LAG: one blanket entry.
    const shrt = r.scan.degraded.filter((d) => d.ticker === "SHRT");
    assert.equal(shrt.length, 4);
    assert.ok(shrt.every((d) => /history window not yet full/.test(d.reason)));
    const lag = r.scan.degraded.filter((d) => d.ticker === "LAG");
    assert.equal(lag.length, 1);
    assert.equal(lag[0].pattern, "all");
    assert.match(lag[0].reason, /latest bar 2026-08-20 is behind the scan session 2026-08-21/);
    assert.equal(r.state.scans.length, 1);
    assert.ok(r.views.MSTR && r.views.LAG.as_of === "2026-08-20");
  });

  it("re-running the same session is idempotent (findings identical, one scan record)", () => {
    const u = universe();
    const first = runScreenScan({ session: SESSION, now: "2026-08-21T21:10:00.000Z", trigger: "manual", inputs: u.inputs, benchBars: u.bench, r2Floor: R2_FLOOR, config: cfg(), state: emptyStoreState() });
    const second = runScreenScan({ session: SESSION, now: "2026-08-21T22:10:00.000Z", trigger: "close_run", inputs: u.inputs, benchBars: u.bench, r2Floor: R2_FLOOR, config: cfg(), state: first.state });
    assert.deepEqual(second.state.findings, first.state.findings);
    assert.equal(second.state.scans.length, 1);
    assert.equal(second.state.scans[0].trigger, "close_run");
    assert.equal(second.scan.new, 0);
    assert.equal(second.scan.continuing, 0);
  });

  it("disabled patterns are not evaluated", () => {
    const u = universe();
    const config = cfg({ patterns: { compression: { enabled: false }, independent_tape: { enabled: false }, insider_divergence: { enabled: false } } });
    const r = runScreenScan({ session: SESSION, now: "2026-08-21T21:10:00.000Z", trigger: "manual", inputs: u.inputs, benchBars: u.bench, r2Floor: R2_FLOOR, config, state: emptyStoreState() });
    assert.equal(r.scan.evaluations, 4);
    assert.ok(r.evaluations.every((e) => e.pattern === "quiet_accumulation"));
  });

  it("no-lookahead end to end: a bar dated after the session changes nothing", () => {
    const u = universe();
    const future = { d: "2026-08-24", o: 1, h: 1, l: 1, c: 5, v: 9e9 };
    const spiked = u.inputs.map((i) => ({ ...i, bars: [...i.bars, future] }));
    const a = runScreenScan({ session: SESSION, now: "2026-08-21T21:10:00.000Z", trigger: "manual", inputs: u.inputs, benchBars: u.bench, r2Floor: R2_FLOOR, config: cfg(), state: emptyStoreState() });
    const b = runScreenScan({ session: SESSION, now: "2026-08-21T21:10:00.000Z", trigger: "manual", inputs: spiked, benchBars: [...u.bench, { ...future, c: 1 }], r2Floor: R2_FLOOR, config: cfg(), state: emptyStoreState() });
    assert.deepEqual(b.state.findings, a.state.findings);
    assert.deepEqual(b.evaluations, a.evaluations);
  });
});

describe("screen/store", () => {
  it("config: writes defaults on first load, merges stored overrides field by field", () => {
    const dir = tmp();
    const store = new ScreenConfigStore(dir);
    assert.deepEqual(store.load(), DEFAULT_SCREEN_CONFIG);
    assert.ok(fs.existsSync(path.join(dir, "config.json")));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ thresholds: { compression: { volRegimeMax: 0.7 } }, patterns: { compression: { enabled: false } }, windows: { sessions: "x" }, retentionDays: 30 }), "utf8");
    const merged = store.load();
    assert.equal(merged.thresholds.compression.volRegimeMax, 0.7);
    assert.equal(merged.thresholds.compression.rangeVolMultiple, 1.5);
    assert.equal(merged.patterns.compression.enabled, false);
    assert.equal(merged.patterns.compression.priority, 4);
    assert.equal(merged.windows.sessions, 5);
    assert.equal(merged.retentionDays, 30);
  });

  it("findings: round-trips state and reports the last scan", () => {
    const dir = tmp();
    const store = new ScreenFindingsStore(dir);
    assert.deepEqual(store.load(), emptyStoreState());
    assert.equal(store.lastScan(), null);
    const u = universe();
    const r = runScreenScan({ session: SESSION, now: "2026-08-21T21:10:00.000Z", trigger: "manual", inputs: u.inputs, benchBars: u.bench, r2Floor: R2_FLOOR, config: cfg(), state: store.load() });
    store.save(r.state);
    const fresh = new ScreenFindingsStore(dir);
    assert.deepEqual(fresh.load(), r.state);
    assert.equal(fresh.lastScan()?.session, SESSION);
  });
});
