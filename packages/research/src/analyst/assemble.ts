/**
 * §3 input assembly — deterministic, capped, verdict-aware.
 *
 * A pure function of (incident, verdicts, quant_context, config). Token
 * discipline is a spec requirement: the WMT incident carries 81 messages and
 * must not ship wholesale. Included, in order: the anomaly/measurement
 * messages (full payloads — few and dense), filings, calendar, a capped set
 * of insider lines, classified news as one line each (direct first by
 * materiality, then indirect; capped), the count of excluded articles,
 * composite tags, the latest quant_context, the degraded flag and the
 * reaction_state.
 *
 * Never included: user identity, holdings, watchlist, priority score or
 * band. Reasoning must be independent of who is watching.
 *
 * Every included message gets a short ref (`m1`, `m2`, …) the model cites as
 * evidence; refs resolve back to message ids at validation.
 */

import type { MessageClassification } from "../base/classification.js";
import { MEASUREMENT_MESSAGE_TYPES, type CompositeTag, type Incident } from "../base/types.js";
import type { Direction, Materiality, Relevance } from "../classifier/types.js";
import type { BaseMessage } from "../base/types.js";
import type {
  FilingItemPayload,
  InsiderFilingPayload,
  NewsItemPayload,
  QuantContext,
  ScheduledEventPayload,
  TrackerMessage,
} from "../tracker/types.js";
import type { AnalystConfig } from "./config.js";
import { computeReactionState, structureMessage } from "./reaction.js";
import type { TapeStructurePayload } from "../screen/types.js";
import type { AnalystRequestKind, ReactionState } from "./types.js";

export type AssembledAnomaly = {
  ref: string;
  id: string;
  type: string;
  timestamp: string;
  context_flags: string[];
  payload: Record<string, unknown>;
};

export type AssembledFiling = {
  ref: string;
  id: string;
  timestamp: string;
  form_type: string;
  item_codes: string[];
  filed_at: string;
  accession_number: string;
};

export type AssembledCalendar = {
  ref: string;
  id: string;
  timestamp: string;
  due_at: string;
  fiscal_period: string;
  earnings_rhythm: number | null;
  rescheduled: boolean;
};

export type AssembledInsider = {
  ref: string;
  id: string;
  timestamp: string;
  insider_name: string;
  role: string;
  transaction_code: string;
  is_10b5_1_plan: boolean;
  value: number | null;
  transaction_date: string | null;
};

export type AssembledNewsLine = {
  ref: string;
  id: string;
  headline: string;
  source: string;
  published_at: string;
  event_type: string;
  event_label: string;
  relevance: Exclude<Relevance, "none">;
  materiality: Materiality;
  direction: Direction;
};

export type AssembledInput = {
  ticker: string;
  kind: AnalystRequestKind;
  incident: {
    incident_id: string;
    window_start: string;
    window_end: string | null;
    window_status: "open" | "closed";
    trigger_type: "organic" | "scheduled";
    composite_tags: CompositeTag[];
    degraded_context: boolean;
    earnings_absorption: boolean;
    related_incident_id: string | null;
    message_count: number;
  };
  anomalies: AssembledAnomaly[];
  filings: AssembledFiling[];
  calendar: AssembledCalendar[];
  insiders: AssembledInsider[];
  insiders_omitted: number;
  news: AssembledNewsLine[];
  /** Classified direct/indirect lines dropped by the cap. */
  news_omitted: { direct: number; indirect: number };
  /** Articles represented only by the count line. */
  news_excluded: { none: number; unassessed: number; failed: number; unclassified: number };
  quant_context: QuantContext | null;
  /** S3: the Screen structure this incident is about (structure_review only). */
  structure: TapeStructurePayload | null;
  reaction_state: ReactionState;
  /** ref → message id. */
  refs: Record<string, string>;
  /** Every message id in the incident — the evidence universe (§5). */
  evidence_ids: string[];
};

const MATERIALITY_RANK: Record<Materiality, number> = { low: 0, standard: 1, high: 2 };
const STRIPPED_PAYLOAD_KEYS = new Set(["url", "filing_url"]);

function byTime(a: BaseMessage, b: BaseMessage): number {
  return a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

/** Drop display-only URLs from a payload before it reaches the model. */
export function slimPayload(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof payload !== "object" || payload === null) return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (STRIPPED_PAYLOAD_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function assembleInput(
  incident: Incident,
  verdicts: Record<string, MessageClassification>,
  kind: AnalystRequestKind,
  config: AnalystConfig,
): AssembledInput {
  const messages = [...incident.messages].sort(byTime);
  const refs: Record<string, string> = {};
  let n = 0;
  const ref = (id: string): string => {
    n += 1;
    const r = `m${n}`;
    refs[r] = id;
    return r;
  };

  // 1. Anomaly / measurement messages — full payloads.
  const measurement = new Set<string>(MEASUREMENT_MESSAGE_TYPES);
  const anomalies: AssembledAnomaly[] = messages
    .filter((m) => measurement.has(m.type))
    .map((m) => ({
      ref: ref(m.id),
      id: m.id,
      type: m.type,
      timestamp: m.timestamp,
      context_flags: [...m.context_flags],
      payload: slimPayload(m.payload),
    }));

  // 2. Filings — form type, item codes, dates.
  const filings: AssembledFiling[] = messages
    .filter((m) => m.type === "filing_item")
    .map((m) => {
      const p = m.payload as FilingItemPayload;
      return {
        ref: ref(m.id),
        id: m.id,
        timestamp: m.timestamp,
        form_type: p.form_type,
        item_codes: [...p.item_codes],
        filed_at: p.filed_at,
        accession_number: p.accession_number,
      };
    });

  // Calendar — the scheduled events the incident carries (earnings due dates
  // are what a falsifiable watch_trigger is usually pinned to).
  const calendar: AssembledCalendar[] = messages
    .filter((m) => m.type === "scheduled_event")
    .map((m) => {
      const p = m.payload as ScheduledEventPayload;
      return {
        ref: ref(m.id),
        id: m.id,
        timestamp: m.timestamp,
        due_at: p.due_at,
        fiscal_period: p.fiscal_period,
        earnings_rhythm: p.earnings_rhythm,
        rescheduled: p.rescheduled,
      };
    });

  // Insider filings — compact lines, capped (the cluster payload above already
  // summarises them when a cluster fired).
  const insiderMessages = messages.filter((m) => m.type === "insider_filing");
  const insiders: AssembledInsider[] = insiderMessages.slice(0, config.insiderLineCap).map((m) => {
    const p = m.payload as InsiderFilingPayload;
    return {
      ref: ref(m.id),
      id: m.id,
      timestamp: m.timestamp,
      insider_name: p.insider_name,
      role: p.role,
      transaction_code: p.transaction_code,
      is_10b5_1_plan: p.is_10b5_1_plan,
      value: p.value,
      transaction_date: p.transaction_date,
    };
  });
  const insiders_omitted = Math.max(0, insiderMessages.length - insiders.length);

  // 3. Classified news — one line each, direct first by materiality desc,
  // then indirect; within a tier newest first. Capped.
  const news_excluded = { none: 0, unassessed: 0, failed: 0, unclassified: 0 };
  type Candidate = { m: TrackerMessage; c: Extract<MessageClassification, { state: "classified" }> };
  const direct: Candidate[] = [];
  const indirect: Candidate[] = [];
  for (const m of messages) {
    if (m.type !== "news_item") continue;
    const c = verdicts[m.id];
    if (!c || c.state === "unclassified") {
      news_excluded.unclassified += 1;
      continue;
    }
    if (c.state === "failed") {
      news_excluded.failed += 1;
      continue;
    }
    if (c.state === "unassessed") {
      news_excluded.unassessed += 1;
      continue;
    }
    if (c.entry.relevance === "none") {
      news_excluded.none += 1;
      continue;
    }
    (c.entry.relevance === "direct" ? direct : indirect).push({ m, c });
  }
  const rank = (x: Candidate): number =>
    x.c.entry.relevance === "none" ? -1 : MATERIALITY_RANK[x.c.entry.materiality];
  const newestFirst = (a: Candidate, b: Candidate): number =>
    rank(b) - rank(a) ||
    publishedAt(b.m).localeCompare(publishedAt(a.m)) ||
    b.m.timestamp.localeCompare(a.m.timestamp) ||
    a.m.id.localeCompare(b.m.id);
  direct.sort(newestFirst);
  indirect.sort(newestFirst);
  const cap = Math.max(0, config.newsLineCap);
  const takenDirect = direct.slice(0, cap);
  const takenIndirect = indirect.slice(0, Math.max(0, cap - takenDirect.length));
  const news: AssembledNewsLine[] = [...takenDirect, ...takenIndirect].map(({ m, c }) => {
    const p = m.payload as NewsItemPayload;
    const entry = c.entry as Extract<typeof c.entry, { relevance: "direct" | "indirect" }>;
    return {
      ref: ref(m.id),
      id: m.id,
      headline: p.headline ?? "",
      source: p.source ?? "",
      published_at: p.published_at ?? m.timestamp,
      event_type: c.verdict.event_type,
      event_label: c.verdict.event_label,
      relevance: entry.relevance,
      materiality: entry.materiality,
      direction: entry.direction,
    };
  });
  const news_omitted = {
    direct: direct.length - takenDirect.length,
    indirect: indirect.length - takenIndirect.length,
  };

  // 4–5. Tags, latest quant context, degraded flag, reaction_state.
  const reaction_state = computeReactionState(incident, verdicts, config, kind);
  const structure = kind === "structure_review" ? structureMessage(incident) : null;

  return {
    ticker: incident.ticker,
    kind,
    incident: {
      incident_id: incident.incident_id,
      window_start: incident.window_start,
      window_end: incident.window_end,
      window_status: incident.window_status,
      trigger_type: incident.trigger_type,
      composite_tags: [...incident.composite_tags],
      degraded_context: incident.degraded_context,
      earnings_absorption: incident.earnings_absorption,
      related_incident_id: incident.related_incident_id,
      message_count: incident.messages.length,
    },
    anomalies,
    filings,
    calendar,
    insiders,
    insiders_omitted,
    news,
    news_omitted,
    news_excluded,
    quant_context: incident.quant_context,
    structure,
    reaction_state,
    refs,
    evidence_ids: messages.map((m) => m.id),
  };
}

function publishedAt(m: TrackerMessage): string {
  return (m.payload as NewsItemPayload).published_at ?? m.timestamp;
}

/** Total articles represented only by the count line. */
export function excludedCount(input: Pick<AssembledInput, "news_excluded">): number {
  const e = input.news_excluded;
  return e.none + e.unassessed + e.failed + e.unclassified;
}
