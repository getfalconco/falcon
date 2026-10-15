import fs from "node:fs";
import path from "node:path";

/**
 * A small keyed cache in memory and in one JSON file, with a time to live per
 * entry and a cap on how many are kept (oldest written goes first).
 *
 * The news panel keeps two of these under `<data root>/news/`: the article
 * text a publisher's page gave, and Falcon's read of it. Both are cheap to
 * lose (a miss costs a page fetch or one small model call) and must not grow
 * without bound, so the file is rewritten whole, a beat after the last put,
 * and anything unreadable is treated as empty.
 *
 * `dir` is resolved lazily so the data-root override set at startup applies,
 * and so a test can hand in a temp directory.
 */

type Entry<T> = { at: number; ttl: number; value: T };
type FileShape<T> = { version: number; entries: Record<string, Entry<T>> };

export type TtlCacheOptions = {
  dir: () => string;
  file: string;
  /** Default time to live, ms. A put may pass its own. */
  ttlMs: number;
  maxEntries: number;
  version?: number;
  now?: () => number;
  /** Delay before the file is written, ms; 0 writes on the next tick. */
  writeDelayMs?: number;
};

export class TtlCache<T> {
  private entries: Map<string, Entry<T>> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly version: number;

  constructor(private readonly opts: TtlCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.version = opts.version ?? 1;
  }

  filePath(): string {
    return path.join(this.opts.dir(), this.opts.file);
  }

  private load(): Map<string, Entry<T>> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as FileShape<T>;
      if (parsed?.version === this.version && parsed.entries && typeof parsed.entries === "object") {
        const rows = Object.entries(parsed.entries)
          .filter(([, e]) => e && typeof e.at === "number" && typeof e.ttl === "number" && "value" in e)
          .sort(([, a], [, b]) => a.at - b.at);
        for (const [k, e] of rows) this.entries.set(k, e);
      }
    } catch {
      /* no file yet, or unreadable: start empty */
    }
    return this.entries;
  }

  get(key: string): T | undefined {
    const entries = this.load();
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > hit.ttl) {
      entries.delete(key);
      this.schedule();
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const entries = this.load();
    entries.delete(key);
    entries.set(key, { at: this.now(), ttl: ttlMs ?? this.opts.ttlMs, value });
    while (entries.size > this.opts.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    this.schedule();
  }

  size(): number {
    return this.load().size;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.writeDelayMs ?? 250);
    // Never keep a process (or a test run) alive for a cache write.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes the file now, dropping expired rows on the way. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = this.load();
    const now = this.now();
    const kept: Record<string, Entry<T>> = {};
    for (const [k, e] of entries) {
      if (now - e.at <= e.ttl) kept[k] = e;
      else entries.delete(k);
    }
    try {
      const target = this.filePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: this.version, entries: kept } satisfies FileShape<T>));
      fs.renameSync(tmp, target);
    } catch (err) {
      console.warn(`[news] could not write ${this.opts.file}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Calls sharing a key while one is out get the same promise. */
export class InFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  has(key: string): boolean {
    return this.pending.has(key);
  }

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = work().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
