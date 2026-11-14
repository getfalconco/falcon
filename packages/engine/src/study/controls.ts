/**
 * Matched unlinked controls (design docs/design/ripple-engine-v1.md 6.1).
 *
 * For each (event, hit), 3-5 control firms on the same event date that:
 *   - share the hit's 3-digit SIC (2-digit when fewer than `min` qualify);
 *   - are nearest in size (log market value), then nearest in beta;
 *   - trade above $5 with 20-day median dollar volume >= $5M;
 *   - have no own 8-K Item 2.02 (earnings) in [-5, +L] sessions;
 *   - have no point-in-time graph path to the event company (linked
 *     families; own-firm families such as F7 have none to exclude) and no
 *     event of the same family of their own in the window.
 *
 * Outcome y = sign * (SCAR_hit - mean SCAR_controls), winsorized at +/-3.
 *
 * Pure.
 */

export type ControlCandidate = {
  id: string;
  /** SIC code as filed (e.g. "3674"); null when unknown. */
  sic: string | null;
  /** Market value in USD at the event; null when unknown. */
  sizeUsd: number | null;
  /** Market-model beta over the hit's estimation window. */
  beta: number | null;
  /** Unadjusted price at the event. */
  price: number | null;
  /** 20-day median dollar volume at the event. */
  dollarVolume: number | null;
  /** Own 8-K Item 2.02 in [-5, +L]. */
  ownEarnings?: boolean;
  /** A graph path (<= 2 hops) to the event company. */
  linked?: boolean;
  /** An event of the same family of its own in the window. */
  ownEvent?: boolean;
};

export type HitProfile = { id: string; sic: string | null; sizeUsd: number | null; beta: number | null };

export const CONTROL_RULES = {
  minPrice: 5,
  minDollarVolume: 5_000_000,
  min: 3,
  max: 5,
  /** Nearest-in-size pool the beta match picks from. */
  sizePool: 10,
  winsor: 3,
} as const;

export type ControlRules = { minPrice: number; minDollarVolume: number; min: number; max: number; sizePool: number };

export type ControlSelection = { controls: ControlCandidate[]; level: "sic3" | "sic2" | null; eligible: number };

function sicPrefix(sic: string | null, digits: number): string | null {
  if (!sic) return null;
  const s = sic.replace(/\D/g, "").padStart(4, "0");
  return /^0+$/.test(s) ? null : s.slice(0, digits);
}

/** Whether a candidate passes the liquidity, earnings and link screens. */
export function controlEligible(c: ControlCandidate, hitId: string, rules: ControlRules = CONTROL_RULES): boolean {
  return (
    c.id !== hitId &&
    !c.linked &&
    !c.ownEarnings &&
    !c.ownEvent &&
    c.price !== null &&
    c.price > rules.minPrice &&
    c.dollarVolume !== null &&
    c.dollarVolume >= rules.minDollarVolume &&
    c.beta !== null &&
    Number.isFinite(c.beta) &&
    c.sizeUsd !== null &&
    c.sizeUsd > 0
  );
}

/**
 * The matched controls of one hit: industry first (SIC3, then SIC2), then the
 * `sizePool` nearest in log size, then the `max` nearest in beta among those.
 * Empty (level null) when fewer than `min` qualify at SIC2.
 */
export function selectControls(hit: HitProfile, candidates: readonly ControlCandidate[], rules: ControlRules = CONTROL_RULES): ControlSelection {
  const ok = candidates.filter((c) => controlEligible(c, hit.id, rules));
  for (const [digits, level] of [
    [3, "sic3"],
    [2, "sic2"],
  ] as const) {
    const want = sicPrefix(hit.sic, digits);
    if (!want) break;
    const pool = ok.filter((c) => sicPrefix(c.sic, digits) === want);
    if (pool.length < rules.min) continue;
    let near = pool;
    if (hit.sizeUsd !== null && hit.sizeUsd > 0) {
      const ls = Math.log(hit.sizeUsd);
      near = [...pool].sort((a, b) => Math.abs(Math.log(a.sizeUsd!) - ls) - Math.abs(Math.log(b.sizeUsd!) - ls) || (a.id < b.id ? -1 : 1));
      near = near.slice(0, Math.max(rules.sizePool, rules.max));
    }
    const hb = hit.beta ?? 1;
    const chosen = [...near].sort((a, b) => Math.abs(a.beta! - hb) - Math.abs(b.beta! - hb) || (a.id < b.id ? -1 : 1)).slice(0, rules.max);
    return { controls: chosen, level, eligible: pool.length };
  }
  return { controls: [], level: null, eligible: 0 };
}

export function winsorize(x: number, cap: number = CONTROL_RULES.winsor): number {
  return Math.max(-cap, Math.min(cap, x));
}

/**
 * y = sign * (SCAR_hit - mean SCAR_controls), winsorized at +/-cap. Null
 * with fewer than `min` measured controls.
 */
export function matchedOutcome(scarHit: number, controlScars: readonly number[], sign: 1 | -1 = 1, min: number = CONTROL_RULES.min, cap: number = CONTROL_RULES.winsor): number | null {
  const xs = controlScars.filter((x) => Number.isFinite(x));
  if (!Number.isFinite(scarHit) || xs.length < min) return null;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return winsorize(sign * (scarHit - m), cap);
}
