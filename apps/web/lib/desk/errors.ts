import Anthropic from "@anthropic-ai/sdk";

/**
 * Falcon AI's error handling for /api/desk/chat: which upstream failures are
 * worth retrying (with backoff), and the member-facing message for each
 * failure. Members only ever see "Falcon AI" messages; the upstream status and
 * text are logged server-side (`logLine`), never sent to the browser.
 */

export type FailKind = "busy" | "overloaded" | "timeout" | "unreadable" | "unavailable";

/** Retries of a round that has not streamed anything yet. */
export const MAX_RETRIES = 2;
const BASE_DELAY_MS = 700;
const MAX_DELAY_MS = 4_000;

const status = (error: unknown): number | undefined => (error instanceof Anthropic.APIError ? error.status : undefined);

/** Overloaded (529), other 5xx, rate limited (429) and dropped connections; never a bad request, an abort or a timeout. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  const s = status(error);
  return s === 429 || s === 408 || s === 409 || (s !== undefined && s >= 500);
}

/** Exponential backoff with jitter (attempt 0 = first retry); honours a short retry-after, capped. */
export function retryDelayMs(attempt: number, error?: unknown, random = Math.random): number {
  const header = error instanceof Anthropic.APIError ? error.headers?.get?.("retry-after") : null;
  const after = header ? Number(header) * 1000 : NaN;
  if (Number.isFinite(after) && after >= 0) return Math.min(MAX_DELAY_MS, after);
  const base = BASE_DELAY_MS * 2 ** attempt;
  return Math.min(MAX_DELAY_MS, Math.round(base * (0.75 + random() * 0.5)));
}

export function classify(error: unknown, late = false): FailKind {
  if (late || error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.BadRequestError) return "unreadable";
  const s = status(error);
  if (s === 429) return "busy";
  if (s === 529 || (s !== undefined && s >= 500)) return "overloaded";
  return "unavailable";
}

/** The HTTP reply when the answer could not start. */
export function startFailure(kind: FailKind): { status: number; error: string } {
  switch (kind) {
    case "unreadable":
      return { status: 400, error: "Falcon AI could not read this conversation (an image may be unreadable). Remove it or start a new session." };
    case "busy":
      return { status: 429, error: "Falcon AI is busy right now. Try again in a minute." };
    case "overloaded":
      return { status: 503, error: "Falcon AI is under heavy load right now. Try again in a minute." };
    case "timeout":
      return { status: 503, error: "Falcon AI took longer than usual. Try again." };
    default:
      return { status: 503, error: "Falcon AI is unavailable right now. Try again in a minute." };
  }
}

/**
 * The message after ERROR_MARK when the answer fails mid-stream (`sent`: some text already reached the member).
 * `canContinue`: a resume token came with it, so Retry carries on from where the reply stopped (lab/sessions.ts).
 */
export function streamFailure(kind: FailKind, sent: boolean, canContinue = false): string {
  if (canContinue) {
    const why = kind === "timeout" ? "ran out of time" : kind === "busy" || kind === "overloaded" ? "is under heavy load" : "stopped unexpectedly";
    return `Falcon AI ${why} before finishing. Retry to continue from where it stopped.`;
  }
  if (kind === "timeout") return sent ? "The answer was cut off at the time limit." : "Falcon AI took longer than usual. Try again.";
  if (kind === "busy" || kind === "overloaded") return sent ? "The answer was cut off because Falcon AI is under heavy load. Try again." : "Falcon AI is under heavy load right now. Try again in a minute.";
  return sent ? "The answer was cut off." : "Falcon AI is unavailable right now. Try again in a minute.";
}

/** Server log detail (never sent to the member). */
export function logLine(error: unknown, late = false): string {
  if (late || error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIError) return `${error.status} ${error.name}${error instanceof Anthropic.BadRequestError ? `: ${error.message.slice(0, 300)}` : ""}`;
  return error instanceof Error ? error.message : "stream failed";
}

/** Waits `ms`, or rejects at once when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Opens a stream and waits for its first event, retrying a failed start
 * (`isRetryable`) up to MAX_RETRIES times with backoff while `timeLeftMs()`
 * still allows it. Only a start is retried: nothing has reached the member.
 */
export async function firstEventWithRetry<S extends AsyncIterable<E>, E>(
  open: () => S,
  opts: { signal: AbortSignal; timeLeftMs: () => number; minLeftMs?: number; onRetry?: (attempt: number, error: unknown, delayMs: number) => void },
): Promise<{ stream: S; events: AsyncIterator<E>; first: IteratorResult<E>; retries: number }> {
  for (let attempt = 0; ; attempt++) {
    const stream = open();
    const events = stream[Symbol.asyncIterator]();
    try {
      const first = await events.next();
      return { stream, events, first, retries: attempt };
    } catch (error) {
      const delay = retryDelayMs(attempt, error);
      if (attempt >= MAX_RETRIES || opts.signal.aborted || !isRetryable(error) || opts.timeLeftMs() - delay < (opts.minLeftMs ?? 20_000)) throw error;
      opts.onRetry?.(attempt + 1, error, delay);
      await sleep(delay, opts.signal);
    }
  }
}
