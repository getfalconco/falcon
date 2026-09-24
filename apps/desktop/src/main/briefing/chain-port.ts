/**
 * Handover briefing: what the chain (Tracker, Base, Risk) knows, asked through
 * the same channels the panels use.
 *
 * The chain runs on the engine service for nearly every install and inside
 * this process for a dev checkout that opts out. `invokeChannel` already makes
 * that decision, so this module only names channels and never learns where
 * the answer came from. The invoker is a parameter so the module stays
 * electron-free and a test can stand in for the engine.
 */

import type { BaseReplayResult } from "@meridian/research/base";
import { sliceFromReplay } from "@meridian/research/briefing";
import type { ChainTickerSlice, HeldCoverage, QuantSlice, RiskLatestLite } from "../../shared/briefing-types";
import type { RiskLatest } from "../../shared/risk-types";
import type { TrackerQuantContext, TrackerStatus } from "../../shared/tracker-types";
import { coverageOf, toQuantSlice, toRiskLatestLite } from "./ports-map";

export type ChannelInvoker = <Result>(channel: string, ...args: unknown[]) => Promise<Result>;

type Answer<T> = ({ ok: true } & T) | { ok: false; error?: string };

/**
 * Enough Tracker messages to cover one name's night with room to spare: a
 * heavily covered name logs a few dozen items between two closes, and a
 * weekend triples that. The channel's own default of a thousand would have the
 * engine replay, and the desktop download, days of history per held name.
 */
const REPLAY_MESSAGE_LIMIT = 300;

/**
 * The universe changes when a name is bought, which is rare next to how often
 * the panel is opened. Five minutes keeps one build, and the reopenings right
 * after it, on a single status read.
 */
const STATUS_TTL_MS = 5 * 60_000;

/**
 * A refusal is raised, never returned as an empty answer. The assembly records
 * a raised port as a degraded section; an empty slice would instead be printed
 * as a night in which nothing happened. The engine's own error text stays in
 * this process: the assembly keeps none of it.
 */
function unwrap<T>(channel: string, answer: Answer<T> | null | undefined): { ok: true } & T {
  if (!answer || typeof answer !== "object" || answer.ok !== true) {
    const detail = answer && typeof answer === "object" && "error" in answer && typeof answer.error === "string" ? answer.error : "no answer";
    throw new Error(`${channel}: ${detail}`);
  }
  return answer;
}

export type ChainPort = {
  chainSlice(ticker: string, held: string[], overnightSince: string): Promise<ChainTickerSlice>;
  quant(symbol: string): Promise<QuantSlice | null>;
  riskLatest(): Promise<RiskLatestLite | null>;
};

export function createChainPort(invoke: ChannelInvoker, now: () => number = Date.now): ChainPort {
  let status: { at: number; value: Promise<TrackerStatus> } | null = null;

  const trackerStatus = (): Promise<TrackerStatus> => {
    const nowMs = now();
    if (status && nowMs - status.at < STATUS_TTL_MS) return status.value;
    const value = invoke<Answer<{ status: TrackerStatus }>>("tracker:status").then((answer) => unwrap("tracker:status", answer).status);
    const entry = { at: nowMs, value };
    status = entry;
    // The promise is what is cached, so every slice of one build shares one
    // read. A failed read must not answer for the next five minutes.
    value.catch(() => {
      if (status === entry) status = null;
    });
    return value;
  };

  const coverage = async (ticker: string): Promise<HeldCoverage> => coverageOf(ticker, await trackerStatus());

  return {
    async chainSlice(ticker, held, overnightSince) {
      const covered = await coverage(ticker);
      // `tracker:messages` would be the lighter read, but the engine service's
      // handler for it ignores its options and returns the whole log. The
      // replay reads its options correctly, and it also carries the priority
      // band each headline is ranked by.
      const answer = await invoke<Answer<{ result: BaseReplayResult }>>("base:replay", {
        ticker,
        held,
        limit: REPLAY_MESSAGE_LIMIT,
      });
      return sliceFromReplay(ticker, unwrap("base:replay", answer).result, overnightSince, covered);
    },

    async quant(symbol) {
      // A name the Tracker does not follow has no quant state. The channel
      // says so with a refusal, which for this port is an answer ("not
      // tracked"), so it is settled from the status and the call is not made.
      if ((await coverage(symbol)) === "pending") return null;
      const answer = await invoke<Answer<{ quant: TrackerQuantContext }>>("tracker:quant", symbol);
      return toQuantSlice(unwrap("tracker:quant", answer).quant);
    },

    async riskLatest() {
      const answer = await invoke<Answer<RiskLatest>>("risk:latest");
      return toRiskLatestLite(unwrap("risk:latest", answer));
    },
  };
}
