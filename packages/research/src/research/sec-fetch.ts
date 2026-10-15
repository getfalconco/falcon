/**
 * One polite queue for every SEC EDGAR request a process makes.
 *
 * SEC asks for no more than ten requests a second per client. Several readers
 * reach EDGAR from one process (the desktop's agents reader and everything
 * built on it, the read-through releases, the Tracker, step1's filing fetch,
 * the analyze pipeline's EDGAR facts); each used to space its own requests,
 * so together they could pass that limit. They all go through here instead:
 * request starts at least SEC_MIN_GAP_MS apart (at most four a second for the
 * whole process), at most SEC_MAX_IN_FLIGHT waiting on headers at once, each
 * with a deadline on the response headers.
 *
 * The queue lives on `globalThis`, so two copies of this module (a bundle and
 * a test loader) still share one queue. Each caller keeps its own descriptive
 * User-Agent; this module never invents one from anything personal.
 */

export const SEC_MIN_GAP_MS = 250;
export const SEC_MAX_IN_FLIGHT = 2;
export const SEC_TIMEOUT_MS = 15_000;

export type SecLimiterOptions = {
  minGapMs?: number;
  maxInFlight?: number;
  now?: () => number;
};

export type SecLimiter = {
  /** Runs `task` when its turn comes; the queue survives a failed task. */
  schedule<T>(task: () => Promise<T>): Promise<T>;
  /** Requests started so far, and queued or running now (diagnostics, tests). */
  stats(): { started: number; queued: number; inFlight: number };
};

type Job = { task: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

export function createSecLimiter(opts: SecLimiterOptions = {}): SecLimiter {
  const gap = Math.max(0, opts.minGapMs ?? SEC_MIN_GAP_MS);
  const max = Math.max(1, opts.maxInFlight ?? SEC_MAX_IN_FLIGHT);
  const now = opts.now ?? Date.now;
  const waiting: Job[] = [];
  let inFlight = 0;
  let started = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = (): void => {
    if (timer || inFlight >= max || waiting.length === 0) return;
    const wait = lastStart + gap - now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, wait);
      return;
    }
    const job = waiting.shift()!;
    lastStart = now();
    inFlight += 1;
    started += 1;
    let run: Promise<unknown>;
    try {
      run = Promise.resolve(job.task());
    } catch (err) {
      run = Promise.reject(err);
    }
    run.then(job.resolve, job.reject).finally(() => {
      inFlight -= 1;
      pump();
    });
    pump();
  };

  return {
    schedule<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push({ task, resolve: resolve as (v: unknown) => void, reject });
        pump();
      });
    },
    stats: () => ({ started, queued: waiting.length, inFlight }),
  };
}

const KEY = Symbol.for("meridian.secLimiter");

/** The process-wide EDGAR queue. */
export function sharedSecLimiter(): SecLimiter {
  const g = globalThis as unknown as Record<symbol, SecLimiter | undefined>;
  if (!g[KEY]) g[KEY] = createSecLimiter();
  return g[KEY]!;
}

export type SecFetchOptions = {
  /** The caller's descriptive User-Agent (SEC requires one with a contact address). */
  userAgent: string;
  accept?: string;
  /** Deadline for the response headers; the body is read by the caller. */
  timeoutMs?: number;
};

/** One EDGAR request through the process-wide queue. */
export function secFetch(url: string, opts: SecFetchOptions): Promise<Response> {
  return sharedSecLimiter().schedule(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SEC_TIMEOUT_MS);
    try {
      return await fetch(url, {
        headers: { "User-Agent": opts.userAgent, Accept: opts.accept ?? "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  });
}
