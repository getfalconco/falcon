/**
 * "Explain" (design 6.4): Claude describes the QualityReport in slot
 * templates and never writes a number.
 *
 *   - Each sentence is { template, slots[] }: "{}" marks a slot, and each slot
 *     names a path in report.values ("delay.drop_pct").
 *   - Post-checks: any digit in a template, a slot count that does not match
 *     the "{}" count, or a ref that does not resolve rejects the reply; it is
 *     retried once with the problems listed.
 *   - The server fills the slots, then every sentence passes neutralize().
 *   - Input: the spec, describe(spec) and the report's checks and values. No
 *     prices, no news.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { neutralize } from "../neutralize";
import { resolveRef, slotText, type QualityReport } from "../audit/report";
import type { SpecDescription, StrategySpecV2 } from "../spec";
import { PROMPT_VERSION, REVIEW_SYSTEM } from "./prompts";
import { costUsd, type Usage } from "./usage";

export const REVIEW_MODEL = "claude-sonnet-5-5";

const Sentence = z.object({ template: z.string(), slots: z.array(z.object({ ref: z.string() })) });
export const ReviewOutput = z.object({
  headline: Sentence,
  flags: z.array(z.object({ check_id: z.number().int(), severity: z.enum(["high", "medium", "low"]), meaning: Sentence, try_next: Sentence.nullable() })),
  interpretation_risks: z.array(Sentence),
  next_experiments: z.array(z.object({ change: Sentence, why: Sentence })),
});
type ReviewOutputT = z.infer<typeof ReviewOutput>;
type SentenceT = z.infer<typeof Sentence>;

export type Review = {
  headline: string;
  flags: { check_id: number; severity: "high" | "medium" | "low"; meaning: string; tryNext: string | null }[];
  interpretationRisks: string[];
  nextExperiments: { change: string; why: string }[];
  model: string;
  usage: Usage;
};

export type ReviewResult = { ok: true; review: Review } | { ok: false; reason: "unavailable" | "timeout" | "invalid" | "refusal"; message: string; usage?: Usage };

type MessagesClient = { beta: { messages: { create: (params: never, options?: never) => Promise<unknown> } } };

/** Problems with a reply's templates; empty when it can be rendered. */
export function templateProblems(out: ReviewOutputT, report: QualityReport): string[] {
  const problems: string[] = [];
  const checkIds = new Set(report.checks.map((c) => c.id));
  const visit = (s: SentenceT, where: string) => {
    if (/\d/.test(s.template)) problems.push(`${where}: the template contains a digit ("${s.template}"). Use "{}" and a slot instead.`);
    const holes = (s.template.match(/\{\}/g) ?? []).length;
    if (holes !== s.slots.length) problems.push(`${where}: ${holes} "{}" but ${s.slots.length} slots.`);
    for (const slot of s.slots) if (resolveRef(report.values, slot.ref) === null) problems.push(`${where}: slot "${slot.ref}" is not a path in the report values.`);
  };
  visit(out.headline, "headline");
  out.flags.forEach((f, i) => {
    if (!checkIds.has(f.check_id)) problems.push(`flags[${i}]: check ${f.check_id} is not in the report.`);
    visit(f.meaning, `flags[${i}].meaning`);
    if (f.try_next) visit(f.try_next, `flags[${i}].try_next`);
  });
  out.interpretation_risks.forEach((s, i) => visit(s, `interpretation_risks[${i}]`));
  out.next_experiments.forEach((e, i) => {
    visit(e.change, `next_experiments[${i}].change`);
    visit(e.why, `next_experiments[${i}].why`);
  });
  return problems;
}

/** Fills slots with the report's values and neutralizes the sentence. */
export function render(s: SentenceT, report: QualityReport): string {
  let i = 0;
  const filled = s.template.replace(/\{\}/g, () => slotText(resolveRef(report.values, s.slots[i++]?.ref ?? "")));
  return neutralize(filled).text;
}

function reviewInput(spec: StrategySpecV2, describe: SpecDescription, report: QualityReport, trials: number): string {
  const checks = report.checks.map((c) => ({ id: c.id, name: c.name, tier: c.tier, level: c.level, status: c.status, detail: c.detail }));
  return [
    `<intent>\n${spec.intent || spec.name}\n</intent>`,
    `<rules>\n${describe.rules.join("\n")}\n</rules>`,
    `<evidence_label>${report.label.title}: ${report.label.reasons.join(" ")}</evidence_label>`,
    `<checks>\n${JSON.stringify(checks)}\n</checks>`,
    `<values>\n${JSON.stringify(report.values)}\n</values>`,
    `<ledger>This is trial ${trials} of this strategy.</ledger>`,
  ].join("\n\n");
}

export async function review(
  input: { spec: StrategySpecV2; describe: SpecDescription; report: QualityReport; trials?: number },
  opts: { apiKey?: string | null; client?: MessagesClient; timeoutMs?: number; model?: string; effort?: "medium" | "high" } = {},
): Promise<ReviewResult> {
  const model = opts.model ?? REVIEW_MODEL;
  const budget = opts.timeoutMs ?? 22_000;
  const started = Date.now();
  let client = opts.client;
  if (!client) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return { ok: false, reason: "unavailable", message: "Explain is not configured on this server." };
    client = new Anthropic({ apiKey, timeout: budget, maxRetries: 0 }) as unknown as MessagesClient;
  }
  const usage: Usage = { model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, promptVersion: PROMPT_VERSION };
  const messages: unknown[] = [{ role: "user", content: reviewInput(input.spec, input.describe, input.report, input.trials ?? 1) }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget - (Date.now() - started);
    if (left < 4_000) return { ok: false, reason: "timeout", message: "Explain took too long. Try again.", usage };
    let msg: { model?: string; stop_reason?: string | null; content?: Array<{ type: string; text?: string }>; usage?: Record<string, number> };
    try {
      msg = (await client.beta.messages.create(
        {
          model,
          max_tokens: 6_000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(ReviewOutput) },
          system: [{ type: "text", text: REVIEW_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages,
        } as never,
        { timeout: left } as never,
      )) as typeof msg;
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, reason: "timeout", message: "Explain took too long. Try again.", usage };
      if (e instanceof Anthropic.APIError) {
        console.error("[backtest/ai] review API error", e.status, e.message);
        return { ok: false, reason: "unavailable", message: "Explain is unavailable right now.", usage };
      }
      throw e;
    }
    usage.calls++;
    usage.inputTokens += msg.usage?.input_tokens ?? 0;
    usage.outputTokens += msg.usage?.output_tokens ?? 0;
    usage.cacheReadTokens += msg.usage?.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += msg.usage?.cache_creation_input_tokens ?? 0;
    usage.usd = costUsd(usage, model);
    if (msg.stop_reason === "refusal") return { ok: false, reason: "refusal", message: "Explain could not describe this report.", usage };
    let out: ReviewOutputT | null = null;
    try {
      const r = ReviewOutput.safeParse(JSON.parse((msg.content ?? []).find((b) => b.type === "text")?.text ?? ""));
      out = r.success ? r.data : null;
    } catch {
      out = null;
    }
    const problems = out ? templateProblems(out, input.report) : ["The reply did not match the output schema."];
    if (out && !problems.length) {
      return {
        ok: true,
        review: {
          headline: render(out.headline, input.report),
          flags: out.flags.slice(0, 5).map((f) => ({ check_id: f.check_id, severity: f.severity, meaning: render(f.meaning, input.report), tryNext: f.try_next ? render(f.try_next, input.report) : null })),
          interpretationRisks: out.interpretation_risks.slice(0, 4).map((s) => render(s, input.report)).filter(Boolean),
          nextExperiments: out.next_experiments.slice(0, 3).map((e) => ({ change: render(e.change, input.report), why: render(e.why, input.report) })),
          model: msg.model ?? model,
          usage,
        },
      };
    }
    messages.push({ role: "assistant", content: msg.content });
    messages.push({ role: "user", content: `The reply was rejected:\n${problems.slice(0, 10).map((p) => `- ${p}`).join("\n")}\nReturn the full corrected reply.` });
  }
  return { ok: false, reason: "invalid", message: "Explain could not produce a valid description. Try again.", usage };
}
