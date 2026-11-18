/**
 * Databento historical HTTP client. Every paid pull goes through
 * `DatabentoClient.getRange`, which prices it with `metadata.get_cost`,
 * checks and records it in the shared ledger (`SpendGuard`, cost.ts), and
 * caches the response on disk so nothing is paid twice. Metadata and
 * symbology calls are free and are not recorded.
 *
 * Auth is HTTP Basic with the key as the user name and an empty password.
 * The key comes from `env("DATABENTO_API_KEY")` and is never logged, printed
 * or put in an error message.
 *
 * Responses are requested as JSON lines (`encoding=json`, `pretty_px`,
 * `pretty_ts`, `map_symbols`) compressed with zstd, and stored compressed.
 * Typed parsers for the records the options and flow code reads are below.
 */

import zlib from "node:zlib";
import { env } from "../env.ts";
import { nyInstantMs } from "../study/abnormal.ts";
import { backoffMs, retryableStatus } from "../http.ts";
import { BudgetError, SpendGuard, requestKey, type GuardOptions, type RangeRequest, type SpendCap, type SpendEntry } from "./cost.ts";

export const DATABENTO_BASE = "https://hist.databento.com/v0";

export type HttpResponseLike = {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
};
export type HttpFn = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<HttpResponseLike>;

const defaultHttp: HttpFn = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(300_000) });

type ZstdZlib = { zstdDecompressSync?: (b: Buffer) => Buffer };
const zstdDecompress = (zlib as unknown as ZstdZlib).zstdDecompressSync;

export class DatabentoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DatabentoError";
  }
}

export type PullOptions = {
  /** Name recorded in the ledger (e.g. "options-h4-skew"). */
  caller: string;
  /** Refuse a pull priced above this. */
  maxCallUsd: number;
  /** Refuse when this caller's ledger total would pass this. */
  maxCallerUsd?: number;
  /** Extra caps checked under the ledger lock (cost.ts SpendCap), e.g. a monthly cap over several callers. */
  caps?: readonly SpendCap[];
  /** Only price the request: no ledger line, no data. Cached requests still return their data. */
  dryRun?: boolean;
  /** HTTP attempts for the get_range call (default 4: retries on 429 / 5xx / network errors). */
  attempts?: number;
  /** The caller's own get_cost answer for this exact request (it priced it already): not asked again. */
  pricedUsd?: number;
};

export type RangeResult<T = Record<string, unknown>> = {
  records: T[];
  /** What this call added to the ledger (0 for a cache hit or a dry run). */
  costUsd: number;
  /** The get_cost estimate (also for a dry run); 0 for a cache hit. */
  pricedUsd: number;
  cached: boolean;
  dryRun: boolean;
  key: string;
  /**
   * True when Databento answered 206 Partial Content: the body is valid but
   * some symbols did not resolve for the range (`warning` says which, when
   * Databento sent its X-Warning header). Cached like a full answer.
   */
  partial?: boolean;
  warning?: string;
};

/** Attempts at downloading and decoding a get_range body after it was paid for (one ledger line for all of them). */
export const BODY_ATTEMPTS = 4;

export type ClientOptions = GuardOptions & {
  http?: HttpFn;
  /** Overrides env DATABENTO_API_KEY (tests). */
  apiKey?: string;
  guard?: SpendGuard;
  sleep?: (ms: number) => Promise<void>;
};

export class DatabentoClient {
  readonly guard: SpendGuard;
  private http: HttpFn;
  private apiKey: string | undefined;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions = {}) {
    this.guard = opts.guard ?? new SpendGuard(opts);
    this.http = opts.http ?? defaultHttp;
    this.apiKey = opts.apiKey;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private auth(): string {
    const key = this.apiKey ?? env("DATABENTO_API_KEY");
    if (!key) throw new Error("DATABENTO_API_KEY is not set (process env or apps/web/.env.local)");
    return "Basic " + Buffer.from(`${key}:`).toString("base64");
  }

  /**
   * One HTTP call with retries on 429 / 5xx / network errors. Any 2xx is a
   * success: Databento answers 206 Partial Content, with a valid body, when
   * some symbols do not resolve for the range. Never echoes the key.
   */
  private async call(method: "GET" | "POST", endpoint: string, params: Record<string, string>, attempts = 4): Promise<HttpResponseLike> {
    const qs = new URLSearchParams(params).toString();
    const url = method === "GET" ? `${DATABENTO_BASE}/${endpoint}?${qs}` : `${DATABENTO_BASE}/${endpoint}`;
    const headers: Record<string, string> = { Authorization: this.auth(), Accept: "application/json" };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    let last: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await this.sleep(backoffMs(attempt - 1, last instanceof RetryAfter ? last.retryAfter : null));
      try {
        const res = await this.http(url, { method, headers, body: method === "POST" ? qs : undefined });
        if (res.status >= 200 && res.status < 300) return res;
        const body = (await res.text()).slice(0, 600);
        if (retryableStatus(res.status) && attempt < attempts - 1) {
          last = new RetryAfter(res.headers.get("retry-after"), res.status, body);
          continue;
        }
        throw new DatabentoError(res.status, `Databento ${endpoint} HTTP ${res.status}: ${body}`);
      } catch (err) {
        if (err instanceof DatabentoError) throw err;
        last = err;
      }
    }
    const why = last instanceof RetryAfter ? `HTTP ${last.status}: ${last.body}` : last instanceof Error ? last.message : String(last);
    throw new DatabentoError(0, `Databento ${endpoint} failed after ${attempts} tr${attempts === 1 ? "y" : "ies"}: ${why}`);
  }

  private async metadata<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    // Long symbol lists (OSI symbols by the hundred) pass the gateway's URL limit (HTTP 414): POST them, as apps/web does.
    const res = await this.call((params.symbols?.length ?? 0) > 1_500 ? "POST" : "GET", endpoint, params);
    return JSON.parse(await res.text()) as T;
  }

  /** Free: Databento's price estimate in USD for a get_range request. */
  async getCost(req: RangeRequest): Promise<number> {
    const v = await this.metadata<number>("metadata.get_cost", costParams(req));
    if (typeof v !== "number" || !Number.isFinite(v)) throw new DatabentoError(0, "get_cost: unexpected answer");
    return v;
  }

  /** Free: record count estimate for a get_range request. */
  getRecordCount(req: RangeRequest): Promise<number> {
    return this.metadata<number>("metadata.get_record_count", costParams(req));
  }

  /** Free: {start, end, schema: {name: {start, end}}}. */
  getDatasetRange(dataset: string): Promise<{ start: string; end: string; schema: Record<string, { start: string; end: string }> }> {
    return this.metadata("metadata.get_dataset_range", { dataset });
  }

  listSchemas(dataset: string): Promise<string[]> {
    return this.metadata("metadata.list_schemas", { dataset });
  }

  /** Free: symbology.resolve (raw result object). */
  async resolve(args: { dataset: string; symbols: string[]; stype_in: string; stype_out: string; start_date: string; end_date?: string }): Promise<unknown> {
    const params: Record<string, string> = {
      dataset: args.dataset,
      symbols: args.symbols.join(","),
      stype_in: args.stype_in,
      stype_out: args.stype_out,
      start_date: args.start_date,
    };
    if (args.end_date) params.end_date = args.end_date;
    const res = await this.call("POST", "symbology.resolve", params);
    return JSON.parse(await res.text());
  }

  /**
   * The only way to pull paid data. Order: cache, price, (dry run stops
   * here), budget check + ledger line under the lock, pull, cache write.
   * A pull that fails after the ledger line gets a refund line.
   */
  async getRange<T = Record<string, unknown>>(req: RangeRequest, opts: PullOptions): Promise<RangeResult<T>> {
    if (req.symbols.length === 0) throw new Error("getRange: no symbols");
    if (req.symbols.length > 2000) throw new Error("getRange: at most 2000 symbols a request");
    const key = requestKey(req);
    const hit = this.guard.readCache(key);
    if (hit) return { records: decodeRecords<T>(hit.body, hit.ext), costUsd: 0, pricedUsd: 0, cached: true, dryRun: false, key };

    const priced = typeof opts.pricedUsd === "number" && Number.isFinite(opts.pricedUsd) && opts.pricedUsd >= 0 ? opts.pricedUsd : await this.getCost(req);
    if (opts.dryRun) return { records: [], costUsd: 0, pricedUsd: priced, cached: false, dryRun: true, key };

    // One ledger line per pull, however many download attempts it takes.
    const { entry } = await this.guard.authorize({
      req,
      costUsd: priced,
      caller: opts.caller,
      maxCallUsd: opts.maxCallUsd,
      maxCallerUsd: opts.maxCallerUsd,
      caps: opts.caps,
    });
    const ext = zstdDecompress ? "json.zst" : "json.gz";
    let got: { body: Buffer; records: T[]; partial: boolean; warning: string | null } | null = null;
    let last: unknown = null;
    for (let attempt = 0; attempt < BODY_ATTEMPTS && !got; attempt++) {
      if (attempt > 0) await this.sleep(backoffMs(attempt - 1));
      try {
        // `call` already retried the status codes; a DatabentoError here is final.
        const res = await this.call("POST", "timeseries.get_range", rangeParams(req, zstdDecompress ? "zstd" : "none"), opts.attempts ?? 4);
        let body = Buffer.from(await res.arrayBuffer());
        if (!zstdDecompress) body = zlib.gzipSync(body);
        // A truncated body fails to decode: retried like a dropped download.
        const records = decodeRecords<T>(body, ext);
        got = { body, records, partial: res.status === 206, warning: res.headers.get("x-warning") };
      } catch (err) {
        last = err;
        if (err instanceof DatabentoError) break;
      }
    }
    if (!got) {
      await this.refundQuietly(entry, last);
      throw last instanceof Error ? last : new DatabentoError(0, String(last));
    }
    const { body, records, partial, warning } = got;
    // A partial answer is cached too (it was paid for); its meta says so.
    this.guard.writeCache(key, ext, body, { req, at: entry.at, costUsd: priced, caller: opts.caller, records: records.length, ...(partial ? { partial, warning } : {}) });
    const out: RangeResult<T> = { records, costUsd: priced, pricedUsd: priced, cached: false, dryRun: false, key };
    if (partial) {
      out.partial = true;
      if (warning) out.warning = warning.slice(0, 300);
    }
    return out;
  }

  private async refundQuietly(entry: SpendEntry, err: unknown): Promise<void> {
    try {
      await this.guard.refund(entry, `pull failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    } catch {
      // the charge line stays: overstating spend is the safe failure
    }
  }
}

class RetryAfter {
  constructor(
    readonly retryAfter: string | null,
    readonly status: number,
    readonly body: string,
  ) {}
}

export { BudgetError };

function costParams(req: RangeRequest): Record<string, string> {
  const p: Record<string, string> = {
    dataset: req.dataset,
    schema: req.schema,
    symbols: req.symbols.join(","),
    start: req.start,
    end: req.end,
    stype_in: req.stype_in ?? "raw_symbol",
  };
  if (req.limit) p.limit = String(req.limit);
  return p;
}

function rangeParams(req: RangeRequest, compression: "zstd" | "none"): Record<string, string> {
  return {
    ...costParams(req),
    stype_out: "instrument_id",
    encoding: "json",
    compression,
    pretty_px: "true",
    pretty_ts: "true",
    map_symbols: "true",
  };
}

/** JSON lines (zstd or gzip compressed) to records. */
export function decodeRecords<T>(body: Buffer, ext: string): T[] {
  let raw: Buffer;
  if (ext === "json.zst") {
    if (!zstdDecompress) throw new Error("this Node has no zstd; delete the cached .zst file or upgrade Node");
    raw = body.length ? zstdDecompress(body) : body;
  } else if (ext === "json.gz") raw = zlib.gunzipSync(body);
  else raw = body;
  return parseJsonLines<T>(raw.toString("utf8"));
}

/** Pure. */
export function parseJsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (s) out.push(JSON.parse(s) as T);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed records (pretty_px / pretty_ts JSON). Parsers are pure and lenient:
// prices may arrive as decimal strings or numbers, times as ISO strings or
// nanosecond integers (strings).

type Raw = Record<string, unknown> & { hd?: Record<string, unknown> };

/** Number from a JSON value (decimal string or number); null for null / empty / NaN (pretty_px sends undefined prices as null). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Milliseconds since epoch from an ISO string or a nanosecond integer. */
export function tsMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && /^\d{10,}$/.test(v)) {
    if (v === "18446744073709551615") return null; // UNDEF_TIMESTAMP
    return Number(BigInt(v) / 1_000_000n);
  }
  if (typeof v === "number") return v > 1e15 ? Math.floor(v / 1e6) : v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function hd(r: Raw): Record<string, unknown> {
  return (r.hd as Record<string, unknown> | undefined) ?? r;
}

export function instrumentIdOf(r: Raw): number {
  return Number(hd(r).instrument_id);
}

export type OptionDefinition = {
  instrumentId: number;
  rawSymbol: string;
  underlying: string;
  right: "C" | "P";
  strike: number;
  /** Expiration instant (ms). */
  expirationMs: number;
  /** Expiration date (UTC calendar date of the instant; OPRA uses the expiry date's close). */
  expiration: string;
  multiplier: number;
};

/**
 * Definitions, one per instrument id (the latest record wins when several
 * publishers send one). Records that are not calls or puts, or lack a strike
 * or an expiry, are dropped.
 */
export function parseDefinitions(records: readonly Raw[]): OptionDefinition[] {
  const best = new Map<number, { ts: number; d: OptionDefinition }>();
  for (const r of records) {
    const cls = String(r.instrument_class ?? "");
    if (cls !== "C" && cls !== "P") continue;
    const strike = num(r.strike_price);
    const exp = tsMs(r.expiration);
    const id = instrumentIdOf(r);
    if (strike === null || exp === null || !Number.isFinite(id)) continue;
    // OPRA leaves both multiplier fields undefined (null / INT32_MAX): standard 100-share contracts.
    const m1 = num(r.unit_of_measure_qty);
    const m2 = num(r.contract_multiplier);
    const mult = [m1, m2].find((m) => m !== null && m > 0 && m < 1_000_000) ?? 100;
    const d: OptionDefinition = {
      instrumentId: id,
      rawSymbol: String(r.raw_symbol ?? r.symbol ?? ""),
      underlying: String(r.underlying ?? r.asset ?? ""),
      right: cls,
      strike,
      expirationMs: exp,
      expiration: new Date(exp).toISOString().slice(0, 10),
      multiplier: mult,
    };
    const ts = tsMs(r.ts_recv) ?? tsMs(hd(r).ts_event) ?? 0;
    const prev = best.get(id);
    if (!prev || ts >= prev.ts) best.set(id, { ts, d });
  }
  return [...best.values()].map((x) => x.d);
}

/** Databento StatType values used here. */
export const STAT_TYPE = { openingPrice: 1, lowPrice: 4, highPrice: 5, clearedVolume: 6, openInterest: 9, closePrice: 11 } as const;

/**
 * Open interest per instrument from statistics records (stat_type 9,
 * `quantity`). OPRA sends one per instrument from several publishers; the
 * latest record wins. `disagreements` counts instruments whose publishers
 * reported different values.
 */
export function parseOpenInterest(records: readonly Raw[]): { oi: Map<number, number>; disagreements: number } {
  const best = new Map<number, { ts: number; q: number; vals: Set<number> }>();
  for (const r of records) {
    if (Number(r.stat_type) !== STAT_TYPE.openInterest) continue;
    const q = num(r.quantity);
    if (q === null || q < 0 || q > 2_000_000_000) continue;
    const id = instrumentIdOf(r);
    const ts = tsMs(r.ts_recv) ?? tsMs(hd(r).ts_event) ?? 0;
    const prev = best.get(id);
    if (!prev) best.set(id, { ts, q, vals: new Set([q]) });
    else {
      prev.vals.add(q);
      if (ts >= prev.ts) {
        prev.ts = ts;
        prev.q = q;
      }
    }
  }
  const oi = new Map<number, number>();
  let disagreements = 0;
  for (const [id, b] of best) {
    oi.set(id, b.q);
    if (b.vals.size > 1) disagreements++;
  }
  return { oi, disagreements };
}

export type Bar = { instrumentId: number; symbol: string; tsMs: number; open: number; high: number; low: number; close: number; volume: number };

export function parseOhlcv(records: readonly Raw[]): Bar[] {
  const out: Bar[] = [];
  for (const r of records) {
    const o = num(r.open), h = num(r.high), l = num(r.low), c = num(r.close), v = num(r.volume);
    const t = tsMs(hd(r).ts_event);
    if (o === null || h === null || l === null || c === null || v === null || t === null) continue;
    out.push({ instrumentId: instrumentIdOf(r), symbol: String(r.symbol ?? ""), tsMs: t, open: o, high: h, low: l, close: c, volume: v });
  }
  return out;
}

/** Total volume per instrument id (summed if an instrument has several bars). */
export function volumeByInstrument(bars: readonly Bar[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of bars) m.set(b.instrumentId, (m.get(b.instrumentId) ?? 0) + b.volume);
  return m;
}

export type Quote = { instrumentId: number; tsMs: number; bid: number | null; ask: number | null; bidSize: number; askSize: number };

/** One quote from a cbbo-1m / bbo-1m / mbp-1 record (`levels[0]`); null if unreadable. */
export function quoteOf(r: Raw): Quote | null {
  const lv = (Array.isArray(r.levels) ? r.levels[0] : r) as Record<string, unknown> | undefined;
  if (!lv) return null;
  const t = tsMs(r.ts_recv) ?? tsMs(hd(r).ts_event);
  if (t === null) return null;
  return {
    instrumentId: instrumentIdOf(r),
    tsMs: t,
    bid: num(lv.bid_px),
    ask: num(lv.ask_px),
    bidSize: num(lv.bid_sz) ?? 0,
    askSize: num(lv.ask_sz) ?? 0,
  };
}

/**
 * The quote in force at `atMs` per instrument: the latest record at or
 * before it; when an instrument has none before, the earliest after it (its
 * `tsMs` shows that; the surface flags quotes away from the snapshot time).
 */
export function quotesAt(records: readonly Raw[], atMs: number): Map<number, Quote> {
  const before = new Map<number, Quote>();
  const after = new Map<number, Quote>();
  for (const r of records) {
    const q = quoteOf(r);
    if (!q) continue;
    if (q.tsMs <= atMs) {
      const p = before.get(q.instrumentId);
      if (!p || q.tsMs >= p.tsMs) before.set(q.instrumentId, q);
    } else {
      const p = after.get(q.instrumentId);
      if (!p || q.tsMs < p.tsMs) after.set(q.instrumentId, q);
    }
  }
  for (const [id, q] of after) if (!before.has(id)) before.set(id, q);
  return before;
}

export type Trade = { tsMs: number; price: number; size: number; side: "B" | "A" | "N"; publisherId: number };

/**
 * Trades. Databento `side`: B = the aggressor was a buyer, A = the
 * aggressor was a seller, N = no side (auctions, off-exchange prints,
 * trades against hidden orders).
 */
export function parseTrades(records: readonly Raw[]): Trade[] {
  const out: Trade[] = [];
  for (const r of records) {
    const p = num(r.price), s = num(r.size), t = tsMs(r.ts_recv) ?? tsMs(hd(r).ts_event);
    if (p === null || s === null || t === null) continue;
    const side = r.side === "B" || r.side === "A" ? r.side : "N";
    out.push({ tsMs: t, price: p, size: s, side, publisherId: Number(hd(r).publisher_id ?? 0) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Day-level fetchers (each pull goes through getRange and its guard)

function nyIso(date: string, minutes: number): string {
  return new Date(nyInstantMs(date, minutes)).toISOString();
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export type PullLog = { schema: string; dataset: string; records: number; costUsd: number; pricedUsd: number; cached: boolean; dryRun: boolean };

export type OptionDay = {
  date: string;
  /** Snapshot instant used for quotes. */
  asOfMs: number;
  definitions: OptionDefinition[];
  quotes: Map<number, Quote>;
  openInterest: Map<number, number> | null;
  oiDisagreements: number;
  volume: Map<number, number> | null;
  pulls: PullLog[];
  /** Sum of this call's ledger charges (0 when all cached). */
  costUsd: number;
  /** Sum of get_cost estimates (what a dry run would cost). */
  pricedUsd: number;
};

export type OptionDayRequest = {
  /** Parent symbols, e.g. ["KLAC.OPT"]. Several parents in one request cost the same as separately. */
  parents: string[];
  /** New York session date. */
  date: string;
  /** Snapshot time, New York minutes after midnight (default 15:45 = 945). Use 12:45 on early-close days. */
  snapshotMin?: number;
  /** Minutes of cbbo-1m before the snapshot to look back for each contract's last quote (default 5). */
  lookbackMin?: number;
  /** Which paid parts to pull (definitions always). Defaults: quotes, openInterest and volume all true. */
  quotes?: boolean;
  openInterest?: boolean;
  volume?: boolean;
  pull: PullOptions;
};

/**
 * One underlying-day (or several underlyings at once) of OPRA data:
 * definitions (definition, whole day), open interest (statistics from
 * 00:00 UTC to the open, where OPRA publishes it, ~06:30 ET), daily volume
 * (ohlcv-1d, summed over the exchanges), and the quote snapshot (cbbo-1m in
 * [snapshot - lookback, snapshot + 1 min), last record at or before the
 * snapshot). Request ohlcv-1d one day at a time: a multi-day ohlcv-1d price
 * for a parent comes back hundreds of times higher.
 */
export async function fetchOptionDay(client: DatabentoClient, req: OptionDayRequest): Promise<OptionDay> {
  const { parents, date } = req;
  const snap = req.snapshotMin ?? 15 * 60 + 45;
  const look = req.lookbackMin ?? 5;
  const base = { dataset: "OPRA.PILLAR", symbols: parents, stype_in: "parent" as const };
  const pulls: PullLog[] = [];
  const run = async (schema: string, start: string, end: string) => {
    const res = await client.getRange<Raw>({ ...base, schema, start, end }, req.pull);
    pulls.push({ schema, dataset: base.dataset, records: res.records.length, costUsd: res.costUsd, pricedUsd: res.pricedUsd, cached: res.cached, dryRun: res.dryRun });
    return res.records;
  };
  const defs = parseDefinitions(await run("definition", date, nextDay(date)));
  const asOfMs = nyInstantMs(date, snap);
  let quotes = new Map<number, Quote>();
  if (req.quotes !== false) quotes = quotesAt(await run("cbbo-1m", nyIso(date, snap - look), nyIso(date, snap + 1)), asOfMs);
  let openInterest: Map<number, number> | null = null;
  let oiDisagreements = 0;
  if (req.openInterest !== false) {
    const r = parseOpenInterest(await run("statistics", `${date}T00:00:00Z`, nyIso(date, 9 * 60 + 30)));
    openInterest = r.oi;
    oiDisagreements = r.disagreements;
  }
  let volume: Map<number, number> | null = null;
  if (req.volume !== false) volume = volumeByInstrument(parseOhlcv(await run("ohlcv-1d", date, nextDay(date))));
  return {
    date,
    asOfMs,
    definitions: defs,
    quotes,
    openInterest,
    oiDisagreements,
    volume,
    pulls,
    costUsd: pulls.reduce((s, p) => s + p.costUsd, 0),
    pricedUsd: pulls.reduce((s, p) => s + p.pricedUsd, 0),
  };
}

/** Consolidated daily bars (EQUS.SUMMARY ohlcv-1d, from 2024-07; XNAS.ITCH before that is Nasdaq-only volume). Keyed by symbol, then date. */
export async function fetchStockDaily(
  client: DatabentoClient,
  args: { symbols: string[]; start: string; end: string; dataset?: string; pull: PullOptions },
): Promise<Map<string, Map<string, Bar>>> {
  const res = await client.getRange<Raw>({ dataset: args.dataset ?? "EQUS.SUMMARY", schema: "ohlcv-1d", symbols: args.symbols, start: args.start, end: args.end }, args.pull);
  const out = new Map<string, Map<string, Bar>>();
  for (const b of parseOhlcv(res.records)) {
    const date = new Date(b.tsMs).toISOString().slice(0, 10);
    if (!out.has(b.symbol)) out.set(b.symbol, new Map());
    out.get(b.symbol)!.set(date, b);
  }
  return out;
}

/** Last trade price before the snapshot: close of the XNAS.ITCH ohlcv-1m bar for the minute ending at the snapshot. Keyed by symbol. */
export async function fetchStockSpot(
  client: DatabentoClient,
  args: { symbols: string[]; date: string; snapshotMin?: number; dataset?: string; pull: PullOptions },
): Promise<Map<string, number>> {
  const snap = args.snapshotMin ?? 15 * 60 + 45;
  const res = await client.getRange<Raw>(
    { dataset: args.dataset ?? "XNAS.ITCH", schema: "ohlcv-1m", symbols: args.symbols, start: nyIso(args.date, snap - 10), end: nyIso(args.date, snap) },
    args.pull,
  );
  const last = new Map<string, Bar>();
  for (const b of parseOhlcv(res.records)) {
    const p = last.get(b.symbol);
    if (!p || b.tsMs > p.tsMs) last.set(b.symbol, b);
  }
  return new Map([...last].map(([s, b]) => [s, b.close]));
}

/** Trades with aggressor side for one New York date (04:00 to 20:00 ET; XNAS.ITCH by default). Keyed by symbol. */
export async function fetchStockTrades(
  client: DatabentoClient,
  args: { symbols: string[]; date: string; dataset?: string; regularOnly?: boolean; pull: PullOptions },
): Promise<Map<string, Trade[]>> {
  const [from, to] = args.regularOnly ? [9 * 60 + 30, 16 * 60 + 10] : [4 * 60, 20 * 60];
  const res = await client.getRange<Raw>(
    { dataset: args.dataset ?? "XNAS.ITCH", schema: "trades", symbols: args.symbols, start: nyIso(args.date, from), end: nyIso(args.date, to) },
    args.pull,
  );
  const out = new Map<string, Trade[]>();
  const bySymbol = new Map<string, Raw[]>();
  for (const r of res.records) {
    const s = String(r.symbol ?? "");
    if (!bySymbol.has(s)) bySymbol.set(s, []);
    bySymbol.get(s)!.push(r);
  }
  for (const [s, rs] of bySymbol) out.set(s, parseTrades(rs));
  return out;
}
