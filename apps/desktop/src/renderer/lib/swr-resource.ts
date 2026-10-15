/**
 * Stale-while-revalidate for one remote answer, held at module level so it
 * outlives the component that shows it.
 *
 * The dashboard unmounts on every tab switch and every trip into a stock or
 * the graph. A card that keeps its data in component state therefore starts
 * from nothing each time it comes back: a "loading" line, a fresh request, and
 * the same list it had a moment ago. Here the answer lives in the module; a
 * card that mounts reads it at once and asks again only when it is older than
 * `staleAfterMs`.
 *
 * The rules:
 *   * one request out at a time; a second caller gets the first one's promise;
 *   * a failed request keeps the last good value (the error sits beside it),
 *     and is not retried for `retryAfterMs`, however often the card remounts;
 *   * a timer keeps the value fresh while somebody holds the resource, and
 *     for `keepWarmMs` after the last one lets go, so a card that comes back
 *     from another tab is already current. The timer stops while the window
 *     is hidden and catches up once when it is shown again;
 *   * `seed` (optional) is asked once, before the first request: a cheap local
 *     copy (the main process's disk cache) shown while the real one is out.
 *
 * Nothing here knows about React or the bridge; the clock, the timers and the
 * window's visibility come in through `env`, so the rules can be tested.
 */

export type SwrLoadResult<V> = { ok: true; value: V } | { ok: false; error: string };

export type SwrState<V> = {
  value: V | null;
  /** When `value` was fetched, epoch ms; null while there is none. */
  fetchedAt: number | null;
  /** The last attempt's failure, "" when it gave no reason; null after a success. */
  error: string | null;
  /** A request is out. */
  loading: boolean;
  /** Something is known: a seed, a value or a failure. Until then the card says "loading". */
  settled: boolean;
};

export type SwrEnv = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  isVisible: () => boolean;
  /** Calls `fn` on every visibility change; returns the unsubscribe. */
  onVisibilityChange: (fn: () => void) => () => void;
};

export type SwrOptions<V> = {
  load: () => Promise<SwrLoadResult<V>>;
  seed?: () => Promise<{ value: V; fetchedAt: number } | null>;
  /** Older than this, a mount (or the timer) asks again. */
  staleAfterMs: number;
  /** After a failure, the next attempt waits at least this long. */
  retryAfterMs: number;
  /** How long the timer keeps running once nobody holds the resource. */
  keepWarmMs: number;
  env?: Partial<SwrEnv>;
};

export type SwrResource<V> = {
  getState: () => SwrState<V>;
  subscribe: (listener: () => void) => () => void;
  /** "Somebody is looking": starts the timer and refreshes if stale. Returns the release. */
  retain: () => () => void;
  /** Ask now unless a request is already out (then share it). */
  revalidate: () => Promise<void>;
  /** Ask only when the value is stale and no failure is too recent. */
  refreshIfStale: () => Promise<void>;
  /** Stops the timer and forgets everything (tests). */
  reset: () => void;
};

function defaultEnv(): SwrEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    // Node-side tests import this with no document: treat that as visible.
    isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    onVisibilityChange: (fn) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}

const EMPTY: SwrState<never> = { value: null, fetchedAt: null, error: null, loading: false, settled: false };

export function createSwrResource<V>(options: SwrOptions<V>): SwrResource<V> {
  const env: SwrEnv = { ...defaultEnv(), ...options.env };
  const { staleAfterMs, retryAfterMs, keepWarmMs } = options;

  let state: SwrState<V> = EMPTY;
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  let seeding: Promise<void> | null = null;
  let seeded = !options.seed;
  let lastFailedAt: number | null = null;
  let holders = 0;
  let releasedAt: number | null = null;
  let timer: unknown = null;
  let detachVisibility: (() => void) | null = null;
  /** Bumped by reset, so a reply from before it is dropped. */
  let epoch = 0;

  const setState = (patch: Partial<SwrState<V>>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const isStale = (now: number): boolean => {
    if (lastFailedAt !== null && now - lastFailedAt < retryAfterMs) return false;
    return state.fetchedAt === null || now - state.fetchedAt >= staleAfterMs;
  };

  /** Held now, or let go of recently enough that the reader may be back any moment. */
  const isWarm = (now: number): boolean => holders > 0 || (releasedAt !== null && now - releasedAt < keepWarmMs);

  const clearTimer = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  };

  const goDormant = () => {
    clearTimer();
    detachVisibility?.();
    detachVisibility = null;
  };

  /** The next moment worth asking: the value going stale, or a failure's back-off running out. */
  const dueAt = (): number => {
    const now = env.now();
    let due = state.fetchedAt === null ? now : state.fetchedAt + staleAfterMs;
    if (lastFailedAt !== null) due = Math.max(due, lastFailedAt + retryAfterMs);
    return due;
  };

  const schedule = () => {
    clearTimer();
    if (!env.isVisible()) return;
    const now = env.now();
    if (!isWarm(now)) {
      goDormant();
      return;
    }
    // Dormancy is checked on the timer, so wake no later than the warm window's end.
    let due = dueAt();
    if (holders === 0 && releasedAt !== null) due = Math.min(due, releasedAt + keepWarmMs);
    timer = env.setTimeout(onTimer, Math.max(0, due - now));
  };

  const onTimer = () => {
    timer = null;
    if (!env.isVisible()) return;
    if (!isWarm(env.now())) {
      goDormant();
      return;
    }
    void refreshIfStale().then(schedule, schedule);
  };

  const onVisibility = () => {
    if (!env.isVisible()) {
      clearTimer();
      return;
    }
    if (!isWarm(env.now())) {
      goDormant();
      return;
    }
    // Back from hidden: one catch-up request if the value went stale meanwhile.
    void refreshIfStale().then(schedule, schedule);
  };

  const ensureAwake = () => {
    if (!detachVisibility) detachVisibility = env.onVisibilityChange(onVisibility);
  };

  const seedOnce = (): Promise<void> => {
    if (seeded) return Promise.resolve();
    if (seeding) return seeding;
    const atEpoch = epoch;
    seeding = Promise.resolve()
      .then(() => options.seed?.() ?? null)
      .catch(() => null)
      .then((hit) => {
        if (atEpoch !== epoch) return;
        seeded = true;
        // A real answer that landed first is newer than any copy on disk.
        if (hit && state.value === null) {
          setState({ value: hit.value, fetchedAt: hit.fetchedAt, settled: true });
        }
      })
      .finally(() => {
        if (atEpoch === epoch) seeding = null;
      });
    return seeding;
  };

  const revalidate = (): Promise<void> => {
    if (inflight) return inflight;
    const atEpoch = epoch;
    setState({ loading: true });
    const run = Promise.resolve()
      .then(options.load)
      .then(
        (result) => result,
        (err: unknown): SwrLoadResult<V> => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
      .then((result) => {
        if (atEpoch !== epoch) return;
        const now = env.now();
        if (result && result.ok === true) {
          lastFailedAt = null;
          setState({ value: result.value, fetchedAt: now, error: null, loading: false, settled: true });
        } else {
          lastFailedAt = now;
          // The value already shown stays; the failure only sits beside it.
          const error = result && typeof result.error === "string" ? result.error : "";
          setState({ error, loading: false, settled: true });
        }
      })
      .finally(() => {
        if (atEpoch === epoch) inflight = null;
      });
    inflight = run;
    return run;
  };

  const refreshIfStale = async (): Promise<void> => {
    await seedOnce();
    if (inflight) return inflight;
    if (!isStale(env.now())) return;
    return revalidate();
  };

  const retain = () => {
    holders += 1;
    releasedAt = null;
    ensureAwake();
    void refreshIfStale().then(schedule, schedule);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders = Math.max(0, holders - 1);
      if (holders === 0) {
        releasedAt = env.now();
        schedule();
      }
    };
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retain,
    revalidate,
    refreshIfStale,
    reset: () => {
      epoch += 1;
      goDormant();
      state = EMPTY;
      inflight = null;
      seeding = null;
      seeded = !options.seed;
      lastFailedAt = null;
      holders = 0;
      releasedAt = null;
      for (const listener of [...listeners]) listener();
    },
  };
}
