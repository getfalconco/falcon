"use client";

import { OPTIONS_CAVEAT, optionsChip, optionsSentence, plusMinusPct, type OptionsMove, type RippleOptions } from "@falcon/ripple";
import { MONO, formatDateTime } from "./parts";

/**
 * The options block of a card or hit (OPRA via Databento). The API sends it
 * only to viewers OPTIONS_DISPLAY allows (founder admin by default, pending
 * display licensing), so these render nothing for everyone else.
 */

function moveText(m: OptionsMove | null): string | null {
  if (!m) return null;
  return m.marketAdjustedPct === null ? plusMinusPct(m.rawPct) : `${plusMinusPct(m.rawPct)} (${plusMinusPct(m.marketAdjustedPct)} beyond market)`;
}

function points(x: number | null | undefined): string | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  return `${x > 0 ? "+" : ""}${x.toFixed(1)} pts`;
}

/** Small numbers under the sentence: IV, week and month moves, skew, call-put spread. */
function Figures({ o }: { o: RippleOptions }) {
  const items: Array<[string, string, string]> = [];
  items.push(["ATM IV 30d", `${o.atmIv.toFixed(1)}%`, "At-the-money implied volatility, 30 calendar days"]);
  const w = moveText(o.impliedMove5);
  if (w) items.push(["Week", w, `Expected absolute move over 5 trading sessions, from the ${o.impliedMove5!.expiration} expiry`]);
  const m = moveText(o.impliedMove20);
  if (m) items.push(["Month", m, `Expected absolute move over 20 trading sessions, from the ${o.impliedMove20!.expiration} expiry`]);
  const sk = points(o.skew);
  if (sk) items.push(["Put skew", sk, "Out-of-the-money put IV minus at-the-money call IV, about 30 days (descriptive)"]);
  const cp = points(o.cpSpread);
  if (cp) items.push(["Call-put IV", cp, "Mean call IV minus put IV at the same strikes (descriptive)"]);
  return (
    <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-fs-12 text-quiet">
      {items.map(([k, v, title]) => (
        <div key={k} className="flex items-baseline gap-1.5" title={title}>
          <dt className="text-faint">{k}</dt>
          <dd className="tabular-nums text-fore-4" style={{ fontFamily: MONO }}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A compact "Options" row: the plain sentence, the figures, the as-of time, source and caveat. */
export function OptionsRow({ options, className = "" }: { options: RippleOptions | null | undefined; className?: string }) {
  if (!options) return null;
  const sentence = optionsSentence(options);
  return (
    <div className={`rounded-md border border-line/[0.08] bg-line/[0.02] px-3 py-2.5 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-fs-10.5 uppercase tracking-[0.1em] text-fore/50" style={{ fontFamily: MONO }}>
          Options
        </span>
        <span className="text-fs-11.5 text-faint">
          as of {formatDateTime(options.asOf)} · spot {options.spot.toFixed(2)} · {options.source}
        </span>
      </div>
      {sentence ? <p className="mt-1 text-fs-13 leading-fs-20 text-fore-4">{sentence}</p> : null}
      <Figures o={options} />
      <p className="mt-1.5 text-fs-11.5 leading-fs-17 text-faint">{OPTIONS_CAVEAT}</p>
    </div>
  );
}

/** "±4.1% priced" chip for list rows; nothing without a block. */
export function OptionsChip({ options, className = "" }: { options: RippleOptions | null | undefined; className?: string }) {
  const text = optionsChip(options);
  if (!text || !options) return null;
  const mv = options.impliedMove5 ?? options.impliedMove20;
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded border border-line/15 px-1.5 text-fs-10.5 leading-none tabular-nums text-fore-4 ${className}`}
      style={{ fontFamily: MONO }}
      title={`Options price a move of about ${text.replace(" priced", "")} over ${mv?.sessions === 20 ? "the next month" : "the next week"} (${options.source}, ${formatDateTime(options.asOf)})`}
    >
      {text}
    </span>
  );
}
