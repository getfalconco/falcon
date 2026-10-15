/**
 * When the portfolio tracker writes a `portfolio_snapshots` row, and how old
 * rows are thinned out.
 *
 * The tracker used to insert one row per user every ~5 seconds, around the
 * clock, whether or not the value had moved: about 17,000 rows per user per
 * day, kept forever. The chart cannot draw more than one point per pixel (a
 * 24h Day view is ~90s per pixel), the desktop's privacy export stops at
 * 10,000 rows, and most of those rows repeated the previous value.
 *
 * Write side: a row is written only when the value moved meaningfully, never
 * more often than the session allows, plus a heartbeat so a flat stretch is
 * still drawn flat (a line between two distant points would otherwise slope
 * across hours when nothing traded).
 *
 * Retention: older rows are downsampled by a periodic job
 * (portfolio-retention.ts): one per minute after a day, one per hour after a
 * week, one per day after 90 days. The last row of each bucket is kept, so
 * each surviving point is that period's closing value.
 *
 * Pure functions only, so the policy is testable without Supabase or a clock.
 */

/** Minimum spacing between two rows for one user, by US market session. */
export const SNAPSHOT_MIN_INTERVAL_MS = {
  /** 09:30–16:00 ET, Mon–Fri: at most one row per minute. */
  regular: 60_000,
  /** 04:00–09:30 and 16:00–20:00 ET, Mon–Fri: at most one row per 5 minutes. */
  extended: 5 * 60_000,
  /** Overnight and weekends: at most one row per hour. */
  closed: 60 * 60_000,
} as const;

/** An unchanged value is still written this often, so flat stretches stay flat. */
export const SNAPSHOT_HEARTBEAT_MS = 60 * 60_000;

/** A change smaller than both of these is not a change (rounding, a cent of drift). */
export const SNAPSHOT_MIN_ABS_CHANGE = 0.01;
/** 0.5 basis point of the book. */
export const SNAPSHOT_MIN_REL_CHANGE = 0.00005;

/** Downsampling thresholds for rows already written (retention job). */
export const SNAPSHOT_RETENTION = {
  /** Older than this: at most one row per minute (thins pre-throttle backlog). */
  minuteAfterMs: 24 * 60 * 60_000,
  /** Older than this: at most one row per hour. */
  hourAfterMs: 7 * 24 * 60 * 60_000,
  /** Older than this: at most one row per day (UTC). */
  dayAfterMs: 90 * 24 * 60 * 60_000,
} as const;

export type MarketSession = keyof typeof SNAPSHOT_MIN_INTERVAL_MS;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The US equity session at `at`. Exchange holidays are not modelled: on a
 * holiday prices do not move, so the change threshold suppresses the rows the
 * looser cadence would otherwise allow.
 */
export function marketSession(at: Date): MarketSession {
  const parts = Object.fromEntries(ET_PARTS.formatToParts(at).map((p) => [p.type, p.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "closed";
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 4 * 60 && minutes < 20 * 60) return "extended";
  return "closed";
}

export type LastWrite = { at: number; value: number };

/** True when `value` at `now` deserves a new row, given the user's last written row. */
export function shouldWriteSnapshot(
  last: LastWrite | undefined,
  now: number,
  value: number,
  session: MarketSession = marketSession(new Date(now)),
): boolean {
  if (!Number.isFinite(value)) return false;
  if (!last) return true;
  const elapsed = now - last.at;
  if (elapsed < SNAPSHOT_MIN_INTERVAL_MS[session]) return false;
  const threshold = Math.max(SNAPSHOT_MIN_ABS_CHANGE, Math.abs(last.value) * SNAPSHOT_MIN_REL_CHANGE);
  // The epsilon keeps binary float noise (5.01 - 5 = 0.00999…) from eating a real cent.
  if (Math.abs(value - last.value) >= threshold - 1e-9) return true;
  return elapsed >= SNAPSHOT_HEARTBEAT_MS;
}

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

/**
 * The bucket a row belongs to for retention, or null when it is still young
 * enough to keep as written. Buckets are UTC so the job is deterministic.
 */
export function retentionBucket(tsMs: number, nowMs: number): string | null {
  const age = nowMs - tsMs;
  const iso = new Date(tsMs).toISOString();
  if (age >= SNAPSHOT_RETENTION.dayAfterMs) return `d:${iso.slice(0, 10)}`;
  if (age >= SNAPSHOT_RETENTION.hourAfterMs) return `h:${iso.slice(0, 13)}`;
  if (age >= SNAPSHOT_RETENTION.minuteAfterMs) return `m:${iso.slice(0, 16)}`;
  return null;
}

export type SnapshotRowRef = { id: number; ts: string };

/**
 * Stateful pass over one user's rows in ascending (ts, id) order, across
 * pages: every row followed by a later row in the same bucket is marked for
 * deletion, so each bucket keeps exactly its last row. A bucket is never left
 * empty, and a second pass over the result marks nothing (idempotent).
 */
export class DownsampleWalker {
  private bucket: string | null = null;
  private keeper: SnapshotRowRef | null = null;

  constructor(private readonly nowMs: number) {}

  /** Feed the next page; returns the ids to delete from it (and the page before). */
  feed(rows: SnapshotRowRef[]): number[] {
    const doomed: number[] = [];
    for (const row of rows) {
      const t = Date.parse(row.ts);
      const bucket = Number.isFinite(t) ? retentionBucket(t, this.nowMs) : null;
      if (bucket !== null && bucket === this.bucket && this.keeper) {
        doomed.push(this.keeper.id);
      }
      this.bucket = bucket;
      this.keeper = row;
    }
    return doomed;
  }
}

/** Convenience for tests and one-shot use: the ids a full pass would delete. */
export function idsToDownsample(rows: SnapshotRowRef[], nowMs: number): number[] {
  return new DownsampleWalker(nowMs).feed(rows);
}
