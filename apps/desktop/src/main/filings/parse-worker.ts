/**
 * The Filing changes reader's worker thread: takes one filing's HTML, hands
 * back its digest and searchable text (digest.ts `readFiling`), so a 10-K's
 * half second of parsing never holds the Electron main thread.
 *
 * Bundled by electron-vite as its own chunk next to the main bundle
 * (parse-worker-spawn.ts imports it with `?nodeWorker`); run directly from
 * the .ts source in tests.
 */

import { parentPort } from "node:worker_threads";
import { readFiling, type FilingLike, type ReadFiling } from "./digest";

export type ParseRequest = { id: number; filing: FilingLike; html: string; keepText: boolean };
export type ParseReply = { id: number; ok: true; result: ReadFiling } | { id: number; ok: false; error: string };

parentPort?.on("message", (req: ParseRequest) => {
  let reply: ParseReply;
  try {
    reply = { id: req.id, ok: true, result: readFiling(req.filing, req.html, req.keepText) };
  } catch (err) {
    reply = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(reply);
});
