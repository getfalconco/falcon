/**
 * Pacing for text that streams in word by word (components/ui/streaming-text.tsx).
 * Pure, so it can be tested without a browser.
 *
 * The reveal runs at a reading pace (about 80 ms a word) while the stream is
 * slower than that, and speeds up with the backlog when it is faster: the
 * shown position closes CATCH_UP_S of the gap per second (an exponential
 * catch-up), so a steady fast stream is followed about half a second behind
 * and a burst (a whole answer after a tool round) types out in about 1.5 s.
 * The gap never exceeds MAX_LAG characters.
 */

export type RevealPace = {
  /** Characters a second at the reading pace (~80 ms a word at ~5.6 characters a word). */
  baseCps: number;
  /** Time constant of the catch-up, in seconds. */
  catchUpS: number;
  /** The shown text is never more than this many characters behind. */
  maxLag: number;
};

export const WORD_MS = 80;
export const REVEAL_PACE: RevealPace = { baseCps: 70, catchUpS: 0.45, maxLag: 1_200 };

/**
 * The next shown position after `dtS` seconds. `pos` is fractional (carried
 * between frames); text that shrank (a retry cut it back) is followed at once.
 */
export function revealStep(pos: number, target: number, dtS: number, pace: RevealPace = REVEAL_PACE): number {
  if (target <= pos) return target;
  const dt = Math.max(0, Math.min(dtS, 1));
  const backlog = target - pos;
  const cps = Math.max(pace.baseCps, backlog / pace.catchUpS);
  const next = Math.max(pos + cps * dt, target - pace.maxLag);
  return Math.min(target, next);
}

/** End of the word that `at` falls in, so a word is never cut in half on screen. */
export function wordEnd(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  if (/\s/.test(text[at - 1]!)) return at;
  const m = /\s/.exec(text.slice(at));
  return m ? at + m.index : text.length;
}

/** A text node cut into words with their trailing space ("Revenue ", "grew ", "12%"). */
export function splitWords(s: string): string[] {
  return s.match(/\S+\s*|\s+/g) ?? [];
}

/**
 * When each word (or chip, by key) first showed. A word is animated only while
 * it is younger than its fade, so a re-render or a re-parse of the Markdown
 * (a "**" closing into bold, a table forming) never fades shown words again.
 */
export class RevealClock {
  private born = new Map<string, number>();
  constructor(private readonly fadeMs: number) {}
  /** Whether the item `key` is still fading in at `now` (first sight counts as now). */
  fresh(key: string, now: number): boolean {
    let t = this.born.get(key);
    if (t === undefined) {
      t = now;
      this.born.set(key, t);
    }
    return now - t < this.fadeMs;
  }
  /** Marks keys as long shown (text that was already there when the instance mounted). */
  settle(key: string): void {
    if (!this.born.has(key)) this.born.set(key, -Infinity);
  }
}
