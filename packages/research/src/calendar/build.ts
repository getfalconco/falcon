/**
 * Session calendar: assembly.
 *
 * Calls the ports (the chain and the provider for each held name's earnings
 * dates, the optional overlay over the curated file), hands the answers to
 * the pure modules beside this file and puts their output together into one
 * `CalendarReport`. The arithmetic lives in those modules; what lives here is
 * the part that touches the outside world, and the rule that goes with it:
 * every input can fail on its own, and the calendar still ships with that
 * section marked, because a calendar that refuses to open when one provider
 * read times out is worth less than one that says which name is missing.
 *
 * The only clock is the `now` the caller passes in. Timers are used to bound
 * the port calls, never to read the time.
 */

import { addTradingDays } from "../tracker/calendar.js";
import { MACRO_CALENDAR } from "./data/macro-calendar.js";
import { expiryEventsBetween, type ExpiryEvent } from "./expiry.js";
import { coverageStatus, loadMacroCalendar, mergeCalendarOverlay, validateMacroCalendar } from "./macro-calendar.js";
import { rebalanceEventsBetween, type RebalanceEvent } from "./rebalance.js";
import { REBALANCE_HORIZON_SESSIONS, calendarToday, isRecord, nextEarnings } from "./today.js";
import { resolveSessionWindow } from "./window.js";
import {
  CALENDAR_SCHEMA_VERSION,
  type CalendarDegraded,
  type CalendarPorts,
  type CalendarReport,
  type CalendarRequest,
  type CalendarSectionKey,
  type CorporateCalendarRaw,
  type EarningsSlice,
  type MacroCalendarOverlay,
} from "./types.js";

export type BuildCalendarOptions = {
  /** Longest a single port call may take. Default 6000. */
  perCallTimeoutMs?: number;
  /** Longest the whole build may take; whatever is unfinished then counts as failed. Default 12000. */
  deadlineMs?: number;
  /** Port calls in flight per port. Default 4. */
  concurrency?: number;
};

const DEFAULT_PER_CALL_TIMEOUT_MS = 6000;
const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_CONCURRENCY = 4;

/**
 * What a held symbol may look like. The symbol is interpolated into provider
 * URLs by the ports, and it arrives over IPC from a renderer-side account a
 * user types into, so anything outside this shape is dropped before a port
 * ever sees it.
 */
const SYMBOL_SHAPE = /^[A-Z0-9.\-^=]{1,12}$/;

// ---------------------------------------------------------------------------
// Bounded, failure-collecting port calls
// ---------------------------------------------------------------------------

/**
 * The vocabulary of a failed call's `detail`. A caught error's own text is
 * never used for one: provider errors carry request ids, URLs and now and
 * then a key, and the report crosses into the renderer and onto disk.
 */
type CallFailure = "timed out" | "request failed" | "deadline reached" | "unusable response";

type Settled<T> = { ok: true; value: T } | { ok: false };

/** `seq` is the order in which calls were started, which is the order of the symbols they were started for. */
type Failure = { section: CalendarSectionKey; detail: string; symbols: string[]; seq: number };

const SECTION_ORDER: readonly CalendarSectionKey[] = ["macro_calendar", "earnings"];

type Settler = {
  settle<T>(section: CalendarSectionKey, symbols: string[], fn: () => Promise<T>, usable?: (value: T) => boolean): Promise<Settled<T>>;
  note(section: CalendarSectionKey, detail: string, symbols?: string[]): void;
  degraded(): CalendarDegraded[];
  dispose(): void;
};

function createSettler(perCallTimeoutMs: number, deadlineMs: number): Settler {
  const failures: Failure[] = [];
  let started = 0;

  let expired = false;
  let expire: () => void = () => {};
  const deadline = new Promise<"deadline">((resolve) => {
    expire = () => resolve("deadline");
  });
  const deadlineTimer = setTimeout(() => {
    expired = true;
    expire();
  }, deadlineMs);

  const fail = (section: CalendarSectionKey, detail: CallFailure, symbols: string[], seq: number): void => {
    failures.push({ section, detail, symbols, seq });
  };

  return {
    async settle(section, symbols, fn, usable) {
      const seq = ++started;
      // A call still queued behind the concurrency limit when the deadline
      // passes is not started at all: its answer could not be used, and the
      // request would only add load to a provider that is already slow.
      if (expired) {
        fail(section, "deadline reached", symbols, seq);
        return { ok: false };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), perCallTimeoutMs);
      });
      try {
        // Started inside a then() so a port that throws synchronously is
        // caught like one that rejects.
        const call = Promise.resolve()
          .then(fn)
          .then((value) => ({ value }));
        const outcome = await Promise.race([call, timeout, deadline]);
        if (outcome === "timeout" || outcome === "deadline") {
          fail(section, outcome === "timeout" ? "timed out" : "deadline reached", symbols, seq);
          return { ok: false };
        }
        if (usable && !usable(outcome.value)) {
          fail(section, "unusable response", symbols, seq);
          return { ok: false };
        }
        return { ok: true, value: outcome.value };
      } catch {
        fail(section, "request failed", symbols, seq);
        return { ok: false };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    note(section, detail, symbols = []) {
      failures.push({ section, detail, symbols, seq: ++started });
    },

    /**
     * One entry per section and reason, sections in a fixed order and symbols
     * in the order their calls were started, so the same failures produce the
     * same list whichever call happened to come back first. A name whose two
     * calls both failed the same way is listed once.
     */
    degraded() {
      const out: CalendarDegraded[] = [];
      for (const section of SECTION_ORDER) {
        const own = failures.filter((f) => f.section === section).sort((a, b) => a.seq - b.seq);
        const byDetail = new Map<string, string[] | null>();
        for (const f of own) {
          const known = byDetail.get(f.detail);
          if (f.symbols.length === 0 || known === null) byDetail.set(f.detail, null);
          else byDetail.set(f.detail, [...new Set([...(known ?? []), ...f.symbols])]);
        }
        for (const [detail, symbols] of byDetail) {
          out.push(symbols === null ? { section, detail } : { section, detail, symbols });
        }
      }
      return out;
    },

    dispose() {
      clearTimeout(deadlineTimer);
    },
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

/**
 * The symbols the calendar is for: upper-cased, de-duplicated, in input order.
 * A row without a real, non-zero share count is dust or a closed position and
 * gets no provider call; a symbol outside the shape never reaches a URL.
 */
function heldSymbols(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!isRecord(row)) continue;
    const shares = Number(row.shares);
    if (!Number.isFinite(shares) || shares === 0) continue;
    const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    if (!SYMBOL_SHAPE.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The overlay is fetched at run time and hand-written, so it is held to the
 * same validator as the shipped file, and a port that fails to deliver one is
 * no different from a port that was never wired: the shipped file stands. A
 * rejected overlay costs its corrections, not the calendar.
 */
async function readOverlay(ports: CalendarPorts, settler: Settler): Promise<MacroCalendarOverlay | null> {
  if (typeof ports.calendarOverlay !== "function") return null;
  let overlay: unknown;
  try {
    overlay = await ports.calendarOverlay();
  } catch {
    return null;
  }
  if (!isRecord(overlay)) return null;
  let problems: string[];
  try {
    problems = validateMacroCalendar(mergeCalendarOverlay(MACRO_CALENDAR, overlay as MacroCalendarOverlay));
  } catch {
    problems = ["overlay is not a calendar overlay"];
  }
  if (problems.length > 0) {
    settler.note("macro_calendar", `overlay rejected: ${problems[0]}`);
    return null;
  }
  return overlay as MacroCalendarOverlay;
}

/**
 * Builds the calendar for the session `now` falls on. A port that fails,
 * hangs or answers with nonsense costs the rows it would have supplied,
 * which is listed in `degraded`, and the rest of the calendar stands. Throws
 * only for a clock the session calendar cannot resolve.
 */
export async function buildCalendarReport(
  req: CalendarRequest,
  now: Date,
  ports: CalendarPorts,
  opts: BuildCalendarOptions = {},
): Promise<CalendarReport> {
  const options = isRecord(opts) ? opts : {};
  const settler = createSettler(
    positiveOr(options.perCallTimeoutMs, DEFAULT_PER_CALL_TIMEOUT_MS),
    positiveOr(options.deadlineMs, DEFAULT_DEADLINE_MS),
  );
  const concurrency = Math.floor(positiveOr(options.concurrency, DEFAULT_CONCURRENCY));

  try {
    const cal = loadMacroCalendar(await readOverlay(ports, settler));
    // Resolved after the overlay has answered: an ad-hoc close decides which
    // session the calendar is for.
    const window = resolveSessionWindow(now, cal.session_overrides);
    const target = window.target_session_ymd;
    const held = heldSymbols(isRecord(req) ? req.holdings : []);

    const perSymbol = async <T>(call: (symbol: string) => Promise<T>, usable: (value: T) => boolean): Promise<Map<string, T | null>> => {
      const settled = await mapLimit(held, concurrency, (symbol) => settler.settle("earnings", [symbol], () => call(symbol), usable));
      const out = new Map<string, T | null>();
      held.forEach((symbol, i) => {
        const result = settled[i]!;
        out.set(symbol, result.ok ? result.value : null);
      });
      return out;
    };

    const [chain, corporate] = await Promise.all([
      // Null is an answer here ("not tracked"), not a failure.
      perSymbol<EarningsSlice | null>((s) => ports.earningsFromChain(s), (v) => v === null || isRecord(v)),
      perSymbol<CorporateCalendarRaw>((s) => ports.corporateCalendar(s), isRecord),
    ]);

    // The date rules throw on a malformed bound instead of returning an empty
    // list, which would read as "nothing scheduled".
    let expiries: ExpiryEvent[] = [];
    let rebalances: RebalanceEvent[] = [];
    try {
      expiries = expiryEventsBetween(target, target);
      rebalances = rebalanceEventsBetween(target, addTradingDays(target, REBALANCE_HORIZON_SESSIONS), cal.index_events);
    } catch {
      expiries = [];
      rebalances = [];
      settler.note("macro_calendar", "schedule rules failed");
    }

    const earnings = nextEarnings(held, chain, corporate, target);
    const items = calendarToday(window, cal, expiries, rebalances, earnings, held);
    const coverage = coverageStatus(target, cal);
    if (!coverage.covers_target) settler.note("macro_calendar", "calendar file does not reach this session");

    return {
      schema_version: CALENDAR_SCHEMA_VERSION,
      generated_at: now.toISOString(),
      demo: false,
      window,
      items,
      coverage,
      degraded: settler.degraded(),
    };
  } finally {
    settler.dispose();
  }
}
