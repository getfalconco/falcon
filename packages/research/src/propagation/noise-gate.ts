import type { EventType, SecondOrderSignal } from "./types.js";

/** Single-transaction event types — low magnitude signals from these are noise. */
const SINGLE_TX_TYPES = new Set<EventType>(["partnership", "product_launch"]);

/**
 * Drop low-magnitude signals from single-transaction events
 * (one named counterparty deal that is immaterial at scale).
 */
export function passesNoiseGate(signal: SecondOrderSignal): boolean {
  if (signal.magnitude === "low" && SINGLE_TX_TYPES.has(signal.event_type)) {
    return false;
  }
  return true;
}

export function applyNoiseGate(signals: SecondOrderSignal[]): {
  kept: SecondOrderSignal[];
  dropped: number;
} {
  const kept: SecondOrderSignal[] = [];
  let dropped = 0;
  for (const s of signals) {
    if (passesNoiseGate(s)) kept.push(s);
    else dropped++;
  }
  return { kept, dropped };
}
