import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "@/lib/desk/limits";
import { TITLE_MODEL, TITLE_SYSTEM, cleanTitle, titlePrompt } from "@/lib/desk/title";
import { guard, json, preflight } from "@/lib/strategy/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * A short Falcon AI session title from the first question and answer
 * (lib/desk/title.ts), in the member's language.
 *
 *   POST /api/desk/title { question, answer } -> 200 { title } (empty when none could be made)
 *
 * Same guard as /api/desk/chat (approved member, origin allowlist), 10 a
 * minute per IP and member. Errors are logged here only; the client keeps the
 * default title on any failure.
 */

export function OPTIONS(request: Request) {
  return preflight(request);
}

/** USD for the title model ($0.10 in, $0.50 out per million tokens). */
const cost = (inTok: number, outTok: number) => (inTok * 0.1 + outTok * 0.5) / 1e6;

export async function POST(request: Request) {
  const g = await guard(
    request,
    "desk-title",
    [
      ["min", 10, 60_000, true],
      ["instance", 600, 3_600_000, false],
    ],
    40_000,
  );
  if (!g.ok) return g.response;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return json({ title: "" }, 200, g.origin);
  const question = typeof g.body.question === "string" ? g.body.question : "";
  const answer = typeof g.body.answer === "string" ? g.body.answer : "";
  if (!question.trim()) return json({ error: "Send { question, answer }." }, 400, g.origin);

  try {
    const client = new Anthropic({ apiKey, timeout: 10_000, maxRetries: 1 });
    const msg = await client.messages.create({
      model: TITLE_MODEL,
      max_tokens: 40,
      thinking: { type: "disabled" },
      system: TITLE_SYSTEM,
      messages: [{ role: "user", content: titlePrompt(question, answer) }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const title = msg.stop_reason === "refusal" ? "" : cleanTitle(text);
    const usd = cost(msg.usage.input_tokens, msg.usage.output_tokens);
    await recordUsage(g.userId ?? "preview", usd, 0).catch(() => undefined);
    console.info("[api/desk/title]", JSON.stringify({ ok: !!title, usd: Number(usd.toFixed(6)) }));
    return json({ title }, 200, g.origin);
  } catch (error) {
    console.error("[api/desk/title]", error instanceof Anthropic.APIError ? `${error.status} ${error.name}` : error instanceof Error ? error.message : "failed");
    return json({ title: "" }, 200, g.origin);
  }
}
