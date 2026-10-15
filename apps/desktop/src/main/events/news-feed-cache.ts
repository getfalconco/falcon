import fs from "node:fs";
import path from "node:path";
import type {
  NewsFeedCachedResult,
  NewsFeedOptions,
  NewsFeedResult,
} from "../../shared/news-feed";

/**
 * The main process's copy of the news feed: the last good answer to each
 * `news:feed` request, in memory and in one small file beside the events
 * store, so a restart has something to show before the engine has answered.
 *
 * It sits in front of the engine call, not beside it. There is no other cache
 * on this path: the engine answers `news:feed` by reading its own article
 * store (the poll that fills it is the only thing that spends the Finnhub
 * quota, and it runs on the server whether anyone reads or not), so the cost
 * a read saves here is one HTTP round to the engine and a few hundred KB of
 * JSON. Nothing is ever asked of a news provider from this file.
 *
 * Three things it does:
 *   * a request inside `freshMs` of the last good answer is answered from
 *     memory (two cards, two windows, a renderer reload);
 *   * identical requests already out share one call;
 *   * a failure is passed through untouched, and the last good answer stays
 *     where `peek` can still read it, so the renderer keeps its list.
 */

/** Matches the engine poll's cadence: nothing newer can exist sooner than this. */
export const MAIN_FRESH_MS = 30_000;
/** Distinct requests kept on disk. The card makes one; the rest is headroom. */
const MAX_ENTRIES = 4;
const FILE_VERSION = 1;
export const NEWS_FEED_CACHE_FILE = "news-feed-cache.json";

type OkResult = Extract<NewsFeedResult, { ok: true }>;
type Entry = { fetchedAt: number; result: OkResult };
type FileShape = { version: number; entries: Record<string, Entry> };

/** One key per distinct request: the two numbers the engine reads, nothing else. */
export function newsFeedKey(options?: NewsFeedOptions | null): string {
  const days = typeof options?.days === "number" && Number.isFinite(options.days) ? options.days : "";
  const limit = typeof options?.limit === "number" && Number.isFinite(options.limit) ? options.limit : "";
  return `d=${days}|l=${limit}`;
}

function isOkResult(value: unknown): value is OkResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<OkResult>;
  return v.ok === true && Array.isArray(v.articles) && typeof v.status === "object" && v.status !== null;
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Entry>;
  return typeof v.fetchedAt === "number" && Number.isFinite(v.fetchedAt) && isOkResult(v.result);
}

export type NewsFeedCacheOptions = {
  /** Directory the file lives in; resolved lazily so env overrides set at startup apply. */
  dir: () => string;
  freshMs?: number;
  now?: () => number;
};

export class NewsFeedCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<NewsFeedResult>>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly freshMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: NewsFeedCacheOptions) {
    this.freshMs = opts.freshMs ?? MAIN_FRESH_MS;
    this.now = opts.now ?? Date.now;
  }

  filePath(): string {
    return path.join(this.opts.dir(), NEWS_FEED_CACHE_FILE);
  }

  /** Reads the file once. A missing, unreadable or foreign file is an empty cache. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as Partial<FileShape>;
      if (raw?.version !== FILE_VERSION || !raw.entries || typeof raw.entries !== "object") return;
      for (const [key, entry] of Object.entries(raw.entries)) {
        // An answer already in memory is newer than anything on disk.
        if (isEntry(entry) && !this.entries.has(key)) this.entries.set(key, entry);
      }
    } catch {
      // No file yet, or a torn one: start empty, the next good answer rewrites it.
    }
  }

  /**
   * Written whole, to a temp file renamed over the old one, one write at a
   * time. A crash mid-write leaves the previous file, never half of one.
   */
  private persist(): Promise<void> {
    const snapshot: FileShape = { version: FILE_VERSION, entries: Object.fromEntries(this.entries) };
    const file = this.filePath();
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(snapshot), "utf8");
        await fs.promises.rename(tmp, file);
      })
      .catch((err: unknown) => {
        console.warn("[news] feed cache not written:", err instanceof Error ? err.message : String(err));
      });
    return this.writing;
  }

  /** Waits for any write in progress (tests, and a clean quit). */
  flush(): Promise<void> {
    return this.writing;
  }

  private store(key: string, result: OkResult): void {
    this.entries.delete(key);
    this.entries.set(key, { fetchedAt: this.now(), result });
    // Oldest out first; Map keeps insertion order and `store` re-inserts.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    void this.persist();
  }

  /** The last good answer for this request, however old, without asking anyone. */
  peek(options?: NewsFeedOptions | null): NewsFeedCachedResult {
    this.ensureLoaded();
    const entry = this.entries.get(newsFeedKey(options));
    if (!entry) return { ok: false, error: "no cached feed" };
    return { ...entry.result, fetchedAt: entry.fetchedAt };
  }

  /**
   * The feed for this request: from memory when the last good answer is
   * younger than `freshMs`, otherwise from `fetch`, with identical requests
   * sharing one call.
   */
  get(options: NewsFeedOptions | null | undefined, fetch: () => Promise<unknown>): Promise<NewsFeedResult> {
    this.ensureLoaded();
    const key = newsFeedKey(options);
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.fetchedAt < this.freshMs) return Promise.resolve(entry.result);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const call = Promise.resolve()
      .then(fetch)
      .then(
        (value): NewsFeedResult => {
          if (isOkResult(value)) {
            this.store(key, value);
            return value;
          }
          const error =
            value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
              ? (value as { error: string }).error
              : "";
          return { ok: false, error };
        },
        (err: unknown): NewsFeedResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, call);
    return call;
  }
}
