/// <reference types="electron-vite/node" />
/**
 * Starts Filing changes' parse worker. electron-vite builds parse-worker.ts
 * as its own chunk beside the main bundle (out/main/) and this import turns
 * into `new Worker(<that file>)`, resolved against the main bundle's own
 * path, so dev, a production build and the packaged app's asar all find it.
 * Kept apart so the services and their tests never import `?nodeWorker`.
 */

import type { Worker } from "node:worker_threads";
import createParseWorker from "./parse-worker?nodeWorker";

export function spawnParseWorker(): Worker {
  return createParseWorker({ name: "filings-parse" });
}
