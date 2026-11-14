/**
 * Option-surface features per underlying per day, from an end-of-day quote
 * snapshot plus definitions, open interest and volume. See README.md for
 * definitions, sources and caveats. Pure: no fs, no network, no clock.
 */

import { nyInstantMs } from "../study/abnormal.ts";
import { crrPrice, impliedVolAmerican } from "./american.ts";
import { bsmGreeks, checkQuote, impliedVolEuropean, impliedVolFor, IV_MAX, IV_MIN, type Right } from "./math.ts";
import type { OptionDefinition, Quote } from "./client.ts";

const YEAR_MS = 365 * 86_400_000;
const DAY_MS = 86_400_000;

export type IvModel = "bs2002" | "crr" | "european";

export type SurfaceOptions = {
  /** Max (ask - bid) / mid for a quote to get an implied volatility (default 0.5). */
  maxRelSpread: number;
  /** Max minutes between a quote's sample time and the snapshot (default 15). */
  maxQuoteAgeMin: number;
  /** Model for implied volatility (default "bs2002"). */
  ivModel: IvModel;
  /** Contracts with fewer days to expiry get no IV (default 1: same-day expiries excluded). */
  minDays: number;
  /** Skew (Xing, Zhang & Zhao 2010): expiry window in days (default 10 to 60). */
  skewMinDays: number;
  skewMaxDays: number;
  /** Call-put spread (Cremers & Weinbaum 2010): expiry window (default 7 to 365) and K/S band (default 0.8 to 1.2). */
  cwMinDays: number;
  cwMaxDays: number;
  cwMinMoneyness: number;
  cwMaxMoneyness: number;
  /** Min open interest for a contract to count in the CW spread (default 1 when OI is known). */
  minOi: number;
};

export const DEFAULT_SURFACE_OPTIONS: SurfaceOptions = {
  maxRelSpread: 0.5,
  maxQuoteAgeMin: 15,
  ivModel: "bs2002",
  minDays: 1,
  skewMinDays: 10,
  skewMaxDays: 60,
  cwMinDays: 7,
  cwMaxDays: 365,
  cwMinMoneyness: 0.8,
  cwMaxMoneyness: 1.2,
  minOi: 1,
};

export type SurfaceInput = {
  underlying: string;
  /** New York session date of the snapshot. */
  date: string;
  /** Snapshot instant (ms). */
  asOfMs: number;
  /** Underlying price at the snapshot. */
  spot: number;
  /** Continuously compounded risk-free rate (rates.ts). */
  rate: number;
  /** Continuous dividend yield (rates.ts). */
  divYield: number;
  definitions: readonly OptionDefinition[];
  quotes: ReadonlyMap<number, Quote>;
  openInterest?: ReadonlyMap<number, number>;
  /** Contract volume of the day per instrument id. */
  volume?: ReadonlyMap<number, number>;
  /** Consolidated stock share volume of the day. */
  stockVolume?: number;
  /** Dates to price implied moves to (default: the day after `date`, i.e. the next expiry). */
  moveDates?: readonly string[];
  options?: Partial<SurfaceOptions>;
};

export type ContractRow = {
  instrumentId: number;
  symbol: string;
  right: Right;
  strike: number;
  expiration: string;
  days: number;
  T: number;
  moneyness: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  relSpread: number | null;
  oi: number | null;
  volume: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  /** Quote-quality and IV flags: no_quote, stale_quote, zero_bid, wide, crossed, no_ask, too_short, no_iv. */
  flags: string[];
};

export type ExpiryRow = {
  expiration: string;
  days: number;
  T: number;
  contracts: number;
  withIv: number;
  /** ATM IV: mean of call and put IV at the two strikes around spot, linearly interpolated to spot. */
  atmIv: number | null;
  /** Strike closest to spot that has both a call and a put mid. */
  straddleStrike: number | null;
  straddleMid: number | null;
};

export type ImpliedMove = {
  toDate: string;
  expiration: string;
  days: number;
  /** ATM straddle mid / spot at the strike closest to spot (~ expected absolute move). */
  straddlePct: number | null;
  /** ATM IV x sqrt(T): one standard deviation. */
  ivSdPct: number | null;
  /** ATM IV x sqrt(T) x sqrt(2/pi): expected absolute move under a normal, comparable to the straddle. */
  ivAbsPct: number | null;
};

export type SkewRow = { expiration: string; days: number; putStrike: number; putIv: number; callStrike: number; callIv: number; skew: number };

export type SurfaceFeatures = {
  underlying: string;
  date: string;
  asOfMs: number;
  spot: number;
  rate: number;
  divYield: number;
  /** ATM IV interpolated to 30, 60 and 90 calendar days (total variance linear in time; flat beyond the ends). */
  atmIv30: number | null;
  atmIv60: number | null;
  atmIv90: number | null;
  /** atmIv30 - atmIv90 (near minus far; positive = inverted term structure, an event priced). */
  termSlope: number | null;
  expiries: ExpiryRow[];
  impliedMoves: ImpliedMove[];
  /** XZZ skew at the expiry closest to 30 days within the window. */
  skew: number | null;
  /** Mean XZZ skew over all expiries in the window. */
  skewMean: number | null;
  skewByExpiry: SkewRow[];
  /** CW spread: OI-weighted mean of (call IV - put IV) over same-strike, same-expiry pairs. */
  callPutSpread: number | null;
  callPutPairs: number;
  /** True when OI was missing and pairs were weighted equally. */
  callPutUnweighted: boolean;
  optionVolume: number | null;
  stockVolume: number | null;
  /** Johnson & So: option contracts / (stock shares / 100). */
  oToS: number | null;
  /** Naive dealer gamma exposure, $ per 1% move: sum gamma x OI x multiplier x S^2 x 0.01, calls +, puts -. */
  gex: number | null;
  gexCalls: number | null;
  gexPuts: number | null;
  /** Contracts whose gamma used a borrowed IV (their own had none). */
  gexIvFallbacks: number;
  /** Median spot implied by put-call parity at near-ATM strikes of the nearest expiry (European parity; a sanity check). */
  parityImpliedSpot: number | null;
  quality: {
    contracts: number;
    quoted: number;
    withIv: number;
    flags: Record<string, number>;
    /** Problems worth a look before trusting the day (e.g. parity spot off by > 1%). */
    warnings: string[];
  };
  contracts: ContractRow[];
};

/** Expiry instant: OPRA sends the expiry date at 00:00 UTC; standard equity options stop at the 16:00 New York close. */
export function expiryInstantMs(expiration: string): number {
  return nyInstantMs(expiration, 16 * 60);
}

function ivOf(model: IvModel, price: number, o: { S: number; K: number; T: number; r: number; q: number; right: Right }): number | null {
  if (model === "european") return impliedVolEuropean(price, o);
  if (model === "bs2002") return impliedVolAmerican(price, o);
  // CRR (100 steps for speed), same bounds as the BS2002 path.
  const intrinsic = o.right === "C" ? Math.max(o.S - o.K, 0) : Math.max(o.K - o.S, 0);
  if (!(price > intrinsic) || !(price < (o.right === "C" ? o.S : o.K))) return null;
  // A coarse tree breaks down at tiny volatilities (p > 1 when sigma sqrt(dt) < (r - q) dt): search from 1%.
  return impliedVolFor(price, (sigma) => crrPrice({ ...o, sigma }, 100), Math.max(IV_MIN, 0.01), IV_MAX, 1e-6);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Linear interpolation of total variance in T. Pure. */
export function constantMaturityIv(points: ReadonlyArray<{ T: number; iv: number }>, targetT: number): number | null {
  const pts = points.filter((p) => p.T > 0 && Number.isFinite(p.iv)).sort((a, b) => a.T - b.T);
  if (!pts.length) return null;
  if (targetT <= pts[0]!.T) return pts[0]!.iv;
  if (targetT >= pts[pts.length - 1]!.T) return pts[pts.length - 1]!.iv;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (targetT <= b.T) {
      const wa = a.iv * a.iv * a.T;
      const wb = b.iv * b.iv * b.T;
      const w = wa + ((wb - wa) * (targetT - a.T)) / (b.T - a.T);
      return w > 0 ? Math.sqrt(w / targetT) : null;
    }
  }
  return null;
}

/** Build the contract table (IV, delta, gamma, flags). Pure. */
export function contractRows(input: SurfaceInput, opts: SurfaceOptions): ContractRow[] {
  const { spot: S, rate: r, divYield: q, asOfMs } = input;
  const rows: ContractRow[] = [];
  for (const d of input.definitions) {
    const expMs = expiryInstantMs(d.expiration);
    const T = (expMs - asOfMs) / YEAR_MS;
    if (!(T > 0)) continue;
    const days = (expMs - asOfMs) / DAY_MS;
    const quote = input.quotes.get(d.instrumentId);
    const flags: string[] = [];
    let bid: number | null = null;
    let ask: number | null = null;
    let mid: number | null = null;
    let relSpread: number | null = null;
    let iv: number | null = null;
    if (!quote) flags.push("no_quote");
    else {
      bid = quote.bid;
      ask = quote.ask;
      if (Math.abs(quote.tsMs - asOfMs) > opts.maxQuoteAgeMin * 60_000) flags.push("stale_quote");
      const chk = checkQuote(bid, ask, opts.maxRelSpread);
      mid = chk.mid;
      relSpread = chk.relSpread;
      if (chk.reason) flags.push(chk.reason);
      if (chk.ok && !flags.includes("stale_quote")) {
        if (days < opts.minDays) flags.push("too_short");
        else {
          iv = ivOf(opts.ivModel, chk.mid!, { S, K: d.strike, T, r, q, right: d.right });
          if (iv === null) flags.push("no_iv");
        }
      }
    }
    let delta: number | null = null;
    let gamma: number | null = null;
    if (iv !== null) {
      const g = bsmGreeks({ S, K: d.strike, T, r, q, sigma: iv, right: d.right });
      delta = g.delta;
      gamma = g.gamma;
    }
    rows.push({
      instrumentId: d.instrumentId,
      symbol: d.rawSymbol,
      right: d.right,
      strike: d.strike,
      expiration: d.expiration,
      days,
      T,
      moneyness: d.strike / S,
      bid,
      ask,
      mid,
      relSpread,
      oi: input.openInterest?.get(d.instrumentId) ?? null,
      volume: input.volume ? (input.volume.get(d.instrumentId) ?? 0) : null,
      iv,
      delta,
      gamma,
      flags,
    });
  }
  return rows.sort((a, b) => (a.expiration < b.expiration ? -1 : a.expiration > b.expiration ? 1 : a.strike - b.strike || (a.right < b.right ? -1 : 1)));
}

function byExpiry(rows: readonly ContractRow[]): Map<string, ContractRow[]> {
  const m = new Map<string, ContractRow[]>();
  for (const r of rows) {
    const list = m.get(r.expiration);
    if (list) list.push(r);
    else m.set(r.expiration, [r]);
  }
  return m;
}

/** ATM IV of one expiry: mean(call IV, put IV) per strike, interpolated linearly in strike to spot. Pure. */
export function atmIvOf(rows: readonly ContractRow[], spot: number): number | null {
  const perStrike = new Map<number, number[]>();
  for (const r of rows) {
    if (r.iv === null) continue;
    const l = perStrike.get(r.strike);
    if (l) l.push(r.iv);
    else perStrike.set(r.strike, [r.iv]);
  }
  const pts = [...perStrike].map(([k, ivs]) => ({ k, iv: ivs.reduce((s, x) => s + x, 0) / ivs.length })).sort((a, b) => a.k - b.k);
  if (!pts.length) return null;
  let lo: { k: number; iv: number } | null = null;
  let hi: { k: number; iv: number } | null = null;
  for (const p of pts) {
    if (p.k <= spot) lo = p;
    else if (!hi) hi = p;
  }
  if (lo && hi) return lo.iv + ((hi.iv - lo.iv) * (spot - lo.k)) / (hi.k - lo.k);
  const one = lo ?? hi!;
  return Math.abs(one.k / spot - 1) <= 0.05 ? one.iv : null;
}

function straddleOf(rows: readonly ContractRow[], spot: number): { strike: number; mid: number } | null {
  const calls = new Map<number, number>();
  const puts = new Map<number, number>();
  for (const r of rows) {
    if (r.mid === null || r.bid === null || !(r.bid > 0) || r.flags.includes("stale_quote")) continue;
    (r.right === "C" ? calls : puts).set(r.strike, r.mid);
  }
  let best: { strike: number; mid: number } | null = null;
  for (const [k, c] of calls) {
    const p = puts.get(k);
    if (p === undefined) continue;
    if (!best || Math.abs(k - spot) < Math.abs(best.strike - spot)) best = { strike: k, mid: c + p };
  }
  return best;
}

/** XZZ skew for one expiry: OTM put with K/S in [0.80, 0.95] closest to 0.95, ATM call with K/S in [0.95, 1.05] closest to 1. Pure. */
export function xzzSkew(rows: readonly ContractRow[]): Omit<SkewRow, "expiration" | "days"> | null {
  let put: ContractRow | null = null;
  let call: ContractRow | null = null;
  for (const r of rows) {
    if (r.iv === null) continue;
    if (r.right === "P" && r.moneyness >= 0.8 && r.moneyness <= 0.95) {
      if (!put || Math.abs(r.moneyness - 0.95) < Math.abs(put.moneyness - 0.95)) put = r;
    }
    if (r.right === "C" && r.moneyness >= 0.95 && r.moneyness <= 1.05) {
      if (!call || Math.abs(r.moneyness - 1) < Math.abs(call.moneyness - 1)) call = r;
    }
  }
  if (!put || !call) return null;
  return { putStrike: put.strike, putIv: put.iv!, callStrike: call.strike, callIv: call.iv!, skew: put.iv! - call.iv! };
}

/** CW spread over pairs (same expiry, same strike, both IVs). Weighted by mean OI when known. Pure. */
export function callPutSpread(rows: readonly ContractRow[], opts: SurfaceOptions): { value: number | null; pairs: number; unweighted: boolean } {
  const calls = new Map<string, ContractRow>();
  const puts = new Map<string, ContractRow>();
  for (const r of rows) {
    if (r.iv === null || r.days < opts.cwMinDays || r.days > opts.cwMaxDays) continue;
    if (r.moneyness < opts.cwMinMoneyness || r.moneyness > opts.cwMaxMoneyness) continue;
    (r.right === "C" ? calls : puts).set(`${r.expiration}|${r.strike}`, r);
  }
  const haveOi = rows.some((r) => r.oi !== null);
  let sw = 0;
  let s = 0;
  let pairs = 0;
  for (const [key, c] of calls) {
    const p = puts.get(key);
    if (!p) continue;
    let w = 1;
    if (haveOi) {
      const co = c.oi ?? 0;
      const po = p.oi ?? 0;
      if (co < opts.minOi || po < opts.minOi) continue;
      w = (co + po) / 2;
    }
    pairs++;
    sw += w;
    s += w * (c.iv! - p.iv!);
  }
  return { value: sw > 0 ? s / sw : null, pairs, unweighted: !haveOi };
}

/** Naive GEX in $ per 1% move. Contracts without their own IV borrow the nearest-strike IV of the same expiry. Pure. */
export function gammaExposure(rows: readonly ContractRow[], input: Pick<SurfaceInput, "spot" | "rate" | "divYield" | "definitions">): { total: number; calls: number; puts: number; fallbacks: number } | null {
  if (!rows.some((r) => r.oi !== null)) return null;
  const mult = new Map(input.definitions.map((d) => [d.instrumentId, d.multiplier]));
  const S = input.spot;
  let calls = 0;
  let puts = 0;
  let fallbacks = 0;
  for (const [, list] of byExpiry(rows)) {
    const withIv = list.filter((r) => r.iv !== null);
    for (const r of list) {
      if (!r.oi) continue;
      let gamma = r.gamma;
      if (gamma === null) {
        let best: ContractRow | null = null;
        for (const o of withIv) if (!best || Math.abs(o.strike - r.strike) < Math.abs(best.strike - r.strike)) best = o;
        if (!best) continue;
        gamma = bsmGreeks({ S, K: r.strike, T: r.T, r: input.rate, q: input.divYield, sigma: best.iv!, right: r.right }).gamma;
        fallbacks++;
      }
      const v = gamma * r.oi * (mult.get(r.instrumentId) ?? 100) * S * S * 0.01;
      if (r.right === "C") calls += v;
      else puts -= v;
    }
  }
  return { total: calls + puts, calls, puts, fallbacks };
}

/** All features for one underlying-day. Pure. */
export function surfaceFeatures(input: SurfaceInput): SurfaceFeatures {
  const opts: SurfaceOptions = { ...DEFAULT_SURFACE_OPTIONS, ...input.options };
  const S = input.spot;
  const rows = contractRows(input, opts);
  const groups = byExpiry(rows);

  const expiries: ExpiryRow[] = [];
  for (const [exp, list] of groups) {
    const T = list[0]!.T;
    const st = straddleOf(list, S);
    expiries.push({
      expiration: exp,
      days: list[0]!.days,
      T,
      contracts: list.length,
      withIv: list.filter((r) => r.iv !== null).length,
      atmIv: atmIvOf(list, S),
      straddleStrike: st?.strike ?? null,
      straddleMid: st?.mid ?? null,
    });
  }
  expiries.sort((a, b) => a.T - b.T);
  const curve = expiries.filter((e) => e.atmIv !== null && e.days >= Math.max(opts.minDays, 2)).map((e) => ({ T: e.T, iv: e.atmIv! }));
  const atmIv30 = constantMaturityIv(curve, 30 / 365);
  const atmIv60 = constantMaturityIv(curve, 60 / 365);
  const atmIv90 = constantMaturityIv(curve, 90 / 365);

  // Implied moves: first expiry on or after each date.
  const moveDates = input.moveDates?.length ? input.moveDates : [new Date(Date.parse(`${input.date}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10)];
  const impliedMoves: ImpliedMove[] = [];
  for (const toDate of moveDates) {
    const e = expiries.find((x) => x.expiration >= toDate);
    if (!e) continue;
    const iv = e.atmIv;
    impliedMoves.push({
      toDate,
      expiration: e.expiration,
      days: e.days,
      straddlePct: e.straddleMid !== null ? e.straddleMid / S : null,
      ivSdPct: iv !== null ? iv * Math.sqrt(e.T) : null,
      ivAbsPct: iv !== null ? iv * Math.sqrt(e.T) * Math.sqrt(2 / Math.PI) : null,
    });
  }

  // Skew.
  const skewByExpiry: SkewRow[] = [];
  for (const [exp, list] of groups) {
    const days = list[0]!.days;
    if (days < opts.skewMinDays || days > opts.skewMaxDays) continue;
    const s = xzzSkew(list);
    if (s) skewByExpiry.push({ expiration: exp, days, ...s });
  }
  skewByExpiry.sort((a, b) => a.days - b.days);
  let skew: number | null = null;
  let bestGap = Infinity;
  for (const s of skewByExpiry) {
    if (Math.abs(s.days - 30) < bestGap) {
      bestGap = Math.abs(s.days - 30);
      skew = s.skew;
    }
  }
  const skewMean = skewByExpiry.length ? skewByExpiry.reduce((a, s) => a + s.skew, 0) / skewByExpiry.length : null;

  const cw = callPutSpread(rows, opts);

  let optionVolume: number | null = null;
  if (input.volume) {
    optionVolume = 0;
    for (const v of input.volume.values()) optionVolume += v;
  }
  const stockVolume = input.stockVolume ?? null;
  const oToS = optionVolume !== null && stockVolume ? optionVolume / (stockVolume / 100) : null;

  const gex = gammaExposure(rows, input);

  // Parity check on the nearest expiry with >= 2 days.
  const near = expiries.find((e) => e.days >= 2);
  let parityImpliedSpot: number | null = null;
  if (near) {
    const list = groups.get(near.expiration)!;
    const c = new Map<number, number>();
    const p = new Map<number, number>();
    for (const r of list) if (r.mid !== null && !r.flags.some((f) => f !== "too_short")) (r.right === "C" ? c : p).set(r.strike, r.mid);
    const ests: number[] = [];
    for (const [k, cm] of c) {
      const pm = p.get(k);
      if (pm === undefined || Math.abs(k / S - 1) > 0.05) continue;
      ests.push((cm - pm + k * Math.exp(-input.rate * near.T)) / Math.exp(-input.divYield * near.T));
    }
    parityImpliedSpot = median(ests);
  }

  const flags: Record<string, number> = {};
  for (const r of rows) for (const f of r.flags) flags[f] = (flags[f] ?? 0) + 1;
  const warnings: string[] = [];
  if (parityImpliedSpot !== null && Math.abs(parityImpliedSpot / S - 1) > 0.01) {
    warnings.push(`parity-implied spot ${parityImpliedSpot.toFixed(2)} is ${((parityImpliedSpot / S - 1) * 100).toFixed(1)}% from the spot given`);
  }
  const quoted = rows.filter((r) => !r.flags.includes("no_quote")).length;
  if (rows.length && quoted / rows.length < 0.5) warnings.push(`only ${quoted} of ${rows.length} contracts have a quote at the snapshot`);
  if (atmIv30 === null) warnings.push("no ATM IV curve");

  return {
    underlying: input.underlying,
    date: input.date,
    asOfMs: input.asOfMs,
    spot: S,
    rate: input.rate,
    divYield: input.divYield,
    atmIv30,
    atmIv60,
    atmIv90,
    termSlope: atmIv30 !== null && atmIv90 !== null ? atmIv30 - atmIv90 : null,
    expiries,
    impliedMoves,
    skew,
    skewMean,
    skewByExpiry,
    callPutSpread: cw.value,
    callPutPairs: cw.pairs,
    callPutUnweighted: cw.unweighted,
    optionVolume,
    stockVolume,
    oToS,
    gex: gex?.total ?? null,
    gexCalls: gex?.calls ?? null,
    gexPuts: gex?.puts ?? null,
    gexIvFallbacks: gex?.fallbacks ?? 0,
    parityImpliedSpot,
    quality: { contracts: rows.length, quoted, withIv: rows.filter((r) => r.iv !== null).length, flags, warnings },
    contracts: rows,
  };
}

