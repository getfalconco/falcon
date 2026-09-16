/**
 * §2 best-event selection — the event fed to a run is the incident's best
 * event: the highest-materiality direct verdict among the propagation
 * candidates, else the mapped 8-K item, else the gap's cause. Pure function
 * of (incident, verdicts, config).
 */

import type { MessageClassification } from "../../base/classification.js";
import type { BaseMessage, Incident } from "../../base/types.js";
import type { Materiality } from "../../classifier/types.js";
import { describeItemCode } from "../../classifier/filing-items.js";
import type {
  FilingItemPayload,
  GapEventPayload,
  NewsItemPayload,
} from "../../tracker/types.js";
import type { PropagationConfig } from "./config.js";
import { capText } from "./mechanism.js";
import type { PropagationEvent } from "./types.js";

const MATERIALITY_RANK: Record<Materiality, number> = { low: 0, standard: 1, high: 2 };

/** A classified article says most; a filing is the cause; a gap is the reaction. */
const SOURCE_RANK: Record<PropagationEvent["source"], number> = {
  verdict: 3,
  filing_item: 2,
  gap_cause: 1,
};

/** Drop C0 control characters and DEL; collapse whitespace. */
export function cleanLabel(raw: string, cap: number): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return capText(out, cap);
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export type EventSelectionOptions = {
  /** Restrict to the incident's ticker (the root); candidates are per ticker already. */
  rootTicker: string;
  config: Pick<PropagationConfig, "eightKItemEvents" | "gapHighMaterialityZ" | "fieldCaps">;
};

/**
 * Resolve the best event. Returns null when the incident carries nothing
 * Propagation can read (no candidate verdict, no mapped 8-K, no gap cause).
 */
export function selectBestEvent(
  incident: Pick<Incident, "messages" | "propagation_candidates" | "composite_tags">,
  verdicts: Record<string, MessageClassification>,
  options: EventSelectionOptions,
): PropagationEvent | null {
  const root = options.rootTicker.toUpperCase();
  const cap = options.config.fieldCaps.label;

  // 1. Highest-materiality direct verdict among the candidates.
  const candidateKeys = new Set(
    incident.propagation_candidates
      .filter((c) => c.ticker.toUpperCase() === root)
      .map((c) => c.article_key),
  );
  let best: { message: BaseMessage; materiality: Materiality; rank: number } | null = null;
  const supporting: BaseMessage[] = [];
  for (const message of incident.messages) {
    if (message.ticker.toUpperCase() !== root) continue;
    const c = verdicts[message.id];
    if (!c || c.state !== "classified") continue;
    if (!candidateKeys.has(c.verdict.article_key)) continue;
    if (c.entry.relevance !== "direct") continue;
    supporting.push(message);
    const rank = MATERIALITY_RANK[c.entry.materiality];
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank && message.timestamp > best.message.timestamp)
    ) {
      best = { message, materiality: c.entry.materiality, rank };
    }
  }
  const candidates: PropagationEvent[] = [];
  if (best) {
    const c = verdicts[best.message.id];
    if (c && c.state === "classified" && c.entry.relevance !== "none") {
      const payload = best.message.payload as Partial<NewsItemPayload>;
      const eventTs = payload.published_at && !Number.isNaN(Date.parse(payload.published_at))
        ? payload.published_at
        : best.message.timestamp;
      const lines = supporting
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 8)
        .map((m) => {
          const p = m.payload as Partial<NewsItemPayload>;
          const v = verdicts[m.id];
          const tag =
            v && v.state === "classified" && v.entry.relevance !== "none"
              ? `${v.verdict.event_type} · ${v.entry.materiality} · ${v.entry.direction}`
              : "";
          return oneLine(`${p.headline ?? ""}${tag ? ` (${tag})` : ""}`);
        })
        .filter(Boolean);
      candidates.push({
        type: c.verdict.event_type,
        direction: c.entry.direction,
        materiality: c.entry.materiality,
        label: cleanLabel(c.verdict.event_label || (payload.headline ?? "event"), cap),
        source_msg_ids: [best.message.id],
        event_ts: eventTs,
        source: "verdict",
        evidence_lines: lines,
      });
    }
  }

  // 2. Mapped 8-K item (first mapped code in config order across the filings).
  const gap = incident.messages.find(
    (m): m is BaseMessage & { payload: GapEventPayload } => m.type === "gap_event" && m.ticker.toUpperCase() === root,
  );
  const gapPayload = gap ? (gap.payload as GapEventPayload) : null;
  const filings = incident.messages.filter(
    (m) => m.type === "filing_item" && m.ticker.toUpperCase() === root,
  );
  for (const code of Object.keys(options.config.eightKItemEvents)) {
    for (const filing of filings) {
      const p = filing.payload as FilingItemPayload;
      if (!Array.isArray(p.item_codes) || !p.item_codes.includes(code)) continue;
      const shape = options.config.eightKItemEvents[code];
      // An earnings 8-K carries no sign of its own; the incident's gap, when
      // there is one, is the market's read of it — deterministic and explicit.
      const direction =
        shape.direction === "unclear" && code === "2.02" && gapPayload
          ? gapPayload.direction === "down"
            ? "negative"
            : "positive"
          : shape.direction;
      const lines = [
        oneLine(`${p.form_type} items ${p.item_codes.join(", ")} filed ${String(p.filed_at).slice(0, 10)} — ${p.item_codes.map(describeItemCode).join("; ")}`),
      ];
      if (gapPayload && gap) {
        lines.push(
          `gap ${gapPayload.direction} ${(gapPayload.gap_pct * 100).toFixed(1)}% (z ${gapPayload.gap_z.toFixed(1)}) at ${gap.timestamp}`,
        );
      }
      candidates.push({
        type: shape.type,
        direction,
        materiality: shape.materiality,
        label: cleanLabel(shape.label, cap),
        source_msg_ids: gap && direction !== shape.direction ? [filing.id, gap.id] : [filing.id],
        event_ts: filing.timestamp,
        source: "filing_item",
        evidence_lines: lines,
      });
      break;
    }
  }

  // 3. The gap's cause: an event_gap composite (gap inside an earnings window).
  if (gap && gapPayload && incident.composite_tags.includes("event_gap")) {
    const materiality: Materiality =
      Math.abs(gapPayload.gap_z) >= options.config.gapHighMaterialityZ ? "high" : "standard";
    candidates.push({
      type: "earnings_results",
      direction: gapPayload.direction === "down" ? "negative" : "positive",
      materiality,
      label: cleanLabel(
        `Earnings-window gap ${gapPayload.direction} ${(gapPayload.gap_pct * 100).toFixed(1)}% (z ${gapPayload.gap_z.toFixed(1)})`,
        cap,
      ),
      source_msg_ids: [gap.id],
      event_ts: gap.timestamp,
      source: "gap_cause",
      evidence_lines: [
        `gap ${gapPayload.direction} ${(gapPayload.gap_pct * 100).toFixed(1)}% (z ${gapPayload.gap_z.toFixed(1)}) from prev close ${gapPayload.prev_close} to open ${gapPayload.open_price}`,
      ],
    });
  }

  // The incident's best event: materiality first — the engine's own read of
  // how much it matters — then what kind of thing it is, then recency.
  //
  // Materiality leads because a strict verdict-then-filing chain let a
  // two-day-old standard-materiality article outrank an earnings 8-K that had
  // just landed, anchoring the pricing check two sessions before the event the
  // run was reacting to. Source precedence breaks the ties materiality leaves,
  // and it must: a gap is the market's reaction to the filing that caused it,
  // always later and never the better anchor. Recency decides only between two
  // events of the same kind and weight.
  candidates.sort(
    (a, b) =>
      MATERIALITY_RANK[b.materiality] - MATERIALITY_RANK[a.materiality] ||
      SOURCE_RANK[b.source] - SOURCE_RANK[a.source] ||
      Date.parse(b.event_ts) - Date.parse(a.event_ts),
  );
  return candidates[0] ?? null;
}
