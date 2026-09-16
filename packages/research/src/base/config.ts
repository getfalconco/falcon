/**
 * Base Engine central configuration (spec §8 "config over code", §10).
 *
 * Every weight, threshold, multiplier, window parameter and routing constant
 * used by the incident model, the priority scorer and the routing table is
 * read from this structure — nothing is hardcoded in the logic. The values
 * below are the provisional pilot defaults listed in §10 as open calibration
 * parameters; they are expected to be recalibrated from Tracker shadow data,
 * and the persisted config file overrides them at runtime.
 */

import type {
  ContextFlag,
} from "../tracker/types.js";
import type {
  BaseMessageType,
  CompositeTag,
  PriorityBand,
  RoutingDestination,
  UserProximity,
} from "./types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------
// §2 incident window
// ---------------------------------------------------------------------------

export type BaseWindowConfig = {
  /** Incident closes this long after the last window-extending message. */
  measurementSilenceMs: number;
  /** Hard cap measured from the first message of the incident. */
  hardCapMs: number;
  /** related_incident_id lookback from the prior incident's closure. */
  relatedLookbackMs: number;
  /**
   * Message types that extend an open window. Measurement class only (§2):
   * news_item and the other information messages append without extending, so
   * a continuous news stream cannot hold an incident open indefinitely.
   */
  extendingTypes: BaseMessageType[];
  /**
   * How an incident with no measurement-class message yet closes (B6).
   *
   * "session_close" (default): at the close of the session that prices it
   * plus `noMeasurementCloseGraceMs` — i.e. once that ticker's post-close
   * evaluation has had time to land — or the hard cap, whichever is first.
   * A news-opened incident therefore still absorbs the close-computed
   * detectors it caused (they arrive inside the grace), and if one does
   * arrive the incident becomes measured and the normal 6h/8h rules apply.
   * Opened after the close, "the session that prices it" is the next one.
   *
   * "none" (spec-literal): only the hard cap — every lone-news incident
   * crawls to 8h (89% of incidents in the pilot log).
   * "window_start": the silence timer runs from the first message — closes a
   * 09:30 incident at 15:30 and strands the 16:0x detectors. Do not use.
   */
  silenceAnchorFallback: "session_close" | "none" | "window_start";
  /**
   * Grace past the pricing session's close for a no-measurement incident.
   * The close-run is not instantaneous: the pilot log shows the live run
   * landing 44 minutes after the bell (bar-provider lag), so this must cover
   * that or the reaction lands in a new incident and correlation breaks.
   */
  noMeasurementCloseGraceMs: number;
  /**
   * Whether a scheduled due-trigger incident carries the scheduled_event
   * message that originally scheduled it as a constituent message.
   */
  includeSourceScheduledEvent: boolean;
};

// ---------------------------------------------------------------------------
// §2 composite patterns
// ---------------------------------------------------------------------------

export type BaseTagConfig = {
  /** §2 pattern table weights. Multiple tags may apply. */
  weights: Record<CompositeTag, number>;
  /** Positive contributions are capped here; negatives apply outside the cap (§3). */
  positiveBonusCap: number;
  /** 8-K item code that marks an earnings release. */
  earningsItemCode: string;
  /** Form types treated as an 8-K for event_gap / earnings_surprise. */
  eightKFormTypes: string[];
  /** Context flag that substitutes for an 8-K in the event_gap rule. */
  earningsWindowFlag: ContextFlag;
  /** pre_earnings_silence lookahead. */
  preEarningsSilenceDays: number;
  /**
   * Whether silence_anomaly.next_earnings_due_at may satisfy the
   * pre_earnings_silence lookahead when no scheduled_event message is present
   * in the incident (the scheduled_event usually fired days earlier, in an
   * incident of its own).
   */
  preEarningsSilenceUsesSilencePayload: boolean;
  /**
   * Severity for a `tape_structure` message, by Screen pattern (S2). These
   * are structures, not events: the numbers sit below the event detectors on
   * purpose — the point is that they reach Analyst, not that they outrank a
   * gap.
   */
  tapeStructureSeverity: Record<string, number>;
  /** volume_without_price fires below this |move_zscore|. */
  volumeWithoutPriceMaxAbsMoveZ: number;
  /**
   * standalone_insider_cluster fires at or above this total notional.
   *
   * Every other pattern in §2 is the intersection of two messages, which
   * structurally penalises a message type that is already meaningful alone. A
   * cluster is itself a composite event — three people deciding independently
   * — so past a conviction threshold it is actionable without a partner.
   */
  standaloneInsiderClusterMinNotional: number;
};

// ---------------------------------------------------------------------------
// §3 priority scoring
// ---------------------------------------------------------------------------

/** Ascending [x, severity] anchor points; between them, linear interpolation. */
export type SeverityCurve = Array<[number, number]>;

export type SeveritySource = {
  /** Dotted path into the Tracker message envelope. */
  path: string;
  /** Key into severity.curves. */
  curve: string;
  /** Score on |value| rather than value. */
  abs: boolean;
};

/**
 * A magnitude-tier multiplier applied after a curve. Tiers are ascending and
 * half-open: the first whose `under` bound the value falls below wins;
 * `under: null` is the open-ended top tier.
 */
export type SeverityMultiplierTier = { under: number | null; multiplier: number };

export type SeverityMultiplier = {
  /** Dotted path to the magnitude the tiers are read against. */
  path: string;
  tiers: SeverityMultiplierTier[];
};

export type BaseSeverityConfig = {
  /** severity is clamped to [0, max]. */
  max: number;
  /**
   * Severity for a message with no curve of its own — information-only
   * messages "contribute base severity 5 until classified" (§3), and the
   * detectors with no anchor table of their own fall back to it too.
   */
  base: number;
  /**
   * Below the first anchor, clamp to the first anchor's value (mirroring the
   * spec's clamp above the top anchor) rather than interpolating toward zero.
   */
  clampBelowFirstAnchor: boolean;
  curves: Record<string, SeverityCurve>;
  sources: Partial<Record<BaseMessageType, SeveritySource>>;
  /**
   * Applied to the curve's output, per message type. Headcount alone is not
   * conviction: three insiders buying $1M each is not the same event as three
   * buying $60k each, and the anchor tables cannot express that on their own.
   */
  multipliers: Partial<Record<BaseMessageType, SeverityMultiplier>>;
};

export type FreshnessAnchor =
  /** Close-computed detectors all arrive together and carry no recency (§3). */
  | { kind: "neutral" }
  /** Regular-session open of the message's NY trading day. */
  | { kind: "market_open" }
  /** The envelope timestamp. */
  | { kind: "message" }
  /** A dotted path into the message (e.g. payload.published_at). */
  | { kind: "path"; path: string };

export type BaseFreshnessConfig = {
  /** Freshness at or below fullMs old. */
  max: number;
  /** Neutral value for close-computed detectors. */
  neutral: number;
  /** Age at or below which freshness is `max`. */
  fullMs: number;
  /** Age at or above which freshness is 0. */
  zeroMs: number;
  anchors: Partial<Record<BaseMessageType, FreshnessAnchor>>;
  /** Anchor for a message type with no entry above. */
  defaultAnchor: FreshnessAnchor;
};

/**
 * Absolute-strength floor, evaluated on (severity + composite_bonus) — before
 * the proximity multiplier.
 *
 * Proximity measures the user's existing attention, not the signal's
 * information content. Multiplying the two collapses orthogonal dimensions, so
 * a strong occurrence on an untracked ticker becomes systematically invisible
 * — the opposite of surfacing what the market is not watching. The floor
 * separates them again: proximity governs urgency, not whether a sufficiently
 * strong signal is seen at all.
 *
 * It raises the priority *number* to the band's threshold rather than
 * overriding the band alone, so `band = f(priority)` still holds and the §5
 * priority-ordered queue cannot put a promoted P1 below an unpromoted P2.
 */
export type BaseDiscoveryFloorConfig = {
  enabled: boolean;
  /** Minimum severity + composite_bonus, pre-multiplier. */
  minCombined: number;
  /** Band the incident is promoted to. */
  band: PriorityBand;
};

export type BasePriorityConfig = {
  severity: BaseSeverityConfig;
  freshness: BaseFreshnessConfig;
  proximityMultipliers: Record<UserProximity, number>;
  /** Inclusive lower bounds; anything below bands.P2 is P3. */
  bands: { P0: number; P1: number; P2: number };
  discoveryFloor: BaseDiscoveryFloorConfig;
  /** Round the final score to an integer before banding. */
  round: boolean;
};

// ---------------------------------------------------------------------------
// §4 routing
// ---------------------------------------------------------------------------

export type BaseRoutingConfig = {
  /** 8-K item codes with a known propagation shape. */
  mapped8kItemCodes: string[];
  /** Forms that go to Extraction. */
  extractionForms: string[];
  /** Forms treated as an 8-K by the routing table. */
  eightKFormTypes: string[];
  /** Destination for a filing form matching none of the table's rows. */
  otherFilingDestination: RoutingDestination;
  /** Minimum band for the priority-gated Analyst rows. */
  analystMinBand: PriorityBand;
  /** Destination for a Scheduler due-trigger incident. */
  scheduledTriggerDestination: RoutingDestination;
  /**
   * S2 Phase gate: route `tape_structure` incidents to Analyst. Off means the
   * messages still join incidents and carry their tag — observable in the
   * replay panel — but nothing is dispatched.
   */
  screenToAnalystEnabled: boolean;
  /**
   * Minimum band for the `tape_structure` Analyst row. Deliberately P2, not
   * the P1 the event rows use: these messages score low by design and the
   * point of the channel is that they reach Analyst at all.
   */
  tapeStructureMinBand: PriorityBand;
};

export type BaseDegradedConfig = {
  /**
   * How strictly degraded_context is set (§1). false: only a null the scorer
   * or a tag rule actually needed degrades the incident. true: any null field
   * in the latest quant context degrades it — closer to the letter of §1, but
   * on a young ticker several fields are permanently null under the
   * insufficient-history rule, so the flag stops discriminating.
   */
  onAnyNullQuantField: boolean;
};

/**
 * §2 earnings absorption.
 *
 * An earnings release and the market's reaction to it are one occurrence, but
 * they are separated by a session boundary: the 8-K lands after the close and
 * the gap it causes is measured at the next open, 15+ hours later. The 8h hard
 * cap splits them, so `earnings_surprise` — which needs the filing and the gap
 * together — can never form.
 *
 * An absorbing window replaces the cap and the silence timer for the span of
 * the release: every message for that ticker joins one incident until the
 * reaction session closes. Unrelated messages caught in that span are context,
 * not contamination.
 */
export type BaseEarningsConfig = {
  enabled: boolean;
  /** 8-K item code that marks the release. */
  announcementItemCode: string;
  /**
   * Open an absorbing window on the 8-K itself, not only on a Scheduler
   * due-trigger. The calendar channel is unreliable — in the pilot shadow data
   * exactly one scheduled_event was emitted across 42 tickers — so keying the
   * window solely to it would leave the mechanism dead on real releases.
   */
  openOnAnnouncementFiling: boolean;
  /**
   * When the announcement lands inside a session (neither before the open nor
   * after the close), absorb to that session's close ("bmo") or the next
   * one's ("amc").
   */
  intradayAnnouncementTreatedAs: "bmo" | "amc";
  /**
   * Score the realised reaction from the incident's quant context even though
   * the earnings_window flag suppressed unexplained_move. Suppression stays a
   * detector concern; scoring should still see what actually happened.
   */
  scoreRealisedReaction: boolean;
  /**
   * Grace past the pricing session.s close. The close-computed detectors — the
   * gap, the volume anomaly, the realised residual — are all emitted *after*
   * the close, so a window ending exactly at it would exclude the very
   * reaction the absorption exists to capture.
   */
  absorptionGraceMs: number;
  /** Path and curve for the realised reaction. */
  realisedReaction: SeveritySource;
};

/**
 * Cross-ticker article deduplication (B2). A syndicated article reaches the
 * Classifier once; the other tickers it landed on wait for that verdict.
 */
export type BaseDedupeConfig = {
  enabled: boolean;
  /** A second arrival past this age is a new lead — the cache has expired. */
  ttlMs: number;
  /** Articles on at least this many tickers are flagged `syndicated`. */
  syndicatedMinTickers: number;
  /** Query params dropped before hashing a URL identity (utm_* always are). */
  strippedQueryParams: string[];
};

/**
 * Classifier companion settings (task B9, Classifier spec §10).
 *
 * Base owns the request shape, the re-score mapping and the daily budget;
 * the Classifier owns the verdict store and the call. `rescoreEnabled` is the
 * Phase A → Phase B switch (§13): off, verdicts are recorded and displayed
 * but the information-severity 5 stands; on, a classified message contributes
 * the mapped severity instead.
 */
export type BaseClassifierConfig = {
  /** Phase B switch — apply the §10b mapping in scoring. */
  rescoreEnabled: boolean;
  /** Lead request ticker cap (§3); tickers beyond it are returned unassessed. */
  tickerCap: number;
  /** §9: requests per day, reset at ET midnight. */
  dailyBudget: number;
  /** §10b severity contribution by relevance × materiality. */
  severityMapping: {
    direct: { high: number; standard: number; low: number };
    indirect: { high: number; standard: number; low: number };
    none: number;
    /** unassessed / failed / not yet classified — the information base severity. */
    unassessed: number;
  };
  /** §5 downstream-affinity list: event types that ripple through the graph. */
  networkRelevantEventTypes: string[];
  /** §10c: minimum materiality for a propagation candidate. */
  propagationMinMateriality: "high" | "standard" | "low";
  /** §10d: articles on at least this many tickers get one verdict fanned out. */
  syndicationFanoutMinScope: number;
  /**
   * Pre-earnings preview cap (deterministic, Base-side, no prompt change).
   * An `earnings_results` verdict on an article published inside the
   * `windowDays` before the ticker's known earnings due_at is a preview ("what
   * to watch"), not a result: its materiality is capped to `low` and the
   * classification carries `pre_earnings_preview: true`, so it never becomes a
   * propagation candidate and re-scores as low. Only fires on a known calendar
   * (scheduled_event due_at / Tracker scheduledEarnings); `guidance` is exempt —
   * a company's own pre-announcement is a real event.
   */
  preEarningsPreview: {
    enabled: boolean;
    windowDays: number;
    eventTypes: string[];
  };
};

/**
 * Analyst companion settings (Analyst spec §8). Base owns the analyst budget;
 * the Analyst owns the output store, the call and every other knob.
 */
export type BaseAnalystConfig = {
  /** §8: analyst requests per day, reset at ET midnight. */
  dailyBudget: number;
  /**
   * S2 budget guard: `structure_review` requests (Screen-driven) may take at
   * most this many of the daily budget. Event-driven requests are served
   * first and keep their priority order, so an untested pattern channel can
   * never crowd out an anomaly.
   */
  tapeStructureDailySubCap: number;
};

/**
 * Propagation companion settings (Propagation spec §2, §11). Base owns the
 * stage-2 daily budget and the candidate dispatch band; the Propagation
 * engine owns the matrix, the pricing check, the run store and the call.
 */
export type BasePropagationConfig = {
  /** §11: stage-2 refinements per day, reset at ET midnight. */
  dailyBudget: number;
  /** §2: minimum band for candidate-only (Classifier-fed) dispatch; routed rows always dispatch. */
  dispatchMinBand: PriorityBand;
};

export type BaseConfig = {
  window: BaseWindowConfig;
  earnings: BaseEarningsConfig;
  dedupe: BaseDedupeConfig;
  tags: BaseTagConfig;
  priority: BasePriorityConfig;
  routing: BaseRoutingConfig;
  degraded: BaseDegradedConfig;
  classifier: BaseClassifierConfig;
  analyst: BaseAnalystConfig;
  propagation: BasePropagationConfig;
};

export const DEFAULT_BASE_CONFIG: BaseConfig = {
  window: {
    measurementSilenceMs: 6 * HOUR,
    hardCapMs: 8 * HOUR,
    relatedLookbackMs: 24 * HOUR,
    extendingTypes: [
      "gap_event",
      "volume_anomaly",
      "unexplained_move",
      "drift_event",
      "news_burst",
      "silence_anomaly",
      "filing_overdue",
      "insider_cluster",
      "tape_structure",
    ],
    silenceAnchorFallback: "session_close",
    noMeasurementCloseGraceMs: 60 * MINUTE,
    includeSourceScheduledEvent: true,
  },
  earnings: {
    enabled: true,
    announcementItemCode: "2.02",
    openOnAnnouncementFiling: true,
    intradayAnnouncementTreatedAs: "bmo",
    scoreRealisedReaction: true,
    absorptionGraceMs: 6 * HOUR,
    realisedReaction: { path: "quant_context.residual_zscore", curve: "zscore", abs: true },
  },
  dedupe: {
    enabled: true,
    ttlMs: 48 * HOUR,
    syndicatedMinTickers: 3,
    strippedQueryParams: ["ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid"],
  },
  tags: {
    weights: {
      earnings_surprise: 15,
      insider_confirmation: 15,
      silent_accumulation: 15,
      insider_divergence: 15,
      insider_distribution: 15,
      standalone_insider_cluster: 8,
      disclosure_risk: 15,
      unexplained_activity: 8,
      pre_earnings_silence: 8,
      volume_without_price: 8,
      event_gap: 0,
      explained_move: -15,
      tape_structure: 8,
    },
    positiveBonusCap: 30,
    earningsItemCode: "2.02",
    eightKFormTypes: ["8-K", "8-K/A"],
    earningsWindowFlag: "earnings_window",
    preEarningsSilenceDays: 14,
    preEarningsSilenceUsesSilencePayload: true,
    tapeStructureSeverity: {
      insider_divergence: 15,
      independent_tape: 12,
      quiet_accumulation: 10,
      compression: 8,
    },
    volumeWithoutPriceMaxAbsMoveZ: 0.5,
    standaloneInsiderClusterMinNotional: 1_000_000,
  },
  priority: {
    severity: {
      max: 40,
      base: 5,
      clampBelowFirstAnchor: true,
      curves: {
        zscore: [
          [2.0, 10],
          [3.0, 25],
          [4.0, 40],
        ],
        volume: [
          [3, 8],
          [5, 15],
          [10, 25],
        ],
        insiderCount: [
          [3, 20],
          [5, 30],
        ],
      },
      sources: {
        unexplained_move: { path: "payload.residual_zscore", curve: "zscore", abs: true },
        gap_event: { path: "payload.gap_z", curve: "zscore", abs: true },
        drift_event: { path: "payload.drift_z", curve: "zscore", abs: true },
        volume_anomaly: { path: "payload.volume_ratio", curve: "volume", abs: false },
        insider_cluster: { path: "payload.insider_count", curve: "insiderCount", abs: false },
      },
      multipliers: {
        insider_cluster: {
          path: "payload.total_notional",
          tiers: [
            { under: 250_000, multiplier: 0.8 },
            { under: 1_000_000, multiplier: 1.0 },
            { under: 5_000_000, multiplier: 1.3 },
            { under: null, multiplier: 1.5 },
          ],
        },
      },
    },
    freshness: {
      max: 10,
      neutral: 5,
      fullMs: 1 * HOUR,
      zeroMs: 24 * HOUR,
      anchors: {
        gap_event: { kind: "market_open" },
        news_item: { kind: "path", path: "payload.published_at" },
        filing_item: { kind: "path", path: "payload.filed_at" },
        insider_filing: { kind: "path", path: "payload.filed_at" },
        volume_anomaly: { kind: "neutral" },
        unexplained_move: { kind: "neutral" },
        drift_event: { kind: "neutral" },
        silence_anomaly: { kind: "neutral" },
        filing_overdue: { kind: "neutral" },
      },
      defaultAnchor: { kind: "message" },
    },
    proximityMultipliers: { held: 1.5, watchlist: 1.25, tracked: 1.0 },
    bands: { P0: 70, P1: 40, P2: 15 },
    discoveryFloor: { enabled: true, minCombined: 30, band: "P1" },
    round: true,
  },
  routing: {
    mapped8kItemCodes: ["2.02", "1.01", "5.02", "1.05", "8.01"],
    extractionForms: ["10-K", "10-Q", "20-F"],
    eightKFormTypes: ["8-K", "8-K/A"],
    otherFilingDestination: "classifier",
    analystMinBand: "P1",
    scheduledTriggerDestination: "analyst",
    screenToAnalystEnabled: false,
    tapeStructureMinBand: "P2",
  },
  degraded: { onAnyNullQuantField: false },
  classifier: {
    rescoreEnabled: false,
    tickerCap: 8,
    dailyBudget: 500,
    severityMapping: {
      direct: { high: 25, standard: 12, low: 2 },
      indirect: { high: 10, standard: 5, low: 0 },
      none: 0,
      unassessed: 5,
    },
    networkRelevantEventTypes: [
      "contract_partnership",
      "ma_activity",
      "supply_chain_ops",
      "regulatory_decision",
      "product_clinical",
      "guidance",
      "earnings_results",
    ],
    propagationMinMateriality: "standard",
    syndicationFanoutMinScope: 3,
    preEarningsPreview: { enabled: true, windowDays: 5, eventTypes: ["earnings_results"] },
  },
  analyst: { dailyBudget: 50, tapeStructureDailySubCap: 5 },
  propagation: { dailyBudget: 30, dispatchMinBand: "P2" },
};

/** Deep-merge a persisted partial config over the pilot defaults. */

/**
 * Deployment-level override for the classifier's daily budget.
 *
 * The seed config only applies to an EMPTY volume, so once a service has run
 * once its stored config is authoritative and editing `seed-data` changes
 * nothing. That is correct — the running chain's own writes should outrank an
 * image — but it leaves no way to raise a cap on a box with no panel. Same
 * shape as FALCON_PROPAGATION_ENABLED, and for the same reason: a headless
 * service has to be told by its deployment.
 *
 * Read at merge time rather than baked in, so it takes effect on restart
 * without a code change, and reverting is removing the variable.
 */
function classifierBudgetOverride(): number | null {
  const raw = Number(process.env.FALCON_CLASSIFIER_DAILY_BUDGET);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const limit = Math.floor(raw);
  // Say so, once. An override raised for one afternoon's verification is
  // exactly the kind of thing that stays set for a month: nothing fails, the
  // cap is simply higher than anyone remembers agreeing to. Announcing it on
  // boot — and reporting it on /health — makes "did we put that back?" a
  // glance instead of an archaeology exercise.
  if (!announcedBudgetOverride) {
    announcedBudgetOverride = true;
    console.warn(
      `[base] classifier daily budget OVERRIDDEN to ${limit} by ` +
        `FALCON_CLASSIFIER_DAILY_BUDGET (code default is ` +
        `${DEFAULT_BASE_CONFIG.classifier.dailyBudget}). Remove the variable to restore it.`,
    );
  }
  return limit;
}

let announcedBudgetOverride = false;

/** The active override, or null — surfaced so a forgotten one is visible. */
export function classifierBudgetOverrideValue(): number | null {
  const raw = Number(process.env.FALCON_CLASSIFIER_DAILY_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

export function mergeBaseConfig(partial: Partial<BaseConfig> | null | undefined): BaseConfig {
  const base = structuredClone(DEFAULT_BASE_CONFIG);
  if (!partial) return base;
  const priority = partial.priority;
  return {
    window: { ...base.window, ...(partial.window ?? {}) },
    earnings: { ...base.earnings, ...(partial.earnings ?? {}) },
    dedupe: { ...base.dedupe, ...(partial.dedupe ?? {}) },
    tags: {
      ...base.tags,
      ...(partial.tags ?? {}),
      weights: { ...base.tags.weights, ...(partial.tags?.weights ?? {}) },
      tapeStructureSeverity: { ...base.tags.tapeStructureSeverity, ...(partial.tags?.tapeStructureSeverity ?? {}) },
    },
    priority: {
      ...base.priority,
      ...(priority ?? {}),
      severity: {
        ...base.priority.severity,
        ...(priority?.severity ?? {}),
        curves: { ...base.priority.severity.curves, ...(priority?.severity?.curves ?? {}) },
        sources: { ...base.priority.severity.sources, ...(priority?.severity?.sources ?? {}) },
        multipliers: {
          ...base.priority.severity.multipliers,
          ...(priority?.severity?.multipliers ?? {}),
        },
      },
      freshness: {
        ...base.priority.freshness,
        ...(priority?.freshness ?? {}),
        anchors: { ...base.priority.freshness.anchors, ...(priority?.freshness?.anchors ?? {}) },
      },
      proximityMultipliers: {
        ...base.priority.proximityMultipliers,
        ...(priority?.proximityMultipliers ?? {}),
      },
      bands: { ...base.priority.bands, ...(priority?.bands ?? {}) },
      discoveryFloor: { ...base.priority.discoveryFloor, ...(priority?.discoveryFloor ?? {}) },
    },
    routing: { ...base.routing, ...(partial.routing ?? {}) },
    degraded: { ...base.degraded, ...(partial.degraded ?? {}) },
    classifier: {
      ...base.classifier,
      ...(partial.classifier ?? {}),
      ...(classifierBudgetOverride() != null ? { dailyBudget: classifierBudgetOverride()! } : {}),
      preEarningsPreview: {
        ...base.classifier.preEarningsPreview,
        ...(partial.classifier?.preEarningsPreview ?? {}),
      },
      severityMapping: {
        ...base.classifier.severityMapping,
        ...(partial.classifier?.severityMapping ?? {}),
        direct: {
          ...base.classifier.severityMapping.direct,
          ...(partial.classifier?.severityMapping?.direct ?? {}),
        },
        indirect: {
          ...base.classifier.severityMapping.indirect,
          ...(partial.classifier?.severityMapping?.indirect ?? {}),
        },
      },
    },
    analyst: { ...base.analyst, ...(partial.analyst ?? {}) },
    propagation: { ...base.propagation, ...(partial.propagation ?? {}) },
  };
}
