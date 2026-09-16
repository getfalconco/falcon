/**
 * Quant Lab trading calendar (§6).
 *
 * Derived from the benchmark's ACTUAL bar dates rather than from
 * `tracker/calendar.ts`'s algorithmic holiday table. The algorithmic version is
 * correct for the recurring holidays but carries no ad-hoc closures, and a
 * five-year window contains one (2025-01-09, the Carter national day of
 * mourning). A session the benchmark did not trade is not a session.
 *
 * Every horizon in a backtest — hold periods, "no earnings within N sessions",
 * sessions-until-event — counts on this calendar, so entry and exit dates are
 * always real trading days.
 */

import type { DailyBar } from "../tracker/types.js";

export class TradingCalendar {
  private readonly days: string[];
  private readonly index: Map<string, number>;

  private constructor(days: string[]) {
    this.days = days;
    this.index = new Map(days.map((d, i) => [d, i]));
  }

  /** Build from benchmark bars (SPY). Dates are de-duplicated and sorted. */
  static fromBars(benchBars: DailyBar[]): TradingCalendar {
    const seen = new Set<string>();
    for (const bar of benchBars) {
      if (!bar || typeof bar.d !== "string") continue;
      if (!Number.isFinite(bar.c)) continue;
      seen.add(bar.d);
    }
    return new TradingCalendar([...seen].sort((a, b) => a.localeCompare(b)));
  }

  /** Sessions in the calendar. */
  get length(): number {
    return this.days.length;
  }

  get first(): string | null {
    return this.days[0] ?? null;
  }

  get last(): string | null {
    return this.days[this.days.length - 1] ?? null;
  }

  /** All sessions, oldest first. Caller must not mutate. */
  sessions(): readonly string[] {
    return this.days;
  }

  has(session: string): boolean {
    return this.index.has(session);
  }

  /** Position of a session, or null when it is not a trading day. */
  positionOf(session: string): number | null {
    return this.index.get(session) ?? null;
  }

  /** Session `offset` trading days after `session` (negative walks back). Null past either end. */
  shift(session: string, offset: number): string | null {
    const at = this.index.get(session);
    if (at == null) return null;
    const target = at + offset;
    if (target < 0 || target >= this.days.length) return null;
    return this.days[target];
  }

  /**
   * Trading days from `from` to `to`, signed. Null when either date is not a
   * session — a caller asking "how many sessions until earnings" must not be
   * handed a number derived from a non-trading date.
   */
  between(from: string, to: string): number | null {
    const a = this.index.get(from);
    const b = this.index.get(to);
    if (a == null || b == null) return null;
    return b - a;
  }

  /** Sessions in `[from, to]` inclusive, oldest first. */
  range(from: string, to: string): string[] {
    const a = this.index.get(from) ?? 0;
    const b = this.index.get(to) ?? this.days.length - 1;
    if (a > b) return [];
    return this.days.slice(a, b + 1);
  }

  /**
   * The last session on or before `ymd`, for dates that may not themselves be
   * trading days (a filing accepted on a Saturday belongs to Friday's close).
   */
  onOrBefore(ymd: string): string | null {
    const exact = this.index.get(ymd);
    if (exact != null) return this.days[exact];
    let lo = 0;
    let hi = this.days.length - 1;
    let best: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid] <= ymd) {
        best = this.days[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /** The first session on or after `ymd`. */
  onOrAfter(ymd: string): string | null {
    const exact = this.index.get(ymd);
    if (exact != null) return this.days[exact];
    let lo = 0;
    let hi = this.days.length - 1;
    let best: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid] >= ymd) {
        best = this.days[mid];
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return best;
  }
}
