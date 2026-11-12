/**
 * Majority vote over several judge calls for one event (README, "Judge
 * votes"). The judge is a sampled model, so one call can flip a direction;
 * several calls with the same prompt and schema, counted per candidate, give
 * a direction that holds from run to run.
 *
 *   1. Three calls at once. A vote is one call's answer for one candidate,
 *      and it must pass the same validation as before (checkAnswer: closed
 *      answer sets, framing, no invented numbers). A vote that fails, or is
 *      missing, or whose call failed, is discarded and replaced once by a
 *      retry call; a retried vote that fails again is dropped.
 *   2. Include: more than half of the valid votes include the candidate.
 *   3. Direction: the value at least 2 of the first round's including votes
 *      agree on. When none has 2 (all differ), two more calls (five in all)
 *      and then, among the including votes: "unclear" only when it is itself
 *      a majority, or when up and down tie exactly; else the larger of up and
 *      down. Never unclear just because the votes disagree a little.
 *   4. Confidence: the most common confidence among the votes for the winning
 *      direction, a tie going to the lower one. Mechanism and window: the
 *      first such vote with that confidence (call order), so the pick is
 *      deterministic.
 *
 * Cost guard: every call counts against a budget shared by the run; when it
 * is spent the vote goes ahead with the calls it has (none: the event fails).
 * A deterministic judge (answers from a file) is asked once.
 */

import type { Confidence, Direction } from "@falcon/ripple";
import { checkAnswer, type Judge, type JudgeRequest, type ValidatedAnswer } from "./judge.ts";

export const FIRST_ROUND = 3;
export const SECOND_ROUND = 2;
/** Judge calls per run at most (5 events: 15 in a quiet run, 25 if every event escalates, plus retries). */
export const DEFAULT_MAX_CALLS = 40;

export type VoteSplit = { up: number; down: number; unclear: number; excluded: number };

/** The run's call budget; `used` counts every call made, failed ones too. */
export type CallBudget = { max: number; used: number };

export function callBudget(max = DEFAULT_MAX_CALLS): CallBudget {
  return { max, used: 0 };
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function splitOf(votes: readonly Pick<ValidatedAnswer, "include" | "direction">[]): VoteSplit {
  const s: VoteSplit = { up: 0, down: 0, unclear: 0, excluded: 0 };
  for (const v of votes) {
    if (!v.include) s.excluded++;
    else s[v.direction]++;
  }
  return s;
}

/** Whether more than half of the valid votes include the candidate. Pure. */
export function included(votes: readonly Pick<ValidatedAnswer, "include">[]): boolean {
  const n = votes.filter((v) => v.include).length;
  return votes.length > 0 && n * 2 > votes.length;
}

/** The first round's direction: a value at least 2 including votes agree on, or null (all differ). Pure. */
export function agreed(votes: readonly Pick<ValidatedAnswer, "include" | "direction">[]): Direction | null {
  const s = splitOf(votes);
  const best = (["up", "down", "unclear"] as const).filter((d) => s[d] >= 2).sort((a, b) => s[b] - s[a]);
  return best[0] ?? null;
}

/**
 * The direction after the second round: unclear when it is a majority of
 * the including votes, or when up and down tie; else the larger of up and
 * down. Pure.
 */
export function plurality(votes: readonly Pick<ValidatedAnswer, "include" | "direction">[]): Direction {
  const s = splitOf(votes);
  const n = s.up + s.down + s.unclear;
  if (s.unclear * 2 > n) return "unclear";
  if (s.up === s.down) return "unclear";
  return s.up > s.down ? "up" : "down";
}

/**
 * The winning vote's fields: the most common confidence among the votes for
 * `direction` (a tie: the lower), and the first of them with it. When no
 * vote has that direction (unclear from an up and down tie), the including
 * votes stand in, an unclear one first. Pure.
 */
export function pickVote(votes: readonly ValidatedAnswer[], direction: Direction): ValidatedAnswer {
  const inc = votes.filter((v) => v.include);
  const agreeing = inc.filter((v) => v.direction === direction);
  const pool = agreeing.length ? agreeing : inc;
  const count = new Map<Confidence, number>();
  for (const v of pool) count.set(v.confidence, (count.get(v.confidence) ?? 0) + 1);
  const confidence = [...count.entries()].sort((a, b) => b[1] - a[1] || CONF_RANK[a[0]] - CONF_RANK[b[0]])[0]![0];
  const chosen = pool.find((v) => v.confidence === confidence)!;
  return { ...chosen, direction, confidence };
}

export type VotedHit = { answer: ValidatedAnswer; votes: VoteSplit };

export type VoteResult = {
  /** One entry per candidate that came out included, in candidate order. */
  hits: VotedHit[];
  /** Every candidate's split, included or not (for the run log). */
  splits: Array<{ key: string; votes: VoteSplit; direction: Direction | null; escalated: boolean }>;
  /** Votes discarded by validation (with why) and whether a retry replaced them. */
  discarded: Array<{ key: string; problems: string[] }>;
  calls: number;
};

type Round = Array<{ ok: true; raw: unknown } | { ok: false; error: string }>;

async function ask(judge: Judge, req: JudgeRequest, n: number, budget: CallBudget): Promise<Round> {
  const k = Math.max(0, Math.min(n, budget.max - budget.used));
  budget.used += k;
  return Promise.all(
    Array.from({ length: k }, () =>
      judge.judge(req).then(
        (raw) => ({ ok: true as const, raw }),
        (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
      ),
    ),
  );
}

/** One call's answer for each candidate key: valid, failed validation (with why), or missing. */
function answersOf(req: JudgeRequest, call: Round[number]): Map<string, ValidatedAnswer | { problems: string[] }> {
  const out = new Map<string, ValidatedAnswer | { problems: string[] }>();
  if (!call.ok) {
    for (const c of req.candidates) out.set(c.key, { problems: [`call failed: ${call.error}`] });
    return out;
  }
  const list = Array.isArray((call.raw as { hits?: unknown })?.hits) ? (call.raw as { hits: unknown[] }).hits : [];
  for (const a of list) {
    const v = checkAnswer(req, a);
    if (!v || out.has(v.key)) continue;
    out.set(v.key, v.problems.length ? { problems: v.problems } : v);
  }
  for (const c of req.candidates) if (!out.has(c.key)) out.set(c.key, { problems: ["no answer for this candidate"] });
  return out;
}

const isVote = (x: ValidatedAnswer | { problems: string[] } | undefined): x is ValidatedAnswer => !!x && "key" in x;

/**
 * Asks for `n` votes per candidate, replacing each discarded vote once with
 * a retry call. Adds the valid votes to `votes` (per key, in call order).
 */
async function round(judge: Judge, req: JudgeRequest, n: number, budget: CallBudget, votes: Map<string, ValidatedAnswer[]>, discarded: VoteResult["discarded"]): Promise<void> {
  const first = (await ask(judge, req, n, budget)).map((c) => answersOf(req, c));
  const missing = new Map<string, number>();
  for (const answers of first) {
    for (const [key, a] of answers) {
      if (isVote(a)) votes.get(key)!.push(a);
      else {
        discarded.push({ key, problems: a.problems });
        missing.set(key, (missing.get(key) ?? 0) + 1);
      }
    }
  }
  const retries = Math.max(0, ...missing.values());
  if (retries === 0) return;
  const again = (await ask(judge, req, retries, budget)).map((c) => answersOf(req, c));
  for (const [key, need] of missing) {
    let left = need;
    for (const answers of again) {
      if (left === 0) break;
      const a = answers.get(key);
      if (isVote(a)) {
        votes.get(key)!.push(a);
        left--;
      }
    }
  }
}

/**
 * The voted answers for one event. Throws when not one call could be made
 * or every call failed (the event then has no card, as before).
 */
export async function voteJudge(judge: Judge, req: JudgeRequest, budget: CallBudget): Promise<VoteResult> {
  const votes = new Map<string, ValidatedAnswer[]>(req.candidates.map((c) => [c.key, []]));
  const discarded: VoteResult["discarded"] = [];
  const start = budget.used;
  const firstN = judge.deterministic ? 1 : FIRST_ROUND;
  if (budget.max - budget.used <= 0) throw new Error(`judge call budget spent (${budget.max} calls this run)`);
  await round(judge, req, firstN, budget, votes, discarded);
  if ([...votes.values()].every((v) => v.length === 0)) {
    const why = discarded.find((d) => d.problems[0]?.startsWith("call failed"))?.problems[0] ?? "no valid answer";
    throw new Error(why);
  }

  // A second round when an included candidate's first votes all differ.
  const undecided = (key: string) => {
    const v = votes.get(key)!;
    return included(v) && agreed(v) === null && v.filter((x) => x.include).length > 1;
  };
  const escalate = !judge.deterministic && req.candidates.some((c) => undecided(c.key));
  const escalated = new Set(escalate ? req.candidates.filter((c) => undecided(c.key)).map((c) => c.key) : []);
  if (escalate) {
    // Only the undecided candidates take the extra votes.
    const extra = new Map<string, ValidatedAnswer[]>(req.candidates.map((c) => [c.key, []]));
    await round(judge, req, SECOND_ROUND, budget, extra, discarded);
    for (const key of escalated) votes.get(key)!.push(...extra.get(key)!);
  }

  const hits: VotedHit[] = [];
  const splits: VoteResult["splits"] = [];
  for (const c of req.candidates) {
    const v = votes.get(c.key)!;
    const split = splitOf(v);
    if (!included(v)) {
      splits.push({ key: c.key, votes: split, direction: null, escalated: escalated.has(c.key) });
      continue;
    }
    const inc = v.filter((x) => x.include);
    const direction = escalated.has(c.key) ? plurality(v) : (agreed(v) ?? (inc.length === 1 ? inc[0]!.direction : plurality(v)));
    hits.push({ answer: pickVote(v, direction), votes: split });
    splits.push({ key: c.key, votes: split, direction, escalated: escalated.has(c.key) });
  }
  return { hits, splits, discarded, calls: budget.used - start };
}
