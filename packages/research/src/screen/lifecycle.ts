/**
 * Finding lifecycle (spec §5) — a pure reducer from (store state, one
 * session's evaluations) to the next store state:
 *
 *   present, no open finding  → new (day_count 1)
 *   present, open finding     → continuing (day_count + 1)
 *   absent, open finding      → ended (kept, marked, retained 180d)
 *   n_a                       → untouched (a degraded entry is recorded by the
 *                               scan); an open finding that stays unevaluable
 *                               for `staleEndSessions` ends as not_evaluable
 *
 * Every finding carries the list of scanned sessions on which the condition
 * held, so re-running the same session is idempotent: the session is added or
 * removed from that list rather than counted twice.
 */

import { tradingDaysBetween } from "../tracker/calendar.js";
import type { ScreenConfig } from "./config.js";
import { SCREEN_SCHEMA_VERSION, type ScreenEvaluation, type ScreenFinding, type ScreenPattern, type ScreenStoreState } from "./types.js";

export function findingId(ticker: string, pattern: ScreenPattern, firstSession: string): string {
  return `screen:${ticker.toUpperCase()}:${pattern}:${firstSession}`;
}

export function emptyStoreState(): ScreenStoreState {
  return { schema_version: SCREEN_SCHEMA_VERSION, findings: [], scans: [] };
}

export type LifecycleInput = {
  state: ScreenStoreState;
  evaluations: ScreenEvaluation[];
  /** Completed trading session the evaluations describe. */
  session: string;
  /** Tickers in the tracked universe this scan — open findings on other tickers end as `untracked`. */
  universe: string[];
  config: ScreenConfig;
};

export type LifecycleResult = {
  state: ScreenStoreState;
  new: number;
  continuing: number;
  ended: number;
};

function sortSessions(sessions: string[]): string[] {
  return [...new Set(sessions)].sort();
}

function applyPresent(finding: ScreenFinding, evaluation: ScreenEvaluation, session: string): ScreenFinding {
  const sessions = sortSessions([...finding.sessions, session]);
  const latest = session >= finding.last_evaluated;
  return {
    ...finding,
    state: sessions.length === 1 ? "new" : "continuing",
    day_count: sessions.length,
    first_session: sessions[0],
    last_evaluated: latest ? session : finding.last_evaluated,
    sessions,
    values: latest ? evaluation.values : finding.values,
    modifiers: latest ? evaluation.modifiers : finding.modifiers,
    qualifying_sessions: latest ? evaluation.qualifying_sessions : finding.qualifying_sessions,
    sessions_view: latest ? evaluation.sessions_view : finding.sessions_view,
    read: latest ? (evaluation.read ?? finding.read) : finding.read,
    ended_at: null,
    ended_reason: null,
  };
}

function newFinding(evaluation: ScreenEvaluation, session: string): ScreenFinding {
  return {
    id: findingId(evaluation.ticker, evaluation.pattern, session),
    schema_version: SCREEN_SCHEMA_VERSION,
    ticker: evaluation.ticker.toUpperCase(),
    pattern: evaluation.pattern,
    state: "new",
    day_count: 1,
    first_session: session,
    last_evaluated: session,
    sessions: [session],
    values: evaluation.values,
    modifiers: evaluation.modifiers,
    qualifying_sessions: evaluation.qualifying_sessions,
    sessions_view: evaluation.sessions_view,
    read: evaluation.read ?? "",
    ended_at: null,
    ended_reason: null,
  };
}

function endFinding(finding: ScreenFinding, session: string, reason: ScreenFinding["ended_reason"]): ScreenFinding {
  return { ...finding, state: "ended", ended_at: session, ended_reason: reason, last_evaluated: session >= finding.last_evaluated ? session : finding.last_evaluated };
}

export function applyEvaluations(input: LifecycleInput): LifecycleResult {
  const { session, config } = input;
  const universe = new Set(input.universe.map((t) => t.toUpperCase()));
  let findings = input.state.findings.map((f) => ({ ...f }));
  let created = 0;
  let continued = 0;
  let ended = 0;

  const openIndex = (ticker: string, pattern: ScreenPattern): number => findings.findIndex((f) => f.ended_at == null && f.ticker === ticker && f.pattern === pattern);

  for (const evaluation of input.evaluations) {
    const ticker = evaluation.ticker.toUpperCase();
    const idx = openIndex(ticker, evaluation.pattern);
    const open = idx >= 0 ? findings[idx] : null;

    if (evaluation.status === "present") {
      if (open) {
        const had = open.sessions.includes(session);
        const next = applyPresent(open, evaluation, session);
        findings[idx] = next;
        if (!had) {
          if (next.day_count === 1) created++;
          else continued++;
        }
        continue;
      }
      // A finding that ended on this very session (an earlier re-run read it as
      // false) or carries this id re-opens instead of duplicating.
      const id = findingId(ticker, evaluation.pattern, session);
      const reopenIdx = findings.findIndex((f) => f.ticker === ticker && f.pattern === evaluation.pattern && f.ended_at != null && (f.id === id || f.ended_at === session));
      if (reopenIdx >= 0) {
        const prev = findings[reopenIdx];
        const next = applyPresent(prev, evaluation, session);
        findings[reopenIdx] = next;
        if (next.day_count === 1) created++;
        else continued++;
        continue;
      }
      findings.push(newFinding(evaluation, session));
      created++;
      continue;
    }

    if (evaluation.status === "absent") {
      if (!open) continue;
      const sessions = open.sessions.filter((s) => s !== session);
      if (sessions.length === 0) {
        // The only session it held was this one and a re-run says otherwise — it never existed.
        findings.splice(idx, 1);
        continue;
      }
      const last = sessions[sessions.length - 1];
      const trimmed: ScreenFinding = { ...open, sessions, day_count: sessions.length, first_session: sessions[0] };
      if (session > last) {
        findings[idx] = endFinding(trimmed, session, "condition_false");
        ended++;
      } else {
        findings[idx] = trimmed;
      }
      continue;
    }
    // n_a: untouched here; the stale rule below handles lingering findings.
  }

  // Universe + stale sweep over whatever is still open.
  findings = findings.map((f) => {
    if (f.ended_at != null) return f;
    if (!universe.has(f.ticker)) {
      ended++;
      return endFinding(f, session, "untracked");
    }
    if (session > f.last_evaluated && tradingDaysBetween(f.last_evaluated, session) >= config.staleEndSessions) {
      ended++;
      return endFinding(f, session, "not_evaluable");
    }
    return f;
  });

  findings.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.pattern.localeCompare(b.pattern) || a.first_session.localeCompare(b.first_session));
  return { state: { ...input.state, findings }, new: created, continuing: continued, ended };
}

/** Drop ended findings (and scans) older than the retention window relative to `nowYmd`. */
export function pruneState(state: ScreenStoreState, nowYmd: string, retentionDays: number): ScreenStoreState {
  const cutoffMs = Date.parse(`${nowYmd}T00:00:00Z`) - retentionDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoffMs)) return state;
  const keepYmd = new Date(cutoffMs).toISOString().slice(0, 10);
  return {
    ...state,
    findings: state.findings.filter((f) => f.ended_at == null || f.ended_at >= keepYmd),
    scans: state.scans.filter((s) => s.session >= keepYmd),
  };
}

/** Active findings, panel order: day_count desc, then pattern priority, then ticker. */
export function activeFindings(state: ScreenStoreState, config: ScreenConfig): ScreenFinding[] {
  return state.findings
    .filter((f) => f.ended_at == null)
    .sort((a, b) => b.day_count - a.day_count || config.patterns[a.pattern].priority - config.patterns[b.pattern].priority || a.ticker.localeCompare(b.ticker));
}

/** Ended findings, newest end first. */
export function endedFindings(state: ScreenStoreState): ScreenFinding[] {
  return state.findings.filter((f) => f.ended_at != null).sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? "") || a.ticker.localeCompare(b.ticker));
}
