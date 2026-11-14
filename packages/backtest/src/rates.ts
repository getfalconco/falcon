/** T-bill rate points and the daily cash rate. Pure (the fetch is in data/fred.ts). */

export type RatePoint = { date: string; rate: number };

/**
 * Daily cash return per session, aligned on `dates`: the rate known before
 * the session starts (the latest observation dated before it), / 100 / 252.
 */
export function dailyCashRates(dates: readonly string[], points: readonly RatePoint[]): Float64Array {
  const out = new Float64Array(dates.length);
  let j = -1;
  for (let t = 0; t < dates.length; t++) {
    while (j + 1 < points.length && points[j + 1]!.date < dates[t]!) j++;
    out[t] = j >= 0 ? points[j]!.rate / 100 / 252 : 0;
  }
  return out;
}
