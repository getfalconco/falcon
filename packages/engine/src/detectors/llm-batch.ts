/**
 * Message Batches API runner for calls collected by `collectBatch` (llm.ts):
 * submit, poll, resume. Answers land in the same disk cache live calls use
 * (keyed by `cacheKey`), so a script reruns its pass and reads them from
 * there. Batches cost half the list price.
 *
 * A state file records every batch submitted and the cache keys it holds,
 * so a restarted run polls the batches already in flight instead of paying
 * for the same requests again, and the spend so far (from each result's
 * usage), which with the budget caps what a new submission may cost.
 */

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.ts";
import { answerJson, cacheFileOf, costUsd, messageParams, writeCachedKey, type StructuredCall } from "./llm.ts";

/** Batch price as a share of list price. */
export const BATCH_DISCOUNT = 0.5;

export type BatchState = {
  batches: Array<{ id: string; keys: string[]; submittedAt: string; ended: boolean; succeeded: number; failed: number; costUsd: number }>;
  spentUsd: number;
};

export function readBatchState(file: string): BatchState {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BatchState;
  } catch {
    return { batches: [], spentUsd: 0 };
  }
}

function save(file: string, s: BatchState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(s, null, 1)}\n`);
}

/** A call's cost at batch price, before it runs: input from its length, output at `outFrac` of its cap. Pure. */
export function estimateBatchUsd(call: StructuredCall, outFrac = 0.35): number {
  const input = Math.ceil((call.system.length + call.user.length) / 3.5) + 300;
  return costUsd(call.model ?? "", input, Math.ceil((call.maxTokens ?? 1500) * outFrac)) * BATCH_DISCOUNT;
}

/** Requests per batch: well under the API's 100,000 requests and 256 MB. */
const PER_BATCH = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Submit what is not cached and not already in flight, wait for every open
 * batch to end, write the answers into the cache. Returns the spend this
 * call added. Throws when the estimate would pass the budget.
 */
export async function runBatches(
  requests: Array<{ key: string; call: StructuredCall }>,
  opts: { stateFile: string; budgetUsd: number; log: (l: string) => void; pollMs?: number },
): Promise<{ addedUsd: number; succeeded: number; failed: number }> {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const sdk = new Anthropic({ apiKey: key, maxRetries: 5 });
  const state = readBatchState(opts.stateFile);
  const inFlight = new Set(state.batches.filter((b) => !b.ended).flatMap((b) => b.keys));
  const todo = requests.filter((r) => !inFlight.has(r.key) && !fs.existsSync(cacheFileOf(r.key)));
  const estimate = todo.reduce((s, r) => s + estimateBatchUsd(r.call), 0);
  opts.log(`batch: ${requests.length} requests, ${todo.length} to submit (est. $${estimate.toFixed(2)}), ${inFlight.size} in flight, $${state.spentUsd.toFixed(2)} spent of $${opts.budgetUsd}`);
  if (state.spentUsd + estimate > opts.budgetUsd) throw new Error(`batch estimate $${estimate.toFixed(2)} would pass the budget ($${state.spentUsd.toFixed(2)} spent of $${opts.budgetUsd})`);

  for (let at = 0; at < todo.length; at += PER_BATCH) {
    const part = todo.slice(at, at + PER_BATCH);
    const b = await sdk.messages.batches.create({
      requests: part.map((r) => ({ custom_id: r.key, params: messageParams(r.call) as never })),
    });
    state.batches.push({ id: b.id, keys: part.map((r) => r.key), submittedAt: new Date().toISOString(), ended: false, succeeded: 0, failed: 0, costUsd: 0 });
    save(opts.stateFile, state);
    opts.log(`batch: submitted ${b.id} (${part.length} requests)`);
  }

  const models = new Map(requests.map((r) => [r.key, r.call.model ?? ""]));
  let addedUsd = 0;
  let succeeded = 0;
  let failed = 0;
  for (;;) {
    const open = state.batches.filter((b) => !b.ended);
    if (!open.length) break;
    for (const b of open) {
      const info = await sdk.messages.batches.retrieve(b.id);
      if (info.processing_status !== "ended") {
        const c = info.request_counts;
        opts.log(`batch: ${b.id} ${info.processing_status}, ${c.processing} processing, ${c.succeeded} succeeded, ${c.errored} errored`);
        continue;
      }
      for await (const r of await sdk.messages.batches.results(b.id)) {
        if (r.result.type !== "succeeded") {
          b.failed++;
          continue;
        }
        const m = r.result.message;
        const cost = costUsd(models.get(r.custom_id) || m.model || "", m.usage.input_tokens ?? 0, m.usage.output_tokens ?? 0) * BATCH_DISCOUNT;
        b.costUsd += cost;
        try {
          writeCachedKey(r.custom_id, answerJson(m as never));
          b.succeeded++;
        } catch {
          b.failed++;
        }
      }
      b.ended = true;
      state.spentUsd += b.costUsd;
      addedUsd += b.costUsd;
      succeeded += b.succeeded;
      failed += b.failed;
      save(opts.stateFile, state);
      opts.log(`batch: ${b.id} ended, ${b.succeeded} answers cached, ${b.failed} failed, $${b.costUsd.toFixed(4)}; $${state.spentUsd.toFixed(2)} spent in all`);
    }
    if (state.batches.some((b) => !b.ended)) await sleep(opts.pollMs ?? 60_000);
  }
  return { addedUsd, succeeded, failed };
}
