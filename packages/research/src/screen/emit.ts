/**
 * S1 — the emit channel (Screen → Base).
 *
 * Screen's spec §4 said it emits nothing into the pipeline. That rule now has
 * exactly one narrow exception: when a pattern is detected for the FIRST time
 * (`new`, never `continuing`) on a ticker the user is close to, Screen emits a
 * single `tape_structure` message so Base can open an incident and Analyst can
 * be asked why the structure is forming. Everything else about Screen is
 * unchanged — the pattern logic, thresholds and lifecycle are untouched; this
 * module only reads the post-scan state and decides what leaves the building.
 *
 * The gate is deliberately narrow because untested patterns must not eat the
 * Analyst budget:
 *   - state `new` only (a false→true transition), never `continuing`
 *   - proximity `held` or `watchlist`; tracked-only tickers never emit
 *   - a daily cap (config `dailyEmitCap`), overflow resolved by emit priority
 *   - one emit per finding, ever (`emitted_at` marks it)
 *   - the whole channel is off by default (`emit.screenEmitEnabled`)
 *
 * Pure: a function of (state, views, session, proximity, config, now). The
 * host persists the messages and the marked state.
 */

import { nyYmd } from "../tracker/calendar.js";
import type { QuantContext } from "../tracker/types.js";
import type { ScreenConfig } from "./config.js";
import {
  SCREEN_SCHEMA_VERSION,
  type ScreenFinding,
  type ScreenPattern,
  type ScreenSeriesView,
  type ScreenSinceFirst,
  type ScreenStoreState,
  type TapeStructureMessage,
} from "./types.js";

/** Why an eligible-looking finding did not produce a message. */
export type EmitSkipReason = "not_new" | "already_emitted" | "proximity" | "no_view" | "capped" | "disabled";

export type EmitCandidate = {
  finding: ScreenFinding;
  reason: EmitSkipReason | null;
};

export type EmitInput = {
  /** Store state after the lifecycle reducer has folded this session's evaluations. */
  state: ScreenStoreState;
  /** Series views from the same scan, keyed by ticker. */
  views: Record<string, ScreenSeriesView>;
  /** The completed session the scan describes. */
  session: string;
  /** Wall-clock instant (ISO) — the message timestamp and the emit day. */
  now: string;
  /** Tickers the user holds. */
  held: string[];
  /** Tickers on the user's watchlist. */
  watchlist: string[];
  config: ScreenConfig;
};

export type EmitResult = {
  messages: TapeStructureMessage[];
  /** State with `emitted_at` set on every emitted finding. */
  state: ScreenStoreState;
  /** Findings that reached the cap decision (new + proximate + not yet emitted). */
  eligible: number;
  /** Eligible findings dropped by the daily cap. */
  capped: number;
  /** Per-finding decision trail, for the panel and the tests. */
  candidates: EmitCandidate[];
  /** Emits already on record for this ET day before this scan. */
  emitted_today_before: number;
};

/** ET calendar day of an instant — the cap's reset boundary. */
export function emitDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : nyYmd(d);
}

/**
 * The rank a pattern claims when the daily cap bites. Lower wins. Patterns
 * missing from the configured order sort last, by name, so the result stays
 * deterministic even if the list and the pattern set drift apart.
 */
export function emitRank(pattern: ScreenPattern, config: ScreenConfig): number {
  const i = config.emit.priority.indexOf(pattern);
  return i >= 0 ? i : config.emit.priority.length;
}

/**
 * The quant context the message carries. Built from Screen's own series view
 * rather than read back from the Tracker: the view is what the pattern was
 * evaluated on, so the message and the finding cannot disagree, and Screen
 * gains no new dependency on the Tracker's live state.
 *
 * `session: "closed"` — every Screen emit describes a completed session.
 */
export function quantContextFromView(view: ScreenSeriesView): QuantContext {
  const sessions = view.sessions;
  const last = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const prev = sessions.length > 1 ? sessions[sessions.length - 2] : null;
  const vol = view.daily_vol;
  const moveZ = last?.ret != null && vol != null && vol > 0 ? last.ret / vol : null;
  return {
    beta_90d: view.beta,
    r_squared: view.r2,
    daily_vol_30d: vol,
    vol_regime: view.vol_regime,
    move_today: last?.ret ?? null,
    move_zscore: moveZ,
    residual_move: last?.residual_move ?? null,
    residual_zscore: last?.residual_z ?? null,
    volume_ratio: last?.volume_ratio ?? null,
    volume_ratio_partial: false,
    momentum_5d: view.momentum_5d,
    momentum_20d: view.momentum_20d,
    momentum_60d: null,
    pct_from_52w_high: view.pct_from_52w_high,
    pct_from_52w_low: view.pct_from_52w_low,
    earnings_rhythm: null,
    prev_close: prev?.close ?? null,
    last_price: last?.close ?? null,
    price_asof: view.as_of,
    session: "closed",
  };
}

/**
 * The cumulative move since the pattern's first session — the reference point
 * a `structure_review` reasons against (there is no single event to price).
 *
 * Only the sessions the view actually covers are counted; `covered_from` and
 * `sessions` say how much of the structure that is, so a 12-day pattern read
 * through a 5-session window cannot be mistaken for the whole thing.
 */
export function sinceFirstSession(view: ScreenSeriesView, firstSession: string): ScreenSinceFirst {
  const covered = view.sessions.filter((s) => s.d >= firstSession);
  let compound: number | null = null;
  let zSum = 0;
  let zCount = 0;
  for (const s of covered) {
    if (s.ret != null && Number.isFinite(s.ret)) compound = (compound === null ? 1 : compound) * (1 + s.ret);
    if (s.residual_z != null && Number.isFinite(s.residual_z)) {
      zSum += s.residual_z;
      zCount += 1;
    }
  }
  return {
    covered_from: covered.length > 0 ? covered[0].d : null,
    sessions: covered.length,
    /** Compounded simple return over the covered sessions. */
    ret: compound === null ? null : compound - 1,
    /** Sum of residual z-scores scaled by sqrt(n) — the multi-session equivalent of a one-day z. */
    residual_z_cum: zCount > 0 ? zSum / Math.sqrt(zCount) : null,
  };
}

function messageId(finding: ScreenFinding, session: string): string {
  // Deterministic in (finding, session): a re-run of the same scan cannot
  // produce a second message id for the same emit.
  return `screen:${finding.ticker}:${finding.pattern}:${finding.first_session}:${session}`;
}

export function buildTapeStructureMessage(
  finding: ScreenFinding,
  view: ScreenSeriesView,
  session: string,
  now: string,
): TapeStructureMessage {
  return {
    id: messageId(finding, session),
    schema_version: SCREEN_SCHEMA_VERSION,
    type: "tape_structure",
    ticker: finding.ticker,
    timestamp: now,
    source_engine: "screen",
    context_flags: [],
    quant_context: quantContextFromView(view),
    payload: {
      pattern: finding.pattern,
      finding_id: finding.id,
      first_session: finding.first_session,
      session,
      day_count: finding.day_count,
      values: { ...finding.values },
      modifiers: [...finding.modifiers],
      read: finding.read,
      since_first: sinceFirstSession(view, finding.first_session),
    },
  };
}

/**
 * Decide what this scan emits. Findings are considered in emit-priority order
 * so the cap keeps the most informative patterns; ties break on ticker for
 * determinism.
 */
export function selectEmissions(input: EmitInput): EmitResult {
  const { config, session, now } = input;
  const day = emitDay(now);
  const proximate = new Set(
    [...input.held, ...input.watchlist].map((t) => t.trim().toUpperCase()).filter(Boolean),
  );

  const emittedTodayBefore = input.state.findings.filter((f) => f.emitted_at != null && emitDay(f.emitted_at) === day).length;

  // Only findings this scan turned new are ever considered.
  const ordered = input.state.findings
    .filter((f) => f.ended_at == null)
    .sort((a, b) => emitRank(a.pattern, config) - emitRank(b.pattern, config) || a.ticker.localeCompare(b.ticker));

  const candidates: EmitCandidate[] = [];
  const messages: TapeStructureMessage[] = [];
  const emittedIds = new Set<string>();
  let eligible = 0;
  let capped = 0;
  let budget = Math.max(0, config.emit.dailyEmitCap - emittedTodayBefore);

  for (const finding of ordered) {
    if (!config.emit.screenEmitEnabled) {
      candidates.push({ finding, reason: "disabled" });
      continue;
    }
    if (finding.emitted_at != null) {
      candidates.push({ finding, reason: "already_emitted" });
      continue;
    }
    if (finding.state !== "new") {
      candidates.push({ finding, reason: "not_new" });
      continue;
    }
    if (!proximate.has(finding.ticker)) {
      candidates.push({ finding, reason: "proximity" });
      continue;
    }
    const view = input.views[finding.ticker];
    if (!view) {
      candidates.push({ finding, reason: "no_view" });
      continue;
    }
    eligible += 1;
    if (budget <= 0) {
      capped += 1;
      candidates.push({ finding, reason: "capped" });
      continue;
    }
    budget -= 1;
    messages.push(buildTapeStructureMessage(finding, view, session, now));
    emittedIds.add(finding.id);
    candidates.push({ finding, reason: null });
  }

  const state: ScreenStoreState = {
    ...input.state,
    findings: input.state.findings.map((f) => (emittedIds.has(f.id) ? { ...f, emitted_at: now } : f)),
  };

  return { messages, state, eligible, capped, candidates, emitted_today_before: emittedTodayBefore };
}
