import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { RANGE_QUERY, historyBars, historyFor, isEquityRange } from "@/lib/portfolio-history";
import { readSnapshots, recordSnapshot } from "@/lib/portfolio-store";
import { chooseInterval, downsample, nominalStart, seriesSymbol, snapshotPoints, snapshotsInRange, type HoldingsSnapshot, type PriceSeries } from "@/lib/workspace/equity";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const BENCH = "SPY";

/**
 * The Equity chart's points from the member's real history
 * (lib/workspace/equity.ts): their holdings snapshots
 * (public.portfolio_holdings_history) x market prices, computed HERE so
 * quantities never leave the server; the browser gets values only and closes
 * the curve with the live total.
 *
 *   GET /api/portfolio/equity?range=1M&currency=USD
 *     -> 200 { points: [{ t, v, spy }], firstAt, from, at }
 *        firstAt: the first snapshot (null: no history yet); from: the timeframe's start.
 *        Points start at the later of the two: nothing before the account's
 *        first day, SPY included (the card says "Since Nov 18")
 *
 * Bars: SPY over the whole span at the timeframe's own size (1D 5-minute, 1W
 * 30-minute, 1M hourly, longer daily); the real-history part at the finest
 * size that keeps it under ~250 bars (chooseInterval: 30 days inside 5Y come
 * hourly). Thinned with min/max buckets (downsample), so spikes survive.
 *
 * A member with holdings but no snapshot yet (stored before the history
 * existed) gets one now ("initial"): their history starts at this request.
 * Under `next dev` without a token: `fixture=1` (the dev fixture, connected 2
 * days ago) or `fixture=random&seed=N` (the ⌘P portfolio, 30 days of
 * snapshots), both in memory. 401 not signed in, 400 bad range, 429.
 * Never logs quantities.
 */

const testCreated = new Map<number, number>();
let fixtureCreated: number | null = null;

async function devSnapshots(url: URL): Promise<HoldingsSnapshot[]> {
  const { fixtureHistory, testHistory } = await import("@/lib/workspace/test-history");
  if (url.searchParams.get("fixture") === "random") {
    const seed = Number(url.searchParams.get("seed"));
    if (!Number.isInteger(seed) || seed < 0) return [];
    const { testPortfolio } = await import("@/lib/test-portfolio-server");
    const test = await testPortfolio(seed);
    // The history's times hold still for a seed, as a stored one would.
    if (!testCreated.has(seed)) testCreated.set(seed, Date.now());
    return testHistory(seed, test.accounts, test.positions, testCreated.get(seed)!);
  }
  if (url.searchParams.get("fixture") === "1") {
    const { FIXTURE_ACCOUNTS, FIXTURE_POSITIONS } = await import("@/lib/workspace/fixture-positions");
    fixtureCreated ??= Date.now();
    return fixtureHistory(FIXTURE_ACCOUNTS, FIXTURE_POSITIONS, fixtureCreated);
  }
  return [];
}

/** SPY: the timeframe's bars before `start` (the close in force there), the real part's finer ones from it. */
function joinSeries(before: PriceSeries | undefined, after: PriceSeries | undefined, start: number): PriceSeries | null {
  if (!before && !after) return null;
  const rows: [number, number][] = [];
  before?.t.forEach((t, i) => {
    if (!after || t < start) rows.push([t, before.c[i]!]);
  });
  after?.t.forEach((t, i) => {
    if (!before || t >= start) rows.push([t, after.c[i]!]);
  });
  rows.sort((a, b) => a[0] - b[0]);
  const prev = (after ?? before)!.prev;
  return { t: rows.map((r) => r[0]), c: rows.map((r) => r[1]), ...(prev !== undefined ? { prev } : {}) };
}

export async function GET(request: Request) {
  const limit = rateLimit(`portfolio-equity:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);
  const url = new URL(request.url);
  const range = url.searchParams.get("range");
  if (!isEquityRange(range)) return NextResponse.json({ error: "Unknown range." }, { status: 400, headers: NO_STORE });
  const currency = /^[A-Z]{3}$/.test(url.searchParams.get("currency") ?? "") ? url.searchParams.get("currency")! : "USD";

  let snapshots: HoldingsSnapshot[];
  if (!bearerToken(request)) {
    if (process.env.NODE_ENV !== "development") return NextResponse.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
    snapshots = await devSnapshots(url);
  } else {
    const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
    if (!user) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: NO_STORE });
    const userLimit = rateLimit(`portfolio-equity-user:${user.id}`, { limit: 30, windowMs: 60_000 });
    if (!userLimit.ok) return tooManyRequests(userLimit.retryAfter);
    snapshots = await readSnapshots(user.id);
    if (!snapshots.length) {
      const first = await recordSnapshot(user.id, "initial");
      if (first) snapshots = [first];
    }
  }

  const now = Date.now();
  // 1D starts at the session's first bar (SPY's), the others at their calendar start.
  const bench = await historyFor([BENCH], range);
  const from = nominalStart(range, now) ?? bench[BENCH]?.t[0] ?? now - 86_400_000;
  if (!snapshots.length) return NextResponse.json({ points: [], firstAt: null, from, at: now }, { headers: NO_STORE });

  const start = Math.max(from, snapshots[0]!.at);
  const symbols = new Set<string>([BENCH]);
  for (const s of snapshotsInRange(snapshots, start, now))
    for (const p of s.positions)
      if (p.currency === currency) {
        const sym = seriesSymbol(p);
        if (sym) symbols.add(sym);
      }
  // The real part's bars: the timeframe's own when they suit it, else finer, with a few days before the start for the close in force there.
  const base = RANGE_QUERY[range];
  const interval = range === "1D" ? base.interval : chooseInterval(now - start);
  const days = Math.ceil((now - start) / 86_400_000) + 5;
  const query = interval === base.interval ? base : { range: interval === "1d" ? base.range : `${Math.min(days, interval === "60m" ? 729 : 59)}d`, interval, freshMs: 5 * 60_000, days };
  const series = await historyBars([...symbols], query);
  const spy = joinSeries(bench[BENCH], series[BENCH], start);

  const real = snapshotPoints({ snapshots, series, from, nowMs: now, currency, spy, fromPrevious: range === "1D" });
  const points = downsample(real.points, 400);
  return NextResponse.json({ points, firstAt: real.firstAt, from, at: now }, { headers: NO_STORE });
}
