/**
 * §9 "replay first" — run Base over a recorded Tracker message stream and
 * report what it would have produced: incidents, their tags and priorities,
 * and the routing volume per destination.
 *
 * Pure: no dispatch, no budget, no side effects. This is the surface the
 * shadow-mode instrument panel reads, and the shape the calibration pass
 * compares expectations against.
 */

import type { BaseConfig } from "./config.js";
import { dedupeArticles, type ArticleDedupeResult } from "./article-dedupe.js";
import { isClassifierBound, type VerdictLookup } from "./classification.js";
import { buildIncidents, type IncidentIdFactory } from "./incident.js";
import {
  earningsCalendarFromMessages,
  mergeCalendars,
  withPreEarningsPreviewCap,
  type EarningsCalendar,
} from "./pre-earnings-preview.js";
import { routeIncident, type IncidentRouting } from "./routing.js";
import {
  COMPOSITE_TAG_ORDER,
  toWireIncident,
  type CompositeTag,
  type Incident,
  type PriorityBand,
  type RoutingDestination,
  type UserContext,
} from "./types.js";
import type { BaseMessage } from "./types.js";

export type ReplayedIncident = {
  incident: Incident;
  routing: IncidentRouting;
};

export type ReplayDestinationKey = RoutingDestination | "store_only";

export type BaseReplaySummary = {
  message_count: number;
  incident_count: number;
  ticker_count: number;
  /** Span of the replayed stream. */
  first_message_at: string | null;
  last_message_at: string | null;
  open_incidents: number;
  closed_incidents: number;
  degraded_incidents: number;
  /** Incidents the discovery floor promoted (§8 observability). */
  discovery_floor_promotions: number;
  /**
   * B2 cross-ticker article dedupe. `classifier_requests` is what would go
   * out after dedupe; by_destination.classifier still counts incidents.
   */
  dedupe: {
    news_messages: number;
    distinct_articles: number;
    classifier_requests: number;
    requests_saved: number;
    syndicated_articles: number;
    by_key_source: ArticleDedupeResult["by_key_source"];
  };
  /** §8 observability: incidents by priority band. */
  by_band: Record<PriorityBand, number>;
  /** Incidents by destination; an incident may reach more than one. */
  by_destination: Record<ReplayDestinationKey, number>;
  /** Incidents carrying each composite tag. */
  by_tag: Record<CompositeTag, number>;
  /** Incidents per ticker, descending. */
  by_ticker: Array<{ ticker: string; incidents: number; messages: number }>;
  /**
   * B9 / Classifier §10–§13. rescore_applied mirrors config (Phase B);
   * promotions/demotions compare against the same replay with re-score off.
   */
  classification: {
    rescore_applied: boolean;
    classifier_bound_messages: number;
    messages_with_verdict: number;
    messages_classified: number;
    messages_failed: number;
    messages_unassessed: number;
    incidents_promoted: number;
    incidents_demoted: number;
    propagation_candidates: number;
  };
};

export type BaseReplayResult = {
  summary: BaseReplaySummary;
  incidents: ReplayedIncident[];
  /** Per-article lead/follower groups, largest first. */
  article_groups: ArticleDedupeResult["groups"];
};

export type BaseReplayOptions = {
  config: BaseConfig;
  userContext?: UserContext;
  /** Evaluation instant for window closure; defaults to the last message. */
  now?: string;
  /** Classifier verdicts (B9). */
  verdictLookup?: VerdictLookup;
  /**
   * Known earnings due_at per ticker (the Tracker's scheduledEarnings ledger)
   * for the pre-earnings preview cap. Always merged with the scheduled_event
   * messages found in the stream itself.
   */
  earningsCalendar?: EarningsCalendar;
  /**
   * Incident id factory. §6 calls for uuid-v4 (the default); a consumer that
   * keys persisted state by incident id across replays (Analyst) injects a
   * deterministic factory so the same incident keeps the same id.
   */
  makeIncidentId?: IncidentIdFactory;
};

const BANDS: PriorityBand[] = ["P0", "P1", "P2", "P3"];
const DESTINATIONS: ReplayDestinationKey[] = [
  "classifier",
  "propagation",
  "extraction",
  "analyst",
  "scheduler",
  "store_only",
];

export function replayBase(
  messages: BaseMessage[],
  options: BaseReplayOptions,
): BaseReplayResult {
  const { config } = options;
  // Pre-earnings preview cap: the stream's own scheduled_event ledger plus any
  // explicit calendar the host passes (Tracker scheduledEarnings).
  const verdictLookup = options.verdictLookup
    ? withPreEarningsPreviewCap(
        options.verdictLookup,
        mergeCalendars(earningsCalendarFromMessages(messages), options.earningsCalendar),
        config,
      )
    : undefined;
  const states = buildIncidents(messages, {
    config,
    userContext: options.userContext,
    now: options.now,
    verdictLookup,
    makeIncidentId: options.makeIncidentId,
  });

  // Band migration (Classifier §13 first-week watch): the same replay with
  // re-score off, aligned by position — same stream, same structure.
  const BAND_RANK = { P3: 0, P2: 1, P1: 2, P0: 3 } as const;
  let promoted = 0;
  let demoted = 0;
  if (options.verdictLookup && config.classifier.rescoreEnabled) {
    const baseline = buildIncidents(messages, {
      config: { ...config, classifier: { ...config.classifier, rescoreEnabled: false } },
      userContext: options.userContext,
      now: options.now,
      makeIncidentId: options.makeIncidentId,
    });
    for (let i = 0; i < states.length && i < baseline.length; i++) {
      const d = BAND_RANK[states[i].priority_band] - BAND_RANK[baseline[i].priority_band];
      if (d > 0) promoted += 1;
      else if (d < 0) demoted += 1;
    }
  }
  let classifierBound = 0;
  let withVerdict = 0;
  let classified = 0;
  let failed = 0;
  let unassessed = 0;
  for (const m of messages) {
    if (!isClassifierBound(m, config)) continue;
    classifierBound += 1;
    const c = verdictLookup ? verdictLookup(m) : { state: "unclassified" as const };
    if (c.state === "unclassified") continue;
    withVerdict += 1;
    if (c.state === "classified") classified += 1;
    else if (c.state === "failed") failed += 1;
    else unassessed += 1;
  }

  const replayed: ReplayedIncident[] = states.map((state) => ({
    incident: toWireIncident(state),
    routing: routeIncident(state, config),
  }));

  const by_band = Object.fromEntries(BANDS.map((b) => [b, 0])) as Record<PriorityBand, number>;
  const by_destination = Object.fromEntries(DESTINATIONS.map((d) => [d, 0])) as Record<
    ReplayDestinationKey,
    number
  >;
  const by_tag = Object.fromEntries(COMPOSITE_TAG_ORDER.map((t) => [t, 0])) as Record<
    CompositeTag,
    number
  >;
  const perTicker = new Map<string, { incidents: number; messages: number }>();

  let open = 0;
  let degraded = 0;
  let floored = 0;
  for (const { incident, routing } of replayed) {
    by_band[incident.priority_band] += 1;
    if (incident.window_status === "open") open += 1;
    if (incident.degraded_context) degraded += 1;
    if (incident.discovery_floor_applied) floored += 1;
    for (const tag of incident.composite_tags) by_tag[tag] += 1;
    if (routing.store_only) by_destination.store_only += 1;
    for (const d of routing.destinations) by_destination[d.destination] += 1;
    const entry = perTicker.get(incident.ticker) ?? { incidents: 0, messages: 0 };
    entry.incidents += 1;
    entry.messages += incident.messages.length;
    perTicker.set(incident.ticker, entry);
  }

  const deduped = dedupeArticles(messages, config);
  const timestamps = messages.map((m) => m.timestamp).sort();
  const by_ticker = [...perTicker.entries()]
    .map(([ticker, v]) => ({ ticker, ...v }))
    .sort((a, b) => b.incidents - a.incidents || a.ticker.localeCompare(b.ticker));

  return {
    summary: {
      message_count: messages.length,
      incident_count: replayed.length,
      ticker_count: perTicker.size,
      first_message_at: timestamps[0] ?? null,
      last_message_at: timestamps[timestamps.length - 1] ?? null,
      open_incidents: open,
      closed_incidents: replayed.length - open,
      degraded_incidents: degraded,
      discovery_floor_promotions: floored,
      dedupe: {
        news_messages: deduped.news_count,
        distinct_articles: deduped.lead_count,
        classifier_requests: deduped.lead_count,
        requests_saved: deduped.follower_count,
        syndicated_articles: deduped.groups.filter((g) => g.syndicated).length,
        by_key_source: deduped.by_key_source,
      },
      by_band,
      by_destination,
      by_tag,
      by_ticker,
      classification: {
        rescore_applied: Boolean(options.verdictLookup) && config.classifier.rescoreEnabled,
        classifier_bound_messages: classifierBound,
        messages_with_verdict: withVerdict,
        messages_classified: classified,
        messages_failed: failed,
        messages_unassessed: unassessed,
        incidents_promoted: promoted,
        incidents_demoted: demoted,
        propagation_candidates: replayed.reduce((n, r) => n + r.incident.propagation_candidates.length, 0),
      },
    },
    incidents: replayed,
    article_groups: [...deduped.groups].sort((a, b) => b.message_ids.length - a.message_ids.length),
  };
}
