/**
 * A polite HTTP client for free data sources: few requests at once, a gap
 * between request starts, a timeout on each request, one retry on 429/5xx,
 * and an outer AbortSignal (the run's deadline) that stops everything.
 */

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export type PoliteOptions = {
  concurrency: number;
  minGapMs: number;
  timeoutMs: number;
  retries: number;
};

export class DeadlineError extends Error {
  constructor(message = "The data source did not answer in time.") {
    super(message);
    this.name = "DeadlineError";
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DeadlineError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DeadlineError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class PoliteFetcher {
  private active = 0;
  private waiting: (() => void)[] = [];
  private nextStart = 0;

  constructor(private opts: PoliteOptions) {}

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active >= this.opts.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.waiting = this.waiting.filter((w) => w !== go);
          reject(new DeadlineError());
        };
        this.waiting.push(go);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.active++;
    const now = Date.now();
    const at = Math.max(now, this.nextStart);
    this.nextStart = at + this.opts.minGapMs;
    if (at > now) {
      try {
        await sleep(at - now, signal);
      } catch (e) {
        this.release();
        throw e;
      }
    }
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  async fetch(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new DeadlineError();
      await this.acquire(signal);
      let res: Response | null = null;
      let failure: unknown = null;
      try {
        const signals = [AbortSignal.timeout(this.opts.timeoutMs), ...(signal ? [signal] : [])];
        res = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
        // Read the body inside the slot so the connection is done before the next request starts.
        const body = await res.arrayBuffer();
        const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
        res = new Response(nullBody ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch (e) {
        res = null;
        failure = e;
      } finally {
        this.release();
      }
      if (signal?.aborted) throw new DeadlineError();
      const retryable = failure !== null || (res !== null && (res.status === 429 || res.status >= 500));
      if (!retryable) return res!;
      if (attempt >= this.opts.retries) {
        if (res) return res;
        throw failure instanceof Error ? failure : new Error(String(failure));
      }
      const after = Number(res?.headers.get("retry-after"));
      await sleep(Math.min(5_000, Number.isFinite(after) && after > 0 ? after * 1000 : 800 * (attempt + 1)), signal);
    }
  }
}

/** One client for all Yahoo hosts: 6 at a time, 75 ms between starts, 10 s per request. */
export const yahooFetcher = new PoliteFetcher({ concurrency: 6, minGapMs: 75, timeoutMs: 10_000, retries: 1 });
