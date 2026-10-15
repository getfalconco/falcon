/**
 * Where Filing changes parses a filing: in its worker thread
 * (parse-worker.ts) when one can be started, on the calling thread when not.
 *
 * One worker, started on the first filing and stopped after a minute
 * without one (it holds a few tens of megabytes while it lives). A worker
 * that fails to start is not tried again this run: every filing is read on
 * the calling thread, as before, with a pause between the heavy steps so
 * the event loop still answers IPC. A worker that dies after it worked is
 * started again on the next filing, at most MAX_RESTARTS times; the filings
 * it held are read on the calling thread.
 *
 * Electron-free: the worker is started by an injected `spawn`.
 */

import type { Worker } from "node:worker_threads";
import { readFiling, type FilingLike, type ReadFiling } from "./digest";
import type { ParseReply, ParseRequest } from "./parse-worker";

export const IDLE_STOP_MS = 60_000;
export const MAX_RESTARTS = 3;

export type FilingParser = {
  parse(filing: FilingLike, html: string, keepText: boolean): Promise<ReadFiling>;
  /** "worker" while the worker is (or can be) used, "thread" once it has failed for good or none was given. */
  mode(): "worker" | "thread";
  /** Stops the worker (tests, quit). */
  close(): Promise<void>;
};

/** Lets the event loop answer IPC between two heavy steps. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The calling thread's read, with a pause either side. */
export async function parseInThread(filing: FilingLike, html: string, keepText: boolean): Promise<ReadFiling> {
  await breathe();
  const out = readFiling(filing, html, keepText);
  await breathe();
  return out;
}

type Pending = { req: ParseRequest; resolve: (r: ReadFiling) => void; reject: (e: Error) => void };

export function createFilingParser(opts: { spawn?: () => Worker; idleStopMs?: number; log?: (message: string) => void } = {}): FilingParser {
  const log = opts.log ?? ((m: string) => console.warn(`[filings] ${m}`));
  const idleStopMs = opts.idleStopMs ?? IDLE_STOP_MS;
  let worker: Worker | null = null;
  /** The current worker answered at least once: a later death is a crash, not a failed start. */
  let worked = false;
  let broken = !opts.spawn;
  let restarts = 0;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const armIdle = () => {
    clearIdle();
    if (pending.size > 0 || !worker) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pending.size === 0 && worker) {
        const w = worker;
        worker = null;
        void w.terminate().catch(() => undefined);
      }
    }, idleStopMs);
    idleTimer.unref?.();
  };

  /** The worker went away: what it held is read here, and a worker that never answered is not tried again. */
  const lost = (w: Worker, why: string) => {
    if (worker !== w) return;
    worker = null;
    clearIdle();
    if (!worked) {
      broken = true;
      log(`parse worker could not start (${why}); reading filings on the main thread`);
    } else if (++restarts > MAX_RESTARTS) {
      broken = true;
      log(`parse worker stopped ${restarts} times (${why}); reading filings on the main thread`);
    } else log(`parse worker stopped (${why}); it starts again on the next filing`);
    const held = [...pending.values()];
    pending.clear();
    for (const p of held) parseInThread(p.req.filing, p.req.html, p.req.keepText).then(p.resolve, p.reject);
  };

  const start = (): Worker | null => {
    if (broken) return null;
    if (worker) return worker;
    let w: Worker;
    try {
      w = opts.spawn!();
    } catch (err) {
      broken = true;
      log(`parse worker could not start (${err instanceof Error ? err.message : String(err)}); reading filings on the main thread`);
      return null;
    }
    worked = false;
    worker = w;
    w.unref();
    w.on("message", (reply: ParseReply) => {
      worked = true;
      const p = pending.get(reply.id);
      if (!p) return;
      pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.result);
      else p.reject(new Error(reply.error));
      // An idle worker never keeps the process alive.
      if (pending.size === 0) w.unref();
      armIdle();
    });
    w.on("error", (err) => lost(w, err instanceof Error ? err.message : String(err)));
    w.on("exit", (code) => lost(w, `exit ${code}`));
    return w;
  };

  return {
    parse(filing, html, keepText) {
      const w = start();
      if (!w) return parseInThread(filing, html, keepText);
      clearIdle();
      w.ref();
      return new Promise<ReadFiling>((resolve, reject) => {
        const req: ParseRequest = { id: nextId++, filing, html, keepText };
        pending.set(req.id, { req, resolve, reject });
        try {
          w.postMessage(req);
        } catch (err) {
          lost(w, err instanceof Error ? err.message : String(err));
        }
      });
    },
    mode: () => (broken ? "thread" : "worker"),
    async close() {
      clearIdle();
      const w = worker;
      worker = null;
      if (w) await w.terminate().catch(() => undefined);
    },
  };
}
