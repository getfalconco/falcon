import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A concurrency gate for one provider's requests (Yahoo, market-data-service.ts).
 *
 * Two lanes. A read made inside `asBulk` (the Earnings tab's fan-outs over
 * forty names: implied moves, estimates, reactions, report dates, the
 * read-through radar) is "bulk": at most `bulkMax` of those in flight. Every
 * other read (a chart, a quote, the briefing) is interactive: it goes first
 * when a slot frees, and all reads together stay under `max`. A read that
 * cannot start within `maxWaitMs` fails with the same plain error a timed out
 * read gives, so callers fail soft as they already do.
 *
 * Electron-free.
 */

export type GateOptions = { max: number; bulkMax: number; maxWaitMs: number };

export class GateTimeoutError extends Error {
  constructor() {
    super("Market data request timed out");
  }
}

type Waiter = { bulk: boolean; start: () => void; timer: ReturnType<typeof setTimeout> | null };

const lane = new AsyncLocalStorage<"bulk">();

/** Runs `fn` with every gated read it makes, however deep, in the bulk lane. */
export function asBulk<T>(fn: () => Promise<T>): Promise<T> {
  return lane.run("bulk", fn);
}

export function inBulkLane(): boolean {
  return lane.getStore() === "bulk";
}

export function createRequestGate(opts: GateOptions) {
  let inFlight = 0;
  let bulkInFlight = 0;
  let peak = 0;
  let peakBulk = 0;
  const interactive: Waiter[] = [];
  const bulk: Waiter[] = [];

  const canStart = (isBulk: boolean) => inFlight < opts.max && (!isBulk || bulkInFlight < opts.bulkMax);

  const begin = (isBulk: boolean) => {
    inFlight += 1;
    if (isBulk) bulkInFlight += 1;
    peak = Math.max(peak, inFlight);
    peakBulk = Math.max(peakBulk, bulkInFlight);
  };

  const pump = () => {
    while (interactive.length > 0 && canStart(false)) interactive.shift()!.start();
    while (bulk.length > 0 && canStart(true)) bulk.shift()!.start();
  };

  const acquire = (isBulk: boolean): Promise<void> => {
    const queue = isBulk ? bulk : interactive;
    // Nobody of this lane (or, for bulk, of the interactive lane) is waiting ahead.
    if (queue.length === 0 && (!isBulk || interactive.length === 0) && canStart(isBulk)) {
      begin(isBulk);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        bulk: isBulk,
        timer: null,
        start: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          begin(isBulk);
          resolve();
        },
      };
      waiter.timer = setTimeout(() => {
        const at = queue.indexOf(waiter);
        if (at >= 0) queue.splice(at, 1);
        reject(new GateTimeoutError());
      }, opts.maxWaitMs);
      waiter.timer.unref?.();
      queue.push(waiter);
    });
  };

  const release = (isBulk: boolean) => {
    inFlight -= 1;
    if (isBulk) bulkInFlight -= 1;
    pump();
  };

  return {
    /** Runs `task` once a slot is free; the slot is held until it settles. */
    async run<T>(task: () => Promise<T>, isBulk = inBulkLane()): Promise<T> {
      await acquire(isBulk);
      try {
        return await task();
      } finally {
        release(isBulk);
      }
    },
    stats: () => ({ inFlight, bulkInFlight, waiting: interactive.length + bulk.length, peak, peakBulk }),
  };
}

export type RequestGate = ReturnType<typeof createRequestGate>;

/** A request naming at least this many companies is a fan-out: its reads go in the bulk lane. */
export const BULK_NAMES = 4;

/** `fn` in the bulk lane when the request names at least BULK_NAMES companies; as is otherwise. */
export function bulkFor<T>(names: number, fn: () => Promise<T>): Promise<T> {
  return names >= BULK_NAMES ? asBulk(fn) : fn();
}
