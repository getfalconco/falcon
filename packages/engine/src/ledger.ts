/**
 * What the engine remembers between runs (design 5.1 "Judging is idempotent"
 * and 7.4 "Forward track record"):
 *
 *   - Judgments: an event's voted answers keyed by (event id, candidates
 *     hash), so an event is judged once, and again only when its candidate
 *     set (or the judge prompt version) changes. Stored in
 *     public.ripple_judgments (migration 20261117_ripple_judgments.sql) on a
 *     real run, and in .cache/judgments/ on disk for a dry run (no database).
 *   - Forecasts: one append-only row per judged or built hit, published or
 *     not, in public.ripple_forecasts (migration 20261118_ripple_ledger.sql).
 *     Rows are never updated; a later run that sees the same hit with the same
 *     tier, sign and publish state adds nothing (`on conflict do nothing`).
 *
 * Neither is public: RLS is on with no policies.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import type { RippleCard, RippleHit } from "@falcon/ripple";
import { ENGINE_ROOT } from "./http.ts";
import type { JudgeRequest } from "./judge.ts";
import type { VoteResult } from "./vote.ts";

// ---------------------------------------------------------------------------
// Hashing

/** JSON with object keys sorted, so equal values hash equally. Pure. */
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/**
 * Bump when the judge prompt or schema changes in a way that should re-judge
 * stored events (it is part of the candidates hash).
 */
export const JUDGE_PROMPT_VERSION = "v1-linkclarity";

/**
 * The hash of what the judge sees for an event: the prompt version, the
 * event text and every candidate with its links and quotes. Pure.
 */
export function candidatesHash(req: JudgeRequest): string {
  return sha256(canonicalJson({ v: JUDGE_PROMPT_VERSION, event: req.event, candidates: req.candidates }));
}

// ---------------------------------------------------------------------------
// Judgments

export type StoredJudgment = {
  eventId: string;
  candidatesHash: string;
  judgedAt: string;
  models: string[];
  /** Every candidate's split (VoteResult.splits). */
  votes: VoteResult["splits"];
  /** The voted hits (VoteResult.hits) and the discarded votes. */
  hits: { hits: VoteResult["hits"]; discarded: VoteResult["discarded"] };
  costUsd: number | null;
};

export interface JudgmentStore {
  readonly name: string;
  get(eventId: string, hash: string): Promise<StoredJudgment | null>;
  put(j: StoredJudgment): Promise<void>;
  close?(): Promise<void>;
}

/** A stored judgment as a vote result (no new calls). Pure. */
export function voteFromStored(j: StoredJudgment): VoteResult {
  return { hits: j.hits.hits, splits: j.votes, discarded: j.hits.discarded, calls: 0 };
}

/** A vote result to store. Pure. */
export function storedFromVote(eventId: string, hash: string, voted: VoteResult, models: string[], costUsd: number | null, judgedAt = new Date().toISOString()): StoredJudgment {
  return { eventId, candidatesHash: hash, judgedAt, models, votes: voted.splits, hits: { hits: voted.hits, discarded: voted.discarded }, costUsd };
}

export function memoryJudgmentStore(): JudgmentStore & { rows: Map<string, StoredJudgment> } {
  const rows = new Map<string, StoredJudgment>();
  return {
    name: "memory",
    rows,
    async get(eventId, hash) {
      return rows.get(`${eventId}|${hash}`) ?? null;
    },
    async put(j) {
      const k = `${j.eventId}|${j.candidatesHash}`;
      if (!rows.has(k)) rows.set(k, j);
    },
  };
}

export const JUDGMENTS_CACHE_DIR = path.join(ENGINE_ROOT, ".cache", "judgments");

/** Judgments on disk, one file per (event, candidates hash). For dry runs; never public. */
export function fileJudgmentStore(dir = JUDGMENTS_CACHE_DIR): JudgmentStore {
  const file = (eventId: string, hash: string) => path.join(dir, `${sha256(`${eventId}|${hash}`).slice(0, 32)}.json`);
  return {
    name: `file ${path.relative(ENGINE_ROOT, dir) || dir}`,
    async get(eventId, hash) {
      try {
        const j = JSON.parse(fs.readFileSync(file(eventId, hash), "utf8")) as StoredJudgment;
        return j.eventId === eventId && j.candidatesHash === hash ? j : null;
      } catch {
        return null;
      }
    },
    async put(j) {
      const f = file(j.eventId, j.candidatesHash);
      if (fs.existsSync(f)) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, `${JSON.stringify(j)}\n`);
    },
  };
}

function pgClient(databaseUrl: string): pg.Client {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(databaseUrl);
  return new pg.Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
}

export const JUDGMENT_GET_SQL = `select event_id, candidates_hash, judged_at, models, votes, hits, cost_usd
  from public.ripple_judgments where event_id = $1 and candidates_hash = $2`;

export const JUDGMENT_PUT_SQL = `insert into public.ripple_judgments (event_id, candidates_hash, models, votes, hits, cost_usd)
  values ($1, $2, $3, $4, $5, $6)
  on conflict (event_id, candidates_hash) do nothing`;

/** Judgments in public.ripple_judgments (one connection for the run). */
export function pgJudgmentStore(databaseUrl: string): JudgmentStore {
  let db: pg.Client | null = null;
  const conn = async () => {
    if (!db) {
      db = pgClient(databaseUrl);
      await db.connect();
    }
    return db;
  };
  return {
    name: "supabase ripple_judgments",
    async get(eventId, hash) {
      const r = await (await conn()).query(JUDGMENT_GET_SQL, [eventId, hash]);
      const row = r.rows[0] as { event_id: string; candidates_hash: string; judged_at: Date | string; models: string[]; votes: StoredJudgment["votes"]; hits: StoredJudgment["hits"]; cost_usd: number | null } | undefined;
      if (!row) return null;
      return {
        eventId: row.event_id,
        candidatesHash: row.candidates_hash,
        judgedAt: new Date(row.judged_at).toISOString(),
        models: row.models ?? [],
        votes: row.votes,
        hits: row.hits,
        costUsd: row.cost_usd,
      };
    },
    async put(j) {
      await (await conn()).query(JUDGMENT_PUT_SQL, [j.eventId, j.candidatesHash, j.models, JSON.stringify(j.votes), JSON.stringify(j.hits), j.costUsd]);
    },
    async close() {
      if (db) await (db as pg.Client).end();
      db = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Forecasts

export type ForecastRow = {
  event_id: string;
  card_id: string;
  ticker: string;
  tier: string;
  family: string | null;
  /** 1 up, -1 down, 0 unclear. */
  sign_pred: number;
  window_days: number;
  covariates: Record<string, unknown>;
  model_version: string;
  /** sha256 of the card JSON the hit sits on (published or not); null for a hit dropped before a card. */
  card_sha256: string | null;
  published: boolean;
};

export function signPred(d: RippleHit["direction"]): number {
  return d === "up" ? 1 : d === "down" ? -1 : 0;
}

/** sha256 of a card's canonical JSON. Pure. */
export function cardSha256(card: RippleCard): string {
  return sha256(canonicalJson(card));
}

/** The covariates stored with a hit (the inputs, never an expected return). Pure. */
export function covariatesOf(hit: RippleHit, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    relation: hit.relation,
    degree: hit.degree,
    via: hit.via ?? null,
    confidence: hit.confidence,
    linkClarity: hit.linkClarity ?? null,
    votes: hit.votes ?? null,
    score: hit.score ?? null,
    analysts: hit.analysts ?? null,
    pricedIn: hit.pricedIn ?? null,
    channel: hit.channel ?? null,
    record: hit.history ? { sample: hit.history.sample, hitRate: hit.history.hitRate, windowDays: hit.history.windowDays } : null,
    ...extra,
  };
}

export const FORECAST_INSERT_SQL = `insert into public.ripple_forecasts
  (event_id, card_id, ticker, tier, family, sign_pred, window_days, covariates, model_version, card_sha256, published)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  on conflict do nothing`;

/** Appends forecast rows in one transaction; returns how many were new. */
export async function writeForecasts(databaseUrl: string, rows: readonly ForecastRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = pgClient(databaseUrl);
  await db.connect();
  try {
    await db.query("begin");
    let n = 0;
    for (const r of rows) {
      const res = await db.query(FORECAST_INSERT_SQL, [r.event_id, r.card_id, r.ticker, r.tier, r.family, r.sign_pred, r.window_days, JSON.stringify(r.covariates), r.model_version, r.card_sha256, r.published]);
      n += res.rowCount ?? 0;
    }
    await db.query("commit");
    return n;
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}
