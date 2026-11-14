/**
 * Detector registry. Owned by the detectors workstream; the pipeline only
 * calls `detectAll`.
 */

import type { Detector, DetectorContext, DetectorEvent } from "./types.ts";
import { insiderClusterDetector } from "./insider.ts";
import { distressNtDetector, restatementDetector } from "./distress.ts";
import { contractDetector, customerBankruptcyDetector, guidanceDetector } from "./eightk.ts";
import { activistDetector } from "./activist.ts";

/** Registered detectors, in priority order (docs: src/detectors/README.md). */
export const DETECTORS: Detector[] = [
  insiderClusterDetector(),
  distressNtDetector(),
  restatementDetector(),
  customerBankruptcyDetector(),
  contractDetector(),
  guidanceDetector(),
  activistDetector(),
];

export async function detectAll(ctx: DetectorContext, detectors: Detector[] = DETECTORS): Promise<DetectorEvent[]> {
  const out: DetectorEvent[] = [];
  for (const d of detectors) {
    try {
      out.push(...(await d.detect(ctx)));
    } catch (e) {
      ctx.log(`detector ${d.eventTypes.join("/")} failed: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id));
}

export type { Detector, DetectorContext, DetectorEvent } from "./types.ts";
