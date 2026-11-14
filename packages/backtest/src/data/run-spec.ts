/**
 * The v2 run with data (Node): validate the spec, load what its formulas
 * read through the market data provider, run, and audit. Never throws for bad
 * input, slow sources or missing data; the outcome says which.
 */

import { benchmarks, runChecked, simulateSpec, type CheckedSpec, type RunResultV2 } from "../run";
import { prepare, type SpecData } from "../prepare";
import { resolvePeriod, universeTickers, validateSpec, type SpecIssue } from "../spec";
import { mergeTierB, tierB, type TierBResult } from "../audit/tiers";
import type { QualityReport } from "../audit/report";
import { DeadlineError } from "./http";
import { providerFromEnv, type MarketDataProvider } from "./provider";
import type { Bar, EarningsEvent, RippleEventRaw } from "./types";

export type SpecOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; status: 400 | 502 | 503 | 504; errors: string[]; issues?: SpecIssue[] };

export type SpecRunOptions = {
  provider?: MarketDataProvider;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: Date;
  /** This strategy's trial number in the client's ledger (for the deflated Sharpe ratio). */
  trials?: number;
};

const isAbort = (e: unknown) => e instanceof DeadlineError || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"));

function minusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Loads bars, earnings, Sightings history and the T-bill rate for a checked spec. */
export async function loadSpecData(check: CheckedSpec, provider: MarketDataProvider, period: { start: string; end: string }, signal?: AbortSignal): Promise<SpecData> {
  const warnings: string[] = [];
  const warmDays = Math.max(400, Math.ceil(check.uses.maxWindow * 1.5) + 40);
  const from = minusDays(period.start, warmDays);
  const tickers = check.tickers;
  const universe = universeTickers(check.spec);
  const earningsTickers = Array.from(new Set((check.uses.earningsSelf ? universe : []).concat(Array.from(check.uses.earningsTickers))));
  const bars: Record<string, Bar[]> = {};
  const earnings: Record<string, EarningsEvent[]> = {};
  let ripple: RippleEventRaw[] = [];
  let rates: SpecData["rates"] = [];
  let ratesFallback = false;
  let earningsFailures = 0;

  const jobs: Promise<unknown>[] = tickers.map(async (t) => {
    try {
      bars[t] = await provider.prices.dailyBars(t, from, period.end, signal);
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw new DeadlineError();
      bars[t] = [];
      warnings.push(`${t}: prices could not be loaded (${e instanceof Error ? e.message : "error"}).`);
    }
  });
  if (earningsTickers.length && provider.earnings) {
    for (const t of earningsTickers) {
      jobs.push(
        (async () => {
          try {
            earnings[t] = await provider.earnings!.earnings(t, from, period.end, signal);
          } catch (e) {
            if (isAbort(e) || signal?.aborted) throw new DeadlineError();
            earnings[t] = [];
            earningsFailures++;
          }
        })(),
      );
    }
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
    bars,
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

async function withData<T>(
  input: unknown,
  opts: SpecRunOptions,
  go: (check: CheckedSpec, data: SpecData) => T,
): Promise<SpecOutcome<T>> {
  const check = validateSpec(input, opts.now);
  if (!check.ok) return { ok: false, status: 400, errors: check.issues.map((i) => `${i.path}: ${i.message}`), issues: check.issues };
  let provider = opts.provider;
  if (!provider) {
    const p = providerFromEnv();
    if (!p.ok) return { ok: false, status: 503, errors: [p.error] };
    provider = p.provider;
  }
  const period = resolvePeriod(check.spec, opts.now);
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 20_000), ...(opts.signal ? [opts.signal] : [])]);
  let data: SpecData;
  try {
    data = await loadSpecData(check, provider, period, signal);
  } catch (e) {
    if (isAbort(e) || signal.aborted) {
      return { ok: false, status: 504, errors: ["Loading prices took too long. Data loaded so far is cached, so trying again is usually faster."] };
    }
    return { ok: false, status: 502, errors: [e instanceof Error ? e.message : "Data source error"] };
  }
  if (!(data.bars.SPY ?? []).length) return { ok: false, status: 502, errors: ["SPY prices are unavailable right now."] };
  const cells = Object.values(data.bars).reduce((a, b) => a + b.length, 0);
  if (cells > 1_500_000) return { ok: false, status: 400, errors: ["This run is too large (more than 1.5 million ticker-sessions). Shorten the window or the list."] };
  try {
    return { ok: true, result: go(check, data) };
  } catch (e) {
    return { ok: false, status: 502, errors: [e instanceof Error ? e.message : "The run failed."] };
  }
}

/** Validate, load, run and Tier A. */
export function runSpec(input: unknown, opts: SpecRunOptions = {}): Promise<SpecOutcome<RunResultV2>> {
  return withData(input, opts, (check, data) => runChecked(check, { data, trials: opts.trials, now: opts.now }));
}

export type AuditResult = { tierB: TierBResult; quality: QualityReport | null };

/** Tier B (second request): 200-seed null, parameter neighbourhood, leave-one-ticker-out, regimes. */
export function auditSpec(input: unknown, opts: SpecRunOptions & { quality?: QualityReport | null; deadlineMs?: number } = {}): Promise<SpecOutcome<AuditResult>> {
  return withData(input, opts, (check, data) => {
    if (check.spec.portfolio.mode === "event_study") return { tierB: { checks: [], values: {} }, quality: opts.quality ?? null };
    const p = check.spec.portfolio;
    const prep = prepare(data, check.tickers, resolvePeriod(check.spec, opts.now), p.mode === "rules" ? p.clock : "close", Boolean(check.spec.legacy));
    const base = simulateSpec(check, prep);
    const bench = benchmarks(check.spec, prep);
    const b = tierB(check, prep, base, bench, { deadlineMs: opts.deadlineMs });
    return { tierB: b, quality: opts.quality ? mergeTierB(opts.quality, b) : null };
  });
}
