import type { ScreenTemplates } from "./config.js";
import { fill } from "./templates.js";

/**
 * The band card's headline. Deterministic: the same selection that fills the
 * chart picks the sentence, no model involved, and the wording lives in config
 * so it is calibration rather than code.
 *
 * The rule that governs all the others: the hero is only ever drawn from tier
 * one. A name that appears in the band because the reader holds it — the
 * proximity guarantee — has not cleared the threshold, and the headline must
 * never be more confident than the picture underneath it.
 */

export type BandMode = "compression" | "volume" | "residual";

export type BandCandidate = {
  ticker: string;
  /**
   * The measure the mode ranks on: compression's σ30/σ90, volume's mean ratio
   * over the window, or the signed residual sum.
   */
  value: number;
  /** Compression: today's regime is the low of a complete 90-session series. */
  ninetyDayLow?: boolean;
  /** Volume: how many sessions in the window qualified. */
  sessions?: number;
  /** Volume: the price's own move over the window, standardised. */
  momentumZ?: number | null;
  /** Residual: consecutive sessions running the same way. */
  runSessions?: number;
  /** Residual: +1 up, −1 down. */
  direction?: 1 | -1;
};

export type BandHeadlineInput = {
  mode: BandMode;
  /** Tier one only, already ordered best-first by the mode's own measure. */
  tier1: BandCandidate[];
  /** TICKER → the plural, spoken sector name. Missing tickers just don't cluster. */
  sectors: Record<string, string>;
  templates: ScreenTemplates;
  /** The threshold the band drew, printed in the cluster line. */
  compressionThreshold?: number;
};

/** Which rule fired — carried so tests and telemetry can name it. */
export type BandHeadline = { rule: string; text: string };

/** Two decimals and the multiplication sign: 0.74 → "0.74×". */
export function fmtTimes(value: number, digits = 2): string {
  return `${value.toFixed(digits)}×`;
}

/**
 * The sector shared by more than half of tier one, when tier one is at least
 * three names. Anything looser is a coincidence, not a cluster.
 */
export function dominantSector(
  tier1: BandCandidate[],
  sectors: Record<string, string>,
  minNames = 3,
): string | null {
  if (tier1.length < minNames) return null;
  const counts = new Map<string, number>();
  for (const c of tier1) {
    const sector = sectors[c.ticker.toUpperCase()];
    if (!sector) continue;
    counts.set(sector, (counts.get(sector) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [sector, count] of counts) {
    if (count > bestCount || (count === bestCount && best != null && sector < best)) {
      best = sector;
      bestCount = count;
    }
  }
  return best != null && bestCount * 2 > tier1.length ? best : null;
}

function clusterVars(tier1: BandCandidate[], sector: string): Record<string, string | number> {
  return {
    SECTOR: sector,
    T1: tier1[0].ticker,
    T2: tier1[1].ticker,
    MORE: tier1.length - 2,
  };
}

function compressionHeadline(input: BandHeadlineInput): BandHeadline {
  const { tier1, templates } = input;
  if (tier1.length === 0) {
    return { rule: "empty", text: fill(templates, "band_compression_empty") };
  }
  const hero = tier1[0];

  // 1. The quietest it has been in a quarter — the strongest thing the card
  //    can say, and the only one that needs a complete history to be true.
  if (hero.ninetyDayLow) {
    return {
      rule: "ninety_day_low",
      text: fill(templates, "band_compression_quietest", { TICKER: hero.ticker }),
    };
  }

  // 2. A sector coiling together says more than any single name in it.
  const sector = dominantSector(tier1, input.sectors);
  if (sector) {
    return {
      rule: "cluster",
      text: fill(templates, "band_compression_cluster", {
        ...clusterVars(tier1, sector),
        THRESHOLD: fmtTimes(input.compressionThreshold ?? 0.9, 1),
      }),
    };
  }

  // 3. One name well past the threshold carries the card on its own.
  if (hero.value <= 0.75) {
    return {
      rule: "single",
      text: fill(templates, "band_compression_single", {
        TICKER: hero.ticker,
        X: fmtTimes(hero.value),
      }),
    };
  }

  // 4. Otherwise: how broad it is, and who leads.
  return {
    rule: "broad",
    text: fill(templates, "band_compression_broad", {
      N: tier1.length,
      TICKER: hero.ticker,
      X: fmtTimes(hero.value),
    }),
  };
}

function volumeHeadline(input: BandHeadlineInput): BandHeadline {
  const { tier1, templates } = input;
  if (tier1.length === 0) {
    return { rule: "empty", text: fill(templates, "band_volume_empty") };
  }
  const hero = tier1[0];

  // 1. Heavy volume with the price going nowhere is the whole point of the
  //    mode: someone is doing size without moving the tape.
  const momentum = hero.momentumZ;
  if (momentum != null && Number.isFinite(momentum) && Math.abs(momentum) < 1) {
    return {
      rule: "flat_price",
      text: fill(templates, "band_volume_flat", {
        TICKER: hero.ticker,
        N: hero.sessions ?? 0,
      }),
    };
  }

  const sector = dominantSector(tier1, input.sectors);
  if (sector) {
    return {
      rule: "cluster",
      text: fill(templates, "band_volume_cluster", clusterVars(tier1, sector)),
    };
  }

  return {
    rule: "single",
    text: fill(templates, "band_volume_single", {
      TICKER: hero.ticker,
      X: fmtTimes(hero.value, 1),
    }),
  };
}

function residualHeadline(input: BandHeadlineInput): BandHeadline {
  const { tier1, templates } = input;
  if (tier1.length === 0) {
    return { rule: "empty", text: fill(templates, "band_residual_empty") };
  }
  const hero = tier1[0];

  // 1. A run in one direction is the claim; the word comes from the sign, so
  //    the copy can never disagree with the arithmetic.
  if ((hero.runSessions ?? 0) >= 3 && hero.direction != null) {
    return {
      rule: "run",
      text: fill(templates, "band_residual_run", {
        TICKER: hero.ticker,
        MOVE: fill(
          templates,
          hero.direction > 0 ? "band_residual_word_up" : "band_residual_word_down",
        ),
        N: hero.runSessions ?? 0,
      }),
    };
  }

  const sector = dominantSector(tier1, input.sectors);
  if (sector) {
    return {
      rule: "cluster",
      text: fill(templates, "band_residual_cluster", clusterVars(tier1, sector)),
    };
  }

  return { rule: "empty", text: fill(templates, "band_residual_empty") };
}

export function bandHeadline(input: BandHeadlineInput): BandHeadline {
  if (input.mode === "volume") return volumeHeadline(input);
  if (input.mode === "residual") return residualHeadline(input);
  return compressionHeadline(input);
}
