/**
 * Handover briefing: the one request every consumer shares.
 *
 * The dashboard card, the panel and the host that decides whether the panel
 * opens by itself all read the same report. Each of them fetching for itself
 * would mean three provider rounds per arrival and three answers that can
 * disagree by a minute, so the report lives here as module state (the way
 * `demo-mode.ts` holds its snapshot) and everything else subscribes.
 *
 * The store asks only while somebody is looking: consumers that are on screen
 * call `retainBriefing()`, and the poll runs only while at least one of them
 * holds it AND the window is visible. A briefing nobody can see is not worth a
 * round of provider calls every five minutes.
 *
 * Nothing that comes back from the main process is trusted to be display text:
 * a failure is folded into one of the fixed `BriefingErrorCode` values before
 * it is stored, so no provider message (and so no key or token that one could
 * carry) can reach a component through this state.
 */

import { getDemoSnapshot, mulberry32, subscribeDemoMode } from "@/lib/demo-mode";
import { readPaperAccount, subscribePaperAccount, type PaperAccount } from "@/lib/paper-account";
import { buildRiskAccountPush } from "@/lib/risk-account-bridge";
import { buildDemoBriefing } from "../../shared/briefing-demo";
import {
  resolveBriefingWindow,
  type BriefingErrorCode,
  type BriefingGetResult,
  type BriefingHolding,
  type BriefingNarrative,
  type BriefingNarrativeResult,
  type BriefingPhase,
  type BriefingReport,
  type Story,
} from "../../shared/briefing-types";
import { effectivePhase } from "../../shared/briefing-view";

export type BriefingStatus = "idle" | "loading" | "ready" | "error" | "unsupported";

export type BriefingState = {
  /**
   * "unsupported" is a main process that predates the briefing handlers (the
   * renderer hot-reloads, main and preload do not). It is not an error the
   * reader can retry their way out of, so it is its own state.
   */
  status: BriefingStatus;
  report: BriefingReport | null;
  /** Set on a failed request. A report that was already there stays, with the code beside it. */
  error: BriefingErrorCode | null;
  /** A request is out while an earlier report is still on screen. */
  refreshing: boolean;
  fetchedAt: number | null;
};

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/**
 * How often the report is asked for again, by where the reader stands. Before
 * the open the futures and the pre-market prints are the point of the panel,
 * so five minutes. In session the overnight story is settled and only the
 * calendar's "now" line moves (the view does that from the clock). After the
 * close nothing in the report changes until Asia opens.
 */
const CADENCE_MS: Record<BriefingPhase, number> = {
  pre_open: 5 * 60_000,
  in_session: 30 * 60_000,
  between_sessions: 60 * 60_000,
};

/** The open turns every "pre-market" figure into a session figure; one request just after it catches that. */
export const OPEN_REFETCH_DELAY_MS = 5_000;

/** A trade writes cash and positions as separate events; this gap lets them land as one request. */
export const HOLDINGS_DEBOUNCE_MS = 2_500;

/** The manual refresh skips the main-process cache, so every press is a full provider round. */
export const MANUAL_REFRESH_THROTTLE_MS = 15_000;

/**
 * The demo report draws from its own stream rather than the book's. Seeded
 * with the bare demo seed it would replay the rolls that picked the holdings,
 * and the night's moves would be a function of which names were drawn.
 */
const DEMO_SEED_OFFSET = 7919;

export function cadenceMs(phase: BriefingPhase): number {
  return CADENCE_MS[phase] ?? CADENCE_MS.between_sessions;
}

/**
 * What "the same book" means for the purpose of asking again. Shares at four
 * decimals because that is what the paper account stores; cash to the dollar
 * because it carries float residue after every fill, and a key that changed on
 * residue would re-request the report for a book that did not move. Cost basis
 * is left out: it only ever changes together with the share count.
 */
export function holdingsKey(holdings: readonly BriefingHolding[], cash: number): string {
  const parts = holdings
    .map((h) => {
      const shares = Number.isFinite(h.shares) ? h.shares.toFixed(4) : "0.0000";
      return `${h.symbol.trim().toUpperCase()}:${shares === "-0.0000" ? "0.0000" : shares}`;
    })
    .sort();
  return `${parts.join(",")}|${Number.isFinite(cash) ? Math.round(cash) : 0}`;
}

/** Older than one cadence for the phase, or never fetched at all. */
export function isStale(fetchedAt: number | null, phase: BriefingPhase, nowMs: number): boolean {
  if (fetchedAt === null || !Number.isFinite(fetchedAt)) return true;
  return nowMs - fetchedAt >= cadenceMs(phase);
}

/**
 * Milliseconds until the next request is due: one cadence after the last
 * attempt, or just after the open when that comes first. Zero means "now",
 * which is what a machine waking from sleep past either moment gets.
 *
 * Counted from the last ATTEMPT, not the last success, so a provider that is
 * down is asked once per cadence instead of in a tight loop.
 */
export function nextPollDelayMs(input: {
  lastAttemptAt: number;
  phase: BriefingPhase;
  targetOpenAt: string | null;
  nowMs: number;
}): number {
  const due = input.lastAttemptAt + cadenceMs(input.phase);
  const open = input.targetOpenAt ? Date.parse(input.targetOpenAt) : Number.NaN;
  const afterOpen = open + OPEN_REFETCH_DELAY_MS;
  // Only an open the last attempt has not seen yet pulls the request forward;
  // without that test, every request after 09:30 would schedule the next one
  // for "now" and the poll would spin.
  const next = Number.isFinite(afterOpen) && afterOpen > input.lastAttemptAt && afterOpen < due ? afterOpen : due;
  return Math.max(0, next - input.nowMs);
}

/**
 * The paper account (or the demo book standing in for it) as the engine's
 * request. It goes through the Risk bridge's own reading of the account so the
 * two engines can never disagree about what counts as a position: the same
 * dust threshold, the same upper-casing. `risk.matches_book` in the report
 * depends on exactly that agreement.
 */
export function requestFromAccount(account: PaperAccount): { holdings: BriefingHolding[]; cash: number } {
  // The demo flag and the clock only stamp the push, and the stamp is not used here.
  const push = buildRiskAccountPush(account, false, new Date(0));
  return {
    holdings: push.positions.map((p) => ({
      symbol: p.ticker,
      shares: p.shares,
      cost_usd: Number.isFinite(p.cost_usd) ? p.cost_usd : 0,
    })),
    cash: push.cash,
  };
}

/**
 * Every overnight section came back empty: no market row with a usable move
 * and nothing at all on the held names. Such a report is still worth opening
 * by hand (the calendar is curated and does not fail), but it is not worth
 * laying over the dashboard uninvited.
 */
export function isFullyDegraded(report: BriefingReport): boolean {
  const o = report.overnight;
  const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const markets = Array.isArray(o?.markets) ? o.markets : [];
  const usable = markets.filter((r) => r.state !== "unavailable" && r.state !== "stale" && typeof r.move === "number");
  return (
    usable.length === 0 &&
    count(o?.held_movers) === 0 &&
    count(o?.held_news) === 0 &&
    count(o?.filings) === 0 &&
    count(o?.measurements) === 0
  );
}

const ERROR_CODES: readonly BriefingErrorCode[] = ["invalid_request", "build_failed", "not_found", "unavailable"];

/** Anything that is not one of the fixed codes (a message, an Error, a newer build's code) reads as "unavailable". */
export function toErrorCode(value: unknown): BriefingErrorCode {
  return ERROR_CODES.includes(value as BriefingErrorCode) ? (value as BriefingErrorCode) : "unavailable";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const IDLE: BriefingState = { status: "idle", report: null, error: null, refreshing: false, fetchedAt: null };

let state: BriefingState = IDLE;
const listeners = new Set<() => void>();

let retainCount = 0;
let detach: (() => void) | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let holdingsTimer: ReturnType<typeof setTimeout> | null = null;

let inFlight: Promise<void> | null = null;
let inFlightKey = "";
/** A request that arrived while another was out: run once more when it lands. */
let rerun: { force: boolean } | null = null;
/**
 * Bumped whenever what is in flight stops being wanted (demo toggled, store
 * reset). A reply from an earlier epoch is dropped, which is what keeps a real
 * report from landing on top of a demo one a second after Ctrl+P.
 */
let epoch = 0;

/** The holdings key the stored report was built for. */
let reportKey: string | null = null;
let lastAttemptAt: number | null = null;
let lastManualAt = 0;

const narrativeAsked = new Set<string>();
/** The last model-written narrative received, kept so a poll that returns the template for the same facts does not undo it. */
let modelNarrative: BriefingNarrative | null = null;
/** The stories that came with it, kept for the same reason; null when the answer carried none. */
let modelStories: Story[] | null = null;

function setState(patch: Partial<BriefingState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

export function getBriefingState(): BriefingState {
  return state;
}

export function subscribeBriefing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// This module is imported by node-side tests, where neither global exists.
function bridge(): Window["meridian"] {
  return typeof window === "undefined" ? undefined : window.meridian;
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

/**
 * The phase as of now. From the report when there is one; otherwise from the
 * engine's own window rule, so the retry pace after a failed first request
 * still follows the session.
 */
function currentPhase(now: Date): BriefingPhase {
  if (state.report) return effectivePhase(state.report, now);
  try {
    return resolveBriefingWindow(now).phase;
  } catch {
    return "between_sessions";
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function isReportShaped(report: unknown): report is BriefingReport {
  if (typeof report !== "object" || report === null) return false;
  const r = report as Partial<BriefingReport>;
  return typeof r.window === "object" && r.window !== null && typeof r.window.target_session_ymd === "string";
}

function withKeptNarrative(report: BriefingReport): BriefingReport {
  if (report.narrative?.source === "model") return report;
  if (modelNarrative && modelNarrative.facts_hash === report.facts_hash) {
    return { ...report, narrative: modelNarrative, ...(modelStories ? { stories: modelStories } : {}) };
  }
  return report;
}

/**
 * The report ships with the template narrative and `pending` set while the
 * model writes its version. One follow-up call per set of facts fetches it.
 * A failed call frees the slot again, so the next scheduled report (a cadence
 * away, never sooner) can ask once more; without that, one dropped call would
 * pin the template for the whole session.
 */
function askForNarrative(report: BriefingReport, atEpoch: number): void {
  const ask = bridge()?.getBriefingNarrative;
  if (report.narrative?.pending !== true || typeof ask !== "function") return;
  const request = { target_session_ymd: report.window.target_session_ymd, facts_hash: report.facts_hash };
  const slot = `${request.target_session_ymd}|${request.facts_hash}`;
  if (narrativeAsked.has(slot)) return;
  narrativeAsked.add(slot);

  void Promise.resolve()
    .then(() => ask(request))
    .then((answer: BriefingNarrativeResult) => {
      if (atEpoch !== epoch) return;
      if (!answer || answer.ok !== true || typeof answer.narrative?.text !== "string") {
        narrativeAsked.delete(slot);
        return;
      }
      // The figures on screen may have moved on while the model wrote. Prose
      // about last request's numbers beside this request's numbers is worse
      // than the template, so an answer for other facts is dropped.
      const shown = state.report;
      if (!shown || shown.facts_hash !== request.facts_hash || answer.narrative.facts_hash !== request.facts_hash) return;
      // The stories are settled in the same model call as the lead, so they
      // arrive together and are kept together: the next poll carries the
      // template's version of both for the same facts, and must undo neither.
      // Guarded, because a main process from before the field sends none.
      const stories = Array.isArray(answer.stories) ? answer.stories : null;
      if (answer.narrative.source === "model") {
        modelNarrative = answer.narrative;
        modelStories = stories;
      }
      setState({ report: { ...shown, narrative: answer.narrative, ...(stories ? { stories } : {}) } });
    })
    .catch(() => {
      if (atEpoch === epoch) narrativeAsked.delete(slot);
    });
}

function buildDemo(seed: number, holdings: BriefingHolding[], cash: number, key: string): void {
  try {
    const report = buildDemoBriefing(mulberry32(seed + DEMO_SEED_OFFSET), resolveBriefingWindow(new Date()), holdings, cash);
    reportKey = key;
    lastAttemptAt = Date.now();
    setState({ status: "ready", report, error: null, refreshing: false, fetchedAt: lastAttemptAt });
  } catch {
    setState({ status: "error", report: null, error: "build_failed", refreshing: false });
  }
}

/**
 * One request to the main process, or the demo report built on the spot.
 *
 * There is never more than one request out. A call that arrives meanwhile gets
 * the same promise back; if it wanted something the request in flight does not
 * cover (another book, a round that skips the cache), one more request follows
 * it.
 */
function requestReport(force: boolean): Promise<void> {
  const { holdings, cash } = requestFromAccount(readPaperAccount());
  const key = holdingsKey(holdings, cash);

  // A demo book is assembled here and never crosses into the main process:
  // the point of presentation mode is that it needs no network and no keys.
  const demo = getDemoSnapshot();
  if (demo) {
    buildDemo(demo.seed, holdings, cash, key);
    return Promise.resolve();
  }

  if (inFlight) {
    if (force || key !== inFlightKey) rerun = { force: force || rerun?.force === true };
    return inFlight;
  }

  const get = bridge()?.getBriefing;
  if (typeof get !== "function") {
    pollTimer = clearTimer(pollTimer);
    setState({ status: "unsupported", report: null, error: null, refreshing: false });
    return Promise.resolve();
  }

  const atEpoch = epoch;
  inFlightKey = key;
  setState(state.report ? { status: "ready", refreshing: true } : { status: "loading", error: null, refreshing: false });

  const pending: Promise<void> = Promise.resolve()
    .then(() => get({ holdings, cash, demo: false, ...(force ? { force: true } : {}) }))
    .then(
      (result: BriefingGetResult) => result,
      // A rejected invoke carries the main process's own message. It is
      // dropped here on purpose; only a fixed code goes into the state.
      () => null,
    )
    .then((result) => {
      if (atEpoch !== epoch) return;
      lastAttemptAt = Date.now();
      if (result && result.ok === true && isReportShaped(result.report)) {
        reportKey = key;
        setState({
          status: "ready",
          report: withKeptNarrative(result.report),
          error: null,
          refreshing: false,
          fetchedAt: lastAttemptAt,
        });
        askForNarrative(result.report, atEpoch);
        return;
      }
      const code: BriefingErrorCode =
        result === null ? "unavailable" : result.ok === false ? toErrorCode(result.error) : "build_failed";
      setState(state.report ? { error: code, refreshing: false } : { status: "error", error: code, refreshing: false });
    })
    .finally(() => {
      // A reset or a demo toggle may have put its own request in the slot
      // meanwhile; only the request that still owns it clears it.
      if (inFlight !== pending) return;
      inFlight = null;
      const again = rerun;
      rerun = null;
      if (again) void requestReport(again.force);
      else schedulePoll();
    });
  inFlight = pending;
  return pending;
}

/**
 * Asks for the report. `force` is the manual refresh: it skips the main
 * process's report cache and is throttled here, because every press is a full
 * provider round. Everything else (the poll, a changed book, a retry after an
 * error) goes without it and is limited only by "one request at a time".
 */
export function refreshBriefing(options: { force?: boolean } = {}): Promise<void> {
  if (options.force !== true) return requestReport(false);
  const now = Date.now();
  if (now < manualRefreshAvailableAt()) return inFlight ?? Promise.resolve();
  lastManualAt = now;
  return requestReport(true);
}

/** When the manual refresh takes a press again, so a button can show itself as resting until then. */
export function manualRefreshAvailableAt(): number {
  return lastManualAt === 0 ? 0 : lastManualAt + MANUAL_REFRESH_THROTTLE_MS;
}

// ---------------------------------------------------------------------------
// Polling and the events that bring a request forward
// ---------------------------------------------------------------------------

function schedulePoll(): void {
  pollTimer = clearTimer(pollTimer);
  // A demo report is pinned to the moment it was built for and has nothing to
  // refetch; an unsupported main process has nothing to answer with.
  if (retainCount === 0 || !isVisible() || getDemoSnapshot() || state.status === "unsupported") return;
  if (lastAttemptAt === null) return;
  const now = new Date();
  const delay = nextPollDelayMs({
    lastAttemptAt,
    phase: currentPhase(now),
    targetOpenAt: state.report?.window.target_open_at ?? null,
    nowMs: now.getTime(),
  });
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void requestReport(false);
  }, delay);
}

function currentKey(): string {
  const { holdings, cash } = requestFromAccount(readPaperAccount());
  return holdingsKey(holdings, cash);
}

function onAccountChange(): void {
  holdingsTimer = clearTimer(holdingsTimer);
  // The account event also fires for things that leave the book as it was (a
  // cloud sync writing back the same positions, the demo toggle's own
  // broadcast after this store already rebuilt), so the key decides.
  const key = currentKey();
  if (key === reportKey || (inFlight !== null && key === inFlightKey)) return;
  holdingsTimer = setTimeout(() => {
    holdingsTimer = null;
    if (retainCount > 0 && currentKey() !== reportKey) void requestReport(false);
  }, HOLDINGS_DEBOUNCE_MS);
}

function onDemoChange(): void {
  // Whatever is on screen belongs to the other mode now. It is dropped rather
  // than left up while the replacement loads: a real book shown under a "demo"
  // chip, even for a second, is the one mix-up presentation mode exists to
  // make impossible.
  dropReport();
  if (retainCount > 0) void requestReport(false);
}

function onReturn(): void {
  if (retainCount === 0) return;
  if (!isVisible()) {
    pollTimer = clearTimer(pollTimer);
    return;
  }
  if (getDemoSnapshot() || state.status === "unsupported") return;
  if (isStale(lastAttemptAt, currentPhase(new Date()), Date.now())) void requestReport(false);
  else schedulePoll();
}

function dropReport(): void {
  epoch += 1;
  inFlight = null;
  inFlightKey = "";
  rerun = null;
  reportKey = null;
  lastAttemptAt = null;
  modelNarrative = null;
  modelStories = null;
  narrativeAsked.clear();
  pollTimer = clearTimer(pollTimer);
  holdingsTimer = clearTimer(holdingsTimer);
  state = IDLE;
  for (const listener of [...listeners]) listener();
}

function attach(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  const offAccount = subscribePaperAccount(onAccountChange);
  const offDemo = subscribeDemoMode(onDemoChange);
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onReturn);
  return () => {
    offAccount();
    offDemo();
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
  };
}

/**
 * "I am on screen and showing this." Returns the release. The first holder
 * attaches the listeners and brings the report up to date; the last one to let
 * go stops the poll, so a closed panel beside a hidden card costs nothing.
 */
export function retainBriefing(): () => void {
  retainCount += 1;
  if (retainCount === 1) {
    detach = attach();
    // The listeners were off while nobody held the store, so the mode or the
    // signed-in user may have changed unseen. A report for another book is
    // dropped, not shown while its replacement loads.
    const demoNow = getDemoSnapshot() !== null;
    if (state.report && (state.report.demo !== demoNow || reportKey !== currentKey())) dropReport();
    // A restart is the only way out of "unsupported", but a demo needs no
    // main process at all, so the question is asked again on each first hold.
    if (state.status === "unsupported") state = IDLE;
  }

  const live = state.status !== "unsupported" && getDemoSnapshot() === null;
  if (state.status === "idle" || (live && isStale(lastAttemptAt, currentPhase(new Date()), Date.now()))) {
    void requestReport(false);
  } else if (pollTimer === null) {
    schedulePoll();
  }

  let released = false;
  return () => {
    // A holder that releases twice (an effect cleanup run again) must not let
    // go on behalf of someone else.
    if (released) return;
    released = true;
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount > 0) return;
    pollTimer = clearTimer(pollTimer);
    holdingsTimer = clearTimer(holdingsTimer);
    detach?.();
    detach = null;
  };
}

/** Back to a blank store: sign-out, and the start of every test. Holders stay held. */
export function resetBriefingStore(): void {
  dropReport();
  lastManualAt = 0;
}
