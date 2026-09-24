import fs from "node:fs";
import path from "node:path";

/** Null for a missing file and for one that does not parse: both mean "nothing usable is stored". */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Write to a sibling temp file, then rename over the target, so a reader never
 * sees half a file and a crash mid-write leaves the previous version intact.
 *
 * On Windows a virus scanner or the search indexer can hold a freshly written
 * file open for a few milliseconds, and the rename then throws EPERM or EBUSY.
 * The same retry the Quant Lab store uses: a bare rename would lose a report
 * to a lock that is gone a moment later.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The pid keeps two processes (the app and a dev script) from sharing a temp name.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // The temp file is swept by the next prune.
        }
        throw err;
      }
      sleepBriefly(15 * (attempt + 1));
    }
  }
}

/** Synchronous pause: the stores' callers are all synchronous. */
function sleepBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
