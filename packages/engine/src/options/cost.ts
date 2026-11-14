/**
 * Databento spend guard: one budget, one append-only ledger, one response
 * cache, shared by every agent and process that pulls data.
 *
 *   - Ledger. `.cache/databento/spend.ndjson`, one JSON line per paid pull
 *     ({at, dataset, schema, symbols {count, first}, start, end, costUsd,
 *     caller, key, kind}). A pull that fails after it was reserved gets a
 *     `refund` line with a negative cost, so the file stays append-only.
 *   - Lock. The check "does this pull fit the budget" and the append happen
 *     under one lock (an exclusive `mkdir` of `spend.lock`, which is atomic
 *     on every OS), so two processes can never both spend the last dollars.
 *     A lock older than LOCK_STALE_MS (a crashed holder) is broken.
 *   - Budgets. Total `DATABENTO_BUDGET_USD` (default 90) over the whole
 *     ledger; a per-call cap and an optional per-caller cap passed by the
 *     caller (the per-caller sum is over ledger lines with that caller name).
 *   - Cache. Every response body is stored under `.cache/databento/data/`
 *     keyed by a hash of the canonical request (symbols sorted), written
 *     atomically (temp file + rename). A cached request is never priced or
 *     paid again.
 *
 * Costs recorded are Databento's own `metadata.get_cost` estimates, which
 * are rounded up to 10-minute boundaries (UTC midnight for `definition`), so
 * the ledger overstates the real bill slightly. That is the safe direction.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE_ROOT } from "../http.ts";
import { env } from "../env.ts";

export const DATABENTO_DIR = path.join(ENGINE_ROOT, ".cache", "databento");
export const DEFAULT_TOTAL_BUDGET_USD = 90;
export const LOCK_STALE_MS = 60_000;

/** One get_range request, as sent (form params). */
export type RangeRequest = {
  dataset: string;
  schema: string;
  symbols: string[];
  /** ISO 8601 date or datetime (UTC unless an offset is given). Inclusive. */
  start: string;
  /** Exclusive. */
  end: string;
  stype_in?: "raw_symbol" | "parent" | "instrument_id" | "continuous";
  limit?: number;
};

export type SpendEntry = {
  at: string;
  kind: "charge" | "refund";
  dataset: string;
  schema: string;
  symbols: { count: number; first: string[] };
  start: string;
  end: string;
  costUsd: number;
  caller: string;
  key: string;
  note?: string;
};

export class BudgetError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
    readonly reason: "per_call" | "per_caller" | "total",
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

/** Total budget from the environment (`DATABENTO_BUDGET_USD`), default 90. */
export function totalBudgetFromEnv(): number {
  const raw = env("DATABENTO_BUDGET_USD");
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_TOTAL_BUDGET_USD;
}

/** An ISO date or datetime as a canonical UTC instant ("2026-11-13" and "2026-11-13T00:00:00Z" agree). Pure. */
export function canonicalTime(t: string): string {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : t;
}

/** Canonical cache key of a request: sha256 of sorted, defaulted params, times as UTC instants. Pure. */
export function requestKey(req: RangeRequest): string {
  const canon = {
    dataset: req.dataset,
    schema: req.schema,
    symbols: [...req.symbols].sort(),
    start: canonicalTime(req.start),
    end: canonicalTime(req.end),
    stype_in: req.stype_in ?? "raw_symbol",
    limit: req.limit ?? 0,
    v: 1,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 40);
}

/** Ledger lines parsed; unreadable lines are skipped. Pure. */
export function parseLedger(body: string): SpendEntry[] {
  const out: SpendEntry[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SpendEntry;
      if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd)) out.push(e);
    } catch {
      // a torn line (should not happen under the lock) is ignored
    }
  }
  return out;
}

export function sumSpend(entries: readonly SpendEntry[], caller?: string): number {
  let s = 0;
  for (const e of entries) if (caller === undefined || e.caller === caller) s += e.costUsd;
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type GuardOptions = {
  /** Directory for the ledger, lock and cache (default packages/engine/.cache/databento). */
  dir?: string;
  /** Total budget in USD over the whole ledger (default env DATABENTO_BUDGET_USD or 90). */
  totalBudgetUsd?: number;
  now?: () => Date;
};

export type Authorization = { entry: SpendEntry; spentBeforeUsd: number; callerBeforeUsd: number };

export class SpendGuard {
  readonly dir: string;
  readonly ledgerPath: string;
  readonly lockPath: string;
  readonly dataDir: string;
  readonly totalBudgetUsd: number;
  private now: () => Date;

  constructor(opts: GuardOptions = {}) {
    this.dir = opts.dir ?? DATABENTO_DIR;
    this.ledgerPath = path.join(this.dir, "spend.ndjson");
    this.lockPath = path.join(this.dir, "spend.lock");
    this.dataDir = path.join(this.dir, "data");
    this.totalBudgetUsd = opts.totalBudgetUsd ?? totalBudgetFromEnv();
    this.now = opts.now ?? (() => new Date());
  }

  entries(): SpendEntry[] {
    try {
      return parseLedger(fs.readFileSync(this.ledgerPath, "utf8"));
    } catch {
      return [];
    }
  }

  spentUsd(caller?: string): number {
    return sumSpend(this.entries(), caller);
  }

  /** Runs `fn` holding the ledger lock (exclusive mkdir), breaking a stale lock. */
  async withLock<T>(fn: () => T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        fs.mkdirSync(this.lockPath);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) {
            fs.rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // released between the two calls
        }
        if (Date.now() > deadline) throw new Error(`could not take ${this.lockPath} within 30 s`);
        await sleep(20 + Math.random() * 50);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  /**
   * Checks the pull against the per-call, per-caller and total caps and, if it
   * fits, appends its charge line, all under the lock. Throws BudgetError
   * otherwise (nothing written).
   */
  async authorize(args: {
    req: RangeRequest;
    costUsd: number;
    caller: string;
    maxCallUsd: number;
    maxCallerUsd?: number;
  }): Promise<Authorization> {
    const { req, costUsd, caller, maxCallUsd, maxCallerUsd } = args;
    if (!(costUsd <= maxCallUsd)) {
      throw new BudgetError(
        `refused: ${req.dataset} ${req.schema} costs $${costUsd.toFixed(4)}, over the per-call cap $${maxCallUsd.toFixed(2)}`,
        costUsd,
        "per_call",
      );
    }
    return this.withLock(() => {
      const all = this.entries();
      const spent = sumSpend(all);
      const mine = sumSpend(all, caller);
      if (maxCallerUsd !== undefined && mine + costUsd > maxCallerUsd + 1e-12) {
        throw new BudgetError(
          `refused: caller "${caller}" has spent $${mine.toFixed(4)}; $${costUsd.toFixed(4)} more passes its cap $${maxCallerUsd.toFixed(2)}`,
          costUsd,
          "per_caller",
        );
      }
      if (spent + costUsd > this.totalBudgetUsd + 1e-12) {
        throw new BudgetError(
          `refused: $${spent.toFixed(4)} spent of $${this.totalBudgetUsd.toFixed(2)}; $${costUsd.toFixed(4)} more passes the total budget`,
          costUsd,
          "total",
        );
      }
      const entry: SpendEntry = {
        at: this.now().toISOString(),
        kind: "charge",
        dataset: req.dataset,
        schema: req.schema,
        symbols: { count: req.symbols.length, first: req.symbols.slice(0, 5) },
        start: req.start,
        end: req.end,
        costUsd,
        caller,
        key: requestKey(req),
      };
      fs.appendFileSync(this.ledgerPath, JSON.stringify(entry) + "\n");
      return { entry, spentBeforeUsd: spent, callerBeforeUsd: mine };
    });
  }

  /** Appends a refund line for a reserved pull that returned no data. */
  async refund(entry: SpendEntry, note: string): Promise<void> {
    await this.withLock(() => {
      const line: SpendEntry = { ...entry, at: this.now().toISOString(), kind: "refund", costUsd: -entry.costUsd, note };
      fs.appendFileSync(this.ledgerPath, JSON.stringify(line) + "\n");
    });
  }

  // -------------------------------------------------------------------------
  // Response cache

  private cacheFile(key: string, ext: string): string {
    return path.join(this.dataDir, key.slice(0, 2), `${key}.${ext}`);
  }

  readCache(key: string): { body: Buffer; ext: string } | null {
    for (const ext of ["json.zst", "json.gz"]) {
      try {
        return { body: fs.readFileSync(this.cacheFile(key, ext)), ext };
      } catch {
        // try the next form
      }
    }
    return null;
  }

  /** Atomic write (temp file + rename), plus a small `.meta.json` beside it. */
  writeCache(key: string, ext: string, body: Buffer, meta: Record<string, unknown>): void {
    const file = this.cacheFile(key, ext);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    const metaFile = this.cacheFile(key, "meta.json");
    const mtmp = `${metaFile}.${process.pid}.tmp`;
    fs.writeFileSync(mtmp, JSON.stringify(meta, null, 1));
    fs.renameSync(mtmp, metaFile);
  }
}
