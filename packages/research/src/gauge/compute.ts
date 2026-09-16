/**
 * `gauge(inputs, config, context?) → readout` (spec §7): the pure compute
 * model. Computed on read, no persistence, no budget. Standalone mode runs
 * checks 1–6; context mode adds 7–8 and gives 1/4/5/6 their directional
 * semantics.
 */

import { closeInstant, sessionsElapsed } from "../propagation/engine/pricing.js";
import { isTradingDay, nyYmd, previousTradingDay } from "../tracker/calendar.js";
import type { GaugeConfig } from "./config.js";
import { checkConflict, checkEventWall, checkFreshness, checkRegime, checkResidual, checkStretch, checkTrend, checkVolume } from "./checks.js";
import { recognizeSetup } from "./setups.js";
import { summarize } from "./summary.js";
import { fill } from "./templates.js";
import { GAUGE_SCHEMA_VERSION, type GaugeCheck, type GaugeContext, type GaugeDirection, type GaugeInputs, type GaugeReadout } from "./types.js";

/** Map a Classifier/Propagation event direction onto the thesis direction Gauge reads. */
export function directionFromEvent(direction: string | null | undefined): GaugeDirection | null {
  if (direction === "positive" || direction === "up") return "up";
  if (direction === "negative" || direction === "down") return "down";
  return null;
}

/**
 * Trading sessions opened since the event's reference close — the caller's
 * number when it has one (Propagation pricing), else derived from event_ts
 * the way pricing does: reference close = the last regular close strictly
 * before the event instant.
 */
export function sessionsSinceEvent(context: GaugeContext, now: string): number | null {
  if (typeof context.sessions_since_event === "number" && Number.isFinite(context.sessions_since_event)) return Math.max(0, Math.round(context.sessions_since_event));
  const event = new Date(context.event_ts ?? "");
  if (Number.isNaN(event.getTime())) return null;
  const eventDay = nyYmd(event);
  let refDay: string;
  if (isTradingDay(eventDay)) {
    const close = closeInstant(eventDay);
    refDay = close && event.getTime() >= close.getTime() ? eventDay : previousTradingDay(eventDay);
  } else {
    refDay = previousTradingDay(eventDay);
  }
  return sessionsElapsed(refDay, now);
}

function normalizeContext(context: GaugeContext | null | undefined): GaugeContext | null {
  if (!context) return null;
  return {
    expected_direction: context.expected_direction === "up" || context.expected_direction === "down" ? context.expected_direction : null,
    event_ts: typeof context.event_ts === "string" ? context.event_ts : "",
    source: context.source === "propagation_target" || context.source === "incident" || context.source === "manual" ? context.source : "manual",
    pricing_status: context.pricing_status ?? null,
    sessions_since_event: typeof context.sessions_since_event === "number" ? context.sessions_since_event : null,
    thesis_is_scheduled_event: Boolean(context.thesis_is_scheduled_event),
  };
}

export function gauge(inputs: GaugeInputs, config: GaugeConfig, rawContext?: GaugeContext | null): GaugeReadout {
  const context = normalizeContext(rawContext);
  const mode = context ? "context" : "standalone";
  const ticker = inputs.ticker.toUpperCase();

  if (!inputs.tracked) {
    return {
      schema_version: GAUGE_SCHEMA_VERSION,
      ticker,
      tracked: false,
      mode,
      context,
      computed_at: inputs.now,
      quant_as_of: null,
      setup: {
        key: "no_setup",
        name: fill(config.templates, "setup_name_no_setup"),
        read: fill(config.templates, "setup_read_untracked"),
        direction: null,
        values: {},
        screen: [],
      },
      state: "nothing_here",
      missing: null,
      state_line: null,
      readable: false,
      readability_note: null,
      checks: [],
      summary: {
        evaluable: 0,
        aligned: 0,
        cautions: 0,
        fails: 0,
        unavailable: 0,
        overall: null,
        binding_check: null,
        binding_line: fill(config.templates, "summary_untracked"),
        sentence: fill(config.templates, "summary_untracked"),
        calibrating: false,
        tooltip: fill(config.templates, "tooltip_untracked"),
      },
    };
  }

  const checks: GaugeCheck[] = [
    checkTrend(inputs, config, context),
    checkRegime(inputs, config),
    checkResidual(inputs, config),
    checkVolume(inputs, config, context),
    checkStretch(inputs, config, context),
    checkEventWall(inputs, config, context),
  ];
  if (context) {
    checks.push(checkConflict(inputs, config, context));
    checks.push(checkFreshness(config, context, sessionsSinceEvent(context, inputs.now)));
  }

  // v2: the hero is the recognized structure; the checks stay exactly as they
  // were and become its evidence (§1).
  const recognised = recognizeSetup(inputs, config, context);

  return {
    schema_version: GAUGE_SCHEMA_VERSION,
    ticker,
    tracked: true,
    mode,
    context,
    computed_at: inputs.now,
    quant_as_of: inputs.quant?.as_of ?? null,
    setup: recognised.setup,
    state: recognised.state,
    missing: recognised.missing,
    state_line: recognised.state_line,
    readable: recognised.readable,
    readability_note: recognised.readability_note,
    checks,
    summary: summarize(checks, config),
  };
}
