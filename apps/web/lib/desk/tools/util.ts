/**
 * Shared helpers for the Desk's data tools: ticker checks, a small in-memory
 * TTL cache (nothing on disk, so it works inside a Netlify function), number
 * rounding, New York dates, and a size cap so every result stays small enough
 * for the model's context. Server-only. Pure apart from the cache.
 */

export type DeskToolContext = {
  /** Aborts every request of the call (the chat request was cancelled, or the route's deadline passed). */
  signal?: AbortSignal;
  /** Per-tool time budget in ms (default DEFAULT_TOOL_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
};

/** A tool's typical budget; each tool aims for well under it. */
export const DEFAULT_TOOL_TIMEOUT_MS = 9_000;

/** The error a tool returns to the model instead of throwing. */
export class ToolError extends Error {}

/** How far a long download has come (points loaded of the total), for the member's tool row. */
export type ToolProgress = { loaded: number; total: number };

/**
 * A tool whose work is still running past its budget (an on-demand options history pull). The message is for the
 * model only (what to do when the reply cannot wait); the route waits on it in the next request instead, and the
 * member sees a row still loading, never this text.
 */
export class ToolPending extends ToolError {
  constructor(
    message: string,
    readonly progress: ToolProgress,
  ) {
    super(message);
    this.name = "ToolPending";
  }
}

/** A short, user-facing reason the model can read and repeat. */
export type ToolFailure = { error: string };

/* ------------------------------------------------------------------ tickers */

/**
 * A US ticker in the form Yahoo and SEC's company_tickers.json both use:
 * upper case, class shares with a dash ("BRK.B", "brk/b", "$BRK-B" -> "BRK-B").
 * Throws ToolError for anything else.
 */
export function normalizeTicker(input: unknown): string {
  if (typeof input !== "string") throw new ToolError("ticker is required (a US stock symbol such as AAPL).");
  const t = input.trim().toUpperCase().replace(/^\$/, "").replace(/[./]/g, "-");
  if (!/^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(t)) throw new ToolError(`"${String(input).slice(0, 20)}" is not a US stock ticker. Use the symbol, e.g. AAPL or BRK.B.`);
  return t;
}

/* ------------------------------------------------------------------ numbers */

/** Rounds to `digits` decimals; null for anything not finite. */
export function round(x: number | null | undefined, digits = 2): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Percent from a ratio (0.0391 -> 3.91). */
export function pct(ratio: number | null | undefined, digits = 2): number | null {
  return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? null : round(ratio * 100, digits);
}

/** A finite number from a value or Yahoo's { raw } wrapper, else null. */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const r = (v as { raw?: unknown }).raw;
    if (typeof r === "number" && Number.isFinite(r)) return r;
  }
  return null;
}

/** Up to `max` items evenly spread over `items`, first and last always kept. */
export function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items.slice();
  if (max < 2) return items.slice(-1);
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]!);
  return out;
}

/* ------------------------------------------------------------------ dates */

const NY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** New York calendar date and minutes past midnight of an instant. */
export function nyParts(ms: number): { date: string; minutes: number; time: string } {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  const m = Number(p.minute);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: h * 60 + m, time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
}

/** "2026-11-13 16:00 ET" for an instant. */
export function nyStamp(ms: number): string {
  const p = nyParts(ms);
  return `${p.date} ${p.time} ET`;
}

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Weekdays from a to b (a weekday count; NYSE holidays are not skipped). */
export function weekdayIndex(ymd: string): number {
  const day = Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 86_400_000);
  // 1970-01-01 was a Thursday (weekday 4 when Monday = 0).
  const weeks = Math.floor((day + 3) / 7);
  const dow = (day + 3) % 7; // 0 Monday .. 6 Sunday
  return weeks * 5 + Math.min(dow, 4);
}

/* ------------------------------------------------------------------ cache */

/** A small TTL + LRU cache in memory (per server instance). */
export class TtlCache<T> {
  private map = new Map<string, { at: number; value: T }>();
  constructor(
    private ttlMs: number,
    private max = 200,
  ) {}

  get(key: string, now = Date.now()): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Caches a promise per key: concurrent callers share one fetch; failures are not kept. */
export async function cached<T>(cache: TtlCache<Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = load();
  cache.set(key, p);
  p.catch(() => {
    if (cache.get(key) === p) cache.delete(key);
  });
  return p;
}

/* ------------------------------------------------------------------ size */

/** About 4k tokens of JSON. */
export const MAX_RESULT_CHARS = 12_000;

/**
 * The result as JSON of at most `max` characters: while it is too long, the
 * longest array anywhere in it loses its last quarter (at least one item) and
 * the result says so in `truncated`. Strings over 4,000 characters are cut
 * first. Arrays of numbers (a price series) are thinned evenly instead.
 */
export function fitResult(value: unknown, max = MAX_RESULT_CHARS): string {
  let json = JSON.stringify(value);
  if (json.length <= max) return json;
  const copy = JSON.parse(json) as unknown;
  const notes: string[] = [];
  const clipStrings = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > 4_000 ? `${v.slice(0, 4_000)} [cut]` : v;
    if (Array.isArray(v)) return v.map(clipStrings);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipStrings(x)]));
    return v;
  };
  let root = clipStrings(copy);
  json = JSON.stringify(root);
  for (let guard = 0; json.length > max && guard < 200; guard++) {
    let best: { arr: unknown[]; path: string; size: number } | null = null;
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) {
        const size = JSON.stringify(v).length;
        if (v.length > 1 && (!best || size > best.size)) best = { arr: v, path, size };
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(root, "");
    if (!best) break;
    const b = best as { arr: unknown[]; path: string };
    const keep = Math.max(1, Math.floor(b.arr.length * 0.75));
    const numeric = b.arr.every((x) => typeof x === "number" || (Array.isArray(x) && x.length <= 3));
    const kept = numeric ? downsample(b.arr, keep) : b.arr.slice(0, keep);
    b.arr.splice(0, b.arr.length, ...kept);
    const note = `${b.path || "result"} shortened to fit`;
    if (!notes.includes(note)) notes.push(note);
    if (root && typeof root === "object" && !Array.isArray(root)) (root as Record<string, unknown>).truncated = notes;
    json = JSON.stringify(root);
  }
  if (json.length > max) {
    root = { truncated: ["result too large; cut"], partial: json.slice(0, max - 200) };
    json = JSON.stringify(root);
  }
  return json;
}

/* ------------------------------------------------------------------ deadline */

/** A signal that aborts on the caller's signal or after `ms`. */
export function deadline(ctx: DeskToolContext, ms = ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS): AbortSignal {
  const signals = [AbortSignal.timeout(ms)];
  if (ctx.signal) signals.push(ctx.signal);
  return AbortSignal.any(signals);
}

/** "MICROSOFT CORP /WA/" -> "Microsoft Corp". */
export function displayName(name: string): string {
  const clean = name.replace(/\s*\/\s*[A-Z]{2,4}\s*\/?\s*$/i, "").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Llc|Plc|Lp|Nv|Sa|Ag|Se|Ii|Iii)\b/g, (w) => w.toUpperCase());
}

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?,?$/i;
const PARTICLE = /^(de|del|della|di|da|van|von|der|den|le|la|mac|st\.?)$/i;

/** Form 4 writes people "LAST FIRST MIDDLE"; this reads "First Middle Last" (engine detectors/util.ts personName). */
export function personName(name: string): string {
  const n = name.trim().replace(/[,\s]+$/, "");
  if (/\b(LLC|L\.?P\.?|INC|CORP|FUND|TRUST|CAPITAL|PARTNERS|HOLDINGS|MANAGEMENT|ADVISORS|LTD|GROUP|FOUNDATION|BANK|PARTNERSHIP|COMPANY)\b/i.test(n)) return displayName(n);
  const comma = /^([^,]+),\s*(.+)$/.exec(n);
  if (comma) return displayName(`${comma[2]} ${comma[1]}`.replace(/,/g, ""));
  let parts = n.split(/\s+/);
  if (parts.length < 2) return displayName(n);
  const suffixes = parts.filter((p) => SUFFIX.test(p));
  parts = parts.filter((p) => !SUFFIX.test(p));
  let lastLen = 1;
  while (lastLen < parts.length - 1 && PARTICLE.test(parts[lastLen - 1]!)) lastLen++;
  return displayName([...parts.slice(lastLen), ...parts.slice(0, lastLen), ...suffixes].join(" "));
}
