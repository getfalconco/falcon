/**
 * A minimal server-side Databento historical client for apps/web (the Desk's
 * on-demand `flow` tool). Ported from the engine's client
 * (packages/engine/src/options/client.ts) without its file ledger and disk
 * cache, which a Netlify function cannot keep: the spend ledger here is
 * Supabase public.options_spend (ledger.ts) and caching is the caller's.
 *
 *   - Auth: HTTP Basic, the key as user name and an empty password. The key
 *     comes from DATABENTO_API_KEY and is never logged or put in an error.
 *   - Every paid pull is priced first with the free `metadata.get_cost`.
 *   - get_range asks for JSON lines (`pretty_px`, `pretty_ts`, `map_symbols`),
 *     zstd-compressed when this Node can decompress it (22.15+), else plain.
 *     Any 2xx is a success: 206 Partial Content has a valid body (some symbols
 *     did not resolve). A body that fails to decode (a dropped download) is
 *     fetched again, up to BODY_ATTEMPTS.
 *   - 429 / 5xx / network errors are retried with a short backoff.
 *
 * Server-only.
 */

import crypto from "node:crypto";
import zlib from "node:zlib";

export const DATABENTO_BASE = "https://hist.databento.com/v0";
/** Attempts per HTTP call (retries on 429 / 5xx / network errors). */
export const CALL_ATTEMPTS = 3;
/** Attempts at downloading and decoding one get_range body. */
export const BODY_ATTEMPTS = 3;

type ZstdZlib = { zstdDecompressSync?: (b: Buffer) => Buffer };
const zstdDecompress = (zlib as unknown as ZstdZlib).zstdDecompressSync;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** One get_range request, as sent. */
export type RangeRequest = {
  dataset: string;
  schema: string;
  symbols: string[];
  /** ISO 8601 instant, inclusive. */
  start: string;
  /** ISO 8601 instant, exclusive. */
  end: string;
  stype_in?: "raw_symbol" | "parent" | "instrument_id" | "continuous";
};

export class DatabentoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DatabentoError";
  }
}

export function databentoKey(): string | null {
  const k = process.env.DATABENTO_API_KEY?.trim();
  return k ? k : null;
}

export function databentoConfigured(): boolean {
  return databentoKey() !== null;
}

/** Canonical key of a request (sorted symbols, times as UTC instants), as the engine's cost.ts requestKey. Pure. */
export function requestKey(req: RangeRequest): string {
  const t = (s: string) => {
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : s;
  };
  const canon = { dataset: req.dataset, schema: req.schema, symbols: [...req.symbols].sort(), start: t(req.start), end: t(req.end), stype_in: req.stype_in ?? "raw_symbol", limit: 0, v: 1 };
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 40);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const retryable = (status: number) => status === 429 || status >= 500;

function costParams(req: RangeRequest): Record<string, string> {
  return { dataset: req.dataset, schema: req.schema, symbols: req.symbols.join(","), start: req.start, end: req.end, stype_in: req.stype_in ?? "raw_symbol" };
}

/**
 * One HTTP call with retries. Any 2xx is returned (206 included); other
 * statuses throw DatabentoError with a short body excerpt (never the key).
 */
async function call(method: "GET" | "POST", endpoint: string, params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const key = databentoKey();
  if (!key) throw new DatabentoError(0, "DATABENTO_API_KEY is not set");
  const qs = new URLSearchParams(params).toString();
  const url = method === "GET" ? `${DATABENTO_BASE}/${endpoint}?${qs}` : `${DATABENTO_BASE}/${endpoint}`;
  const headers: Record<string, string> = { Authorization: "Basic " + Buffer.from(`${key}:`).toString("base64"), Accept: "application/json" };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  let last = "";
  for (let attempt = 0; attempt < CALL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(250 * 3 ** (attempt - 1), signal);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: method === "POST" ? qs : undefined, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      last = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.status >= 200 && res.status < 300) return res;
    const body = (await res.text().catch(() => "")).slice(0, 300);
    if (retryable(res.status) && attempt < CALL_ATTEMPTS - 1) {
      last = `HTTP ${res.status}: ${body}`;
      continue;
    }
    throw new DatabentoError(res.status, `Databento ${endpoint} HTTP ${res.status}: ${body}`);
  }
  throw new DatabentoError(0, `Databento ${endpoint} failed after ${CALL_ATTEMPTS} tries: ${last.slice(0, 300)}`);
}

/** Free: Databento's price in USD for a get_range request (POSTed when the symbol list would make the URL too long: HTTP 414). */
export async function getCost(req: RangeRequest, signal?: AbortSignal): Promise<number> {
  const params = costParams(req);
  const res = await call(params.symbols.length > 1_500 ? "POST" : "GET", "metadata.get_cost", params, signal);
  const v = JSON.parse(await res.text()) as unknown;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new DatabentoError(0, "get_cost: unexpected answer");
  return v;
}

/** Free: the last instant (ms) a schema of a dataset is available to. */
export async function getDatasetEnd(dataset: string, schema: string, signal?: AbortSignal): Promise<number | null> {
  return datasetEndOf(await getDatasetEnds(dataset, signal), schema);
}

export type DatasetEnds = { end: number | null; schemas: Record<string, number> };

/** Free: the dataset's available end (ms), overall and per schema, in one call. */
export async function getDatasetEnds(dataset: string, signal?: AbortSignal): Promise<DatasetEnds> {
  const res = await call("GET", "metadata.get_dataset_range", { dataset }, signal);
  const v = JSON.parse(await res.text()) as { end?: string; schema?: Record<string, { end?: string }> };
  const schemas: Record<string, number> = {};
  for (const [k, s] of Object.entries(v.schema ?? {})) {
    const ms = Date.parse(s?.end ?? "");
    if (Number.isFinite(ms)) schemas[k] = ms;
  }
  const end = Date.parse(v.end ?? "");
  return { end: Number.isFinite(end) ? end : null, schemas };
}

/** A schema's end from getDatasetEnds (the dataset's end when the schema has none). Pure. */
export function datasetEndOf(ends: DatasetEnds | null, schema: string): number | null {
  if (!ends) return null;
  return ends.schemas[schema] ?? ends.end;
}

export type RangeBody<T> = { records: T[]; partial: boolean; warning: string | null; bytes: number };

/**
 * Paid: get_range as JSON lines. Price it with getCost and record the spend
 * before calling this. Retries a body that fails to decode.
 */
export async function getRange<T = Record<string, unknown>>(req: RangeRequest, signal?: AbortSignal): Promise<RangeBody<T>> {
  const params = {
    ...costParams(req),
    stype_out: "instrument_id",
    encoding: "json",
    compression: zstdDecompress ? "zstd" : "none",
    pretty_px: "true",
    pretty_ts: "true",
    map_symbols: "true",
  };
  let last: unknown = null;
  for (let attempt = 0; attempt < BODY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(300 * attempt, signal);
    // `call` already retried status codes; a DatabentoError here is final.
    const res = await call("POST", "timeseries.get_range", params, signal);
    try {
      const body = Buffer.from(await res.arrayBuffer());
      const records = decodeRecords<T>(body);
      return { records, partial: res.status === 206, warning: res.headers.get("x-warning"), bytes: body.length };
    } catch (err) {
      if (signal?.aborted) throw err;
      last = err;
    }
  }
  throw new DatabentoError(0, `get_range body unreadable after ${BODY_ATTEMPTS} tries: ${last instanceof Error ? last.message.slice(0, 200) : String(last)}`);
}

/** JSON lines, zstd-compressed (detected by its magic bytes) or plain. */
export function decodeRecords<T>(body: Buffer): T[] {
  let raw = body;
  if (body.length >= 4 && ZSTD_MAGIC.every((b, i) => body[i] === b)) {
    if (!zstdDecompress) throw new Error("zstd body but this Node cannot decompress it");
    raw = zstdDecompress(body);
  }
  const out: T[] = [];
  const text = raw.toString("utf8");
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    if (line) out.push(JSON.parse(line) as T);
    start = end + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ record fields */

/** Number from a JSON value (decimal string or number); null for null / empty / NaN. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Milliseconds since epoch from an ISO string or a nanosecond integer (string). */
export function tsMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && /^\d{10,}$/.test(v)) {
    if (v === "18446744073709551615") return null;
    return Number(BigInt(v) / BigInt(1_000_000));
  }
  if (typeof v === "number") return v > 1e15 ? Math.floor(v / 1e6) : v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

export type Trade = { tsMs: number; price: number; size: number; side: "B" | "A" | "N" };

/**
 * Trades (engine client.ts parseTrades). Databento `side` on a trade is the
 * aggressor: B = the buyer lifted the offer, A = the seller hit the bid,
 * N = no side (opening/closing crosses, some non-displayed executions).
 */
export function parseTrades(records: ReadonlyArray<Record<string, unknown>>): Trade[] {
  const out: Trade[] = [];
  for (const r of records) {
    const hd = (r.hd as Record<string, unknown> | undefined) ?? r;
    const p = num(r.price);
    const s = num(r.size);
    const t = tsMs(r.ts_recv) ?? tsMs(hd.ts_event);
    if (p === null || s === null || t === null) continue;
    out.push({ tsMs: t, price: p, size: s, side: r.side === "B" || r.side === "A" ? r.side : "N" });
  }
  return out;
}

/** One option quote (engine client.ts Quote): the top of book of a cbbo-1m record. */
export type Quote = { instrumentId: number; tsMs: number; bid: number | null; ask: number | null; bidSize: number; askSize: number };

/** One quote from a cbbo-1m / bbo-1m / mbp-1 record (`levels[0]`); null if unreadable (engine quoteOf). */
export function quoteOf(r: Record<string, unknown>): Quote | null {
  const lv = (Array.isArray(r.levels) ? r.levels[0] : r) as Record<string, unknown> | undefined;
  if (!lv) return null;
  const hd = (r.hd as Record<string, unknown> | undefined) ?? r;
  const t = tsMs(r.ts_recv) ?? tsMs(hd.ts_event);
  if (t === null) return null;
  return { instrumentId: Number(hd.instrument_id), tsMs: t, bid: num(lv.bid_px), ask: num(lv.ask_px), bidSize: num(lv.bid_sz) ?? 0, askSize: num(lv.ask_sz) ?? 0 };
}

/**
 * Each contract's quote at an instant (engine quotesAt): the latest at or
 * before it, else the first after it. Pure.
 */
export function quotesAt(records: ReadonlyArray<Record<string, unknown>>, atMs: number): Map<number, Quote> {
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
  after.forEach((q, id) => {
    if (!before.has(id)) before.set(id, q);
  });
  return before;
}
