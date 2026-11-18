import Anthropic from "@anthropic-ai/sdk";
import { HELP_GUIDE } from "@/lib/help/guide";
import { corsHeaders, guard, json, preflight } from "@/lib/strategy/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Netlify's synchronous function limit (60 s, fixed; docs.netlify.com/build/functions/configuration). */
export const maxDuration = 60;

/**
 * The in-app help chat: answers questions about how Falcon works, streamed as
 * plain text.
 *
 *   POST /api/help { messages: [{ role: "user" | "assistant", content }], view? }
 *     -> 200 text/plain stream of the reply
 *     -> 400 bad body, 401 not signed in as an approved member, 413 too large,
 *        429 rate limited, 503 not configured or unavailable
 *
 * Same guard as /api/strategy/* (origin allowlist, approved member's bearer
 * token, limits, size cap; no token needed only under `next dev`, for the
 * preview). Claude Haiku 5.5, up to 600 output tokens, the last 12 messages
 * only; the product guide (lib/help/guide.ts) is the cached system prompt.
 * 6 a minute and 60 an hour per IP and per member, 600 an hour per instance.
 */

const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 600;
const MAX_MESSAGES = 12;
const MAX_CHARS = 2_000;
/**
 * The whole request, sign-in check and streaming included, ends within 50 s
 * of arriving: 10 s under the 60 s limit for a cold start. A reply still
 * streaming then is cut off with a note.
 */
const DEADLINE_MS = 50_000;

export function OPTIONS(request: Request) {
  return preflight(request);
}

/** The last messages, starting with the user's, alternating roles. */
function cleanMessages(v: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(v)) return [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of v.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = String((m as { content?: unknown }).content ?? "")
      .trim()
      .slice(0, MAX_CHARS);
    if ((role !== "user" && role !== "assistant") || !content) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${String(last.content)}\n\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export async function POST(request: Request) {
  const arrived = Date.now();
  const g = await guard(
    request,
    "help",
    [
      ["min", 6, 60_000, true],
      ["hour", 60, 3_600_000, true],
      ["instance", 600, 3_600_000, false],
    ],
    MAX_MESSAGES * MAX_CHARS * 2 + 4_000,
  );
  if (!g.ok) return g.response;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return json({ error: "Help is not configured on this server." }, 503, g.origin);

  const messages = cleanMessages(g.body.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "Send { messages } ending with a question." }, 400, g.origin);
  const view = typeof g.body.view === "string" ? g.body.view.replace(/[<>]/g, "").trim().slice(0, 200) : "";
  if (view) {
    const last = messages[messages.length - 1];
    last.content = `<current_view>${view}</current_view>\n\n${String(last.content)}`;
  }

  const guardMs = Date.now() - arrived;
  const client = new Anthropic({ apiKey, timeout: DEADLINE_MS - guardMs, maxRetries: 0 });
  let stream: ReturnType<typeof client.messages.stream>;
  try {
    stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Short answers to simple questions: low effort keeps the thinking (and the wait) small.
      output_config: { effort: "low" },
      system: [{ type: "text", text: HELP_GUIDE, cache_control: { type: "ephemeral" } }],
      messages,
    });
  } catch (error) {
    console.error("[api/help]", error instanceof Error ? error.message : "start failed");
    return json({ error: "Help is unavailable right now." }, 503, g.origin);
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = false;
      let late = false;
      // The SDK timeout only covers the wait for the first byte; this ends a reply still streaming at the deadline.
      const timer = setTimeout(
        () => {
          late = true;
          stream.abort();
        },
        Math.max(0, DEADLINE_MS - (Date.now() - arrived)),
      );
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            sent = true;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        console.info("[api/help]", JSON.stringify({ stop: final.stop_reason, guardMs, totalMs: Date.now() - arrived, usage: final.usage }));
        if (final.stop_reason === "refusal" && !sent) controller.enqueue(encoder.encode("I can't help with that here. Ask me how to read a Sighting or a Backtest result."));
        else if (final.stop_reason === "max_tokens") controller.enqueue(encoder.encode(" …"));
      } catch (error) {
        const timedOut = late || error instanceof Anthropic.APIConnectionTimeoutError;
        console.error(
          "[api/help]",
          JSON.stringify({ error: timedOut ? "timeout" : error instanceof Anthropic.APIError ? `${error.status} ${error.name}` : error instanceof Error ? error.message : "stream failed", guardMs, totalMs: Date.now() - arrived }),
        );
        controller.enqueue(
          encoder.encode(sent ? "\n\n(The answer was cut off. Try again.)" : timedOut ? "Help took longer than usual. Try again." : "Help is unavailable right now. Try again in a minute."),
        );
      } finally {
        clearTimeout(timer);
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { ...corsHeaders(g.origin), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
