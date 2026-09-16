/**
 * One gate in front of every model call this process makes.
 *
 * Two limits, because providers enforce two different things and only one of
 * them is concurrency.
 *
 * CONCURRENCY — how many calls may be in flight at once. This is what the
 * gateway caps: three hosts sharing one key, each tuned to 4, 2 and 2, put up
 * to eight calls out together and 1,225 classifications failed in a day with
 * "rate or concurrency limit exceeded". A per-host setting cannot fix that,
 * because the limit belongs to the KEY.
 *
 * RATE — how many calls may start per minute. OpenRouter's free tier allows 20
 * a minute, and concurrency alone cannot hold that line: one call in flight at
 * a time still starts sixty a minute if each takes a second. Limiting
 * concurrency to control a rate only works if you know the latency, and you
 * don't.
 *
 * So the rate is enforced directly, per destination host, because the two
 * routes have very different ceilings — a free OpenRouter key and a first-party
 * Anthropic key should not throttle each other.
 */

import { providerRouteFor, type EngineName } from "./providerRoute.js";

/**
 * Calls in flight at once, across every host in this process.
 *
 * Three is where the observed failures started, not a number chosen because we
 * would like it to be true — the gateway's real ceiling is undocumented and
 * cannot be probed without spending.
 */
export const DEFAULT_PROVIDER_CONCURRENCY = 3;

/**
 * Requests per minute, by destination host.
 *
 * 18 rather than 20 for OpenRouter: the window is measured from our side, and a
 * limit set exactly at the provider's is one clock-skew away from tripping it.
 * Anthropic's first-party limits are far higher than anything this chain
 * produces, so it is left effectively open rather than guessed at.
 */
export const HOST_RATE_LIMITS: Record<string, number> = {
  "openrouter.ai": 18,
};
export const DEFAULT_RATE_LIMIT_PER_MIN = 600;

/**
 * How long a call will wait for a slot before giving up.
 *
 * A queue with no ceiling turns a rate limit into a hang: after a restart the
 * classifier has a backlog, and at 18/min a few hundred queued calls would sit
 * for twenty minutes behind a request timeout that fired long before. Failing
 * at the gate is recoverable — the budget counts it, the breaker sees it, and
 * the next cycle retries. Hanging is not.
 */
export const DEFAULT_MAX_WAIT_MS = 90_000;

function configuredConcurrency(): number {
  const raw = Number(process.env.FALCON_PROVIDER_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_PROVIDER_CONCURRENCY;
}

function configuredRate(host: string): number {
  const raw = Number(process.env.FALCON_PROVIDER_RPM);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return HOST_RATE_LIMITS[host] ?? DEFAULT_RATE_LIMIT_PER_MIN;
}

export class RateLimitWaitError extends Error {
  constructor(host: string, waitedMs: number) {
    super(
      `Gave up waiting ${Math.round(waitedMs / 1000)}s for a ${host} rate slot — ` +
        `the queue is longer than the limit can drain.`,
    );
    this.name = "RateLimitWaitError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sliding window of start times, one per destination host. */
class RateWindow {
  private readonly starts: number[] = [];

  constructor(private readonly perMinute: number) {}

  /** ms to wait before another call may start; 0 when one may start now. */
  delay(now: number): number {
    const cutoff = now - 60_000;
    while (this.starts.length > 0 && this.starts[0]! <= cutoff) this.starts.shift();
    if (this.starts.length < this.perMinute) return 0;
    // The oldest start in the window leaves it at +60s; that is the earliest a
    // slot opens.
    return Math.max(1, this.starts[0]! + 60_000 - now);
  }

  record(now: number): void {
    this.starts.push(now);
  }

  count(now: number): number {
    const cutoff = now - 60_000;
    return this.starts.filter((t) => t > cutoff).length;
  }
}

class Gate {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly windows = new Map<string, RateWindow>();
  private peak = 0;
  private admitted = 0;
  private rateWaits = 0;

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.drain();
  }

  private window(host: string): RateWindow {
    let w = this.windows.get(host);
    if (!w) {
      w = new RateWindow(configuredRate(host));
      this.windows.set(host, w);
    }
    return w;
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active += 1;
      if (this.active > this.peak) this.peak = this.active;
      next();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      return;
    }
    this.active += 1;
    if (this.active > this.peak) this.peak = this.active;
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  async run<T>(host: string, fn: () => Promise<T>, maxWaitMs: number): Promise<T> {
    await this.acquire();
    try {
      // Rate is checked while HOLDING a concurrency slot, so a waiting call
      // cannot be overtaken by one that arrived later — otherwise a busy host
      // starves whoever queued first.
      const started = Date.now();
      const w = this.window(host);
      for (;;) {
        const wait = w.delay(Date.now());
        if (wait === 0) break;
        if (Date.now() - started + wait > maxWaitMs) {
          this.rateWaits += 1;
          throw new RateLimitWaitError(host, Date.now() - started);
        }
        await sleep(Math.min(wait, 1_000));
      }
      w.record(Date.now());
      this.admitted += 1;
      return await fn();
    } finally {
      this.release();
    }
  }

  stats() {
    const now = Date.now();
    const hosts: Record<string, { rpm: number; limit: number }> = {};
    for (const [host, w] of this.windows) {
      hosts[host] = { rpm: w.count(now), limit: configuredRate(host) };
    }
    return {
      limit: this.limit,
      active: this.active,
      queued: this.queue.length,
      peak: this.peak,
      admitted: this.admitted,
      rate_waits: this.rateWaits,
      hosts,
    };
  }
}

let gate: Gate | null = null;

function get(): Gate {
  if (!gate) gate = new Gate(configuredConcurrency());
  return gate;
}

/** Destination host for an engine, or "" when it resolves to the SDK default. */
function hostFor(engine: EngineName): string {
  const { baseUrl } = providerRouteFor(engine);
  if (!baseUrl) return "api.anthropic.com";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Run one provider call under the shared concurrency limit and the destination's
 * rate limit.
 *
 * Wrap the call itself, not the batch: a host that wraps its whole batch holds
 * a slot for its slowest member and starves the others.
 */
export function withProviderSlot<T>(engine: EngineName, fn: () => Promise<T>): Promise<T> {
  const maxWait = Number(process.env.FALCON_PROVIDER_MAX_WAIT_MS);
  return get().run(
    hostFor(engine),
    fn,
    Number.isFinite(maxWait) && maxWait > 0 ? maxWait : DEFAULT_MAX_WAIT_MS,
  );
}

export function providerGateStats(): ReturnType<Gate["stats"]> {
  return get().stats();
}

/** Test seam. */
export function setProviderConcurrency(limit: number): void {
  get().setLimit(limit);
}

export function resetProviderGate(): void {
  gate = null;
}
