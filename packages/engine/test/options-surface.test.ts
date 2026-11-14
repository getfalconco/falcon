import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  parseDefinitions,
  parseOhlcv,
  parseOpenInterest,
  parseTrades,
  quotesAt,
  volumeByInstrument,
  type OptionDefinition,
  type Quote,
} from "../src/options/client.ts";
import { aggregateFlow, quietAccumulation, type FlowDay } from "../src/options/flow.ts";
import { bsmGreeks, bsmPrice, type Right } from "../src/options/math.ts";
import { bs2002Price } from "../src/options/american.ts";
import { callPutSpread, constantMaturityIv, DEFAULT_SURFACE_OPTIONS, expiryInstantMs, surfaceFeatures, xzzSkew, type ContractRow, type SurfaceInput } from "../src/options/surface.ts";

const close = (a: number | null, b: number, tol: number, msg = "") => assert.ok(a !== null && Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`);
const fixtureUrl = (name: string) => new URL(`./fixtures/options/${name}`, import.meta.url);
const fixture = (name: string) => JSON.parse(fs.readFileSync(fixtureUrl(name), "utf8"));
// Real Databento OPRA records are licensed data and stay out of the public repo; these suites run only where the files exist locally.
const needs = (name: string) => (fs.existsSync(fixtureUrl(name)) ? {} : { skip: "fixture not in repo" });

// ---------------------------------------------------------------------------
// Parsers on real Databento records

describe("record parsers (real KLAC records)", needs("klac-2026-11-13-raw.json"), () => {
  const raw = fixture("klac-2026-11-13-raw.json");

  it("definitions: strike, right, expiry, underlying, default multiplier 100 (OPRA sends sentinels)", () => {
    const defs = parseDefinitions(raw.definition);
    assert.equal(defs.length, 3);
    for (const d of defs) {
      assert.equal(d.underlying, "KLAC");
      assert.ok(d.right === "C" || d.right === "P");
      assert.ok(d.strike > 0);
      assert.match(d.expiration, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(d.multiplier, 100);
      // OSI symbol carries the same strike and expiry.
      const m = /^KLAC\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(d.rawSymbol)!;
      assert.equal(`20${m[1]}-${m[2]}-${m[3]}`, d.expiration);
      assert.equal(m[4], d.right);
      assert.equal(Number(m[5]) / 1000, d.strike);
    }
  });

  it("open interest: stat_type 9, one value per instrument across publishers", () => {
    const { oi, disagreements } = parseOpenInterest(raw.statistics);
    assert.ok(oi.size >= 1);
    assert.equal(disagreements, 0);
    for (const v of oi.values()) assert.ok(Number.isInteger(v) && v >= 0);
  });

  it("ohlcv-1d: volume summed over exchanges per instrument", () => {
    const bars = parseOhlcv(raw.ohlcv1d);
    assert.equal(bars.length, raw.ohlcv1d.length);
    const vol = volumeByInstrument(bars);
    assert.equal(vol.size, 1);
    assert.equal([...vol.values()][0], raw.ohlcv1d.reduce((s: number, r: { volume: string }) => s + Number(r.volume), 0));
  });

  it("cbbo-1m: the last sample at or before the snapshot wins; missing bid is null", () => {
    const at = Date.parse("2026-11-13T20:45:00Z");
    const q = quotesAt(raw.cbbo1m, at);
    assert.equal(q.size, 1);
    const one = [...q.values()][0]!;
    assert.ok(one.tsMs <= at);
    assert.equal(one.tsMs, Math.max(...raw.cbbo1m.map((r: { ts_recv: string }) => Date.parse(r.ts_recv)).filter((t: number) => t <= at)));
    // Before every sample: the earliest after is used.
    const early = quotesAt(raw.cbbo1m, Date.parse("2026-11-13T20:00:00Z"));
    assert.equal([...early.values()][0]!.tsMs, Math.min(...raw.cbbo1m.map((r: { ts_recv: string }) => Date.parse(r.ts_recv))));
  });

  it("trades: side B/A/N, prices as numbers; the closing cross has no side", () => {
    const t = parseTrades(raw.trades);
    assert.equal(t.length, raw.trades.length);
    assert.ok(t.every((x) => ["B", "A", "N"].includes(x.side) && x.price > 0));
    const cross = t.find((x) => x.size > 1_000_000)!;
    assert.equal(cross.side, "N");
    const flow = aggregateFlow(t);
    assert.equal(flow.length, 1);
    assert.equal(flow[0]!.auctionVolume, cross.size);
  });
});

// ---------------------------------------------------------------------------
// Surface on the recorded KLAC chain

function loadChain(): SurfaceInput & { fullDayOptionVolume: number } {
  const fx = fixture("klac-2026-11-13-chain.json");
  type Row = [number, string, Right, number, string, number | null, number | null, number | null, number | null, number];
  const rows = fx.contracts as Row[];
  const definitions: OptionDefinition[] = rows.map((c) => ({
    instrumentId: c[0],
    rawSymbol: c[1],
    underlying: "KLAC",
    right: c[2],
    strike: c[3],
    expiration: c[4],
    expirationMs: Date.parse(`${c[4]}T00:00:00Z`),
    multiplier: 100,
  }));
  const quotes = new Map<number, Quote>();
  for (const c of rows) if (c[7] !== null) quotes.set(c[0], { instrumentId: c[0], tsMs: c[7], bid: c[5], ask: c[6], bidSize: 0, askSize: 0 });
  return {
    underlying: "KLAC",
    date: fx.date,
    asOfMs: fx.asOfMs,
    spot: fx.spot,
    rate: fx.rate,
    divYield: fx.divYield,
    definitions,
    quotes,
    openInterest: new Map(rows.filter((c) => c[8] !== null).map((c) => [c[0], c[8]!])),
    volume: new Map(rows.map((c) => [c[0], c[9]])),
    stockVolume: fx.stockVolume,
    fullDayOptionVolume: fx.fullDayOptionVolume,
  };
}

describe("surface features on the recorded KLAC chain (2026-11-13 15:45 ET)", needs("klac-2026-11-13-chain.json"), () => {
  const input = loadChain();
  const f = surfaceFeatures(input);

  it("snapshot is 15:45 New York and expiries end at the 16:00 close", () => {
    assert.equal(new Date(input.asOfMs).toISOString(), "2026-11-13T20:45:00.000Z");
    assert.equal(new Date(expiryInstantMs("2026-11-20")).toISOString(), "2026-11-20T21:00:00.000Z");
    assert.equal(new Date(expiryInstantMs("2027-06-17")).toISOString(), "2027-06-17T20:00:00.000Z");
  });

  it("quality: most contracts quoted and inverted; parity agrees with the spot", () => {
    assert.equal(f.quality.contracts, 516);
    assert.ok(f.quality.withIv / f.quality.contracts > 0.8);
    assert.deepEqual(f.quality.warnings, []);
    close(f.parityImpliedSpot, input.spot, input.spot * 0.005, "parity spot");
  });

  it("ATM IV curve and term slope (recorded values)", () => {
    close(f.atmIv30, 0.6307, 0.0005);
    close(f.atmIv60, 0.6041, 0.0005);
    close(f.atmIv90, 0.6111, 0.0005);
    close(f.termSlope, 0.0196, 0.0005);
    const first = f.expiries[0]!;
    assert.equal(first.expiration, "2026-11-20");
    close(first.atmIv, 0.6749, 0.0005);
  });

  it("implied move to the next expiry: straddle / spot agrees with ATM IV x sqrt(T) x sqrt(2/pi)", () => {
    const m = f.impliedMoves[0]!;
    assert.equal(m.expiration, "2026-11-20");
    close(m.straddlePct, 0.0746, 0.0005);
    close(m.ivAbsPct, m.straddlePct!, 0.003);
    close(m.ivSdPct! * Math.sqrt(2 / Math.PI), m.ivAbsPct!, 1e-12);
    const later = surfaceFeatures({ ...input, moveDates: ["2026-12-15"] }).impliedMoves[0]!;
    assert.equal(later.expiration, "2026-12-18");
  });

  it("XZZ skew: OTM put near 0.95 minus ATM call, 10-60 days, headline at the expiry closest to 30 days", () => {
    assert.deepEqual(
      f.skewByExpiry.map((s) => s.expiration),
      ["2026-12-11", "2026-12-18"],
    );
    for (const s of f.skewByExpiry) {
      assert.ok(s.putStrike / input.spot <= 0.95 && s.putStrike / input.spot >= 0.8);
      assert.ok(Math.abs(s.callStrike / input.spot - 1) <= 0.05);
    }
    close(f.skew, 0.0336, 0.0005);
    close(f.skewMean, 0.0198, 0.0005);
  });

  it("CW call-put spread, O/S and GEX (recorded values)", () => {
    close(f.callPutSpread, -0.0419, 0.0005);
    assert.equal(f.callPutPairs, 155);
    assert.equal(f.callPutUnweighted, false);
    assert.equal(f.optionVolume, 6426);
    close(f.oToS, 6426 / (12507104 / 100), 1e-12);
    close(f.gex, -7.846e6, 0.01e6);
    close(f.gexCalls! + f.gexPuts!, f.gex!, 1e-6);
    assert.ok(f.gexCalls! > 0 && f.gexPuts! < 0);
  });

  it("European IVs give nearly the same ATM level (American premium is small at the money)", () => {
    const eu = surfaceFeatures({ ...input, options: { ivModel: "european" } });
    close(eu.atmIv30, f.atmIv30!, 0.003);
  });

  it("without OI the CW spread is unweighted and GEX is null", () => {
    const g = surfaceFeatures({ ...input, openInterest: undefined });
    assert.equal(g.callPutUnweighted, true);
    assert.equal(g.gex, null);
    assert.ok(g.callPutPairs >= f.callPutPairs);
  });
});

// ---------------------------------------------------------------------------
// Surface on a synthetic chain with known answers

function syntheticChain(ivOf: (right: Right, k: number, days: number) => number, model: "bsm" | "bs2002" = "bs2002"): SurfaceInput {
  const S = 100;
  const asOfMs = Date.parse("2026-11-13T20:45:00Z");
  const r = 0.04;
  const q = 0.01;
  const defs: OptionDefinition[] = [];
  const quotes = new Map<number, Quote>();
  const oi = new Map<number, number>();
  let id = 1;
  for (const exp of ["2026-11-20", "2026-12-11", "2026-12-18", "2027-01-15", "2027-02-19"]) {
    const T = (expiryInstantMs(exp) - asOfMs) / (365 * 86_400_000);
    const days = T * 365;
    for (let k = 70; k <= 130; k += 2.5) {
      for (const right of ["C", "P"] as const) {
        const sigma = ivOf(right, k, days);
        const o = { S, K: k, T, r, q, sigma, right };
        const p = model === "bsm" ? bsmPrice(o) : bs2002Price(o);
        defs.push({ instrumentId: id, rawSymbol: `X${id}`, underlying: "X", right, strike: k, expiration: exp, expirationMs: Date.parse(exp), multiplier: 100 });
        quotes.set(id, { instrumentId: id, tsMs: asOfMs, bid: p * 0.995, ask: p * 1.005, bidSize: 1, askSize: 1 });
        oi.set(id, right === "C" ? 100 : 300);
        id++;
      }
    }
  }
  return { underlying: "X", date: "2026-11-13", asOfMs, spot: S, rate: r, divYield: q, definitions: defs, quotes, openInterest: oi };
}

describe("surface features on a synthetic chain", () => {
  it("flat 30% surface: ATM IV 30%, zero slope, zero skew, zero call-put spread", () => {
    const f = surfaceFeatures(syntheticChain(() => 0.3));
    close(f.atmIv30, 0.3, 1e-4);
    close(f.atmIv90, 0.3, 1e-4);
    close(f.termSlope, 0, 1e-4);
    close(f.skew, 0, 1e-4);
    close(f.callPutSpread, 0, 1e-4);
  });

  it("recovers a planted smirk, a call premium and an inverted term structure", () => {
    const iv = (right: Right, k: number, days: number) => 0.3 + 0.4 * Math.max(0, 1 - k / 100) + (right === "C" ? 0.02 : 0) + (days < 40 ? 0.1 : 0);
    const f = surfaceFeatures(syntheticChain(iv));
    // Put at K = 95 (K/S 0.95) minus call at K = 100: 0.4 x 0.05 - 0.02 = 0.
    close(f.skew, 0.4 * 0.05 - 0.02, 2e-4);
    close(f.callPutSpread, 0.02, 2e-4);
    assert.ok(f.expiries[0]!.atmIv! > 0.39);
    assert.ok(f.termSlope! > 0);
  });

  it("GEX sign: calls add, puts subtract, scaled by gamma x OI x 100 x S^2 x 1%", () => {
    const input = syntheticChain(() => 0.3);
    const f = surfaceFeatures(input);
    let expect = 0;
    for (const d of input.definitions) {
      const T = (expiryInstantMs(d.expiration) - input.asOfMs) / (365 * 86_400_000);
      const g = bsmGreeks({ S: 100, K: d.strike, T, r: input.rate, q: input.divYield, sigma: 0.3, right: d.right }).gamma;
      expect += (d.right === "C" ? 1 : -1) * g * input.openInterest!.get(d.instrumentId)! * 100 * 100 * 100 * 0.01;
    }
    close(f.gex, expect, Math.abs(expect) * 0.002);
    assert.ok(f.gex! < 0, "3x put OI makes the naive GEX negative");
  });

  it("liquidity filters: wide, zero-bid and stale quotes get no IV", () => {
    const input = syntheticChain(() => 0.3);
    const ids = [...input.quotes.keys()];
    const quotes = new Map(input.quotes);
    quotes.set(ids[0]!, { ...quotes.get(ids[0]!)!, bid: 0 });
    quotes.set(ids[1]!, { ...quotes.get(ids[1]!)!, bid: 0.01, ask: 5 });
    quotes.set(ids[2]!, { ...quotes.get(ids[2]!)!, tsMs: input.asOfMs - 3_600_000 });
    quotes.delete(ids[3]!);
    const f = surfaceFeatures({ ...input, quotes });
    const byId = new Map(f.contracts.map((c) => [c.instrumentId, c]));
    assert.deepEqual(byId.get(ids[0]!)!.flags, ["zero_bid"]);
    assert.deepEqual(byId.get(ids[1]!)!.flags, ["wide"]);
    assert.deepEqual(byId.get(ids[2]!)!.flags, ["stale_quote"]);
    assert.deepEqual(byId.get(ids[3]!)!.flags, ["no_quote"]);
    for (const i of ids.slice(0, 4)) assert.equal(byId.get(i)!.iv, null);
  });
});

describe("surface helpers", () => {
  it("constant maturity interpolates total variance and is flat beyond the ends", () => {
    const pts = [
      { T: 0.1, iv: 0.4 },
      { T: 0.3, iv: 0.3 },
    ];
    const w = 0.4 * 0.4 * 0.1 + ((0.3 * 0.3 * 0.3 - 0.4 * 0.4 * 0.1) * (0.2 - 0.1)) / 0.2;
    close(constantMaturityIv(pts, 0.2), Math.sqrt(w / 0.2), 1e-12);
    assert.equal(constantMaturityIv(pts, 0.05), 0.4);
    assert.equal(constantMaturityIv(pts, 1), 0.3);
    assert.equal(constantMaturityIv([], 0.2), null);
  });

  it("xzzSkew needs both legs; callPutSpread weights by mean OI", () => {
    const row = (right: Right, strike: number, iv: number | null, oi: number | null): ContractRow => ({
      instrumentId: strike * 10 + (right === "C" ? 1 : 2),
      symbol: "",
      right,
      strike,
      expiration: "2026-12-18",
      days: 30,
      T: 30 / 365,
      moneyness: strike / 100,
      bid: 1,
      ask: 1.1,
      mid: 1.05,
      relSpread: 0.1,
      oi,
      volume: 0,
      iv,
      delta: null,
      gamma: null,
      flags: [],
    });
    assert.equal(xzzSkew([row("C", 100, 0.3, 1)]), null);
    const s = xzzSkew([row("P", 90, 0.4, 1), row("P", 94, 0.36, 1), row("C", 100, 0.3, 1), row("C", 104, 0.29, 1)])!;
    assert.equal(s.putStrike, 94);
    assert.equal(s.callStrike, 100);
    close(s.skew, 0.06, 1e-12);
    const cw = callPutSpread([row("C", 100, 0.32, 100), row("P", 100, 0.3, 300), row("C", 105, 0.3, 10), row("P", 105, 0.34, 30)], DEFAULT_SURFACE_OPTIONS);
    // Weights 200 and 20: (200 x 0.02 + 20 x -0.04) / 220.
    close(cw.value, (200 * 0.02 + 20 * -0.04) / 220, 1e-12);
    assert.equal(cw.pairs, 2);
  });
});

// ---------------------------------------------------------------------------
// Flow

describe("order flow", () => {
  const t = (iso: string, price: number, size: number, side: "B" | "A" | "N") => ({ tsMs: Date.parse(iso), price, size, side, publisherId: 2 });

  it("aggregates by New York date, regular session, unknown side left out of signed numbers", () => {
    const trades = [
      t("2026-11-13T13:00:00Z", 100, 500, "B"), // 08:00 ET pre-market: dropped
      t("2026-11-13T14:30:00.500Z", 100, 1000, "N"), // opening cross
      t("2026-11-13T15:00:00Z", 100, 100, "B"),
      t("2026-11-13T15:00:01Z", 101, 300, "B"),
      t("2026-11-13T15:00:02Z", 100.5, 200, "A"),
      t("2026-11-13T15:00:03Z", 100.6, 50, "N"), // hidden order
      t("2026-11-13T21:00:00.2Z", 100.4, 5000, "N"), // closing cross
      t("2026-11-14T00:30:00Z", 99, 700, "A"), // 19:30 ET after hours: dropped
    ];
    const [d] = aggregateFlow(trades);
    assert.equal(d!.date, "2026-11-13");
    assert.equal(d!.volume, 1000 + 100 + 300 + 200 + 50 + 5000);
    assert.equal(d!.buyVolume, 400);
    assert.equal(d!.sellVolume, 200);
    assert.equal(d!.unknownVolume, 6050);
    assert.equal(d!.auctionVolume, 6000);
    close(d!.imbalance, 200 / 600, 1e-12);
    close(d!.netSignedDollar, 100 * 100 + 101 * 300 - 100.5 * 200, 1e-9);
    close(d!.signedShare, 600 / 6650, 1e-12);
    // 00:30Z on the 14th is 19:30 ET on the 13th: same New York day when all sessions are kept.
    const all = aggregateFlow(trades, { session: "all" });
    assert.equal(all.length, 1);
    assert.equal(all[0]!.volume, d!.volume + 500 + 700);
  });

  it("tick rule signs hidden trades but never auction prints", () => {
    const trades = [
      t("2026-11-13T14:30:00.500Z", 100, 1000, "N"),
      t("2026-11-13T15:00:00Z", 100, 100, "B"),
      t("2026-11-13T15:00:01Z", 100.2, 50, "N"), // uptick: buy
      t("2026-11-13T15:00:02Z", 100.2, 50, "N"), // zero tick after uptick: buy
      t("2026-11-13T15:00:03Z", 100.1, 70, "N"), // downtick: sell
      t("2026-11-13T21:00:00.2Z", 99, 5000, "N"),
    ];
    const [d] = aggregateFlow(trades, { classify: "tick" });
    assert.equal(d!.buyVolume, 200);
    assert.equal(d!.sellVolume, 70);
    assert.equal(d!.unknownVolume, 6000);
  });

  it("quiet accumulation: net buying on a flat price scores high; the same buying on a big move scores 0", () => {
    const closes: Array<{ date: string; close: number }> = [];
    const start = Date.parse("2026-06-01T12:00:00Z");
    let p = 100;
    for (let i = 0; i < 80; i++) {
      if (i < 70) p *= 1 + (i % 2 ? 0.02 : -0.0196); // ~2% daily vol, then flat through the flow days
      closes.push({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), close: p });
    }
    const flowDays: FlowDay[] = closes.slice(70).map((c) => ({
      date: c.date,
      trades: 100,
      volume: 1000,
      buyVolume: 300,
      sellVolume: 100,
      unknownVolume: 600,
      buyDollar: 30_000,
      sellDollar: 10_000,
      unknownDollar: 60_000,
      auctionVolume: 0,
      netSignedDollar: 20_000,
      imbalance: 0.5,
      dollarImbalance: 0.5,
      signedShare: 0.4,
      vwap: 100,
    }));
    const rows = quietAccumulation(flowDays, closes, { window: 5 });
    assert.equal(rows.length, 6);
    const r = rows[0]!;
    close(r.imbalance, 0.5, 1e-12);
    assert.equal(r.positiveDays, 5);
    assert.ok(r.sigma! > 0.015 && r.sigma! < 0.025);
    assert.ok(r.quiet, `zMove ${r.zMove}`);
    close(r.zMove, 0, 1e-12);
    close(r.score, 0.5, 1e-12);

    const jumped = closes.map((c, i) => (i >= 70 ? { ...c, close: c.close * 1.15 } : c));
    const moved = quietAccumulation(flowDays, jumped, { window: 5 })[0]!;
    assert.equal(moved.quiet, false);
    assert.equal(moved.score, 0);
  });
});
