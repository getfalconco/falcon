/**
 * Indicator math on one price series. Every function returns an array the
 * length of its input; value i uses only inputs 0..i (no look-ahead), and is
 * NaN until enough history exists. Pure.
 */

export function sma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA with alpha 2/(period+1), seeded with the simple average of the first `period` values. */
export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i]! + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's RSI: the first average gain/loss is the simple mean of the first
 * `period` changes, then each is smoothed as (prev * (period - 1) + x) / period.
 * All gains and no losses gives 100; a flat series gives 50.
 */
export function rsi(closes: readonly number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = value(gain, loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value(gain, loss);
  }
  return out;
}

/** Percent change of the close over `days` sessions. */
export function nDayReturn(closes: readonly number[], days: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  for (let i = days; i < closes.length; i++) {
    const base = closes[i - days]!;
    if (base > 0) out[i] = (closes[i]! / base - 1) * 100;
  }
  return out;
}

/** Percent gap of each open against the previous close. */
export function gapPct(opens: readonly number[], closes: readonly number[]): number[] {
  const out = new Array<number>(opens.length).fill(NaN);
  for (let i = 1; i < opens.length; i++) {
    const prev = closes[i - 1]!;
    if (prev > 0) out[i] = (opens[i]! / prev - 1) * 100;
  }
  return out;
}

/** Highest (or lowest) close of the `days` sessions before i, excluding i. */
export function priorExtreme(closes: readonly number[], days: number, kind: "max" | "min"): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  // Monotonic deque of indices over the window [i - days, i - 1].
  const dq: number[] = [];
  let head = 0;
  const better = kind === "max" ? (a: number, b: number) => a >= b : (a: number, b: number) => a <= b;
  for (let i = 0; i < closes.length; i++) {
    if (i >= days) {
      while (head < dq.length && dq[head]! < i - days) head++;
      out[i] = closes[dq[head]!]!;
    }
    while (dq.length > head && better(closes[i]!, closes[dq[dq.length - 1]!]!)) dq.pop();
    dq.push(i);
  }
  return out;
}
