/**
 * Billing verification — does the provider bill the tokens it says we sent?
 *
 * This exists because of a measured contradiction. Asked to COUNT a real 24,000
 * character filing chunk, the gateway answered 6,885 tokens (3.95 chars/token,
 * exactly what English prose should be). Asked to PROCESS the same chunk, it
 * billed 12,025. Same host, same payload, same model — 1.75x apart.
 *
 * `count_tokens` is the oracle that makes this checkable: it is the provider's
 * own tokenizer, it needs no key on this gateway, and it costs nothing. So the
 * probe below sends one payload to both surfaces and records the ratio. A
 * result near 1.0 means billing is honest; sustained >1 is the provider
 * charging for tokens its own tokenizer says are not there.
 *
 * Deliberately provider-agnostic: point it at Anthropic directly and it
 * verifies Anthropic. The point is not to accuse one vendor, it is to never
 * again be unable to answer "are we being billed correctly?".
 */

import Anthropic from "@anthropic-ai/sdk";

/** How far from 1.0 a ratio may sit before it is called a discrepancy. */
export const RATIO_TOLERANCE = 0.05;

export type TokenAuditSample = {
  at: string;
  /** Host the sample was taken against — the two accounts must never be mixed. */
  host: string;
  model: string;
  /** Characters actually sent, for a sanity check independent of tokenisers. */
  requestChars: number;
  /** What the provider's own `count_tokens` says the payload is. */
  countedInputTokens: number;
  /** What the provider's message response reported as billable input. */
  billedInputTokens: number;
  billedCacheCreationTokens: number;
  billedCacheReadTokens: number;
  /** billed ÷ counted. 1.0 is honest; 1.75 is what prompted this module. */
  ratio: number;
  /** Chars per token each surface implies — the human-readable smell test. */
  countedCharsPerToken: number;
  billedCharsPerToken: number;
  ok: boolean;
  error: string | null;
};

export type TokenAuditVerdict = {
  samples: TokenAuditSample[];
  /** Median ratio across samples — one probe can be noise, a trend cannot. */
  medianRatio: number | null;
  /** True when the median sits outside tolerance for long enough to act on. */
  discrepancy: boolean;
  /**
   * What the overcharge implies in money, given a period's billed input. Null
   * until there is a ratio to apply.
   */
  estimatedOverchargeUsd: number | null;
};

export type ProbeOptions = {
  /** Base URL to verify. Omit for api.anthropic.com. */
  baseUrl?: string;
  apiKey: string;
  model: string;
  /**
   * The payload to measure. Use real production text — a lorem-ipsum probe
   * would measure the tokeniser on text we never actually send.
   */
  system: string;
  user: string;
  /** Per-1M input price, for the money estimate. */
  inputUsdPerM?: number;
  timeoutMs?: number;
};

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "api.anthropic.com";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function client(options: ProbeOptions): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
}

/**
 * One probe: count the payload, then send it, then compare.
 *
 * `max_tokens: 1` keeps the output side to a single token — the measurement is
 * about the INPUT accounting, and there is no reason to pay for a completion to
 * learn it. The input is still billed in full, which is exactly the quantity
 * under test.
 */
export async function probeTokenBilling(options: ProbeOptions): Promise<TokenAuditSample> {
  const host = hostOf(options.baseUrl);
  const requestChars = options.system.length + options.user.length;
  const base: TokenAuditSample = {
    at: new Date().toISOString(),
    host,
    model: options.model,
    requestChars,
    countedInputTokens: 0,
    billedInputTokens: 0,
    billedCacheCreationTokens: 0,
    billedCacheReadTokens: 0,
    ratio: 0,
    countedCharsPerToken: 0,
    billedCharsPerToken: 0,
    ok: false,
    error: null,
  };

  try {
    const c = client(options);
    const request = {
      model: options.model,
      system: options.system,
      messages: [{ role: "user" as const, content: options.user }],
    };

    const counted = await c.messages.countTokens(request, {
      timeout: options.timeoutMs ?? 60_000,
    });

    const sent = await c.messages.create(
      { ...request, max_tokens: 1 },
      { timeout: options.timeoutMs ?? 120_000 },
    );

    const billedInput = sent.usage.input_tokens;
    const cacheCreate = sent.usage.cache_creation_input_tokens ?? 0;
    const cacheRead = sent.usage.cache_read_input_tokens ?? 0;
    // Everything the provider counts as input-side, however it labels it. A
    // vendor that splits the same tokens across `input` and `cache_creation`
    // would look honest on either field alone.
    const billedTotal = billedInput + cacheCreate + cacheRead;

    return {
      ...base,
      countedInputTokens: counted.input_tokens,
      billedInputTokens: billedInput,
      billedCacheCreationTokens: cacheCreate,
      billedCacheReadTokens: cacheRead,
      ratio: counted.input_tokens > 0 ? billedTotal / counted.input_tokens : 0,
      countedCharsPerToken: counted.input_tokens > 0 ? requestChars / counted.input_tokens : 0,
      billedCharsPerToken: billedTotal > 0 ? requestChars / billedTotal : 0,
      ok: true,
      error: null,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Read a set of samples as a verdict.
 *
 * The median, not the mean: one probe against a cold cache or a retried request
 * can sit anywhere, and a single outlier must not be able to manufacture an
 * accusation — nor hide one.
 */
export function verdictFrom(
  samples: TokenAuditSample[],
  options?: { billedInputTokensThisPeriod?: number; inputUsdPerM?: number },
): TokenAuditVerdict {
  const ok = samples.filter((s) => s.ok && s.countedInputTokens > 0);
  const medianRatio = median(ok.map((s) => s.ratio));
  const discrepancy = medianRatio != null && Math.abs(medianRatio - 1) > RATIO_TOLERANCE;

  let estimatedOverchargeUsd: number | null = null;
  const billed = options?.billedInputTokensThisPeriod;
  const price = options?.inputUsdPerM;
  if (discrepancy && medianRatio != null && medianRatio > 1 && billed != null && price != null) {
    // What the same work should have cost at a ratio of 1.0.
    const shouldHaveBeen = billed / medianRatio;
    estimatedOverchargeUsd = ((billed - shouldHaveBeen) / 1_000_000) * price;
  }

  return { samples, medianRatio, discrepancy, estimatedOverchargeUsd };
}

/**
 * A representative probe payload built from real filing text.
 *
 * Size matters: the discrepancy is a ratio, so it shows on any payload, but a
 * short one is dominated by fixed per-message overhead and reads noisier. This
 * targets the size step1 actually sends.
 */
export function buildProbePayload(filingText: string, chars = 24_000): { system: string; user: string } {
  const slice = filingText.slice(0, chars);
  return {
    system:
      "You extract business relationships from SEC filing text. " +
      "Reply with the single word OK and nothing else.",
    user: `Source excerpt:\n"""${slice}"""\n\nReply OK.`,
  };
}
