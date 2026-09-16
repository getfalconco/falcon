/**
 * The seeded strategy library (§9).
 *
 * Each of these is a hypothesis the product already acts on. None has ever been
 * measured. Shipping them as version 1 IS the point of building Quant Lab —
 * the instrument exists to kill the bad ones, and it should start by pointing
 * at Falcon's own claims rather than at something invented for the demo.
 *
 * Every strategy carries, in `notes`, what it tests and what result would kill
 * it. Writing the kill condition BEFORE seeing the number is the whole
 * discipline: a threshold chosen afterwards is a threshold chosen to pass.
 */

import { newStrategy } from "./strategy.js";
import type { Strategy } from "./types.js";

const CREATED_AT = "2026-08-25T00:00:00.000Z";

/**
 * 1. Unpriced neighbour after a mapped 8-K — Falcon's core thesis.
 *
 * Entry is `next_open` because most results releases are accepted after the
 * close: with `signal_close` the engine would correctly refuse the majority of
 * these candidates, and the surviving sample would be the unrepresentative
 * before-the-open minority.
 */
export const UNPRICED_NEIGHBOUR: Strategy = newStrategy({
  strategy_id: "seed-unpriced-neighbour",
  name: "Unpriced supplier after mapped 8-K",
  created_at: CREATED_AT,
  universe: { tickers: "tracked", min_history_sessions: 300 },
  trigger: {
    kind: "event",
    event: { types: ["8k_item_2.02", "8k_item_1.01", "8k_item_5.02"], on: "graph_neighbour" },
    graph: { edge_from_event_ticker: true, min_tier: "important", max_hops: 1 },
  },
  filters: [
    { kind: "unpriced", max_ratio: 0.35 },
    { kind: "liquidity", min_dollar_volume_20d: 5_000_000 },
  ],
  entry: { when: "next_open" },
  hold: { sessions: [1, 3, 5] },
  exit: { kind: "time_only" },
  direction: { kind: "event_direction" },
  notes:
    "Tests Falcon's core thesis: that a filing-mapped counterparty which has NOT yet moved goes on to move in the event's direction. " +
    "Kill condition: if the sector-relative median at every horizon sits inside the base rate's confidence interval, the relationship graph carries no tradable second-order information and the propagation engine's premise is wrong.",
});

/**
 * 2. Quiet accumulation — tests Screen.
 *
 * Runs with the news-burst veto disabled (it cannot be rebuilt historically),
 * which is the permissive direction. A failure here is therefore a strong
 * result and a pass is a weak one.
 */
export const QUIET_ACCUMULATION: Strategy = newStrategy({
  strategy_id: "seed-quiet-accumulation",
  name: "Quiet accumulation",
  created_at: CREATED_AT,
  universe: { tickers: "tracked", min_history_sessions: 300 },
  trigger: { kind: "pattern", pattern: { names: ["quiet_accumulation"], state: "new" } },
  filters: [
    { kind: "r2_floor", min: 0.15 },
    { kind: "no_earnings_within", sessions: 5 },
  ],
  entry: { when: "signal_close" },
  hold: { sessions: [5, 10] },
  exit: { kind: "time_only" },
  direction: { kind: "long_only" },
  notes:
    "Tests Screen's premise that volume without price is accumulation that later resolves upward. " +
    "Kill condition: no edge over base rate at either horizon. Note the veto handicap runs in this strategy's FAVOUR — the news-burst gate is disabled historically, so more signals fire here than would fire live. Failing under those conditions is conclusive.",
});

/**
 * 3a / 3b. Coiled release — tests Gauge, and the compression claim that has
 * already failed once at index level.
 *
 * Shipped as two strategies rather than one with a switch, because they are
 * different rules and each deserves its own version history: "does compression
 * resolve upward" and "does compression resolve in the direction the tape was
 * already leaning" are separate questions.
 */
export const COILED_LONG: Strategy = newStrategy({
  strategy_id: "seed-coiled-long",
  name: "Coiled release (long only)",
  created_at: CREATED_AT,
  universe: { tickers: "tracked", min_history_sessions: 300 },
  trigger: { kind: "setup", setup: { names: ["coiled"], state: "actionable" } },
  filters: [{ kind: "liquidity", min_dollar_volume_20d: 5_000_000 }],
  entry: { when: "signal_close" },
  hold: { sessions: [5, 10] },
  exit: { kind: "time_only" },
  direction: { kind: "long_only" },
  notes:
    "Tests Gauge's COILED setup as a long. The compression card already died against 33 years of index data, so the prior is that this fails too; the question is whether single-name compression behaves differently from index compression. " +
    "Kill condition: median at or below base rate, which would retire COILED as an actionable state.",
});

export const COILED_DIRECTIONAL: Strategy = newStrategy({
  strategy_id: "seed-coiled-directional",
  name: "Coiled release (setup direction)",
  created_at: CREATED_AT,
  universe: { tickers: "tracked", min_history_sessions: 300 },
  trigger: { kind: "setup", setup: { names: ["coiled"], state: "actionable" } },
  filters: [{ kind: "liquidity", min_dollar_volume_20d: 5_000_000 }],
  entry: { when: "signal_close" },
  hold: { sessions: [5, 10] },
  exit: { kind: "time_only" },
  direction: { kind: "pattern_direction" },
  notes:
    "The same setup, signed by the direction Gauge reads rather than assumed long. " +
    "Kill condition: no better than the long-only variant, which would mean the direction Gauge attaches to a coiled range carries no information.",
});

/**
 * 4. Insider divergence — tests the detector that produced the first P1s.
 *
 * NOT backtestable today: Tracker prunes insider transactions to a
 * 10-business-day window, so there is no cluster history to test against. It
 * ships defined and marked `unavailable_historically` so the live ledger can
 * start accumulating a forward record immediately — which is the only evidence
 * this rule can currently earn, and by construction it cannot be overfit.
 */
export const INSIDER_DIVERGENCE: Strategy = newStrategy({
  strategy_id: "seed-insider-divergence",
  name: "Insider divergence",
  created_at: CREATED_AT,
  universe: { tickers: "tracked", min_history_sessions: 300 },
  trigger: { kind: "pattern", pattern: { names: ["insider_divergence"], state: "new" } },
  filters: [{ kind: "liquidity", min_dollar_volume_20d: 5_000_000 }],
  entry: { when: "signal_close" },
  hold: { sessions: [10] },
  exit: { kind: "time_only" },
  direction: { kind: "pattern_direction" },
  notes:
    "Tests the insider-cluster detector that produced Falcon's first P1 incidents: insiders buying while momentum falls (or selling while it rises). " +
    "NOT BACKTESTABLE — Tracker keeps only a 10-business-day insider window, so no history exists. Live-ledger only until the Form 4 archive is backfilled. " +
    "Kill condition (forward): after 30 live signals, no edge over base rate at 10 sessions.",
});

export const SEED_STRATEGIES: Strategy[] = [
  UNPRICED_NEIGHBOUR,
  QUIET_ACCUMULATION,
  COILED_LONG,
  COILED_DIRECTIONAL,
  INSIDER_DIVERGENCE,
];

/** Seeds missing from the store, so seeding is idempotent. */
export function missingSeeds(existingIds: Set<string>): Strategy[] {
  return SEED_STRATEGIES.filter((s) => !existingIds.has(s.strategy_id));
}
