import pg from "pg";

/**
 * Company news for every US-listed company, kept in Postgres
 * (public.news_items, migration supabase/migrations/20261126_news_items.sql).
 *
 * The sweeper walks the Finnhub US universe one symbol at a time, calls
 * /company-news for the last few days and upserts the articles. Its cursor
 * and a lease live in public.news_sweep_state, so it resumes where it left off
 * and only one sweeper (the Netlify scheduled function or a local run) calls
 * Finnhub at a time.
 *
 * Used by netlify/functions/news-sweep.mts, scripts/news-sweep.ts (run by
 * Node directly, so this file sticks to type-only TypeScript syntax and
 * imports nothing but pg) and GET /api/news.
 */

const FINNHUB = "https://finnhub.io/api/v1";
/** Exchanges kept from Finnhub's US list: NYSE, Nasdaq, NYSE American, NYSE Arca, Cboe BZX. OTC is left out. */
const EXCHANGES = new Set(["XNYS", "XNAS", "XASE", "ARCX", "BATS"]);
const TYPES = new Set(["Common Stock", "ADR", "REIT"]);
const UNIVERSE_MAX_AGE_MS = 24 * 3600_000;
const WINDOW_DAYS = 3;
const KEEP_DAYS = 14;
/** Calls left for everything else that shares the key: below this many remaining in Finnhub's minute, the sweeper pauses. */
const RESERVE = 10;

export function createNewsPool(url: string, max = 2): pg.Pool {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
  const pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 });
  pool.on("error", () => undefined);
  return pool;
}

// ---------------------------------------------------------------- reading

export type NewsRow = {
  id: number;
  symbols: string[];
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string;
  category: string;
  publishedAt: string;
};

/** Newest first. `before` (ISO time) pages back; `symbol` keeps articles tagged with that ticker. */
export async function readNews(pool: pg.Pool, opts: { symbol?: string; limit: number; before?: string }): Promise<NewsRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.symbol) {
    args.push([opts.symbol]);
    where.push(`symbols @> $${args.length}::text[]`);
  }
  if (opts.before) {
    args.push(opts.before);
    where.push(`published_at < $${args.length}::timestamptz`);
  }
  args.push(opts.limit);
  const { rows } = await pool.query<{
    id: string;
    symbols: string[];
    headline: string;
    summary: string;
    source: string;
    url: string;
    image: string;
    category: string;
    published_at: Date;
  }>(
    `select id, symbols, headline, summary, source, url, image, category, published_at
       from public.news_items
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by published_at desc, id desc
      limit $${args.length}`,
    args,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    symbols: r.symbols,
    headline: r.headline,
    summary: r.summary,
    source: r.source,
    url: r.url,
    image: r.image,
    category: r.category,
    publishedAt: r.published_at.toISOString(),
  }));
}

// ---------------------------------------------------------------- Finnhub

type FinnhubSymbol = { symbol?: string; type?: string; mic?: string };
type FinnhubArticle = {
  id?: number;
  category?: string;
  datetime?: number;
  headline?: string;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
};

type Limit = { remaining: number | null; resetAt: number | null };

function readLimit(res: Response): Limit {
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return {
    remaining: res.headers.has("x-ratelimit-remaining") && Number.isFinite(remaining) ? remaining : null,
    resetAt: res.headers.has("x-ratelimit-reset") && Number.isFinite(reset) ? reset * 1000 : null,
  };
}

class FinnhubError extends Error {
  status: number;
  limit: Limit;
  constructor(status: number, limit: Limit, message: string) {
    super(message);
    this.status = status;
    this.limit = limit;
  }
}

async function finnhub<T>(path: string, key: string, timeoutMs = 7_000): Promise<{ body: T; limit: Limit }> {
  const res = await fetch(`${FINNHUB}${path}`, { headers: { "X-Finnhub-Token": key }, signal: AbortSignal.timeout(timeoutMs) });
  const limit = readLimit(res);
  if (!res.ok) throw new FinnhubError(res.status, limit, `Finnhub ${path.split("?")[0]}: HTTP ${res.status}`);
  return { body: (await res.json()) as T, limit };
}

/** Finnhub's US list cut to common stocks, ADRs and REITs on the main exchanges, sorted. One API call. */
export async function fetchUniverse(key: string): Promise<{ symbols: string[]; limit: Limit }> {
  const { body, limit } = await finnhub<FinnhubSymbol[]>("/stock/symbol?exchange=US", key, 20_000);
  const set = new Set<string>();
  for (const s of Array.isArray(body) ? body : []) {
    if (s.symbol && s.type && s.mic && TYPES.has(s.type) && EXCHANGES.has(s.mic)) set.add(s.symbol.toUpperCase());
  }
  return { symbols: [...set].sort(), limit };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- sweeping

export type SweepOptions = {
  /** Who holds the lease while this runs, e.g. "netlify:ab12" or "local:host:123". */
  owner: string;
  /** How long the lease lasts past each symbol; a crashed sweeper frees it after this. */
  leaseMs: number;
  /** Most Finnhub calls this batch makes (the universe refresh counts as one). */
  maxCalls: number;
  /** Stop starting calls once this much time has passed. */
  budgetMs: number;
  /** Least time between two Finnhub calls (60000 / calls per minute). */
  intervalMs: number;
  /** On a 429 or a nearly spent minute: true waits for Finnhub's reset and goes on, false ends the batch. */
  waitOnLimit: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
};

export type SweepResult = {
  /** Set when another sweeper holds the lease; nothing was called. */
  heldBy?: { owner: string; until: string };
  calls: number;
  symbols: number;
  articles: number;
  rateLimited: number;
  errors: number;
  lastSymbol: string | null;
  universe: number;
  pruned: number;
  stoppedBy: "calls" | "budget" | "limit" | "signal" | "lease" | "auth" | "held";
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

type State = { universe: string[]; universe_at: Date | null; last_symbol: string | null; lease_owner: string | null; lease_until: Date | null };

async function acquire(pool: pg.Pool, owner: string, leaseMs: number): Promise<{ ok: true; state: State } | { ok: false; owner: string; until: Date }> {
  await pool.query(`insert into public.news_sweep_state (id) values (1) on conflict (id) do nothing`);
  const { rows } = await pool.query<State>(
    `update public.news_sweep_state
        set lease_owner = $1, lease_until = now() + make_interval(secs => $2::double precision / 1000), updated_at = now()
      where id = 1 and (lease_until is null or lease_until < now() or lease_owner = $1)
      returning universe, universe_at, last_symbol, lease_owner, lease_until`,
    [owner, leaseMs],
  );
  if (rows[0]) return { ok: true, state: rows[0] };
  const held = await pool.query<{ lease_owner: string; lease_until: Date }>(`select lease_owner, lease_until from public.news_sweep_state where id = 1`);
  return { ok: false, owner: held.rows[0]?.lease_owner ?? "unknown", until: held.rows[0]?.lease_until ?? new Date() };
}

/** Frees the lease if `owner` still holds it. */
export async function releaseLease(pool: pg.Pool, owner: string): Promise<void> {
  await pool.query(`update public.news_sweep_state set lease_until = now(), updated_at = now() where id = 1 and lease_owner = $1`, [owner]);
}

async function upsertArticles(pool: pg.Pool, symbol: string, articles: FinnhubArticle[], keepAfterMs: number): Promise<number> {
  const byId = new Map<number, FinnhubArticle>();
  for (const a of articles) {
    if (typeof a.id !== "number" || !a.headline || !a.url || typeof a.datetime !== "number") continue;
    if (a.datetime * 1000 < keepAfterMs) continue;
    byId.set(a.id, a);
  }
  if (!byId.size) return 0;
  const list = [...byId.values()];
  const related = (a: FinnhubArticle) =>
    [...new Set([symbol, ...(a.related ?? "").split(",").map((s) => s.trim().toUpperCase())].filter(Boolean))].join(",");
  const res = await pool.query(
    `insert into public.news_items as n (id, symbols, headline, summary, source, url, image, category, published_at, fetched_at)
     select t.id, string_to_array(t.rel, ','), t.headline, t.summary, t.source, t.url, t.image, t.category, to_timestamp(t.ts), now()
       from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::double precision[])
         as t(id, rel, headline, summary, source, url, image, category, ts)
     on conflict (id) do update set
       symbols = (select array_agg(distinct s order by s) from unnest(n.symbols || excluded.symbols) as s),
       headline = excluded.headline,
       summary = excluded.summary,
       image = excluded.image,
       fetched_at = now()`,
    [
      list.map((a) => a.id),
      list.map(related),
      list.map((a) => a.headline ?? ""),
      list.map((a) => a.summary ?? ""),
      list.map((a) => a.source ?? ""),
      list.map((a) => a.url ?? ""),
      list.map((a) => a.image ?? ""),
      list.map((a) => a.category ?? ""),
      list.map((a) => a.datetime ?? 0),
    ],
  );
  return res.rowCount ?? 0;
}

/**
 * One batch: takes the lease, prunes old rows, refreshes the universe when it
 * is a day old, then fetches symbols from the cursor on, paced at `intervalMs`
 * and never past Finnhub's minute (it keeps RESERVE calls free for other
 * users of the key). Leaves the lease held; call releaseLease when done.
 */
export async function sweepBatch(pool: pg.Pool, key: string, opts: SweepOptions): Promise<SweepResult> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const result: SweepResult = { calls: 0, symbols: 0, articles: 0, rateLimited: 0, errors: 0, lastSymbol: null, universe: 0, pruned: 0, stoppedBy: "calls" };

  const lease = await acquire(pool, opts.owner, opts.leaseMs);
  if (!lease.ok) return { ...result, heldBy: { owner: lease.owner, until: lease.until.toISOString() }, stoppedBy: "held" };
  const state = lease.state;
  result.lastSymbol = state.last_symbol;

  const pruned = await pool.query(`delete from public.news_items where published_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
  result.pruned = pruned.rowCount ?? 0;

  let nextCallAt = 0;
  /** Waits for the pace and for room in Finnhub's minute. False when the batch should end instead. */
  const ready = async (limit: Limit | null): Promise<boolean> => {
    if (limit && limit.remaining !== null && limit.remaining < RESERVE) {
      const waitMs = Math.max(1000, (limit.resetAt ?? Date.now() + 60_000) - Date.now() + 1000);
      if (!opts.waitOnLimit) {
        result.stoppedBy = "limit";
        return false;
      }
      log(`Finnhub minute nearly spent (${limit.remaining} left), waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs, opts.signal);
    }
    await sleep(nextCallAt - Date.now(), opts.signal);
    if (opts.signal?.aborted) {
      result.stoppedBy = "signal";
      return false;
    }
    if (result.calls >= opts.maxCalls) {
      result.stoppedBy = "calls";
      return false;
    }
    if (Date.now() - started >= opts.budgetMs) {
      result.stoppedBy = "budget";
      return false;
    }
    nextCallAt = Date.now() + opts.intervalMs;
    return true;
  };

  let universe = state.universe;
  let lastLimit: Limit | null = null;
  if (!universe.length || !state.universe_at || Date.now() - state.universe_at.getTime() > UNIVERSE_MAX_AGE_MS) {
    if (!(await ready(null))) return result;
    result.calls++;
    try {
      const fresh = await fetchUniverse(key);
      lastLimit = fresh.limit;
      if (fresh.symbols.length > 1000) {
        universe = fresh.symbols;
        await pool.query(`update public.news_sweep_state set universe = $1, universe_at = now(), updated_at = now() where id = 1`, [universe]);
        log(`Universe refreshed: ${universe.length} symbols`);
      }
    } catch (err) {
      result.errors++;
      log(`Universe refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof FinnhubError && (err.status === 401 || err.status === 403)) {
        result.stoppedBy = "auth";
        return result;
      }
    }
  }
  result.universe = universe.length;
  if (!universe.length) return result;

  // First symbol after the cursor (the list is sorted), wrapping to the start.
  let index = 0;
  if (state.last_symbol) {
    const after = universe.findIndex((s) => s > state.last_symbol!);
    index = after === -1 ? 0 : after;
  }

  while (await ready(lastLimit)) {
    const symbol = universe[index];
    const now = Date.now();
    const path = `/company-news?symbol=${encodeURIComponent(symbol)}&from=${isoDay(now - WINDOW_DAYS * 86_400_000)}&to=${isoDay(now)}`;
    result.calls++;
    try {
      const { body, limit } = await finnhub<FinnhubArticle[]>(path, key);
      lastLimit = limit;
      result.articles += await upsertArticles(pool, symbol, Array.isArray(body) ? body : [], now - KEEP_DAYS * 86_400_000);
    } catch (err) {
      if (err instanceof FinnhubError && err.status === 429) {
        // Retry the same symbol after Finnhub's reset (or end the batch).
        result.rateLimited++;
        lastLimit = { remaining: 0, resetAt: err.limit.resetAt ?? Date.now() + 60_000 };
        log(`429 on ${symbol}`);
        continue;
      }
      if (err instanceof FinnhubError && err.status === 401) {
        result.errors++;
        result.stoppedBy = "auth";
        log(`Finnhub refused the key (HTTP 401)`);
        break;
      }
      // Anything else (a bad symbol, a timeout, a 5xx): note it and move on.
      result.errors++;
      log(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const wrapped = index === universe.length - 1;
    const moved = await pool.query(
      `update public.news_sweep_state
          set last_symbol = $1, passes = passes + $2::int, lease_until = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
        where id = 1 and lease_owner = $4`,
      [symbol, wrapped ? 1 : 0, opts.leaseMs, opts.owner],
    );
    result.symbols++;
    result.lastSymbol = symbol;
    if (!moved.rowCount) {
      result.stoppedBy = "lease";
      log("Lease lost to another sweeper");
      break;
    }
    if (wrapped) log(`Finished a pass over ${universe.length} symbols`);
    index = wrapped ? 0 : index + 1;
  }
  return result;
}
