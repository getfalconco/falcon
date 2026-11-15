/**
 * The v2 run with data (Node): validate the spec, load what its formulas
 * read through the market data provider, run, and audit. Never throws for bad
 * input, slow sources or missing data; the outcome says which.
 */

import { benchmarks, runChecked, simulateSpec, type CheckedSpec, type RunResultV2 } from "../run";
import { packBars, prepare, type PackedBars, type SpecData } from "../prepare";
import { SPEC_LIMITS, resolvePeriod, universeTickers, validateSpec, type SpecIssue } from "../spec";
import { mergeTierB, tierB, type TierBResult } from "../audit/tiers";
import type { QualityReport } from "../audit/report";
import { DeadlineError } from "./http";
import { providerFromEnv, type MarketDataProvider } from "./provider";
import type { EarningsEvent, RippleEventRaw } from "./types";

export type SpecOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; status: 400 | 502 | 503 | 504; errors: string[]; issues?: SpecIssue[]; progress?: LoadProgress };

/** Default whole-request budget: Netlify's 60 s function limit less room for a cold start and the response. */
export const SPEC_DEADLINE_MS = 50_000;
/** Kept back before the deadline for the run itself (or the Tier B checks) and the response. */
export const COMPUTE_RESERVE_MS = 8_000;
export const LOAD_TIMEOUT_MESSAGE = "Loading prices took too long. Data loaded so far is cached, so trying again is usually faster.";

/** Time a step may still take before the deadline, keeping COMPUTE_RESERVE_MS back (at least 1 s). */
export function workBudgetMs(deadlineAt: number, now = Date.now()): number {
  return Math.max(1_000, deadlineAt - now - COMPUTE_RESERVE_MS);
}

export type SpecRunOptions = {
  provider?: MarketDataProvider;
  /**
   * Epoch ms the outcome must be ready by (default SPEC_DEADLINE_MS from the
   * call). Routes pass their deadline measured from the request's arrival.
   * Loading prices, then the Tier B checks, each stop COMPUTE_RESERVE_MS before it.
   */
  deadlineAt?: number;
  signal?: AbortSignal;
  now?: Date;
  /** This strategy's trial number in the client's ledger (for the deflated Sharpe ratio). */
  trials?: number;
};

const isAbort = (e: unknown) => e instanceof DeadlineError || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"));

function minusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Ticker reads in flight at once. The HTTP client keeps Yahoo itself to a few
 * requests at a time; this bounds cache reads and parsing, so a 1,500-ticker
 * universe does not hold 1,500 parsed files in memory together.
 */
export const LOAD_POOL = 24;

/** Runs fn over items, at most `limit` at a time; stops starting new ones once the signal aborts. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new DeadlineError();
      await fn(items[next++]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Tickers with prices in hand while loading (shown with a 504, so the app can tell a second try will get further). */
export type LoadProgress = { loaded: number; total: number };

/** Loads bars (packed by ticker), earnings, Sightings history and the T-bill rate for a checked spec. */
export async function loadSpecData(
  check: CheckedSpec,
  provider: MarketDataProvider,
  period: { start: string; end: string },
  signal?: AbortSignal,
  progress: LoadProgress = { loaded: 0, total: 0 },
): Promise<SpecData> {
  const warnings: string[] = [];
  const warmDays = Math.max(400, Math.ceil(check.uses.maxWindow * 1.5) + 40);
  const from = minusDays(period.start, warmDays);
  const tickers = check.tickers;
  const universe = universeTickers(check.spec);
  const earningsTickers = Array.from(new Set((check.uses.earningsSelf ? universe : []).concat(Array.from(check.uses.earningsTickers))));
  const packed: Record<string, PackedBars> = {};
  const earnings: Record<string, EarningsEvent[]> = {};
  let ripple: RippleEventRaw[] = [];
  let rates: SpecData["rates"] = [];
  let ratesFallback = false;
  let earningsFailures = 0;
  progress.total = tickers.length;
  progress.loaded = 0;

  const jobs: Promise<unknown>[] = [
    pool(
      tickers,
      LOAD_POOL,
      async (t) => {
        try {
          packed[t] = packBars(await provider.prices.dailyBars(t, from, period.end, signal));
          progress.loaded++;
        } catch (e) {
          if (isAbort(e) || signal?.aborted) throw new DeadlineError();
          packed[t] = packBars([]);
          warnings.push(`${t}: prices could not be loaded (${e instanceof Error ? e.message : "error"}).`);
        }
      },
      signal,
    ),
  ];
  if (earningsTickers.length && provider.earnings) {
    jobs.push(
      pool(
        earningsTickers,
        LOAD_POOL,
        async (t) => {
          try {
            earnings[t] = await provider.earnings!.earnings(t, from, period.end, signal);
          } catch (e) {
            if (isAbort(e) || signal?.aborted) throw new DeadlineError();
            earnings[t] = [];
            earningsFailures++;
          }
        },
        signal,
      ),
    );
  }
  if (check.uses.ripple && provider.ripple) {
    jobs.push(
      (async () => {
        ripple = await provider.ripple!.events({ tickers: universe, from, to: period.end }, signal);
      })().catch(() => warnings.push("Sightings history could not be loaded.")),
    );
  }
  if (provider.rates) {
    jobs.push(
      (async () => {
        try {
          rates = await provider.rates!.dtb3(signal);
        } catch (e) {
          if (signal?.aborted) throw new DeadlineError();
          ratesFallback = true;
        }
      })(),
    );
  } else ratesFallback = true;
  const settled = await Promise.allSettled(jobs);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  if (earningsTickers.length && !provider.earnings) warnings.push("No earnings source is connected, so earnings rules never fire.");
  if (earningsFailures) warnings.push(`Earnings history could not be loaded for ${earningsFailures} of ${earningsTickers.length} tickers.`);
  return {
    bars: {},
    packed,
    earnings,
    ripple,
    rates,
    sources: {
      prices: provider.prices.name,
      earnings: earningsTickers.length ? (provider.earnings?.name ?? null) : null,
      ripple: check.uses.ripple ? (provider.ripple?.name ?? null) : null,
      rates: provider.rates?.name ?? null,
    },
    flags: { ratesFallback, rippleConnected: Boolean(provider.ripple), betaSource: provider.beta },
    warnings: warnings.sort(),
  };
}

/** Sessions per calendar year (for estimates before any price is loaded). */
const SESSIONS_PER_YEAR = 252;

export type RunSize = { tickers: number; years: number; cells: number; warmDays: number };

/** Ticker-sessions a run will load (universe, referenced tickers and SPY, warm-up included), estimated from the calendar. */
export function runSize(check: CheckedSpec, period: { start: string; end: string }): RunSize {
  const warmDays = Math.max(400, Math.ceil(check.uses.maxWindow * 1.5) + 40);
  const days = (Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86_400_000;
  const years = Math.max(0, days / 365.25);
  const cells = Math.round(check.tickers.length * ((days + warmDays) / 365.25) * SESSIONS_PER_YEAR);
  return { tickers: check.tickers.length, years, cells, warmDays };
}

/** The longest test, in whole years, that keeps this many tickers under the cell limit. */
export function maxYearsFor(tickers: number, warmDays = 400): number {
  return Math.max(0, Math.floor(SPEC_LIMITS.maxCells / (tickers * SESSIONS_PER_YEAR) - warmDays / 365.25));
}

function tooLargeMessage(size: RunSize): string {
  const maxYears = maxYearsFor(size.tickers, size.warmDays);
  const m = (n: number) => (n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return (
    `This run is too large: ${size.tickers.toLocaleString("en-US")} tickers over ${size.years.toFixed(1)} years is about ${m(size.cells)} million ticker-sessions, and one run handles up to ${m(SPEC_LIMITS.maxCells)} million.` +
    (maxYears >= 1 ? ` With this list, set a period of at most ${maxYears} years, or use a smaller list (for example the S&P 500 today).` : " Use a shorter list.")
  );
}

async function withData<T>(
  input: unknown,
  opts: SpecRunOptions,
  go: (check: CheckedSpec, data: SpecData, deadlineAt: number) => T,
): Promise<SpecOutcome<T>> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + SPEC_DEADLINE_MS;
  const check = validateSpec(input, opts.now);
  if (!check.ok) return { ok: false, status: 400, errors: check.issues.map((i) => `${i.path}: ${i.message}`), issues: check.issues };
  let provider = opts.provider;
  if (!provider) {
    const p = providerFromEnv();
    if (!p.ok) return { ok: false, status: 503, errors: [p.error] };
    provider = p.provider;
  }
  const period = resolvePeriod(check.spec, opts.now);
  const size = runSize(check, period);
  if (size.cells > SPEC_LIMITS.maxCells) return { ok: false, status: 400, errors: [tooLargeMessage(size)] };
  const signal = AbortSignal.any([AbortSignal.timeout(workBudgetMs(deadlineAt)), ...(opts.signal ? [opts.signal] : [])]);
  const progress: LoadProgress = { loaded: 0, total: 0 };
  let data: SpecData;
  try {
    data = await loadSpecData(check, provider, period, signal, progress);
  } catch (e) {
    if (isAbort(e) || signal.aborted) {
      const wide = progress.total > 100;
      return {
        ok: false,
        status: 504,
        errors: [wide ? `Prices for ${progress.loaded.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")} tickers are loaded and cached; running again picks up from there.` : LOAD_TIMEOUT_MESSAGE],
        progress: { ...progress },
      };
    }
    return { ok: false, status: 502, errors: [e instanceof Error ? e.message : "Data source error"] };
  }
  const spy = data.packed?.SPY?.day.length ?? data.bars.SPY?.length ?? 0;
  if (!spy) return { ok: false, status: 502, errors: ["SPY prices are unavailable right now."] };
  const cells = Object.values(data.packed ?? {}).reduce((a, b) => a + b.day.length, 0) + Object.values(data.bars).reduce((a, b) => a + b.length, 0);
  if (cells > SPEC_LIMITS.maxCells) return { ok: false, status: 400, errors: [tooLargeMessage({ ...size, cells })] };
  try {
    return { ok: true, result: go(check, data, deadlineAt) };
  } catch (e) {
    return { ok: false, status: 502, errors: [e instanceof Error ? e.message : "The run failed."] };
  }
}

/** Validate, load, run and Tier A. */
export function runSpec(input: unknown, opts: SpecRunOptions = {}): Promise<SpecOutcome<RunResultV2>> {
  return withData(input, opts, (check, data) => runChecked(check, { data, trials: opts.trials, now: opts.now, releaseBars: true }));
}

export type AuditResult = { tierB: TierBResult; quality: QualityReport | null };

/** Tier B (second request): 200-seed null, parameter neighbourhood, leave-one-ticker-out, regimes. */
export function auditSpec(input: unknown, opts: SpecRunOptions & { quality?: QualityReport | null } = {}): Promise<SpecOutcome<AuditResult>> {
  return withData(input, opts, (check, data, deadlineAt) => {
    if (check.spec.portfolio.mode === "event_study") return { tierB: { checks: [], values: {} }, quality: opts.quality ?? null };
    const p = check.spec.portfolio;
    const prep = prepare(data, check.tickers, resolvePeriod(check.spec, opts.now), p.mode === "rules" ? p.clock : "close", Boolean(check.spec.legacy));
    data.bars = {}; // the panel holds what the checks read; see RunOptionsV2.releaseBars
    data.packed = {};
    const base = simulateSpec(check, prep);
    const bench = benchmarks(check.spec, prep);
    // Optional checks start only while this leaves the reserve before the deadline (the 200-seed null always runs).
    const b = tierB(check, prep, base, bench, { deadlineMs: workBudgetMs(deadlineAt) });
    return { tierB: b, quality: opts.quality ? mergeTierB(opts.quality, b) : null };
  });
}
