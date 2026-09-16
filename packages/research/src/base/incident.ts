/**
 * §2 incident model — measurement-anchored rolling window + correlation.
 *
 * Pure functions over a Tracker message sequence. Out-of-order and redelivered
 * messages are tolerated: the stream is sorted and deduplicated by message id
 * before grouping, so identical sequences in any arrival order produce
 * identical incidents (§8).
 */

import { randomUUID } from "node:crypto";
import { nextTradingDay, nyYmd, sessionTimes } from "../tracker/calendar.js";
import type {
  FilingItemPayload,
  NewsItemPayload,
  QuantContext,
  ScheduledEventPayload,
} from "../tracker/types.js";
import { propagationCandidatesFor, type VerdictLookup } from "./classification.js";
import type { BaseConfig } from "./config.js";
import { computeDegradedContext, computePriority } from "./priority.js";
import { deriveCompositeTags } from "./tags.js";
import {
  EMPTY_USER_CONTEXT,
  resolveProximity,
  type IncidentState,
  type SchedulerDueTrigger,
  type UserContext,
} from "./types.js";
import type { BaseMessage, BaseMessageType } from "./types.js";

// ---------------------------------------------------------------------------
// Window arithmetic
// ---------------------------------------------------------------------------

/** §2: only measurement-class messages extend an open window. */
export function isWindowExtending(type: BaseMessageType, config: BaseConfig): boolean {
  return config.window.extendingTypes.includes(type);
}

/**
 * The instant an incident closes: 6h after the last extending message or the
 * 8h hard cap from the first message, whichever comes first.
 *
 * With no extending message yet, `silenceAnchorFallback` decides: "none"
 * (spec-literal) leaves only the hard cap in play, so a news-opened incident
 * can still absorb the close-computed detectors it caused.
 */
export function windowCloseAtMs(state: IncidentState, config: BaseConfig): number {
  // An absorbing window replaces both timers outright (§2): it closes when the
  // session that prices the release closes, whenever that is.
  if (state.absorbing_until !== null) return Date.parse(state.absorbing_until);
  const startMs = Date.parse(state.window_start);
  const capMs = startMs + config.window.hardCapMs;
  if (state.last_measurement_at !== null) {
    const lastMs = Date.parse(state.last_measurement_at);
    const silenceMs = lastMs + config.window.measurementSilenceMs;
    // B6-b: a measurement the stretched no-measurement window admitted can sit
    // past the nominal 8h cap (07:00 open, 16:44 close-run). The cap cannot
    // then retroactively precede a message the incident already holds, so the
    // silence timer governs alone. Unreachable for an un-stretched incident —
    // it closes at the cap before any later measurement can arrive — so
    // measured behaviour is otherwise exactly the 6h / 8h rule.
    return capMs < lastMs ? silenceMs : Math.min(silenceMs, capMs);
  }
  // No measurement yet (B6). The silence timer has nothing to anchor on, so
  // without a rule of its own a lone-news incident crawls to the cap.
  switch (config.window.silenceAnchorFallback) {
    case "window_start":
      return Math.min(startMs + config.window.measurementSilenceMs, capMs);
    case "session_close": {
      const pricing = pricingSession(state.window_start);
      if (pricing === null) return capMs;
      const targetMs = pricing.closeMs + config.window.noMeasurementCloseGraceMs;
      // B6-b: opened inside the session that prices it, the cap stretches to
      // the session target — a 07:00 ET news open must still be alive for the
      // 16:44 close-run, which an 8h cap (15:00) would strand in a new
      // incident. The target is the ceiling; there is no second extension.
      // Opened after the close, the pricing session is tomorrow's and the cap
      // stands: a 12h+ news incident is a zombie, and tomorrow's close
      // detectors belong to tomorrow's incident, not to stale news.
      return pricing.sameSession ? targetMs : Math.min(targetMs, capMs);
    }
    default:
      return capMs;
  }
}

/**
 * The session that prices an instant: today's if the instant falls before
 * today's close (`sameSession`), otherwise the next trading day's. Null only
 * if the calendar cannot resolve one (never in practice).
 */
function pricingSession(atIso: string): { closeMs: number; sameSession: boolean } | null {
  const at = new Date(atIso);
  const day = nyYmd(at);
  const today = sessionTimes(day);
  if (today && at.getTime() < today.closeUtc.getTime()) {
    return { closeMs: today.closeUtc.getTime(), sameSession: true };
  }
  const next = sessionTimes(nextTradingDay(day));
  return next ? { closeMs: next.closeUtc.getTime(), sameSession: false } : null;
}

export function windowCloseAt(state: IncidentState, config: BaseConfig): string {
  return new Date(windowCloseAtMs(state, config)).toISOString();
}

// ---------------------------------------------------------------------------
// §2 earnings absorption
// ---------------------------------------------------------------------------

/** True when this filing is the earnings release itself. */
export function isEarningsAnnouncement(message: BaseMessage, config: BaseConfig): boolean {
  if (message.type !== "filing_item") return false;
  const p = message.payload as FilingItemPayload;
  return (
    config.tags.eightKFormTypes.includes(p.form_type) &&
    p.item_codes.includes(config.earnings.announcementItemCode)
  );
}

/**
 * The instant an earnings absorption window closes.
 *
 * Announced before the open, the reaction is that session's; announced after
 * the close, it is the next session's. Either way the window runs to the close
 * of the session that prices the news, which is what keeps the filing and the
 * gap it caused inside one incident.
 */
export function absorptionEndAt(announcementIso: string, config: BaseConfig): string | null {
  const at = new Date(announcementIso);
  const day = nyYmd(at);
  const times = sessionTimes(day);
  const t = at.getTime();

  // Announced on a non-trading day: the next session prices it.
  if (!times) return closeOf(nextTradingDay(day), config);

  if (t < times.openUtc.getTime()) return withGrace(times.closeUtc.toISOString(), config); // BMO
  if (t >= times.closeUtc.getTime()) return closeOf(nextTradingDay(day), config); // AMC
  return config.earnings.intradayAnnouncementTreatedAs === "amc"
    ? closeOf(nextTradingDay(day), config)
    : withGrace(times.closeUtc.toISOString(), config);
}

function closeOf(day: string, config: BaseConfig): string | null {
  const times = sessionTimes(day);
  return times ? withGrace(times.closeUtc.toISOString(), config) : null;
}

function withGrace(closeIso: string, config: BaseConfig): string {
  return new Date(Date.parse(closeIso) + config.earnings.absorptionGraceMs).toISOString();
}

// ---------------------------------------------------------------------------
// Trigger identity (§2 related incidents)
// ---------------------------------------------------------------------------

/** Identity keys a later incident can be linked to: 8-K accession, scheduled due_at, article id. */
export function triggerIdentities(messages: BaseMessage[], config: BaseConfig): string[] {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.type === "filing_item") {
      const p = m.payload as FilingItemPayload;
      if (config.tags.eightKFormTypes.includes(p.form_type)) out.add(`8k:${p.accession_number}`);
    } else if (m.type === "scheduled_event") {
      out.add(`sched:${(m.payload as ScheduledEventPayload).due_at}`);
    } else if (m.type === "news_item") {
      out.add(`article:${(m.payload as NewsItemPayload).article_id}`);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export type IncidentIdFactory = (ticker: string, windowStart: string, index: number) => string;

export type BuildIncidentsOptions = {
  config: BaseConfig;
  /** Proximity source for scoring (§3); defaults to tracked-only. */
  userContext?: UserContext;
  /**
   * Evaluation instant used to decide whether the still-open incidents have
   * in fact closed. Defaults to the last message in the stream.
   */
  now?: string;
  /**
   * Per-incident scoring instant. Defaults to the incident's last message —
   * the moment Base last saw evidence for it.
   */
  evaluateAt?: (state: IncidentState) => string;
  /** §6 calls for uuid-v4; tests inject a deterministic factory. */
  makeIncidentId?: IncidentIdFactory;
  /**
   * Scheduler due-triggers to interleave by fired_at, so a replay models the
   * Scheduler as well as the Tracker stream (§2 scheduled triggers).
   */
  dueTriggers?: SchedulerDueTrigger[];
  /** Classifier verdicts (B9): re-score when enabled, propagation candidates always. */
  verdictLookup?: VerdictLookup;
};

function sortAndDedupe(messages: BaseMessage[]): BaseMessage[] {
  const seen = new Set<string>();
  const unique: BaseMessage[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue; // redelivery (§8)
    seen.add(m.id);
    unique.push(m);
  }
  return unique.sort((a, b) => {
    const d = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function latestQuantContext(messages: BaseMessage[]): QuantContext | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].quant_context) return messages[i].quant_context;
  }
  return null;
}

/**
 * Fill in everything derived from an incident's message set: tags, quant
 * context, degraded flag, proximity and priority.
 */
export function scoreIncident(
  state: IncidentState,
  options: { config: BaseConfig; userContext?: UserContext; now: string; verdictLookup?: VerdictLookup },
): IncidentState {
  const { config } = options;
  const userContext = options.userContext ?? EMPTY_USER_CONTEXT;
  const quantContext = latestQuantContext(state.messages);
  const composite_tags = deriveCompositeTags(
    {
      messages: state.messages,
      windowStart: state.window_start,
      quantContext,
      earningsAbsorption: state.earnings_absorption,
    },
    config,
  );
  const user_proximity = resolveProximity(state.ticker, userContext);
  const scored = computePriority({
    messages: state.messages,
    composite_tags,
    user_proximity,
    now: options.now,
    config,
    verdictLookup: options.verdictLookup,
  });
  return {
    ...state,
    composite_tags,
    propagation_candidates: options.verdictLookup
      ? propagationCandidatesFor(state.messages, options.verdictLookup, config)
      : [],
    quant_context: quantContext,
    degraded_context: computeDegradedContext(state.messages, quantContext, config),
    user_proximity,
    priority: scored.priority,
    priority_band: scored.band,
    discovery_floor_applied: scored.discovery_floor_applied,
    trigger_identities: triggerIdentities(state.messages, config),
  };
}

/**
 * Group a Tracker message stream into incidents. Structure first (windowing
 * and correlation), then tags and priority per incident.
 */
export function buildIncidents(
  messages: BaseMessage[],
  options: BuildIncidentsOptions,
): IncidentState[] {
  const { config } = options;
  const makeId = options.makeIncidentId ?? (() => randomUUID());
  const ordered = sortAndDedupe(messages);
  const nowMs = Date.parse(
    options.now ?? ordered[ordered.length - 1]?.timestamp ?? new Date(0).toISOString(),
  );

  const open = new Map<string, IncidentState>();
  const all: IncidentState[] = [];
  let index = 0;

  const openIncident = (message: BaseMessage): IncidentState => {
    const state: IncidentState = {
      incident_id: makeId(message.ticker, message.timestamp, index++),
      ticker: message.ticker,
      trigger_type: "organic",
      window_start: message.timestamp,
      window_end: null,
      window_status: "open",
      composite_tags: [],
      priority: 0,
      priority_band: "P3",
      degraded_context: false,
      discovery_floor_applied: false,
      earnings_absorption: false,
      messages: [message],
      quant_context: message.quant_context ?? null,
      user_proximity: "tracked",
      related_incident_id: null,
      propagation_candidates: [],
      last_measurement_at: isWindowExtending(message.type, config) ? message.timestamp : null,
      absorbing_until: null,
      trigger_identities: [],
    };
    all.push(state);
    return state;
  };

  /** Mark an incident as absorbing once its announcement is known (§2). */
  const markAbsorbing = (state: IncidentState, message: BaseMessage): void => {
    if (!config.earnings.enabled || !config.earnings.openOnAnnouncementFiling) return;
    if (!isEarningsAnnouncement(message, config)) return;
    const until = absorptionEndAt(message.timestamp, config);
    if (!until) return;
    // Keep the later end if a second release lands inside the window.
    if (state.absorbing_until === null || until > state.absorbing_until) {
      state.absorbing_until = until;
      state.earnings_absorption = true;
    }
  };

  // Scheduler due-triggers are interleaved into the timeline by fired_at so a
  // replay models the Scheduler too: at the due time the trigger opens an
  // absorbing scheduled incident, and everything the ticker emits afterwards —
  // the 8-K, the next open's gap, the close batch — joins it (§2).
  const triggers = [...(options.dueTriggers ?? [])].sort(
    (a, b) => Date.parse(a.fired_at) - Date.parse(b.fired_at) || (a.id < b.id ? -1 : 1),
  );
  let nextTrigger = 0;
  const fireTriggersUpTo = (atIso: string): void => {
    while (nextTrigger < triggers.length && triggers[nextTrigger].fired_at <= atIso) {
      const trigger = triggers[nextTrigger++];
      const existing = open.get(trigger.ticker) ?? null;
      if (existing && existing.absorbing_until !== null) {
        // The release already opened an absorbing incident (a BMO 8-K ahead
        // of its due_at). One occurrence — merge rather than split.
        const identity = `sched:${trigger.due_at}`;
        if (!existing.trigger_identities.includes(identity)) existing.trigger_identities.push(identity);
        const until = absorptionEndAt(trigger.due_at, config);
        if (until && until > existing.absorbing_until) existing.absorbing_until = until;
        continue;
      }
      if (existing) {
        const closeMs = Math.min(windowCloseAtMs(existing, config), Date.parse(trigger.fired_at));
        existing.window_end = new Date(closeMs).toISOString();
        existing.window_status = "closed";
        open.delete(trigger.ticker);
      }
      const scheduled = openScheduledIncident(trigger, all, {
        config,
        userContext: options.userContext,
        makeIncidentId: (t, w) => makeId(t, w, index++),
        verdictLookup: options.verdictLookup,
      });
      all.push(scheduled);
      open.set(trigger.ticker, scheduled);
    }
  };

  for (const message of ordered) {
    fireTriggersUpTo(message.timestamp);
    const ticker = message.ticker;
    let current = open.get(ticker) ?? null;
    if (current) {
      // Inside an absorption window neither the silence timer nor the hard cap
      // applies: the release and the session that prices it are one occurrence.
      const absorbing =
        current.absorbing_until !== null && message.timestamp < current.absorbing_until;
      if (!absorbing) {
        const closeMs = windowCloseAtMs(current, config);
        if (Date.parse(message.timestamp) >= closeMs) {
          current.window_end = new Date(closeMs).toISOString();
          current.window_status = "closed";
          open.delete(ticker);
          current = null;
        }
      }
    }
    if (!current) {
      current = openIncident(message);
      open.set(ticker, current);
      markAbsorbing(current, message);
      continue;
    }
    current.messages.push(message);
    if (isWindowExtending(message.type, config)) current.last_measurement_at = message.timestamp;
    // The announcement absorbs the incident it lands in, so messages that
    // arrived minutes before it — the close-computed reaction, the news dump —
    // are carried along rather than stranded in a separate incident.
    markAbsorbing(current, message);
  }

  // Triggers that fire after the last message still open their incidents.
  fireTriggersUpTo(new Date(nowMs).toISOString());

  // Anything still open closes if its window already elapsed as of `now`.
  for (const state of open.values()) {
    const closeMs = windowCloseAtMs(state, config);
    if (nowMs >= closeMs) {
      state.window_end = new Date(closeMs).toISOString();
      state.window_status = "closed";
    }
  }

  // Derived fields, then related-incident linking (needs identities on all).
  const evaluateAt =
    options.evaluateAt ??
    ((state: IncidentState) => state.messages[state.messages.length - 1]?.timestamp ?? state.window_start);
  const scored = all.map((state) =>
    scoreIncident(state, {
      config,
      userContext: options.userContext,
      now: evaluateAt(state),
      verdictLookup: options.verdictLookup,
    }),
  );
  return linkRelatedIncidents(scored, config);
}

/**
 * §2: link incidents on the same ticker opened within the lookback of the
 * prior incident's closure that share a trigger identity.
 */
export function linkRelatedIncidents(
  incidents: IncidentState[],
  config: BaseConfig,
): IncidentState[] {
  return incidents.map((incident, i) => {
    const startMs = Date.parse(incident.window_start);
    let best: IncidentState | null = null;
    let bestEnd = -Infinity;
    for (let j = 0; j < i; j++) {
      const prior = incidents[j];
      if (prior.ticker !== incident.ticker) continue;
      if (prior.window_end === null) continue;
      const endMs = Date.parse(prior.window_end);
      const gap = startMs - endMs;
      if (gap < 0 || gap > config.window.relatedLookbackMs) continue;
      if (!prior.trigger_identities.some((id) => incident.trigger_identities.includes(id))) continue;
      if (endMs >= bestEnd) {
        bestEnd = endMs;
        best = prior;
      }
    }
    return best ? { ...incident, related_incident_id: best.incident_id } : incident;
  });
}

// ---------------------------------------------------------------------------
// Scheduled due-triggers (§2)
// ---------------------------------------------------------------------------

export type ScheduledIncidentOptions = {
  config: BaseConfig;
  userContext?: UserContext;
  makeIncidentId?: IncidentIdFactory;
  verdictLookup?: VerdictLookup;
};

/**
 * A Scheduler due-trigger opens its own incident — it does not require an
 * open one to exist — and points back at the incident that carried the
 * scheduled_event.
 */
export function openScheduledIncident(
  trigger: SchedulerDueTrigger,
  priorIncidents: IncidentState[],
  options: ScheduledIncidentOptions,
): IncidentState {
  const { config } = options;
  const makeId = options.makeIncidentId ?? (() => randomUUID());
  const identity = `sched:${trigger.due_at}`;

  let source: IncidentState | null = null;
  let sourceMessage: BaseMessage | null = null;
  for (const prior of priorIncidents) {
    if (prior.ticker !== trigger.ticker) continue;
    const match = prior.messages.find(
      (m) => m.type === "scheduled_event" && (m.payload as ScheduledEventPayload).due_at === trigger.due_at,
    );
    if (!match && !prior.trigger_identities.includes(identity)) continue;
    if (source === null || Date.parse(prior.window_start) >= Date.parse(source.window_start)) {
      source = prior;
      sourceMessage = match ?? null;
    }
  }

  const messages =
    config.window.includeSourceScheduledEvent && sourceMessage ? [sourceMessage] : [];
  // The due-trigger IS the release as far as Base knows: with no 8-K yet, the
  // announcement time is due_at, and BMO/AMC falls out of where it sits
  // against the session (§2 absorption). The 8-K, when it lands, can only
  // extend this — see markAbsorbing in buildIncidents.
  const absorbing_until = config.earnings.enabled ? absorptionEndAt(trigger.due_at, config) : null;
  const state: IncidentState = {
    incident_id: makeId(trigger.ticker, trigger.fired_at, 0),
    ticker: trigger.ticker,
    trigger_type: "scheduled",
    window_start: trigger.fired_at,
    window_end: null,
    window_status: "open",
    composite_tags: [],
    priority: 0,
    priority_band: "P3",
    degraded_context: false,
    discovery_floor_applied: false,
    earnings_absorption: absorbing_until !== null,
    messages,
    quant_context: trigger.quant_context ?? sourceMessage?.quant_context ?? null,
    user_proximity: "tracked",
    related_incident_id: source?.incident_id ?? null,
    propagation_candidates: [],
    last_measurement_at: null,
    absorbing_until,
    trigger_identities: [identity],
  };
  const scored = scoreIncident(state, {
    config,
    userContext: options.userContext,
    now: trigger.fired_at,
    verdictLookup: options.verdictLookup,
  });
  return {
    ...scored,
    // scoreIncident recomputes identities from messages; the trigger's own
    // due_at identity must survive even when no source message was carried.
    trigger_identities: [...new Set([identity, ...scored.trigger_identities])].sort(),
    related_incident_id: source?.incident_id ?? null,
  };
}
