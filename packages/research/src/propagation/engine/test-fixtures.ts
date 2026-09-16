/**
 * Test support for the Propagation engine: a synthetic graph with every role
 * and both directions, quant snapshot builders, incident/request builders on
 * top of the Base message builders, and fixture model callers. CI never makes
 * a live call. Not exported from the barrel.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageClassification } from "../../base/classification.js";
import type { Incident } from "../../base/types.js";
import type { Direction, Materiality, Verdict } from "../../classifier/types.js";
import type { DailyBar, TrackerMessage } from "../../tracker/types.js";
import { filingItem, gapEvent, newsItem } from "../../base/test-fixtures.js";
import type { GraphEdge } from "../types.js";
import { DEFAULT_PROPAGATION_CONFIG, type PropagationConfig } from "./config.js";
import { indexGraph, type GraphIndex } from "./graph.js";
import type { TargetQuantSnapshot } from "./pricing.js";
import type { PropagationRequest } from "./requests.js";
import { propagationRequestId } from "./requests.js";
import type { QuantSource } from "./stage1.js";
import type { ModelCaller, PropagationEvent } from "./types.js";

export const NOW = "2026-08-21T21:00:00.000Z";
export const GRAPH_AT = "2026-08-13T22:38:11.325Z";

const here = path.dirname(fileURLToPath(import.meta.url));

export function edge(
  id: string,
  root: string,
  counterparty: { ticker: string | null; name: string },
  category: string,
  overrides: Partial<GraphEdge> = {},
): GraphEdge {
  const cpId = counterparty.ticker ?? `name:${counterparty.name.toLowerCase()}`;
  return {
    id,
    root_ticker: root,
    counterparty_id: cpId,
    counterparty_name: counterparty.name,
    counterparty_ticker: counterparty.ticker,
    category,
    subtype: `${category}_subtype`,
    confidence: 0.9,
    strength: 0.5,
    strength_tier: "important",
    evidence_quote: `${root} filing: ${counterparty.name} is our ${category}.`,
    source_url: `https://www.sec.gov/${root}/${id}`,
    valid_from: "2026-03-01",
    filing_date: "2026-03-01",
    accession_number: null,
    ...overrides,
  };
}

/**
 * Synthetic graph around NVDA:
 *   NVDA → TSM supplier (important) — and TSM → NVDA? no: the reverse test is
 *   TSM as root: NVDA's forward edge makes NVDA TSM's customer.
 *   NVDA → MU supplier (critical), → AMD competitor (marginal), → MSFT competitor,
 *   NVDA → [Samsung] supplier (name-only), → [OpenAI] partner (name-only),
 *   NVDA → TDCC dependency (name-only),
 *   MSFT → NVDA supplier (reverse: MSFT is NVDA's customer),
 *   AMD → NVDA competitor (reverse duplicate of the forward competitor pair; higher tier),
 *   CEG → MSFT customer (unrelated), ACME → NVDA dependency (ACME depends on NVDA → depended_on_by).
 */
export function syntheticGraph(): GraphIndex {
  const edges: GraphEdge[] = [
    edge("NVDA:TSM:supplier", "NVDA", { ticker: "TSM", name: "Taiwan Semiconductor" }, "supplier", {
      subtype: "wafer_fabrication",
      strength_tier: "important",
      confidence: 0.95,
      evidence_quote: "We rely on TSMC for wafer fabrication of our GPUs.",
    }),
    edge("NVDA:MU:supplier", "NVDA", { ticker: "MU", name: "Micron Technology" }, "supplier", {
      subtype: "memory",
      strength_tier: "critical",
      confidence: 0.9,
    }),
    edge("NVDA:AMD:competitor", "NVDA", { ticker: "AMD", name: "Advanced Micro Devices" }, "competitor", {
      subtype: "gpus",
      strength_tier: "marginal",
      confidence: 0.8,
    }),
    edge("NVDA:MSFT:competitor", "NVDA", { ticker: "MSFT", name: "Microsoft" }, "competitor", {
      subtype: "custom_silicon",
      strength_tier: "marginal",
      confidence: 0.7,
    }),
    edge("NVDA:samsung:supplier", "NVDA", { ticker: null, name: "Samsung Electronics" }, "supplier", {
      subtype: "hbm_memory",
      strength_tier: "important",
      confidence: 0.85,
    }),
    edge("NVDA:openai:partner", "NVDA", { ticker: null, name: "OpenAI" }, "partner", {
      subtype: "compute_partnership",
      strength_tier: "important",
      confidence: 0.8,
    }),
    edge("NVDA:tdcc:dependency", "NVDA", { ticker: null, name: "Taiwan Depository" }, "dependency", {
      subtype: "clearing",
      strength_tier: "marginal",
      confidence: 0.6,
    }),
    edge("MSFT:NVDA:supplier", "MSFT", { ticker: "NVDA", name: "NVIDIA" }, "supplier", {
      subtype: "ai_accelerators",
      strength_tier: "critical",
      confidence: 0.92,
      evidence_quote: "Our Azure AI infrastructure depends on GPUs supplied by NVIDIA.",
    }),
    edge("AMD:NVDA:competitor", "AMD", { ticker: "NVDA", name: "NVIDIA" }, "competitor", {
      subtype: "gpu_competitor",
      strength_tier: "important",
      confidence: 0.9,
      evidence_quote: "We compete with NVIDIA in GPUs and AI accelerators.",
    }),
    edge("CEG:MSFT:customer", "CEG", { ticker: "MSFT", name: "Microsoft" }, "customer", {
      subtype: "power_purchase_agreement",
      strength_tier: "critical",
    }),
    edge("ACME:NVDA:dependency", "ACME", { ticker: "NVDA", name: "NVIDIA" }, "dependency", {
      subtype: "cuda_platform",
      strength_tier: "important",
      confidence: 0.75,
    }),
  ];
  return indexGraph({
    generatedAt: GRAPH_AT,
    pipelineVersion: 5,
    nodes: [
      { id: "NVDA", label: "NVDA", kind: "ticker" },
      { id: "TSM", label: "TSM", kind: "ticker" },
      { id: "MU", label: "MU", kind: "ticker" },
      { id: "AMD", label: "AMD", kind: "ticker" },
      { id: "MSFT", label: "MSFT", kind: "ticker" },
      { id: "CEG", label: "CEG", kind: "ticker" },
      { id: "ACME", label: "ACME", kind: "ticker" },
      { id: "name:samsung electronics", label: "Samsung Electronics", kind: "name" },
      { id: "name:openai", label: "OpenAI", kind: "name" },
      { id: "name:taiwan depository", label: "Taiwan Depository", kind: "name" },
    ],
    edges,
  });
}

/** The real desktop graph, when the checkout has it (skipped in CI without it). */
export function realGraphPath(): string | null {
  const p = path.resolve(here, "../../../../../apps/desktop/data/graph.json");
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Quant snapshots
// ---------------------------------------------------------------------------

/** Consecutive NY trading days (weekdays, no holidays in the range used). */
export function tradingDays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function bars(closes: Array<[string, number]>): DailyBar[] {
  return closes.map(([d, c]) => ({ d, o: c, h: c, l: c, c, v: 1_000_000 }));
}

/** Flat 100 closes for 2026-08-10 … 2026-08-21 (10 sessions). */
export function flatBars(price = 100, days = tradingDays("2026-08-10", 10)): DailyBar[] {
  return bars(days.map((d) => [d, price]));
}

export function snapshot(overrides: Partial<TargetQuantSnapshot> = {}): TargetQuantSnapshot {
  return {
    ticker: "TSM",
    bars: flatBars(100),
    benchBars: flatBars(500),
    beta: 1.0,
    r2: 0.5,
    vol30: 0.02,
    lastPrice: 100,
    lastPriceTs: "2026-08-21T20:00:00.000Z",
    benchLastPrice: null,
    ...overrides,
  };
}

export function quantSource(snapshots: Record<string, TargetQuantSnapshot | null>): QuantSource {
  return {
    isTracked: (t) => Object.prototype.hasOwnProperty.call(snapshots, t.toUpperCase()),
    snapshot: async (t) => snapshots[t.toUpperCase()] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Incidents / requests
// ---------------------------------------------------------------------------

export function baseIncident(ticker: string, messages: TrackerMessage[], overrides: Partial<Incident> = {}): Incident {
  return {
    incident_id: `inc-${ticker}`,
    ticker,
    trigger_type: "organic",
    window_start: messages[0]?.timestamp ?? NOW,
    window_end: null,
    window_status: "open",
    composite_tags: [],
    priority: 60,
    priority_band: "P1",
    degraded_context: false,
    discovery_floor_applied: false,
    earnings_absorption: false,
    messages: messages.map((m) => ({ ...m, ticker })),
    quant_context: null,
    user_proximity: "tracked",
    related_incident_id: null,
    propagation_candidates: [],
    ...overrides,
  };
}

export function verdict(
  articleKey: string,
  eventType: Verdict["event_type"],
  label: string,
  entry: { ticker: string; materiality: Materiality; direction: Direction; relevance?: "direct" | "indirect" },
): Verdict {
  return {
    schema_version: 1,
    prompt_version: "cls-1.0",
    model: "fixture",
    article_key: articleKey,
    kind: "news",
    event_type: eventType,
    event_label: label,
    syndication_scope: 1,
    tickers: [{ ticker: entry.ticker, relevance: entry.relevance ?? "direct", materiality: entry.materiality, direction: entry.direction }],
    unassessed_tickers: [],
    status: "ok",
    metadata_missing: false,
    classified_at: NOW,
    failure_reason: null,
  };
}

export function classified(v: Verdict): MessageClassification {
  const entry = v.tickers[0];
  return { state: "classified", verdict: v, entry };
}

/** Synthetic NVDA earnings incident: a high-materiality direct verdict, an 8-K 2.02 and a down gap. */
export function nvdaEarningsIncident(): { incident: Incident; verdicts: Record<string, MessageClassification> } {
  const news = newsItem("n-nvda-1", "2026-08-20T21:05:00.000Z", {
    headline: "Nvidia Q2 revenue misses; data-center guide below consensus",
    published_at: "2026-08-20T21:05:00.000Z",
    article_id: "900001",
  });
  const news2 = newsItem("n-nvda-2", "2026-08-20T20:40:00.000Z", {
    headline: "Nvidia reports fiscal Q2 results",
    published_at: "2026-08-20T20:40:00.000Z",
    article_id: "900002",
  });
  const filing = filingItem("f-nvda-1", "2026-08-20T20:35:00.000Z", { item_codes: ["2.02", "9.01"] });
  const gap = gapEvent("g-nvda-1", "2026-08-21T13:32:00.000Z", { gap_pct: -0.052, gap_z: -2.4, direction: "down", prev_close: 220, open_price: 208.6 });
  const v1 = verdict("id:900001", "earnings_results", "Nvidia Q2 revenue miss; data-center guide below consensus", {
    ticker: "NVDA",
    materiality: "high",
    direction: "negative",
  });
  const v2 = verdict("id:900002", "earnings_results", "Nvidia reports fiscal Q2 results", {
    ticker: "NVDA",
    materiality: "standard",
    direction: "unclear",
  });
  const incident = baseIncident("NVDA", [filing, news2, news, gap], {
    incident_id: "inc-nvda-earnings",
    composite_tags: ["earnings_surprise", "event_gap"],
    priority: 80,
    priority_band: "P0",
    propagation_candidates: [
      { ticker: "NVDA", article_key: "id:900001", event_type: "earnings_results", event_label: v1.event_label },
      { ticker: "NVDA", article_key: "id:900002", event_type: "earnings_results", event_label: v2.event_label },
    ],
  });
  return { incident, verdicts: { [news.id]: classified(v1), [news2.id]: classified(v2) } };
}

export function eventFixture(overrides: Partial<PropagationEvent> = {}): PropagationEvent {
  return {
    type: "earnings_results",
    direction: "negative",
    materiality: "high",
    label: "Q2 revenue miss; data-center guide below consensus",
    source_msg_ids: ["n-nvda-1"],
    event_ts: "2026-08-20T21:05:00.000Z",
    source: "verdict",
    evidence_lines: ["Nvidia Q2 revenue misses; data-center guide below consensus (earnings_results · high · negative)"],
    ...overrides,
  };
}

export function requestFixture(overrides: Partial<PropagationRequest> = {}): PropagationRequest {
  const { incident, verdicts } = nvdaEarningsIncident();
  const event = overrides.event ?? eventFixture();
  const root = overrides.root_ticker ?? "NVDA";
  return {
    request_id: propagationRequestId(incident, root, event),
    incident_id: incident.incident_id,
    root_ticker: root,
    incident,
    event,
    trigger_rules: ["filing_item.8k.mapped", "gap_event.propagation"],
    update: false,
    prior_run_id: null,
    requested_at: NOW,
    verdicts,
    ...overrides,
  };
}

export function configFixture(overrides: Partial<PropagationConfig> = {}): PropagationConfig {
  return { ...structuredClone(DEFAULT_PROPAGATION_CONFIG), retryBackoffMs: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// Model callers
// ---------------------------------------------------------------------------

export function textCaller(text: string): ModelCaller {
  return async () => ({ text, input_tokens: 100, output_tokens: 50 });
}

export function jsonCaller(value: unknown): ModelCaller {
  return textCaller(JSON.stringify(value));
}

/** Returns each text in turn; the last one repeats. */
export function sequenceCaller(texts: string[]): ModelCaller & { calls: number } {
  let i = 0;
  const caller = (async () => {
    const text = texts[Math.min(i, texts.length - 1)];
    i += 1;
    caller.calls = i;
    return { text, input_tokens: 100, output_tokens: 50 };
  }) as unknown as ModelCaller & { calls: number };
  caller.calls = 0;
  return caller;
}

export function failingCaller(error: Error | (() => Error)): ModelCaller & { calls: number } {
  const caller = (async () => {
    caller.calls += 1;
    throw typeof error === "function" ? error() : error;
  }) as unknown as ModelCaller & { calls: number };
  caller.calls = 0;
  return caller;
}
