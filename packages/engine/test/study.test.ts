import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entryIndex,
  eventStudy,
  fitMarketModel,
  isNyseEarlyClose,
  isNyseSession,
  lastCloseIndex,
  measureEvent,
  nyInstantMs,
  nyseSessions,
  reactionDayIndex,
  type PriceSeries,
} from "../src/study/abnormal.ts";
import { matchedOutcome, selectControls, winsorize, type ControlCandidate } from "../src/study/controls.ts";
import { eventPublicMs, findInsiderEvents, isRoutine, tradeMonths, type PurchaseFiling } from "../src/study/insider-events.ts";
import { clusteredMeanTest, neweyWestMean, seededRandom, tTwoSidedP, twoWayMeanTest, wildClusterBootstrapP } from "../src/study/stats.ts";

// ---------------------------------------------------------------------------
// Synthetic bars

function normal(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** Prices from returns, open = previous close (no overnight gap), so open->close = close->close. */
function series(returns: readonly number[], start = 100): PriceSeries {
  const close: number[] = [];
  const open: number[] = [];
  let p = start;
  for (let i = 0; i < returns.length; i++) {
    open.push(p);
    p = i === 0 ? p : p * (1 + returns[i]!);
    close.push(p);
  }
  // Day 0's open equals its close (return 0 on day 0).
  open[0] = close[0]!;
  return { open, close };
}

const SESSIONS = nyseSessions("2020-01-01", "2022-12-31");
/** 16:30 New York on a session: after the close, so entry is the next session's open. */
const afterClose = (ymd: string) => nyInstantMs(ymd, 16 * 60 + 30);

describe("NYSE calendar and the entry anchor", () => {
  it("counts the known number of sessions per year", () => {
    assert.equal(nyseSessions("2022-01-01", "2022-12-31").length, 251);
    assert.equal(nyseSessions("2023-01-01", "2023-12-31").length, 250);
    assert.equal(nyseSessions("2024-01-01", "2024-12-31").length, 252);
    assert.equal(isNyseSession("2024-03-29"), false); // Good Friday
    assert.equal(isNyseSession("2023-06-19"), false); // Juneteenth
    assert.equal(isNyseSession("2022-12-26"), false); // Christmas observed
    assert.equal(isNyseSession("2022-01-01"), false); // Saturday; 2021-12-31 trades
    assert.equal(isNyseSession("2021-12-31"), true);
    assert.equal(isNyseSession("2025-01-09"), false); // national day of mourning
    assert.equal(isNyseEarlyClose("2024-07-03"), true);
    assert.equal(isNyseEarlyClose("2025-11-28"), true);
  });

  const cal = nyseSessions("2024-01-01", "2025-12-31");
  const at = (ymd: string, h: number, m = 0) => nyInstantMs(ymd, h * 60 + m);
  const entry = (ms: number, lat = 0) => cal[entryIndex(cal, ms, lat)!];
  const last = (ms: number) => cal[lastCloseIndex(cal, ms)!];
  const day0 = (ms: number) => cal[reactionDayIndex(cal, ms)!];

  it("overnight: after the close enters at the next open", () => {
    assert.equal(entry(at("2024-03-05", 17)), "2024-03-06");
    assert.equal(last(at("2024-03-05", 17)), "2024-03-05");
    assert.equal(day0(at("2024-03-05", 17)), "2024-03-06");
  });

  it("intraday and pre-open", () => {
    assert.equal(entry(at("2024-03-05", 11)), "2024-03-06");
    assert.equal(last(at("2024-03-05", 11)), "2024-03-04");
    assert.equal(day0(at("2024-03-05", 11)), "2024-03-05");
    assert.equal(entry(at("2024-03-05", 8)), "2024-03-05");
    // Strictly after: an acceptance at 09:30:00 waits for the next open.
    assert.equal(entry(at("2024-03-05", 9, 30)), "2024-03-06");
    // Latency: 09:00 plus 45 minutes is past the open.
    assert.equal(entry(at("2024-03-05", 9), 45 * 60_000), "2024-03-06");
    assert.equal(entry(at("2024-03-05", 9), 15 * 60_000), "2024-03-05");
  });

  it("weekend and holidays", () => {
    assert.equal(entry(at("2024-03-08", 18)), "2024-03-11"); // Friday evening
    assert.equal(entry(at("2024-03-09", 12)), "2024-03-11"); // Saturday
    assert.equal(entry(at("2024-03-28", 17)), "2024-04-01"); // Good Friday between
    assert.equal(entry(at("2025-11-26", 20)), "2025-11-28"); // Thanksgiving between
    assert.equal(entry(at("2024-06-18", 17)), "2024-06-20"); // Juneteenth
    // Early close: 14:00 on July 3 is after that day's 13:00 close; July 4 is closed.
    assert.equal(last(at("2024-07-03", 14)), "2024-07-03");
    assert.equal(entry(at("2024-07-03", 14)), "2024-07-05");
  });

  it("works across daylight-saving changes (winter open is 14:30 UTC)", () => {
    assert.equal(new Date(nyInstantMs("2024-01-10", 9 * 60 + 30)).toISOString(), "2024-01-10T14:30:00.000Z");
    assert.equal(new Date(nyInstantMs("2024-07-10", 9 * 60 + 30)).toISOString(), "2024-07-10T13:30:00.000Z");
  });
});

describe("market model and legs", () => {
  it("recovers a known abnormal return as CAR and SCAR", () => {
    const rnd = seededRandom(7);
    const n = SESSIONS.length;
    const m = Array.from({ length: n }, () => 0.0004 + 0.01 * normal(rnd));
    const ev = 500;
    const s = m.map((x, i) => {
      if (i > ev && i <= ev + 5) return 0.0002 + 1.5 * x + 0.01; // +1% a day for 5 sessions, no noise
      return 0.0002 + 1.5 * x + 0.01 * normal(rnd);
    });
    const r = measureEvent({ sessions: SESSIONS, stock: series(s), market: series(m), publicMs: afterClose(SESSIONS[ev]!) });
    assert.ok(r.ok);
    assert.equal(r.entry, ev + 1);
    assert.ok(Math.abs(r.model.beta - 1.5) < 0.15, `beta ${r.model.beta}`);
    const d5 = r.drift[5]!;
    assert.ok(Math.abs(d5.car - 0.05) < 0.006, `car ${d5.car}`);
    assert.ok(Math.abs(d5.scar - d5.car / (r.model.sigma * Math.sqrt(5))) < 1e-12);
    assert.ok(d5.scar > 1.8 && d5.scar < 2.8, `scar ${d5.scar}`);
    // No gap in the synthetic opens: PRE is zero.
    assert.ok(r.pre && Math.abs(r.pre.raw) < 1e-12);
  });

  it("SPY measured against itself has no abnormal return", () => {
    const rnd = seededRandom(11);
    const m = Array.from({ length: SESSIONS.length }, () => 0.0005 + 0.012 * normal(rnd));
    const spy = series(m);
    const r = measureEvent({ sessions: SESSIONS, stock: spy, market: spy, publicMs: afterClose(SESSIONS[600]!) });
    assert.ok(r.ok);
    assert.ok(Math.abs(r.model.beta - 1) < 1e-9);
    for (const L of [5, 20, 60]) assert.ok(Math.abs(r.drift[L]!.car) < 1e-9);
  });

  it("needs 120 valid estimation days", () => {
    const m = Array.from({ length: SESSIONS.length }, (_, i) => 0.001 * Math.sin(i));
    const s = series(m.map((x) => 2 * x + 0.0001));
    const close = Array.from(s.close);
    for (let i = 0; i < 400; i++) close[i] = NaN;
    const r = measureEvent({ sessions: SESSIONS, stock: { open: s.open, close }, market: series(m), publicMs: afterClose(SESSIONS[420]!) });
    assert.deepEqual(r, { ok: false, reason: "no_estimation" });
    assert.equal(fitMarketModel(s, series(m), 1, 100), null);
  });

  it("a beta-2 stock with no event effect: market-model t stays small; raw minus SPY is biased", () => {
    let mmSmall = 0;
    let rawBiased = 0;
    const seeds = 20;
    for (let seed = 1; seed <= seeds; seed++) {
      const rnd = seededRandom(1000 + seed);
      const n = SESSIONS.length;
      // A rising market: +0.15% a day on average.
      const m = Array.from({ length: n }, () => 0.0015 + 0.01 * normal(rnd));
      const market = series(m);
      const mm: { value: number; date: string; firm: string }[] = [];
      const raw: { value: number; date: string; firm: string }[] = [];
      for (let k = 0; k < 150; k++) {
        const s = m.map((x) => 2 * x + 0.02 * normal(rnd));
        const ev = 280 + Math.floor(rnd() * (n - 360));
        const r = measureEvent({ sessions: SESSIONS, stock: series(s), market, publicMs: afterClose(SESSIONS[ev]!), windows: [20] });
        if (!r.ok || !r.drift[20]) continue;
        mm.push({ value: r.drift[20].car * 100, date: SESSIONS[ev]!, firm: `F${k}` });
        raw.push({ value: r.drift[20].rawMinusMarket * 100, date: SESSIONS[ev]!, firm: `F${k}` });
      }
      if (Math.abs(eventStudy(mm)!.byDate.t) < 2) mmSmall++;
      if (eventStudy(raw)!.byDate.t > 2) rawBiased++;
    }
    assert.ok(mmSmall >= 16, `market model |t| < 2 in ${mmSmall}/${seeds}`);
    assert.ok(rawBiased >= 16, `raw minus SPY t > 2 in ${rawBiased}/${seeds}`);
  });
});

describe("statistics", () => {
  it("clustered SE matches a hand-computed fixture", () => {
    // y = 1,2,3,4,6; mean 3.2; cluster sums of residuals -3.4, -0.2, 3.6;
    // V = 1.5 * (11.56 + 0.04 + 12.96) / 25 = 1.4736.
    const r = clusteredMeanTest([1, 2, 3, 4, 6], ["A", "A", "B", "C", "C"]);
    assert.equal(r.clusters, 3);
    assert.ok(Math.abs(r.se - Math.sqrt(1.4736)) < 1e-12);
    assert.ok(Math.abs(r.t - 3.2 / Math.sqrt(1.4736)) < 1e-12);
    assert.equal(r.df, 2);
  });

  it("two-way (CGM) SE matches a hand-computed fixture", () => {
    // V_firm = 1.5 * 19.76/25 = 1.1856; V_month = 2 * 0.32/25 = 0.0256; V_both = 1.25 * 14.8/25 = 0.74.
    const r = twoWayMeanTest([1, 2, 3, 4, 6], ["a", "a", "b", "b", "c"], ["m1", "m2", "m1", "m2", "m1"]);
    assert.ok(Math.abs(r.se - Math.sqrt(1.1856 + 0.0256 - 0.74)) < 1e-12);
    assert.equal(r.df, 1);
  });

  it("t tail areas", () => {
    assert.ok(Math.abs(tTwoSidedP(2, 10) - 0.073388) < 1e-5);
    assert.ok(Math.abs(tTwoSidedP(1, 1) - 0.5) < 1e-9);
    assert.ok(Math.abs(tTwoSidedP(1.959964, Infinity) - 0.05) < 1e-5);
  });

  it("Newey-West with no lags is the iid SE (1/n)", () => {
    const xs = [1, -1, 2, 0, 3];
    const r = neweyWestMean(xs, 0);
    const m = 1;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / 25;
    assert.ok(Math.abs(r.se - Math.sqrt(v)) < 1e-12);
  });

  it("wild-cluster bootstrap: small p for a clear effect, large for noise", () => {
    const ys = [1, 2, 3, 1.5, 2.5, 0.8, 1.2, 2.2, 1.8, 2.9];
    const keys = ys.map((_, i) => `d${i}`);
    assert.ok(wildClusterBootstrapP(ys, keys) < 0.01);
    const noise = [1, -1.1, 0.5, -0.4, 2, -2.1, 0.3, -0.2];
    assert.ok(wildClusterBootstrapP(noise, noise.map((_, i) => `d${i}`)) > 0.5);
  });

  it("eventStudy counts event dates and reports a bootstrap p only below 30 dates", () => {
    const obs = [1, 2, 3, 4].map((v, i) => ({ value: v, date: i < 2 ? "2024-01-02" : "2024-02-05", firm: `T${i}` }));
    const s = eventStudy(obs)!;
    assert.equal(s.n, 4);
    assert.equal(s.g, 2);
    assert.equal(s.median, 2.5);
    assert.notEqual(s.bootstrapP, null);
  });
});

describe("matched controls", () => {
  const base = { price: 20, dollarVolume: 10e6, beta: 1 };
  const c = (id: string, sic: string, sizeUsd: number, beta: number, extra: Partial<ControlCandidate> = {}): ControlCandidate => ({ ...base, id, sic, sizeUsd, beta, ...extra });

  it("same SIC3, nearest size then beta, liquidity and earnings screens", () => {
    const hit = { id: "H", sic: "3674", sizeUsd: 1e9, beta: 1.2 };
    const cands = [
      c("H", "3674", 1e9, 1.2),
      c("A", "3674", 1.1e9, 1.3),
      c("B", "3672", 0.9e9, 1.1), // 367x: same SIC3
      c("C", "3674", 2e9, 1.25),
      c("D", "3674", 1e9, 1.2, { price: 4 }), // too cheap
      c("E", "3674", 1e9, 1.2, { ownEarnings: true }),
      c("F", "3674", 1e9, 1.2, { dollarVolume: 1e6 }),
      c("G", "3711", 1e9, 1.2), // other industry
    ];
    const r = selectControls(hit, cands);
    assert.equal(r.level, "sic3");
    assert.deepEqual(r.controls.map((x) => x.id).sort(), ["A", "B", "C"]);
  });

  it("falls back to SIC2 and gives up below three", () => {
    const hit = { id: "H", sic: "3674", sizeUsd: 1e9, beta: 1 };
    const r = selectControls(hit, [c("A", "3674", 1e9, 1), c("B", "3600", 1e9, 1), c("C", "3711", 1e9, 1), c("D", "3690", 1e9, 1)]);
    assert.equal(r.level, "sic2");
    assert.deepEqual(r.controls.map((x) => x.id).sort(), ["A", "B", "D"]);
    assert.equal(selectControls(hit, [c("A", "3674", 1e9, 1)]).level, null);
  });

  it("takes the five nearest in beta from the ten nearest in size", () => {
    const hit = { id: "H", sic: "2834", sizeUsd: 1e9, beta: 1 };
    const cands = Array.from({ length: 14 }, (_, i) => c(`S${i}`, "2834", 1e9 * Math.exp(i * 0.1), 1 + (13 - i) * 0.05));
    const r = selectControls(hit, cands);
    // S10..S13 are outside the size pool even though their betas are nearest.
    assert.deepEqual(r.controls.map((x) => x.id), ["S9", "S8", "S7", "S6", "S5"]);
  });

  it("outcome is the signed, winsorized difference", () => {
    assert.equal(matchedOutcome(2, [0, 1, 2]), 1);
    assert.equal(matchedOutcome(-2, [0, 1, 2], -1), 3);
    assert.equal(matchedOutcome(5, [-1, 0, 0]), 3);
    assert.equal(matchedOutcome(1, [0, 0]), null);
    assert.equal(winsorize(-4), -3);
  });
});

describe("F7 insider events", () => {
  it("routine insiders: same calendar month in each of the prior three years", () => {
    const months = tradeMonths([
      { ownerCik: "O1", issuerCik: "I", transDate: "2019-03-04" },
      { ownerCik: "O1", issuerCik: "I", transDate: "2020-03-20" },
      { ownerCik: "O1", issuerCik: "I", transDate: "2021-03-01" },
      { ownerCik: "O2", issuerCik: "I", transDate: "2019-03-04" },
      { ownerCik: "O2", issuerCik: "I", transDate: "2021-03-04" },
    ]);
    assert.equal(isRoutine(months, "O1", "I", "2022-03-15"), true);
    assert.equal(isRoutine(months, "O1", "I", "2022-04-15"), false);
    assert.equal(isRoutine(months, "O1", "J", "2022-03-15"), false);
    assert.equal(isRoutine(months, "O2", "I", "2022-03-15"), false);
  });

  const f = (issuerCik: string, ownerCik: string, filingDate: string, valueUsd = 20_000, isOfficerOrDirector = true, accession = `${issuerCik}-${ownerCik}-${filingDate}`): PurchaseFiling => ({
    accession,
    issuerCik,
    ownerCik,
    filingDate,
    transDate: filingDate,
    isOfficerOrDirector,
    valueUsd,
    price: 10,
  });

  it("cluster rule, single-purchase rule and cooldown", () => {
    const caps: Record<string, number> = { A: 5e9, B: 5e9, C: 1.5e9, D: 3e9, E: 1e9 };
    const filings = [
      // A: three insiders Mon-Wed-Fri: a cluster on Friday.
      f("A", "O1", "2024-03-04"),
      f("A", "O2", "2024-03-06"),
      f("A", "O3", "2024-03-08"),
      // A again 12 days later: inside the 30-day cooldown.
      f("A", "O4", "2024-03-18"),
      f("A", "O5", "2024-03-19"),
      f("A", "O6", "2024-03-20"),
      // A after the cooldown.
      f("A", "O1", "2024-04-15"),
      f("A", "O2", "2024-04-16"),
      f("A", "O7", "2024-04-16"),
      // B: the third insider comes six business days after the first.
      f("B", "O1", "2024-03-04"),
      f("B", "O2", "2024-03-06"),
      f("B", "O3", "2024-03-12"),
      // C: one officer, $150k, $1.5B company.
      f("C", "O1", "2024-05-01", 150_000),
      // D: the same at a $3B company.
      f("D", "O1", "2024-05-01", 150_000),
      // E: a 10% holder (not an officer or director), $500k.
      f("E", "O1", "2024-05-01", 500_000, false),
      // A repeated insider does not count twice.
      f("F", "O1", "2024-05-01"),
      f("F", "O1", "2024-05-02"),
      f("F", "O2", "2024-05-03"),
    ];
    const events = findInsiderEvents(filings, (x) => caps[x.issuerCik] ?? null);
    const got = events.map((e) => `${e.issuerCik} ${e.date} ${e.kind}`);
    assert.deepEqual(got, ["A 2024-03-08 cluster", "A 2024-04-16 cluster", "C 2024-05-01 single"]);
    assert.equal(events[0]!.clusterNeeded, 1);
    assert.equal(events[1]!.clusterNeeded, 2);
  });

  it("event time: the acceptance that completes the rule", () => {
    const filings = [f("A", "O1", "2024-04-15"), f("A", "O2", "2024-04-16", 20_000, true, "x2"), f("A", "O7", "2024-04-16", 20_000, true, "x7")];
    const [ev] = findInsiderEvents(filings, () => null);
    assert.ok(ev);
    const t2 = nyInstantMs("2024-04-16", 17 * 60);
    const t7 = nyInstantMs("2024-04-16", 12 * 60);
    // Two new insiders needed that day: the later of the two acceptances.
    assert.equal(eventPublicMs(ev, new Map([["x2", t2], ["x7", t7]])), t2);
    assert.equal(eventPublicMs(ev, new Map([["x7", t7]])), null);
  });
});
