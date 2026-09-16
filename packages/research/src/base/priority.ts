/**
 * §3 priority scoring.
 *
 *   priority = max(0, severity + composite_bonus) x proximity_multiplier + freshness
 *
 * A pure function of (messages, user context, config) plus an explicit `now`
 * — no clock reads, so identical inputs always produce identical scores (§8).
 */

import { nyYmd, sessionTimes } from "../tracker/calendar.js";
import type {
  QuantContext,
} from "../tracker/types.js";
import type { BaseConfig, FreshnessAnchor, SeverityCurve, SeveritySource } from "./config.js";
import { classifiedSeverity, type MessageClassification, type VerdictLookup } from "./classification.js";
import { compositeBonus } from "./tags.js";
import type {
  BaseMessage,
  CompositeTag,
  PriorityBand,
  UserProximity,
} from "./types.js";

// ---------------------------------------------------------------------------
// Severity (0–40)
// ---------------------------------------------------------------------------

function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Binary floating point turns exact interpolations into values like
 * 13.000000000000004. These are calibration-grade numbers, so the artifact is
 * meaningless — trimming it keeps pinned expectations readable.
 */
function trimFloat(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * Linear interpolation across the anchor points. Above the top anchor the
 * value clamps to it (§3); below the first anchor it clamps to that anchor's
 * value when `clampBelow`, otherwise it interpolates down toward the origin.
 */
export function interpolateCurve(curve: SeverityCurve, x: number, clampBelow: boolean): number {
  if (curve.length === 0) return 0;
  const [firstX, firstY] = curve[0];
  const [lastX, lastY] = curve[curve.length - 1];
  if (x <= firstX) {
    if (clampBelow) return firstY;
    return firstX === 0 ? firstY : trimFloat((x / firstX) * firstY);
  }
  if (x >= lastX) return lastY;
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1];
    const [x1, y1] = curve[i];
    if (x <= x1) return trimFloat(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
  }
  return lastY;
}

export type MessageSeverity = {
  /** Severity contribution, or null when the driving field was null (§1). */
  value: number | null;
  /** True when this message had a configured source that resolved to null. */
  nullComponent: boolean;
};

/**
 * True when this message set is an earnings release and its reaction.
 *
 * The earnings_window flag suppresses unexplained_move by design — a move into
 * earnings is not unexplained — but that leaves the realised reaction with no
 * route into severity at all, so a -7 sigma print scores like a press release.
 * Suppression stays a detector concern; scoring reads the quant context.
 */
export function isEarningsReaction(messages: BaseMessage[], config: BaseConfig): boolean {
  if (!config.earnings.enabled || !config.earnings.scoreRealisedReaction) return false;
  const release = messages.some((m) => {
    if (m.type !== "filing_item") return false;
    const p = m.payload as { form_type: string; item_codes: string[] };
    return (
      config.tags.eightKFormTypes.includes(p.form_type) &&
      p.item_codes.includes(config.earnings.announcementItemCode)
    );
  });
  if (!release) return false;
  return messages.some((m) => m.context_flags.includes(config.tags.earningsWindowFlag));
}

/** Severity contributed by one message. */
export function messageSeverity(
  message: BaseMessage,
  config: BaseConfig,
  context?: { earningsReaction?: boolean; classification?: MessageClassification },
): MessageSeverity {
  const sev = config.priority.severity;
  // In an earnings reaction the realised move is scored off the quant context
  // carried by every message, whichever message happens to carry the largest.
  const realised = context?.earningsReaction
    ? scoreThrough(message, config.earnings.realisedReaction, config)
    : null;
  const withRealised = (value: number | null): number | null => {
    if (realised === null) return value;
    return value === null ? realised : Math.max(value, realised);
  };

  // S2: a Screen structure message scores from the per-pattern table — it has
  // no single magnitude field a curve could read.
  if (message.type === "tape_structure") {
    const pattern = (message.payload as { pattern?: string }).pattern ?? "";
    const configured = config.tags.tapeStructureSeverity[pattern];
    const value = typeof configured === "number" && Number.isFinite(configured) ? configured : sev.base;
    return { value: withRealised(Math.max(0, Math.min(value, sev.max))), nullComponent: false };
  }

  const source = sev.sources[message.type];
  if (!source) {
    // Information-only messages (and detectors with no anchor table of their
    // own) contribute the configured base severity until classified. Once a
    // Classifier verdict exists for the message and Phase B re-score is on
    // (B9 / Classifier §10b), the mapped contribution replaces the flat base;
    // failed / unassessed verdicts leave it unchanged.
    const classification = context?.classification;
    const value =
      classification && config.classifier.rescoreEnabled
        ? classifiedSeverity(classification, config)
        : sev.base;
    return { value: withRealised(Math.min(value, sev.max)), nullComponent: false };
  }
  const raw = finiteOrNull(readPath(message, source.path));
  if (raw === null) return { value: withRealised(null), nullComponent: true };
  const scored = (scoreThrough(message, source, config) ?? 0) * multiplierFor(message, config);
  return { value: withRealised(Math.max(0, Math.min(trimFloat(scored), sev.max))), nullComponent: false };
}

/** Read a source path and score it through its curve; null when not computable. */
function scoreThrough(
  message: BaseMessage,
  source: SeveritySource,
  config: BaseConfig,
): number | null {
  const sev = config.priority.severity;
  const raw = finiteOrNull(readPath(message, source.path));
  if (raw === null) return null;
  const curve = sev.curves[source.curve] ?? [];
  const x = source.abs ? Math.abs(raw) : raw;
  return Math.max(0, Math.min(trimFloat(interpolateCurve(curve, x, sev.clampBelowFirstAnchor)), sev.max));
}

/**
 * The magnitude-tier multiplier for a message, or 1 when the type has none.
 *
 * A null magnitude leaves the curve's own score untouched rather than
 * defaulting to the bottom tier: an uncomputable notional is not evidence of a
 * small one, and §1 forbids reading null as zero.
 */
export function multiplierFor(message: BaseMessage, config: BaseConfig): number {
  const spec = config.priority.severity.multipliers[message.type];
  if (!spec) return 1;
  const magnitude = finiteOrNull(readPath(message, spec.path));
  if (magnitude === null) return 1;
  for (const tier of spec.tiers) {
    if (tier.under === null || magnitude < tier.under) return tier.multiplier;
  }
  return 1;
}

export type SeverityResult = {
  severity: number;
  /** The strongest statistical trigger — also the freshness anchor (§3). */
  driver: BaseMessage | null;
  /** A configured severity component resolved to null somewhere. */
  hasNullComponent: boolean;
};

/** §3: severity is the magnitude of the strongest statistical trigger. */
export function severityOf(
  messages: BaseMessage[],
  config: BaseConfig,
  verdictLookup?: VerdictLookup,
): SeverityResult {
  let severity = 0;
  let driver: BaseMessage | null = null;
  let hasNullComponent = false;
  const earningsReaction = isEarningsReaction(messages, config);
  for (const message of messages) {
    const { value, nullComponent } = messageSeverity(message, config, {
      earningsReaction,
      classification: verdictLookup ? verdictLookup(message) : undefined,
    });
    if (nullComponent) hasNullComponent = true;
    if (value === null) continue;
    // >= not >: among equally strong triggers the latest is the better recency
    // anchor. In an earnings reaction the realised residual rides on every
    // message, so first-wins would anchor freshness to a day-old headline
    // rather than the gap that just printed.
    if (driver === null || value >= severity) {
      severity = value;
      driver = message;
    }
  }
  return { severity, driver, hasNullComponent };
}

// ---------------------------------------------------------------------------
// Freshness (0–10)
// ---------------------------------------------------------------------------

function anchorFor(message: BaseMessage, config: BaseConfig): FreshnessAnchor {
  return config.priority.freshness.anchors[message.type] ?? config.priority.freshness.defaultAnchor;
}

/** Resolve the instant freshness decays from, or null for a neutral score. */
export function freshnessAnchorAt(message: BaseMessage, config: BaseConfig): string | null {
  const anchor = anchorFor(message, config);
  switch (anchor.kind) {
    case "neutral":
      return null;
    case "message":
      return message.timestamp;
    case "market_open": {
      const times = sessionTimes(nyYmd(new Date(message.timestamp)));
      return times ? times.openUtc.toISOString() : message.timestamp;
    }
    case "path": {
      const value = readPath(message, anchor.path);
      return typeof value === "string" && value ? value : message.timestamp;
    }
  }
}

/** §3 freshness: full below fullMs old, decaying linearly to 0 at zeroMs. */
export function freshnessOf(message: BaseMessage, now: string, config: BaseConfig): number {
  const f = config.priority.freshness;
  const at = freshnessAnchorAt(message, config);
  if (at === null) return f.neutral;
  const age = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(age)) return f.neutral;
  if (age <= f.fullMs) return f.max;
  if (age >= f.zeroMs) return 0;
  return (f.max * (f.zeroMs - age)) / (f.zeroMs - f.fullMs);
}

// ---------------------------------------------------------------------------
// Degraded context (§1)
// ---------------------------------------------------------------------------

/**
 * True when a value the scorer or a tag rule needed was null. Null is never
 * treated as zero — it is recorded so downstream knows the score was computed
 * on incomplete quant state.
 */
export function computeDegradedContext(
  messages: BaseMessage[],
  quantContext: QuantContext | null,
  config: BaseConfig,
): boolean {
  if (messages.length > 0 && quantContext === null) return true;
  if (config.degraded.onAnyNullQuantField && quantContext !== null) {
    for (const [key, value] of Object.entries(quantContext)) {
      if (key !== "session" && value === null) return true;
    }
  }
  for (const message of messages) {
    if (messageSeverity(message, config).nullComponent) return true;
    // volume_without_price cannot be evaluated without move_zscore.
    if (message.type === "volume_anomaly" && (quantContext?.move_zscore ?? null) === null) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

const BAND_RANK: Record<PriorityBand, number> = { P3: 0, P2: 1, P1: 2, P0: 3 };

export function bandOf(score: number, config: BaseConfig): PriorityBand {
  const b = config.priority.bands;
  if (score >= b.P0) return "P0";
  if (score >= b.P1) return "P1";
  if (score >= b.P2) return "P2";
  return "P3";
}

/** Band comparison for the priority-gated routing rows (§4). */
export function bandAtLeast(band: PriorityBand, minimum: PriorityBand): boolean {
  return BAND_RANK[band] >= BAND_RANK[minimum];
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export type PriorityInput = {
  messages: BaseMessage[];
  composite_tags: CompositeTag[];
  user_proximity: UserProximity;
  /** Evaluation instant — passed in, never read from the clock (§8). */
  now: string;
  config: BaseConfig;
  /** Classifier verdicts for re-score (B9); absent = every message unclassified. */
  verdictLookup?: VerdictLookup;
};

export type PriorityResult = {
  priority: number;
  band: PriorityBand;
  severity: number;
  composite_bonus: number;
  /** severity + composite_bonus, clamped at 0 — the discovery floor's input. */
  combined: number;
  proximity_multiplier: number;
  freshness: number;
  /** True when the discovery floor raised this score (§8 observability). */
  discovery_floor_applied: boolean;
  /** id of the message that set severity and anchored freshness. */
  driver_message_id: string | null;
};

export function computePriority(input: PriorityInput): PriorityResult {
  const { config } = input;
  const { severity, driver } = severityOf(input.messages, config, input.verdictLookup);
  const bonus = compositeBonus(input.composite_tags, config);
  const multiplier = config.priority.proximityMultipliers[input.user_proximity];
  const freshness = driver ? freshnessOf(driver, input.now, config) : 0;
  const combined = Math.max(0, severity + bonus);
  const raw = combined * multiplier + freshness;
  let priority = config.priority.round ? Math.round(raw) : raw;

  // Discovery floor: absolute strength, measured before the proximity
  // multiplier, guarantees a minimum band whoever happens to be watching.
  // Raising the number rather than overriding the band keeps band = f(priority),
  // so the §5 priority-ordered queue stays coherent.
  const floor = config.priority.discoveryFloor;
  let discovery_floor_applied = false;
  if (floor.enabled && combined >= floor.minCombined) {
    const floorPriority = floor.band === "P3" ? 0 : config.priority.bands[floor.band];
    if (priority < floorPriority) {
      priority = floorPriority;
      discovery_floor_applied = true;
    }
  }

  return {
    priority,
    band: bandOf(priority, config),
    severity,
    composite_bonus: bonus,
    combined,
    proximity_multiplier: multiplier,
    freshness,
    discovery_floor_applied,
    driver_message_id: driver?.id ?? null,
  };
}
