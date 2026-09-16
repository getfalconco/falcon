/**
 * §2 composite patterns — pure functions over an incident's message set.
 *
 * Every component, weight and threshold comes from BaseConfig. Multiple tags
 * may apply to one incident; the emitted array is in COMPOSITE_TAG_ORDER so
 * identical message sequences produce identical incidents (§8).
 */

import { calendarDaysBetween, nyYmd } from "../tracker/calendar.js";
import type {
  DriftEventPayload,
  FilingItemPayload,
  InsiderClusterPayload,
  QuantContext,
  ScheduledEventPayload,
  SilenceAnomalyPayload,
} from "../tracker/types.js";
import type { BaseConfig } from "./config.js";
import { COMPOSITE_TAG_ORDER, type CompositeTag } from "./types.js";
import type { BaseMessage, BaseMessageType } from "./types.js";

export type TagInput = {
  messages: BaseMessage[];
  /** Reference instant for "due today" and the lookahead rules: window_start. */
  windowStart: string;
  /** Latest quant context for the ticker (§6). */
  quantContext: QuantContext | null;
  /** True when an earnings release is holding this incident open (§2). */
  earningsAbsorption?: boolean;
};

function ofType(messages: BaseMessage[], type: BaseMessageType): BaseMessage[] {
  return messages.filter((m) => m.type === type);
}

/** Insider transaction direction expressed on the price axis. */
function insiderAxis(direction: "buy" | "sell"): "up" | "down" {
  return direction === "buy" ? "up" : "down";
}

function isEightK(payload: FilingItemPayload, config: BaseConfig): boolean {
  return config.tags.eightKFormTypes.includes(payload.form_type);
}

/** Every earnings due_at visible from this incident. */
function dueDates(input: TagInput, config: BaseConfig): string[] {
  const out: string[] = [];
  for (const m of ofType(input.messages, "scheduled_event")) {
    out.push((m.payload as ScheduledEventPayload).due_at);
  }
  if (config.tags.preEarningsSilenceUsesSilencePayload) {
    for (const m of ofType(input.messages, "silence_anomaly")) {
      const due = (m.payload as SilenceAnomalyPayload).next_earnings_due_at;
      if (due) out.push(due);
    }
  }
  return out;
}

/** S2: the incident carries a Screen structure message. */
function hasTapeStructure(messages: TagInput["messages"]): boolean {
  return messages.some((m) => m.type === "tape_structure");
}

export function deriveCompositeTags(input: TagInput, config: BaseConfig): CompositeTag[] {
  const { messages } = input;
  const tags = new Set<CompositeTag>();

  const gaps = ofType(messages, "gap_event");
  const volumes = ofType(messages, "volume_anomaly");
  const unexplained = ofType(messages, "unexplained_move");
  const drifts = ofType(messages, "drift_event");
  const bursts = ofType(messages, "news_burst");
  const silences = ofType(messages, "silence_anomaly");
  const overdues = ofType(messages, "filing_overdue");
  const clusters = ofType(messages, "insider_cluster");
  const filings = ofType(messages, "filing_item");
  const scheduled = ofType(messages, "scheduled_event");

  const eightKs = filings.filter((m) => isEightK(m.payload as FilingItemPayload, config));
  const earningsEightK = eightKs.some((m) =>
    (m.payload as FilingItemPayload).item_codes.includes(config.tags.earningsItemCode),
  );

  // earnings_surprise: gap_event + 8-K item 2.02, with the release established
  // either by a scheduled_event due today or by the absorption window itself —
  // inside an absorbing incident the "due today" condition is what opened it.
  const windowDay = nyYmd(new Date(input.windowStart));
  const dueToday = scheduled.some(
    (m) => nyYmd(new Date((m.payload as ScheduledEventPayload).due_at)) === windowDay,
  );
  if ((dueToday || input.earningsAbsorption === true) && gaps.length > 0 && earningsEightK) {
    tags.add("earnings_surprise");
  }

  // insider_confirmation: insider_cluster + unexplained_move
  if (clusters.length > 0 && unexplained.length > 0) tags.add("insider_confirmation");

  // silent_accumulation / insider_divergence: insider_cluster x drift_event
  for (const cluster of clusters) {
    const cp = cluster.payload as InsiderClusterPayload;
    for (const drift of drifts) {
      const dp = drift.payload as DriftEventPayload;
      const sameDirection = insiderAxis(cp.direction) === dp.direction;
      if (sameDirection) {
        // Only accumulation is a pattern; a sell cluster drifting down is
        // simply consistent, and the table gives it no tag.
        if (cp.direction === "buy") tags.add("silent_accumulation");
      } else {
        tags.add("insider_divergence");
      }
    }
  }

  // insider_distribution: insider_cluster (sell) + news_burst
  if (
    bursts.length > 0 &&
    clusters.some((m) => (m.payload as InsiderClusterPayload).direction === "sell")
  ) {
    tags.add("insider_distribution");
  }

  // standalone_insider_cluster: a cluster above the conviction threshold, with
  // or without a partner message. Every other row in the table is the
  // intersection of two messages, which would leave a $3M CEO-and-directors
  // cluster untagged purely for arriving alone.
  if (
    clusters.some(
      (m) =>
        (m.payload as InsiderClusterPayload).total_notional >=
        config.tags.standaloneInsiderClusterMinNotional,
    )
  ) {
    tags.add("standalone_insider_cluster");
  }

  // disclosure_risk: filing_overdue + (unexplained_move | volume_anomaly)
  if (overdues.length > 0 && (unexplained.length > 0 || volumes.length > 0)) {
    tags.add("disclosure_risk");
  }

  // unexplained_activity: unexplained_move + volume_anomaly
  if (unexplained.length > 0 && volumes.length > 0) tags.add("unexplained_activity");

  // pre_earnings_silence: silence_anomaly + scheduled_event due <= N days
  if (silences.length > 0) {
    const withinLookahead = dueDates(input, config).some((due) => {
      const days = calendarDaysBetween(windowDay, nyYmd(new Date(due)));
      return days >= 0 && days <= config.tags.preEarningsSilenceDays;
    });
    if (withinLookahead) tags.add("pre_earnings_silence");
  }

  // volume_without_price: volume_anomaly + |move_zscore| < threshold.
  // A null move_zscore is "not computable", never zero (§1) — no tag.
  const moveZ = input.quantContext?.move_zscore ?? null;
  if (volumes.length > 0 && moveZ !== null && Math.abs(moveZ) < config.tags.volumeWithoutPriceMaxAbsMoveZ) {
    tags.add("volume_without_price");
  }

  // event_gap: gap_event + 8-K filing_item or earnings_window flag
  const earningsWindow = messages.some((m) =>
    m.context_flags.includes(config.tags.earningsWindowFlag),
  );
  if (gaps.length > 0 && (eightKs.length > 0 || earningsWindow)) tags.add("event_gap");

  // explained_move: unexplained_move + news_burst. Burst only: baseline news
  // flow is noise and a burst is the signal (same reading as Tracker T6). A
  // ticker on 6-7 articles a day has >= 3 news_item in almost every open
  // incident, so a headcount arm would hand every revived unexplained_move a
  // -15 on arrival and kill it at P3 before anyone saw it.
  if (unexplained.length > 0 && bursts.length > 0) tags.add("explained_move");

  // tape_structure (S2): Screen reported a multi-session structure forming on
  // this ticker. Unlike every other tag it is not an intersection of two
  // messages — the structure is itself the composite, already the product of
  // several sessions, so its presence is the pattern.
  if (hasTapeStructure(messages)) tags.add("tape_structure");

  return COMPOSITE_TAG_ORDER.filter((t) => tags.has(t));
}

/**
 * §3 composite_bonus: sum of tag weights, positive contributions capped,
 * negative weights applied outside the cap.
 */
export function compositeBonus(tags: CompositeTag[], config: BaseConfig): number {
  let positive = 0;
  let negative = 0;
  for (const tag of tags) {
    const weight = config.tags.weights[tag] ?? 0;
    if (weight >= 0) positive += weight;
    else negative += weight;
  }
  return Math.min(positive, config.tags.positiveBonusCap) + negative;
}
