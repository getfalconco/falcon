import type { StockThesisResult } from "../../../shared/stock-thesis";

/**
 * The renderer's one copy of the reader's theses, behind `useThesis`
 * (thesis-store.ts). Read once per ticker from the main process and kept;
 * a save goes to main and, once main has it, every section reading that
 * ticker is told. Saves for one ticker run in order, so a slow early save
 * never lands after a later one.
 *
 * `scope` names whose theses these are (the signed-in account): when it
 * changes, everything read so far is dropped and read again.
 *
 * Free of React and of `window`, so it is tested on its own.
 */

export type ThesisBridge = {
  get: (ticker: string) => Promise<StockThesisResult>;
  set: (ticker: string, text: string) => Promise<StockThesisResult>;
};

export type ThesisSnapshot = { readonly text: string | null; readonly loading: boolean };

type Entry = ThesisSnapshot & { readonly loaded: boolean };

const LOADING: ThesisSnapshot = Object.freeze({ text: null, loading: true });

export class ThesisSaveError extends Error {
  constructor(readonly code: string) {
    super(`thesis not saved: ${code}`);
  }
}

export function createThesisCache(bridge: () => ThesisBridge | null, scope: () => string = () => "") {
  let entries = new Map<string, Entry>();
  let reads = new Map<string, Promise<void>>();
  let queues = new Map<string, Promise<unknown>>();
  let currentScope = scope();
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const fn of listeners) fn();
  };

  const checkScope = () => {
    const now = scope();
    if (now === currentScope) return;
    currentScope = now;
    entries = new Map();
    reads = new Map();
    queues = new Map();
  };

  const put = (ticker: string, entry: Entry) => {
    entries.set(ticker, entry);
    tell();
  };

  const key = (ticker: string) => ticker.trim().toUpperCase();

  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** What a section shows for `ticker` right now. The same object until it changes. */
    snapshot(ticker: string): ThesisSnapshot {
      checkScope();
      return entries.get(key(ticker)) ?? LOADING;
    },

    /** Reads `ticker` from main unless it has been read (or is being read). */
    ensure(ticker: string): Promise<void> {
      checkScope();
      const t = key(ticker);
      if (!t) return Promise.resolve();
      if (entries.get(t)?.loaded) return Promise.resolve();
      const pending = reads.get(t);
      if (pending) return pending;
      const api = bridge();
      if (!api) {
        put(t, { text: null, loading: false, loaded: true });
        return Promise.resolve();
      }
      const at = currentScope;
      const read = api
        .get(t)
        .then(
          (res) => {
            if (at !== currentScope) return;
            // A failed read (signed out for a moment, main busy) shows the
            // empty field and is asked again on the next visit.
            if (res.ok) put(t, { text: res.thesis?.text ?? null, loading: false, loaded: true });
            else put(t, { text: entries.get(t)?.text ?? null, loading: false, loaded: false });
          },
          () => {
            if (at === currentScope) put(t, { text: entries.get(t)?.text ?? null, loading: false, loaded: false });
          },
        )
        .finally(() => {
          if (reads.get(t) === read) reads.delete(t);
        });
      reads.set(t, read);
      return read;
    },

    /** Saves (or, with blank text, clears) the thesis; rejects with a ThesisSaveError when main did not keep it. */
    save(ticker: string, text: string): Promise<void> {
      checkScope();
      const t = key(ticker);
      const api = bridge();
      if (!t || !api) return Promise.reject(new ThesisSaveError("unavailable"));
      const at = currentScope;
      const prior = queues.get(t) ?? Promise.resolve();
      const run = prior
        .catch(() => undefined)
        .then(() => api.set(t, text))
        .then((res) => {
          if (!res.ok) throw new ThesisSaveError(res.error);
          if (at === currentScope) put(t, { text: res.thesis?.text ?? null, loading: false, loaded: true });
        });
      queues.set(t, run);
      void run.catch(() => undefined).finally(() => {
        if (queues.get(t) === run) queues.delete(t);
      });
      return run;
    },
  };
}

export type ThesisCache = ReturnType<typeof createThesisCache>;
