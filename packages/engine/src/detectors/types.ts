/**
 * Shared contract between event detectors (src/detectors/*) and the pipeline
 * (src/pipeline.ts). Design: docs/design/ripple-engine-v1.md, sections 3.2 and 7.
 *
 * A detector turns primary-source documents (EDGAR filings first) into
 * DetectorEvents. It states filed facts only: every number in `title`,
 * `summary` or `facts` must appear in a quoted source. Detectors never judge
 * direction for linked companies; that is the pipeline's job (graph + judge).
 */

import type { Source } from "@falcon/ripple";

/** Pre-registered families (docs/design/ripple-engine-v1.md, 3.2). */
export type FamilyId =
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12" | "F13";

export type EventType =
  | "earnings_read_through"   // F10, 8-K 2.02 / 6-K quarterly
  | "monthly_revenue"         // F11, Taiwan 6-K
  | "insider_cluster"         // F7, Form 4 open-market purchases (code P)
  | "distress_nt"             // F6, NT 10-K / NT 10-Q / NT 20-F
  | "restatement_402"         // F6, 8-K item 4.02 non-reliance
  | "customer_bankruptcy"     // F5, 8-K item 1.03 (of a company with linked suppliers)
  | "contract_material"       // F3/F4, 8-K item 1.01 commercial agreement
  | "contract_termination"    // F3, 8-K item 1.02
  | "guidance_down"           // F1, 7.01 / 8.01 / 2.02 EX-99 outlook cut, preannouncement, disruption
  | "guidance_up"             // F2, 7.01 / 8.01 / 2.02 EX-99 outlook raise, capex up
  | "activist_stake";         // F8, SCHEDULE 13D initial

/** Which way the event points for the company it is about: 1 good, -1 bad, 0 neutral, null unknown. */
export type EventSign = 1 | -1 | 0 | null;

export type DetectorEvent = {
  /** Stable id: "<eventType>-<accession>" (one accession can yield one event per type). */
  id: string;
  eventType: EventType;
  family: FamilyId;
  /** 10-digit CIK of the company the event is about (the issuer). */
  cik: string;
  /** Primary US ticker of that company, null when it has none (private, delisted). */
  ticker: string | null;
  companyName: string;
  /** EDGAR acceptanceDateTime (ISO, UTC) or the first public time of a non-SEC source. Never the filing date. */
  acceptedAt: string;
  /** Primary accession number, e.g. "0001193125-26-453582". */
  accession: string;
  form: string;
  /** 8-K items when relevant, e.g. ["1.01", "9.01"]. */
  items: string[];
  /** Short neutral headline built from filed facts, e.g. "3 insiders bought $1.2M of ACME stock in 4 days". */
  title: string;
  /** One to three plain sentences, filed facts only, numbers included. */
  summary: string[];
  sign: EventSign;
  /**
   * Size for ranking, comparable within an event type only:
   * insider_cluster: purchase $ / market value in %; contract: value / trailing revenue in %;
   * guidance: the change in % when stated; others null.
   */
  magnitude: number | null;
  /** Structured filed facts (counterparty, value, insiders, reason, ...). Strings are quotes or names. */
  facts: Record<string, string | number | boolean | null>;
  /** Primary sources; the first is the main document. */
  sources: Source[];
  /** Verbatim quotes from the sources backing the summary (checked as substrings of the document text). */
  quotes: string[];
  /**
   * "own": the card's single hit is the company itself (insider cluster, distress).
   * "linked": the pipeline walks the graph from the company and judges linked hits.
   */
  propagates: "own" | "linked";
  /** Detector-specific flags that cap the event at the Watch tier (anti-pump filter failed, shell, recent offering...). */
  watchOnlyReasons: string[];
};

export type DetectorContext = {
  /** Events whose acceptance time is in [since, until). */
  since: Date;
  until: Date;
  /** Cost guard for detectors that call an LLM (dollars for this run). */
  llmBudgetUsd: number;
  /** When true, no network writes; reads are allowed. */
  dryRun: boolean;
  log: (line: string) => void;
};

export type Detector = {
  eventTypes: EventType[];
  detect(ctx: DetectorContext): Promise<DetectorEvent[]>;
};
