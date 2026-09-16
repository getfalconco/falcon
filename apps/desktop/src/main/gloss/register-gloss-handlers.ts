import {
  anthropicGlossCaller,
  glossConfigured,
  glossSelection,
  translateGloss,
  GlossError,
  type GlossRequest,
  type GlossResult,
} from "@meridian/research/gloss";
import { registerIpcHandler } from "../ipc-register";

/**
 * Gloss IPC: the renderer sends a highlighted string, the main process turns
 * it into an explanation. The key stays here, as every provider key does.
 *
 * Three guards sit in front of the model. A cache, because a reader highlights
 * the same word twice and the second time should be instant and free; an
 * in-flight map, because a dragged selection fires the same lookup repeatedly
 * before the first one lands; and a rate limit, because a selection is one
 * mouse gesture and a mouse can make a lot of them.
 */

const CACHE_LIMIT = 200;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;

type Channel = "explain" | "translate";

const glossCache = new Map<string, GlossResult>();
const translationCache = new Map<string, string>();
const inFlight = new Map<string, Promise<unknown>>();
/** One window per channel: word lookups must not lock out the TR toggle. */
const recent: Record<Channel, number[]> = { explain: [], translate: [] };

function key(parts: Array<string | undefined>): string {
  return parts.map((p) => (p ?? "").trim().slice(0, 480).toLowerCase()).join("|");
}

/** Oldest out first, so a long session can't grow these without bound. */
function remember<T>(cache: Map<string, T>, k: string, value: T): void {
  cache.set(k, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function withinRate(channel: Channel, now: number): boolean {
  const window = recent[channel].filter((t) => now - t < RATE_WINDOW_MS);
  recent[channel] = window;
  if (window.length >= RATE_MAX) return false;
  window.push(now);
  return true;
}

/**
 * The same selection asked for twice before the first answer lands shares one
 * model call — a drag across a headline is a burst of identical lookups.
 */
function once<T>(k: string, run: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(k) as Promise<T> | undefined;
  if (pending) return pending;
  const promise = run().finally(() => inFlight.delete(k));
  inFlight.set(k, promise);
  return promise;
}

/**
 * Provider errors carry HTTP bodies and model ids; those belong in the log,
 * not in a 290px card. Only our own messages are written for a reader.
 */
function readerMessage(err: unknown, what: string): string {
  if (err instanceof GlossError) return err.message;
  console.error(`[gloss] ${what} failed:`, err);
  return "Couldn't reach the model. Try again in a moment.";
}

export function registerGlossHandlers(): void {
  registerIpcHandler(
    "gloss:explain",
    async (_event, request: { selection?: string; context?: string; ticker?: string }) => {
      const selection = typeof request?.selection === "string" ? request.selection : "";
      if (!selection.trim()) return { ok: false as const, error: "nothing selected" };
      if (!glossConfigured()) return { ok: false as const, error: "no model configured" };

      const payload: GlossRequest = {
        selection,
        context: typeof request?.context === "string" ? request.context : undefined,
        ticker: typeof request?.ticker === "string" ? request.ticker : undefined,
      };

      const cacheKey = key(["explain", payload.selection, payload.ticker, payload.context]);
      const hit = glossCache.get(cacheKey);
      if (hit) return { ok: true as const, gloss: hit, cached: true as const };

      if (inFlight.has(cacheKey) === false && !withinRate("explain", Date.now())) {
        return { ok: false as const, error: "too many lookups — give it a moment" };
      }

      try {
        const gloss = await once(cacheKey, () => glossSelection(payload, anthropicGlossCaller));
        remember(glossCache, cacheKey, gloss);
        return { ok: true as const, gloss, cached: false as const };
      } catch (err) {
        return { ok: false as const, error: readerMessage(err, "explain") };
      }
    },
  );

  // Turkish is a second call, made only when the reader asks for it — the
  // first answer stays short, and the toggle pays for itself.
  registerIpcHandler(
    "gloss:translate",
    async (_event, request: { term?: string; english?: string }) => {
      const english = typeof request?.english === "string" ? request.english : "";
      const term = typeof request?.term === "string" ? request.term : "";
      if (!english.trim()) return { ok: false as const, error: "nothing to translate" };
      if (!glossConfigured()) return { ok: false as const, error: "no model configured" };

      const cacheKey = key(["translate", term, english]);
      const hit = translationCache.get(cacheKey);
      if (hit) return { ok: true as const, turkish: hit, cached: true as const };

      if (inFlight.has(cacheKey) === false && !withinRate("translate", Date.now())) {
        return { ok: false as const, error: "too many lookups — give it a moment" };
      }

      try {
        const { turkish } = await once(cacheKey, () =>
          translateGloss(term, english, anthropicGlossCaller),
        );
        remember(translationCache, cacheKey, turkish);
        return { ok: true as const, turkish, cached: false as const };
      } catch (err) {
        return { ok: false as const, error: readerMessage(err, "translate") };
      }
    },
  );
}
