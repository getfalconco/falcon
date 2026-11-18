import Anthropic from "@anthropic-ai/sdk";
import { DESK_SYSTEM, deskDateLine } from "@/lib/desk/system";
import { DESK_TOOLS, deskToolLabel, runDeskTool, type DeskToolOutcome } from "@/lib/desk/tools";
import { deskToolCommand } from "@/lib/desk/tools/command";
import {
  CODE_EXECUTION_TOOL,
  LOAD_PRICES_TOOL,
  MODEL,
  handOffCounts,
  loadPricesLabel,
  prepareContainer,
  readResultFile,
  runLoadPrices,
  signResume,
  verifyResume,
  type ResumeState,
  type ToolWait,
} from "@/lib/desk/strategy-run";
import { corsHeaders, guard, json, preflight } from "@/lib/strategy/guard";
import { AUDIT_DEFER_TEXT, AUDIT_MIN_MS, AUDIT_TOOL, loadsBenchmark, loadsInTurns, runAuditTool } from "@/lib/desk/audit-run";
import { EVENT_BACKTEST_TOOL } from "@/lib/desk/event-spec";
import { EVENT_DEFER_TEXT, EVENT_MIN_MS, eventBacktestLabel, runEventBacktestTool } from "@/lib/desk/event-backtest-run";
import type { RunResult } from "@/lib/desk/run-result";
import { ASK_USER_TOOL, askOutcome, pickAsk, resumeFromAsk, signAsk } from "@/lib/desk/tools/ask";
import { CHART_TOOL, chartLabel, runChartTool } from "@/lib/desk/tools/chart";
import { classify, firstEventWithRetry, logLine, startFailure, streamFailure } from "@/lib/desk/errors";
import { checkBudget, limitsOff, recordUsage, unlimitedUser } from "@/lib/desk/limits";
import { requireFounderAdmin } from "@/lib/admin-session";
import { clientIp } from "@/lib/rate-limit";
import { FORGET_TOOL, MEMORY_TOOL_NAMES, REMEMBER_TOOL, memoryLabel, runMemoryTool } from "@/lib/desk/tools/memory";
import { cleanMemory, memoryBlock } from "@/lib/desk/memory";
import { cleanContext, contextText, isContextText } from "@/lib/desk/history-context";
import { FALCON_TOOLS, falconToolLabel, isFalconTool, runFalconTool } from "@/lib/desk/tools/falcon";
import { EVENTS_TOOL, eventsLabel, runEventsTool } from "@/lib/desk/tools/events";
import { LOAD_EVENTS_TOOL, loadEventsLabel, runLoadEvents, withEventTickers } from "@/lib/desk/tools/load-events";
import { LOAD_GRAPH_TOOL, loadGraphLabel, runLoadGraph } from "@/lib/desk/tools/load-graph";
import { SCOREBOARD_TOOL, runScoreboardTool, scoreboardLabel } from "@/lib/desk/tools/scoreboard";
import { IV_TOOL_NAME } from "@/lib/desk/tools/iv";
import type { ToolProgress } from "@/lib/desk/tools/util";
import { appContextText, cleanAppContext, portfolioWeightsText } from "@/lib/desk/app-actions";
import { portfolioForAi } from "@/lib/portfolio-store";
import { canResume, cutMessages, cutTurn, isServerResult, joinResumed, toolsStarved, type Cut } from "@/lib/desk/resume";
import { assignSourceIds, buildRegistry, checkReply, cleanSourceBase, replyText, withSourceId, type Turn } from "@/lib/desk/citations";
import { FINAL_NOTE, partialRunSummary, replyLanguage } from "@/lib/desk/partial";
import { codeDraft } from "@/lib/desk/code-cards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Netlify's synchronous function limit (60 s, fixed; docs.netlify.com/build/functions/configuration). */
export const maxDuration = 60;

/**
 * The Desk chat: a research conversation with Claude Opus 5.5, streamed as
 * plain text (Markdown the client renders). Claude can call the Desk data
 * tools (lib/desk/tools: quotes, price history, SEC fundamentals, earnings,
 * filings and their text, insider trades), the tools of one round in
 * parallel; tool activity is sent in the stream as TOOL_MARK lines.
 *
 * Strategy tests (lib/desk/strategy-run.ts): Claude calls `load_prices`
 * (daily bars uploaded with the Files API into the code execution sandbox),
 * then writes and runs Python with Anthropic's code execution tool
 * (`code_execution_20260521`). The run shows in the stream as RUN_MARK lines
 * (started, data, code, command, stdout, result, error, finished) and the
 * client opens a results panel. A test can outlast one request: the route
 * then stops at a block boundary and sends a signed resume token (RUN_MARK
 * `continue`); the client posts again with it and the same container.
 *
 *   POST /api/desk/chat { messages: [{ role, text, images? }], resume?: string, ask?: { token, answers? } }
 *     -> 200 text/plain stream of the reply
 *     -> 400 bad body or image, 401 not signed in as an approved member,
 *        413 too large, 429 rate limited, 503 not configured
 *
 * Same guard as /api/help (origin allowlist, approved member's bearer token,
 * limits, size cap; no token needed only under `next dev`, for the preview).
 * The last 20 messages; images only on user messages, PNG/JPEG/WebP/GIF as
 * base64, at most 5 MB each, 4 per message and 8 per request.
 * Effort `low`, up to 16,000 output tokens a round, refusals fall back
 * server-side (`fallbacks: "default"`). The system prompt is cached; the date
 * follows it, and the conversation is cached too (top-level cache_control).
 * 8 a minute and 80 an hour per IP and per member (a resumed request counts),
 * 800 an hour per instance.
 */

const EFFORT = "low" as const;
const MAX_TOKENS = 16_000;
const MAX_MESSAGES = 20;
const MAX_USER_CHARS = 8_000;
const MAX_ASSISTANT_CHARS = 24_000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGES_PER_REQUEST = 8;
/** Anthropic's per-image limit, decoded. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = 12_000_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
/**
 * The whole request, sign-in check and streaming included, ends within 50 s
 * of arriving: 10 s under the 60 s limit for a cold start. A reply still
 * streaming then is cut off with a note, or resumed when it is a strategy test.
 */
const DEADLINE_MS = 50_000;
/**
 * A failure after the reply has started is sent as this character and a short
 * message; the Desk shows it as an error with "Try again" (lab/sessions.ts).
 */
const ERROR_MARK = "\u001e";
/**
 * Tool activity: this character, one JSON line and a newline, between the
 * reply's text (lab/sessions.ts strips and parses them):
 *   {"id","state":"running","label":"Looking up AAPL quote"}
 *   {"id","state":"done","label":"Looked up AAPL quote","ok":true,"ms":412,"result":"{...}"}
 */
const TOOL_MARK = "\u001d";
/**
 * Strategy-test activity, same framing as TOOL_MARK (`t` is the kind):
 *   {"t":"started","id"}  {"t":"data","id","text"}  {"t":"code","id","path","code","key","kind","old"?,"new"?,"whole"?}
 *   {"t":"draft","id","key","lang","path"?,"from","add"} (a script still being written: its text from `from` on is `add`)
 *   {"t":"command","id","command","key"?,"bare"?}  {"t":"stdout","id","stdout","stderr","rc","key"?}
 * `key` is the code-execution call's id: the chat shows each script as a card (lab/ScriptCard.tsx) at its place.
 *   {"t":"result","id","result","problems"}  {"t":"error","id","message"}
 *   {"t":"finished","id"}  {"t":"continue","token"} (post again with { resume: token })
 *   {"t":"ask","id","questions","token"} (ask_user: the reply ends; the answer posts { ask: { token, answers? } })
 */
const RUN_MARK = "\u001c";
/**
 * Tool rounds per reply (across resumes); one more round then answers in text (tool_choice none). Each round
 * checks the deadline, and a research reply short of time resumes in a new request rather than being cut.
 */
const MAX_TOOL_ROUNDS = 10;
/** An empty activity line goes out after this long with nothing sent (a long tool, a quiet round). */
const HEARTBEAT_MS = 5_000;
/** Per-round budget for the data tools, at most this; less when the deadline is near. */
const TOOL_TIMEOUT_MS = 9_000;
/** load_prices may take longer (hundreds of tickers on a cold cache). */
const LOAD_TIMEOUT_MS = 38_000;
/** flow (Databento trades) may take longer: a heavily traded session is a 15-25 s download. */
const FLOW_TIMEOUT_MS = 25_000;
/** falcon_options buying one options chain on demand (a few seconds; its download stops at 25 s). */
const IV_TIMEOUT_MS = 25_000;
/**
 * falcon_options detail history buys one snapshot per sampled session (lib/desk/tools/iv-history.ts), 15-40 s for a
 * year. When the reply can resume it may use the time up to the hand-off instead and is waited on in the next request.
 */
const IV_HISTORY_TIMEOUT_MS = 35_000;
/** An on-demand options pull or /flow is not started with less than this (they take about 20-25 s): the reply resumes first. */
const SLOW_TOOL_MIN_MS = 20_000;
/** Kept back from the deadline to stream the final answer. */
const ANSWER_RESERVE_MS = 15_000;
/** Kept back from the deadline to hand off when an options history pull is still loading (the next request waits on it). */
const HANDOFF_RESERVE_MS = 3_000;
/** Below this budget the tools are not run ("out of time" results) and the next round must answer. */
const MIN_TOOL_MS = 3_000;
/** During a strategy test, a new round needs this much time left; otherwise the reply resumes in a new request. */
const RUN_ROUND_MIN_MS = 22_000;
/**
 * A reply resumes at most this many times (about 10 minutes in all; a long strategy test with a sweep and its audit
 * takes 5, a slow script's audit re-runs up to 3 more, an event test over 1,000 tickers since 2016 a few more).
 * Hand-offs that only wait on a price load still making progress are not counted (lib/desk/strategy-run.ts
 * handOffCounts, at most FREE_HOPS a reply). The last request answers in text before its time is up (FINAL_NOTE).
 */
const MAX_RESUMES = 12;
/** load_prices that may hand off: time kept back from its budget to write and upload the file (24 MB for 1,000 tickers x 11 years). */
const LOAD_FILE_RESERVE_MS = 12_000;
const STDOUT_CHARS = 6_000;
/** A script being written goes out to the chat at most this often (RUN_MARK `draft`). */
const DRAFT_MS = 250;

export function OPTIONS(request: Request) {
  return preflight(request);
}

class BadInput extends Error {}

/** The first bytes of the file match its declared type. */
function magicMatches(type: ImageType, data: string): boolean {
  const head = Buffer.from(data.slice(0, 24), "base64");
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  switch (type) {
    case "image/png":
      return head[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/gif":
      return ascii(0, 4) === "GIF8";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  }
}

function cleanImage(v: unknown): Anthropic.Beta.BetaImageBlockParam {
  const mediaType = (v as { mediaType?: unknown })?.mediaType;
  const data = (v as { data?: unknown })?.data;
  if (typeof mediaType !== "string" || !(IMAGE_TYPES as readonly string[]).includes(mediaType)) throw new BadInput("Images must be PNG, JPEG, WebP or GIF.");
  if (typeof data !== "string" || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new BadInput("An image could not be read. Attach it again.");
  const bytes = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) throw new BadInput("Each image must be under 5 MB.");
  if (!magicMatches(mediaType as ImageType, data)) throw new BadInput("Images must be PNG, JPEG, WebP or GIF.");
  return { type: "image", source: { type: "base64", media_type: mediaType as ImageType, data } };
}

/**
 * The last messages, starting with the user's, same-role neighbours merged; images first in a turn, then text.
 * A member message's `context` (what the reply before it showed: charts, question cards, a strategy test;
 * lib/desk/history-context.ts) opens its turn as one tagged block, so it never reads as the model's own words.
 */
function cleanMessages(v: unknown): { messages: Anthropic.Beta.BetaMessageParam[]; images: number } {
  if (!Array.isArray(v)) return { messages: [], images: 0 };
  const out: { role: "user" | "assistant"; content: Anthropic.Beta.BetaContentBlockParam[] }[] = [];
  let images = 0;
  for (const m of v.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    const text = String((m as { text?: unknown }).text ?? "")
      .trim()
      .slice(0, role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS);
    const rawImages = role === "user" ? (m as { images?: unknown }).images : undefined;
    const list = Array.isArray(rawImages) ? rawImages : [];
    if (list.length > MAX_IMAGES_PER_MESSAGE) throw new BadInput(`Attach at most ${MAX_IMAGES_PER_MESSAGE} images per message.`);
    images += list.length;
    if (images > MAX_IMAGES_PER_REQUEST) throw new BadInput("Too many images in this conversation. Start a new session.");
    const context = role === "user" ? cleanContext((m as { context?: unknown }).context) : [];
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [...(context.length ? [{ type: "text" as const, text: contextText(context) }] : []), ...list.map(cleanImage)];
    if (text) blocks.push({ type: "text", text });
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  while (out.length && out[0].role !== "user") out.shift();
  // An image with no words: give the model something to answer.
  const final = out[out.length - 1];
  if (final?.role === "user" && !final.content.some((b) => b.type === "text" && !isContextText(b.text))) final.content.push({ type: "text", text: "What does this show?" });
  return { messages: out, images };
}

/** A python script inside a bash command: `cat > x.py <<'EOF' ... EOF` or `python3 - <<'EOF' ... EOF`. */
function scriptsInCommand(command: string): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const re = /(?:cat\s*>\s*(\S+\.py)|python3?\s+-)\s*<<\s*-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\2\b/g;
  for (let m = re.exec(command); m; m = re.exec(command)) out.push({ path: m[1] ?? "(inline script)", code: m[3]! });
  return out;
}

/** USD for Claude Opus 5.5 tokens ($4 in, $20 out, $5 cache write, $0.20 cache read per million). */
const cost = (u: { in: number; out: number; cacheRead: number; cacheWrite: number }) => (u.in * 4 + u.out * 20 + u.cacheWrite * 5 + u.cacheRead * 0.2) / 1e6;
const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export async function POST(request: Request) {
  const arrived = Date.now();
  // Development only: a shorter deadline from a header, to exercise the hand-off and resume path (`next dev`; never in production).
  const devDeadline = process.env.NODE_ENV === "development" ? Number(request.headers.get("x-desk-deadline-ms")) : NaN;
  const deadlineMs = Number.isFinite(devDeadline) && devDeadline >= 5_000 ? Math.min(DEADLINE_MS, devDeadline) : DEADLINE_MS;
  // Development only: the deadline fails the reply instead of handing off, to exercise Retry's continue path.
  const devNoResume = process.env.NODE_ENV === "development" && request.headers.get("x-desk-no-resume") === "1";
  // Under `next dev` (localhost) Falcon AI has no limits at all: no rate limits, no daily budget, nothing counted (lib/desk/limits.ts).
  const noLimits = limitsOff();
  const g = await guard(
    request,
    "desk",
    noLimits
      ? []
      : [
          ["min", envInt("DESK_PER_MINUTE", 8), 60_000, true],
          ["hour", envInt("DESK_PER_HOUR", 80), 3_600_000, true],
          ["instance", 800, 3_600_000, false],
        ],
    MAX_BODY_BYTES,
  );
  if (!g.ok) return g.response;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return json({ error: "Falcon AI is not configured on this server." }, 503, g.origin);
  // The member's daily budget (lib/desk/limits.ts); the dev preview (no member) counts per IP. The founder admin is never capped.
  const usageKey = g.userId ?? `ip:${clientIp(request)}`;
  // A valid founder admin session (lib/admin-session): never capped, and sees options under OPTIONS_DISPLAY=admin like /api/sightings.
  const founderAdmin = (await requireFounderAdmin().catch(() => null)) !== null;
  const budget = await checkBudget(usageKey, noLimits || unlimitedUser(g.userId) || founderAdmin);
  if (!budget.ok) {
    console.info("[api/desk/chat]", JSON.stringify({ stop: "daily_limit", reason: budget.reason }));
    return json({ error: budget.error }, 429, g.origin);
  }

  let messages: Anthropic.Beta.BetaMessageParam[];
  let images: number;
  let memory: ReturnType<typeof cleanMemory> = [];
  try {
    ({ messages, images } = cleanMessages(g.body.messages));
    // The member's saved memory (lib/desk/memory.ts), kept by the client until desk_memory is applied.
    memory = cleanMemory(g.body.memory);
  } catch (error) {
    if (error instanceof BadInput) return json({ error: error.message }, 400, g.origin);
    throw error;
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "Send { messages } ending with a question." }, 400, g.origin);
  // What the member has open in the app (lib/desk/app-actions.ts): a short block after the cached prefix.
  const app = cleanAppContext(g.body.app);
  // Source ids (lib/desk/citations.ts) number on from the conversation's last one, the same in every request of a reply.
  const srcBase = cleanSourceBase(g.body.srcBase);
  const appBlock = appContextText(app);
  // The member's position sizes, read here by user id and never taken from the request: whole percents only (lib/portfolio-store.ts).
  const own = await Promise.race([
    portfolioForAi(g.userId),
    new Promise<{ weights: []; paper: false }>((resolve) => setTimeout(() => resolve({ weights: [], paper: false }), 2_500)),
  ]);
  const weightsBlock = portfolioWeightsText(own.weights, own.paper);
  const weights = new Map(own.weights.map((w) => [w.ticker, w]));
  let resumed: ResumeState | null = null;
  if (g.body.resume !== undefined) {
    resumed = verifyResume(g.body.resume, apiKey, g.userId);
    if (!resumed) return json({ error: "This answer can no longer be continued. Ask again." }, 400, g.origin);
    if (resumed.n >= MAX_RESUMES) return json({ error: "This answer ran too long and was stopped. Try asking for less at once." }, 400, g.origin);
  }
  // The member's answer to an ask_user card (lib/desk/tools/ask.ts): the asking reply's real turns come back with the
  // missing tool_result, and the reply carries on from there (a resume of it keeps the same cut of the history).
  if (g.body.ask !== undefined) {
    const a = resumeFromAsk(messages, g.body.ask, apiKey, g.userId);
    if (a) {
      messages = a.messages;
      resumed ??= a.resumed;
    }
  }

  const guardMs = Date.now() - arrived;
  const client = new Anthropic({ apiKey, timeout: deadlineMs - guardMs, maxRetries: 0 });
  /** This reply's turns so far (carried over a resume); the model sees messages + tail. */
  const tail: Anthropic.Beta.BetaMessageParam[] = resumed ? [...resumed.tail] : [];
  const state = {
    container: resumed?.container ?? null,
    runId: resumed?.runId ?? null,
    dataFiles: resumed ? [...resumed.dataFiles] : ([] as string[]),
    files: { ...(resumed?.files ?? {}) } as Record<string, string>,
    lastScript: "",
    /** The last result downloaded in this request (the audit reads it; after a resume the audit harness copies it back). */
    lastResult: null as RunResult | null,
  };
  /** Aborted when the viewer goes away or the deadline passes; stops the model stream and any tool still running. */
  const ctl = new AbortController();
  let current: ReturnType<typeof client.beta.messages.stream> | null = null;
  const startRound = (answerNow: boolean) =>
    (current = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Thinking is always on for Opus 5.5; low effort keeps it short so the reply starts in about a second.
        output_config: { effort: EFFORT },
        // A request the safety classifiers decline is re-run on the recommended fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // Caches the conversation up to its last block, so a follow-up (or the next round) re-reads earlier turns cheaply.
        cache_control: { type: "ephemeral" },
        // Fixed list and order: tools render before the system prompt, inside its cached prefix.
        tools: [...DESK_TOOLS, LOAD_PRICES_TOOL, LOAD_EVENTS_TOOL, LOAD_GRAPH_TOOL, EVENT_BACKTEST_TOOL, AUDIT_TOOL, CHART_TOOL, ASK_USER_TOOL, REMEMBER_TOOL, FORGET_TOOL, ...FALCON_TOOLS, EVENTS_TOOL, SCOREBOARD_TOOL, CODE_EXECUTION_TOOL],
        // Never removed (that would break the cache); "none" makes the model answer with what it has.
        tool_choice: answerNow ? { type: "none" } : { type: "auto" },
        system: [
          { type: "text", text: DESK_SYSTEM, cache_control: { type: "ephemeral" } },
          { type: "text", text: deskDateLine() },
          // After the cached prefix, so a change to memory does not invalidate it.
          ...(memoryBlock(memory) ? [{ type: "text" as const, text: memoryBlock(memory)! }] : []),
          ...(appBlock ? [{ type: "text" as const, text: appBlock }] : []),
          ...(weightsBlock ? [{ type: "text" as const, text: weightsBlock }] : []),
        ],
        messages: [...messages, ...tail],
        ...(state.container ? { container: state.container } : {}),
      },
      { signal: ctl.signal },
    ));
  let stream!: ReturnType<typeof startRound>;
  let events!: AsyncIterator<Anthropic.Beta.BetaRawMessageStreamEvent>;
  let first: IteratorResult<Anthropic.Beta.BetaRawMessageStreamEvent> | null = null;
  /** Retried starts this request (overloaded, 5xx, rate limited: lib/desk/errors.ts). */
  let retries = 0;
  /** Starts a round and waits for its first event, retrying a failed start with backoff while there is time. */
  const openRound = async (answerNow: boolean) => {
    const r = await firstEventWithRetry<ReturnType<typeof startRound>, Anthropic.Beta.BetaRawMessageStreamEvent>(() => startRound(answerNow), {
      signal: ctl.signal,
      timeLeftMs: () => deadlineMs - (Date.now() - arrived),
      onRetry: (attempt, error, ms) => {
        retries++;
        console.warn("[api/desk/chat] retry", JSON.stringify({ attempt, error: logLine(error), ms }));
      },
    });
    stream = r.stream;
    events = r.events;
    first = r.first;
  };
  let late = false;
  const onAbort = () => {
    ctl.abort();
    current?.abort();
  };
  const onClientAbort = () => onAbort();
  request.signal.addEventListener("abort", onClientAbort);
  // The SDK timeout only covers the wait for the first byte; this ends a reply still streaming (or a tool still running) at the deadline.
  const timer = setTimeout(
    () => {
      late = true;
      onAbort();
    },
    Math.max(0, deadlineMs - (Date.now() - arrived)),
  );
  const done = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onClientAbort);
  };
  // Upstream details are logged here only; the member sees a Falcon AI message (lib/desk/errors.ts).
  const failure = (error: unknown) => ({ kind: classify(error, late), log: logLine(error, late) });

  // Wait for the first event, so a failed start (overloaded, rate limited, bad image) is an HTTP error, not reply text.
  try {
    // A request that waits on a tool call still loading (ToolWait) opens its round once the call is in.
    if (!resumed?.waiting) await openRound(false);
  } catch (error) {
    done();
    const f = failure(error);
    console.error("[api/desk/chat]", JSON.stringify({ error: request.signal.aborted ? "client_abort" : f.log, retries, guardMs, totalMs: Date.now() - arrived }));
    const s = startFailure(f.kind);
    return json({ error: s.error }, s.status, g.origin);
  }
  /** When the first model event arrived (the response starts then): sign-in, budget and the model's start. */
  const startMs = Date.now() - arrived;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = false;
      /** Whether the text so far ends in whitespace (a new round's text starts a new paragraph otherwise). */
      let endsClean = true;
      let firstMs: number | null = null;
      let fallback = false;
      let rounds = 0;
      let tools = 0;
      let model = "";
      let stop: string | null = null;
      let resumeAt: string | null = null;
      const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
      /** Spend outside the main rounds (the audit's own model calls), for the daily budget. */
      let extraUsd = 0;
      let lastByteAt = Date.now();
      const say = (text: string) => {
        lastByteAt = Date.now();
        controller.enqueue(encoder.encode(text));
      };
      // Heartbeat: during a long tool or a quiet round, an empty activity line (the client skips a line with no id)
      // keeps proxies from closing an idle stream and shows the reply is still alive.
      const heartbeat = setInterval(() => {
        if (Date.now() - lastByteAt < HEARTBEAT_MS || ctl.signal.aborted) return;
        try {
          say(`${TOOL_MARK}{}\n`);
        } catch {
          clearInterval(heartbeat);
        }
      }, 1_000);
      /** Counts this request toward the member's daily budget (once). */
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        if (!noLimits) void recordUsage(usageKey, cost(usage) + extraUsd).catch(() => undefined);
      };
      /** One tool activity line (lab/sessions.ts parses these out of the text). JSON escapes control characters, so it stays on one line. */
      /** Source ids of this reply's tool calls by tool_use id (lib/desk/citations.ts); a done line carries its `src`. */
      let srcOf = new Map<string, string>();
      const mark = (event: Record<string, unknown>) => {
        const src = event.state === "done" && typeof event.id === "string" ? srcOf.get(event.id) : undefined;
        say(`${TOOL_MARK}${JSON.stringify(src ? { ...event, src } : event)}\n`);
      };
      /** The last round's content (the final answer is not put on the tail), for the citation check. */
      let lastContent: Anthropic.Beta.BetaContentBlock[] | null = null;
      const runMark = (event: Record<string, unknown>) => say(`${RUN_MARK}${JSON.stringify(event)}\n`);
      /** Downloads of result files started this request (awaited before the reply ends). */
      const pending: Promise<void>[] = [];
      /** The audit asked for a fresh request: hand off right after this tool round. */
      let auditDeferred = false;
      /** The container-id request, started with the first price load (an object: it is set inside the tool callbacks). */
      const prep: { p: ReturnType<typeof prepareContainer> | null } = { p: null };

      const beginRun = () => {
        if (state.runId) return;
        state.runId = `run_${Date.now().toString(36)}`;
        runMark({ t: "started", id: state.runId });
      };
      /** `key` and `kind` place the script's card in the chat (lab/ScriptCard.tsx): created by the model, or Falcon's event test script. */
      const showScript = (path: string, code: string, card: { key: string; kind: "created" | "falcon" }) => {
        state.files[path] = code;
        state.lastScript = code;
        runMark({ t: "code", id: state.runId, path, code, ...card });
      };
      /**
       * Code-execution calls still streaming in this round, by block index: what they write so far goes out as `draft`
       * lines (at most every DRAFT_MS), so the chat shows the script as it is written.
       */
      const drafts = new Map<number, { key: string; tool: "editor" | "bash"; json: string; sent: string; path?: string; last: number }>();
      const sendDraft = (d: { key: string; tool: "editor" | "bash"; json: string; sent: string; path?: string; last: number }) => {
        d.last = Date.now();
        const c = codeDraft(d.tool, d.json);
        if (!c) return;
        let from = 0;
        const max = Math.min(c.code.length, d.sent.length);
        while (from < max && c.code.charCodeAt(from) === d.sent.charCodeAt(from)) from++;
        if (from === c.code.length && from === d.sent.length && c.path === d.path) return;
        runMark({ t: "draft", id: state.runId, key: d.key, lang: c.lang, ...(c.path ? { path: c.path } : {}), from, add: c.code.slice(from) });
        d.sent = c.code;
        d.path = c.path;
      };
      /** A finished code execution call: show the script or command it carries. */
      const onServerToolUse = (b: Anthropic.Beta.BetaServerToolUseBlock) => {
        beginRun();
        const input = b.input as { command?: unknown; path?: unknown; file_text?: unknown; old_str?: unknown; new_str?: unknown };
        if (b.name === "text_editor_code_execution") {
          const path = typeof input.path === "string" ? input.path : "script.py";
          if (input.command === "create" && typeof input.file_text === "string") showScript(path, input.file_text, { key: b.id, kind: "created" });
          else if (input.command === "str_replace" && typeof input.old_str === "string" && typeof input.new_str === "string") {
            // An edit: its card shows the lines replaced; the whole file goes to the results panel when it is known.
            const whole = state.files[path]?.includes(input.old_str) ? state.files[path]!.replace(input.old_str, input.new_str) : undefined;
            if (whole !== undefined) {
              state.files[path] = whole;
              state.lastScript = whole;
            }
            const edit = { key: b.id, kind: "edited", old: input.old_str.slice(0, 20_000), new: input.new_str.slice(0, 20_000) };
            runMark({ t: "code", id: state.runId, path, code: whole ?? input.new_str, ...edit, ...(whole === undefined ? { whole: false } : {}) });
          }
        } else if (b.name === "bash_code_execution" && typeof input.command === "string") {
          const scripts = scriptsInCommand(input.command);
          scripts.forEach((s, i) => showScript(s.path, s.code, { key: i ? `${b.id}:${i}` : b.id, kind: "created" }));
          // A command with no script in it is a card of its own ("Ran …").
          runMark({ t: "command", id: state.runId, command: input.command.slice(0, 4_000), key: b.id, ...(scripts.length ? {} : { bare: true }) });
        }
      };
      const onServerResult = (b: Anthropic.Beta.BetaContentBlock) => {
        if (b.type === "bash_code_execution_tool_result") {
          const c = b.content;
          if (c.type === "bash_code_execution_tool_result_error") {
            runMark({ t: "stdout", id: state.runId, key: b.tool_use_id, stdout: "", stderr: `Code execution error: ${c.error_code}`, rc: -1 });
            return;
          }
          runMark({ t: "stdout", id: state.runId, key: b.tool_use_id, stdout: c.stdout.slice(-STDOUT_CHARS), stderr: c.stderr.slice(-STDOUT_CHARS), rc: c.return_code });
          const ids = c.content.map((f) => f.file_id);
          if (!ids.length) return;
          const runId = state.runId;
          pending.push(
            readResultFile(client, ids, AbortSignal.any([request.signal, AbortSignal.timeout(8_000)])).then(
              (r) => {
                if (!r) return;
                if ("error" in r) runMark({ t: "error", id: runId, message: r.error });
                else {
                  if (!r.result.code && state.lastScript) r.result.code = state.lastScript;
                  // A result that names no benchmark compares with the one load_prices was asked for (SPY by default).
                  if (!r.result.benchmark) r.result.benchmark = loadsBenchmark(loadsInTurns(tail)) ?? "";
                  state.lastResult = r.result;
                  runMark({ t: "result", id: runId, result: r.result, problems: r.problems });
                }
              },
              () => undefined,
            ),
          );
        } else if (b.type === "text_editor_code_execution_tool_result" && b.content.type === "text_editor_code_execution_tool_result_error") {
          runMark({ t: "stdout", id: state.runId, key: b.tool_use_id, stdout: "", stderr: `File edit failed: ${b.content.error_message ?? b.content.error_code}`, rc: -1 });
        }
      };
      /**
       * Stops this request and hands the client a token to carry on in a new one. After a cut round (lib/desk/resume.ts)
       * the client drops `rewind` characters (a cut word) and the next request joins its text with `joint`.
       * `retry`: the reply failed here; the token is for the member's Retry, not followed at once.
       */
      const handOff = (cut?: Cut, retry = false, waiting?: ToolWait) => {
        // "" when the reply has said nothing yet in any request (its first words then start without a blank line).
        const joint = cut?.follow === "user" ? cut.joint : sent || (resumed ? resumed.joint !== "" : false) ? undefined : "";
        // A hand-off that only waits on a price load still making progress does not count toward MAX_RESUMES.
        const counts = handOffCounts({ waitingOnPrices: waiting?.loaded !== undefined, loadedBefore: resumed?.waiting?.loaded ?? 0, loadedNow: waiting?.loaded ?? 0, free: resumed?.free ?? 0 });
        const free = (resumed?.free ?? 0) + (counts ? 0 : 1);
        const token = signResume({ tail, container: state.container, runId: state.runId, dataFiles: state.dataFiles, files: state.files, n: (resumed?.n ?? 0) + (counts ? 1 : 0), ...(free ? { free } : {}), ...(joint !== undefined ? { joint } : {}), ...(waiting ? { waiting } : {}) }, apiKey, g.userId);
        if (!retry) resumeAt = `${Date.now() - arrived}ms`;
        runMark({ t: "continue", token, ...(cut?.rewind ? { rewind: cut.rewind } : {}), ...(retry ? { retry: true } : {}) });
      };
      /** Whether this reply may carry on in a new request (the member is still there, resumes left). */
      const resumable = () => !devNoResume && canResume({ clientGone: request.signal.aborted, n: resumed?.n ?? 0, max: MAX_RESUMES });
      /**
       * The last request of a strategy test that cannot finish in time: the route writes what ran, its numbers and what
       * did not run (lib/desk/partial.ts), so the reply never ends empty.
       */
      const sayPartial = () => {
        const last = messages[messages.length - 1];
        const asked = Array.isArray(last?.content) ? last.content.map((b) => (b.type === "text" ? b.text : "")).join(" ") : String(last?.content ?? "");
        say(`${sent ? "\n\n" : ""}${partialRunSummary({ turns: [...tail, ...(lastContent ? [{ role: "assistant", content: lastContent }] : [])], result: state.lastResult, lang: replyLanguage(asked), auditTool: AUDIT_TOOL.name })}`);
        sent = true;
        console.info("[api/desk/chat] partial", JSON.stringify({ run: state.runId, resumed: resumed?.n ?? 0 }));
      };
      /** Blocks finished in the round now streaming; `inRound` until that round's turn is final (then the loop below keeps it). */
      let finished = 0;
      let inRound = false;
      /** A round cut mid-stream: its usage counted (the usage event never came) and what can go back to the API put on the tail. */
      const takeCut = (): Cut | undefined => {
        if (!inRound) return undefined;
        inRound = false;
        const snap = stream.currentMessage;
        // Its input as reported at the start, its output estimated from what was streamed (about 4 characters a token).
        if (snap) {
          usage.in += snap.usage.input_tokens;
          usage.cacheRead += snap.usage.cache_read_input_tokens ?? 0;
          usage.cacheWrite += snap.usage.cache_creation_input_tokens ?? 0;
          usage.out += Math.round(JSON.stringify(snap.content).length / 4);
        }
        const cut = cutTurn(snap?.content, finished);
        tail.push(...cutMessages(cut));
        return cut;
      };

      /** Calls of this round still loading at the hand-off (an options history pull): the next request waits on them. */
      const deferred = new Set<string>();
      /**
       * A falcon_* call (lib/desk/tools/falcon.ts): an app action rides on the done line and the client runs it once.
       * falcon_options may buy options data on demand (lib/desk/tools/iv.ts). A history pull reports its points as they
       * load and, when the reply can carry on in a new request, uses the time up to the hand-off; still loading then,
       * its row stays running and the next request waits on it (`deferred`), so the model never has to ask again.
       */
      const runFalconCall = async (b: { id: string; name: string; input: unknown }, remaining: number, timeoutMs: number, since = Date.now()): Promise<DeskToolOutcome> => {
        const label = falconToolLabel(b.name, b.input, "running");
        const history = b.name === IV_TOOL_NAME && (b.input as { detail?: unknown } | null)?.detail === "history";
        const wait = history && resumable();
        const ivMs = history ? IV_HISTORY_TIMEOUT_MS : IV_TIMEOUT_MS;
        const falconMs = b.name !== IV_TOOL_NAME ? timeoutMs : wait ? Math.max(timeoutMs, remaining - HANDOFF_RESERVE_MS) : Math.max(timeoutMs, Math.min(ivMs, remaining - ANSWER_RESERVE_MS));
        const onProgress = history ? (progress: ToolProgress) => mark({ id: b.id, state: "running", label, progress }) : undefined;
        const { action, pending: loading, ...r } = await runFalconTool(b.name, b.input, { app, weights, admin: founderAdmin, signal: ctl.signal, timeoutMs: Math.max(MIN_TOOL_MS, falconMs), onProgress });
        const ms = Date.now() - since;
        if (loading && wait && !ctl.signal.aborted) {
          deferred.add(b.id);
          mark({ id: b.id, state: "running", label, progress: loading });
        } else {
          // Still loading with no next request to wait in: the model reads what to do; the member sees a neutral row, never that text.
          const result = loading ? JSON.stringify({ status: "still loading", loaded: loading.loaded, total: loading.total }) : r.content;
          mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms, result, ...(loading ? { pending: true } : {}), ...(action ? { action } : {}) });
        }
        console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms, ...(loading ? { loading } : {}) }));
        return { ...r, ms };
      };
      /** Tickers loaded by the load_prices calls left loading this request (ToolWait.loaded), by call id. */
      const pricesLoaded = new Map<string, number>();
      /**
       * load_prices (lib/desk/strategy-run.ts). When the reply can carry on in a new request, a big cold load (1,000
       * tickers since 2016) may use the time up to the hand-off: still loading then, its row stays running with its
       * progress and the next request runs the call again (finished tickers come from the cache) before any model round,
       * so the model never has to ask again. Otherwise it has LOAD_TIMEOUT_MS and the model reads what to do.
       */
      const runPricesCall = async (b: { id: string; name: string; input: unknown }, remaining: number, since = Date.now()): Promise<DeskToolOutcome & { fileId?: string }> => {
        const label = loadPricesLabel(b.input, "running");
        // Learn the sandbox's container id while the prices load.
        if (!state.container && !prep.p) prep.p = prepareContainer(client, ctl.signal);
        const wait = resumable();
        const budget = wait ? Math.max(2_000, remaining - HANDOFF_RESERVE_MS) : Math.max(2_000, Math.min(LOAD_TIMEOUT_MS, remaining - 10_000));
        const fetchMs = wait ? Math.max(1_000, budget - LOAD_FILE_RESERVE_MS) : budget;
        // tickers_from_events: the tickers of an earlier load_events file of this reply, filled in here (lib/desk/tools/load-events.ts).
        const ev = withEventTickers(b.input, [...messages, ...tail]);
        const r = ev.error
          ? { ok: false, content: JSON.stringify({ error: ev.error }), label: loadPricesLabel(b.input, "done"), log: `load_prices failed: ${ev.error}`, ms: 0, fileId: undefined, pending: undefined }
          : await runLoadPrices(client, ev.input, AbortSignal.any([ctl.signal, AbortSignal.timeout(budget)]), {
              fetchSignal: AbortSignal.timeout(fetchMs),
              onProgress: (progress) => mark({ id: b.id, state: "running", label, progress }),
            });
        const ms = Date.now() - since;
        if (r.pending && wait && !ctl.signal.aborted) {
          deferred.add(b.id);
          pricesLoaded.set(b.id, r.pending.loaded);
          mark({ id: b.id, state: "running", label, progress: { loaded: r.pending.loaded, total: r.pending.total } });
          runMark({ t: "data", id: state.runId, text: `Loaded ${r.pending.loaded.toLocaleString("en-US")} of ${r.pending.total.toLocaleString("en-US")} tickers; the rest load in the next step.` });
        } else {
          if (r.log) runMark({ t: "data", id: state.runId, text: r.log });
          mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms, result: r.content });
        }
        console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms, ...(r.pending ? { loading: r.pending } : {}) }));
        return { name: b.name, ok: r.ok, content: r.content, label: r.label, ms, fileId: r.fileId };
      };
      /** ToolWait.loaded when every call left loading is a price load (its hand-off may then be free: handOffCounts). */
      const waitLoaded = (ids: Iterable<string>): number | undefined => {
        let sum = 0;
        for (const id of ids) {
          const n = pricesLoaded.get(id);
          if (n === undefined) return undefined;
          sum += n;
        }
        return sum;
      };
      /**
       * A request carrying on from a hand-off with calls still loading (ToolWait): runs them again (they wait on the same
       * pull, with the points loaded so far in the member's row), then the round's results go on the tail and the next
       * round opens. Still loading: hands off again. Returns whether it handed off.
       */
      const resumeWaiting = async (w: ToolWait): Promise<boolean> => {
        const turn = tail[tail.length - 1];
        const uses = (turn?.role === "assistant" && Array.isArray(turn.content) ? turn.content : []).filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
        srcOf = assignSourceIds(messages as Turn[], tail as Turn[], srcBase);
        const remaining = deadlineMs - (Date.now() - arrived);
        const fresh = new Map<string, DeskToolOutcome>();
        const uploads: string[] = [];
        await Promise.all(
          uses
            .filter((b) => w.ids.includes(b.id) && (isFalconTool(b.name) || b.name === LOAD_PRICES_TOOL.name))
            .map(async (b) => {
              if (b.name === LOAD_PRICES_TOOL.name) {
                mark({ id: b.id, state: "running", label: loadPricesLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                const { fileId, ...r } = await runPricesCall(b, remaining, w.since);
                if (fileId) {
                  uploads.push(fileId);
                  state.dataFiles.push(fileId);
                }
                fresh.set(b.id, r);
                return;
              }
              mark({ id: b.id, state: "running", label: falconToolLabel(b.name, b.input, "running"), ...deskToolCommand(b.name, b.input) });
              fresh.set(b.id, await runFalconCall(b, remaining, TOOL_TIMEOUT_MS, w.since));
            }),
        );
        if (prep.p) {
          const p = await prep.p;
          state.container = p.id ?? state.container;
          usage.in += p.usage.in;
          usage.out += p.usage.out;
          prep.p = null;
        }
        if (ctl.signal.aborted && !late) throw new Error("aborted");
        tools += fresh.size;
        const prior = new Map(w.results.flatMap((x) => (x.type === "tool_result" ? [[x.tool_use_id, x] as const] : [])));
        const results: Anthropic.Beta.BetaContentBlockParam[] = [
          ...uses.flatMap((b): Anthropic.Beta.BetaContentBlockParam[] => {
            if (deferred.has(b.id)) return [];
            const f = fresh.get(b.id);
            if (f) return [{ type: "tool_result", tool_use_id: b.id, content: withSourceId(srcOf.get(b.id), f.content), is_error: !f.ok }];
            return [prior.get(b.id) ?? { type: "tool_result", tool_use_id: b.id, content: JSON.stringify({ error: "no result" }), is_error: true }];
          }),
          ...w.results.filter((x) => x.type !== "tool_result"),
          ...uploads.map((file_id) => ({ type: "container_upload" as const, file_id })),
        ];
        if (deferred.size) {
          const loaded = waitLoaded(deferred);
          handOff(undefined, false, { ids: [...deferred], results, since: w.since, ...(loaded !== undefined ? { loaded } : {}) });
          return true;
        }
        tail.push({ role: "user", content: results });
        // Too little time left to answer well (or the deadline passed): the next request answers with a full budget.
        if ((late || deadlineMs - (Date.now() - arrived) < ANSWER_RESERVE_MS) && resumable()) {
          handOff();
          return true;
        }
        await openRound(false);
        return false;
      };

      try {
        let answerNow = false;
        // Carrying on from a hand-off with a tool call still loading: wait on it first (no model round until it is in).
        const waited = resumed?.waiting ? await resumeWaiting(resumed.waiting) : false;
        if (waited) stop = "resume";
        for (let round = 0; !waited; round++) {
          rounds = round + 1;
          // A new round's text starts a new paragraph; a resumed reply's first text (in whichever round it comes) joins the
          // text kept from the cut round (resumed.joint), or starts a new paragraph (the text before it came in the previous request).
          let lead = !sent && g.body.resume !== undefined ? (resumed?.joint ?? "\n\n") : sent && !endsClean ? "\n\n" : "";
          finished = 0;
          inRound = true;
          drafts.clear();
          try {
            for (let r = first ?? (await events.next()); !r.done; r = await events.next()) {
              const event = r.value;
              if (event.type === "content_block_start") {
                const cb = event.content_block;
                if (cb.type === "fallback") fallback = true;
                // Result blocks arrive whole in their start event.
                else if (isServerResult(cb.type)) onServerResult(cb);
                // A code-execution call starts: what it writes streams to its card (sendDraft).
                else if (cb.type === "server_tool_use" && (cb.name === "text_editor_code_execution" || cb.name === "bash_code_execution")) {
                  beginRun();
                  drafts.set(event.index, { key: cb.id, tool: cb.name === "bash_code_execution" ? "bash" : "editor", json: "", sent: "", last: 0 });
                }
              } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
                const d = drafts.get(event.index);
                if (d) {
                  d.json += event.delta.partial_json;
                  if (Date.now() - d.last >= DRAFT_MS) sendDraft(d);
                }
              } else if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
                if (firstMs === null) firstMs = Date.now() - arrived;
                const text = lead ? joinResumed(lead, event.delta.text) : event.delta.text;
                lead = "";
                sent = true;
                endsClean = /\s$/.test(text);
                say(text);
              } else if (event.type === "content_block_stop") {
                finished = event.index + 1;
                const b = stream.currentMessage?.content[event.index];
                drafts.delete(event.index);
                if (b?.type === "server_tool_use") onServerToolUse(b);
              } else if (event.type === "message_delta" && event.delta.container) {
                state.container = event.delta.container.id;
              }
            }
          } catch (error) {
            // Cut off at the deadline mid-round (a long answer, a long script, long thinking): keep what was finished and
            // the text written so far, and carry on in a new request. Any reply, not only a strategy test.
            if (!(late && resumable())) throw error;
            const cut = takeCut();
            await Promise.all(pending);
            stop = "resume";
            handOff(cut);
            break;
          }
          first = null;
          const msg = await stream.finalMessage();
          inRound = false;
          model = msg.model;
          stop = msg.stop_reason;
          if (msg.container?.id) state.container = msg.container.id;
          usage.in += msg.usage.input_tokens;
          usage.out += msg.usage.output_tokens;
          usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
          usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
          // After a fallback hop, only what the fallback model produced counts (the declined part is left out).
          const lastHop = msg.content.map((b) => b.type).lastIndexOf("fallback");
          const content = lastHop >= 0 ? msg.content.slice(lastHop) : msg.content;
          lastContent = content;

          // A long code execution turn paused by the API: send it back as it is and let it carry on.
          if (msg.stop_reason === "pause_turn") {
            tail.push({ role: "assistant", content });
            if (deadlineMs - (Date.now() - arrived) < RUN_ROUND_MIN_MS) {
              await Promise.all(pending);
              if (!resumable() && !request.signal.aborted && state.runId) {
                // The reply's last request: no new request can carry the script on, so say where it got to.
                sayPartial();
                stop = "partial";
                break;
              }
              stop = "resume";
              handOff();
              break;
            }
            await openRound(false);
            continue;
          }
          // Only a finished tool_use turn runs tools: never on refusal or max_tokens.
          if (msg.stop_reason !== "tool_use" || answerNow) break;
          const calls = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          if (!calls.length) break;
          // The member stopped (or the deadline passed) while the round streamed: no tool runs, nothing more is spent.
          if (ctl.signal.aborted && !(late && resumable())) throw new Error(late ? "timeout" : "aborted");
          if (late) {
            // The deadline passed as the round ended: its text goes back, its tool calls are made again in the next request.
            const cut = cutTurn(msg.content, msg.content.length);
            tail.push(...cutMessages(cut));
            await Promise.all(pending);
            stop = "resume";
            handOff(cut);
            break;
          }

          const remaining = deadlineMs - (Date.now() - arrived);
          const timeoutMs = Math.min(TOOL_TIMEOUT_MS, remaining - ANSWER_RESERVE_MS);
          const outOfTime = timeoutMs < MIN_TOOL_MS;
          // Too little time left to run this round's tools well (a desk lookup under MIN_TOOL_MS, an on-demand options pull
          // or /flow under SLOW_TOOL_MIN_MS): rather than "out of time" or timed-out results, the round's text goes back and
          // the next request (a full budget) makes the calls again. Not in a request's first round: the next request would
          // be no better off.
          const starved = toolsStarved(
            calls.map((b) => b.name),
            remaining - ANSWER_RESERVE_MS,
            { slow: [IV_TOOL_NAME, "flow"], slowMs: SLOW_TOOL_MIN_MS, minMs: MIN_TOOL_MS },
          );
          if (starved && round > 0 && resumable() && !calls.some((b) => b.name === ASK_USER_TOOL.name)) {
            const cut = cutTurn(msg.content, msg.content.length);
            tail.push(...cutMessages(cut));
            await Promise.all(pending);
            stop = "resume";
            handOff(cut);
            break;
          }
          tools += calls.length;
          const uploads: string[] = [];
          // ask_user: the first valid call ends the reply after this round (its result comes with the member's answer); the others get an error now.
          const ask = pickAsk(calls);
          deferred.clear();
          srcOf = assignSourceIds(messages as Turn[], [...tail, { role: "assistant", content }] as Turn[], srcBase);
          const toolsSince = Date.now();
          const outcomes = await Promise.all(
            calls.map(async (b) => {
              if (b.name === ASK_USER_TOOL.name) return askOutcome(b.id, ask);
              if (b.name === LOAD_EVENTS_TOOL.name) {
                // Falcon's historical events in bulk (lib/desk/tools/load-events.ts): one gzipped CSV into the sandbox, like load_prices.
                beginRun();
                mark({ id: b.id, state: "running", label: loadEventsLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                if (!state.container && !prep.p) prep.p = prepareContainer(client, ctl.signal);
                const budget = Math.max(2_000, Math.min(LOAD_TIMEOUT_MS, remaining - 10_000));
                const r = await runLoadEvents(client, b.input, AbortSignal.any([ctl.signal, AbortSignal.timeout(budget)]));
                if (r.fileId) {
                  uploads.push(r.fileId);
                  state.dataFiles.push(r.fileId);
                }
                if (r.log) runMark({ t: "data", id: state.runId, text: r.log });
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content });
                console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms }));
                return { name: b.name, ok: r.ok, content: r.content, label: r.label, ms: r.ms } satisfies DeskToolOutcome;
              }
              if (b.name === LOAD_GRAPH_TOOL.name) {
                // The point-in-time filing graph in bulk (lib/desk/tools/load-graph.ts): one gzipped CSV into the sandbox, like load_events.
                beginRun();
                mark({ id: b.id, state: "running", label: loadGraphLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                if (!state.container && !prep.p) prep.p = prepareContainer(client, ctl.signal);
                const budget = Math.max(2_000, Math.min(LOAD_TIMEOUT_MS, remaining - 10_000));
                const r = await runLoadGraph(client, b.input, AbortSignal.any([ctl.signal, AbortSignal.timeout(budget)]));
                if (r.fileId) {
                  uploads.push(r.fileId);
                  state.dataFiles.push(r.fileId);
                }
                if (r.log) runMark({ t: "data", id: state.runId, text: r.log });
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content });
                console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms }));
                return { name: b.name, ok: r.ok, content: r.content, label: r.label, ms: r.ms } satisfies DeskToolOutcome;
              }
              if (b.name === LOAD_PRICES_TOOL.name) {
                beginRun();
                mark({ id: b.id, state: "running", label: loadPricesLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                // A load still going at the hand-off is finished by the next request (runPricesCall, `deferred`).
                const { fileId, ...r } = await runPricesCall(b, remaining);
                if (fileId) {
                  uploads.push(fileId);
                  state.dataFiles.push(fileId);
                }
                return r satisfies DeskToolOutcome;
              }
              if (b.name === EVENT_BACKTEST_TOOL.name) {
                // An event test from declared rules (lib/desk/event-backtest-run.ts): Falcon's helper runs in the sandbox, not a model-written script.
                beginRun();
                mark({ id: b.id, state: "running", label: eventBacktestLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                // Too little time for the run: asked again in the next request (at most once a reply, while it can still resume).
                if (remaining < EVENT_MIN_MS && !JSON.stringify(tail).includes(EVENT_DEFER_TEXT) && (resumed?.n ?? 0) + 1 < MAX_RESUMES) {
                  auditDeferred = true;
                  const content = JSON.stringify({ error: EVENT_DEFER_TEXT });
                  mark({ id: b.id, state: "done", label: "Event test continues in the next step", ok: true, ms: 0, result: content });
                  return { name: b.name, ok: true, content, label: "Event test continues in the next step", ms: 0 } satisfies DeskToolOutcome;
                }
                await Promise.all(pending);
                const r = await runEventBacktestTool({ client, container: state.container, input: b.input, turns: [...messages, ...tail], budgetMs: Math.max(8_000, remaining - 5_000), signal: ctl.signal });
                if (r.script) showScript(r.script.path, r.script.code, { key: b.id, kind: "falcon" });
                if (r.command) runMark({ t: "command", id: state.runId, command: r.command.slice(0, 4_000) });
                if (r.stdout) runMark({ t: "stdout", id: state.runId, key: b.id, ...r.stdout });
                if (r.log) runMark({ t: "data", id: state.runId, text: r.log });
                if (r.result) {
                  state.lastResult = r.result;
                  runMark({ t: "result", id: state.runId, result: r.result, problems: r.problems ?? [] });
                }
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content });
                extraUsd += r.usd;
                console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms, usd: Number(r.usd.toFixed(4)) }));
                return { name: b.name, ok: r.ok, content: r.content, label: r.label, ms: r.ms } satisfies DeskToolOutcome;
              }
              if (b.name === AUDIT_TOOL.name) {
                // The independent audit (lib/desk/audit-run.ts): it needs a fresh request's time, so with too little left it asks to be called again (the reply then resumes).
                beginRun();
                mark({ id: b.id, state: "running", label: "Auditing the test", ...deskToolCommand(b.name, b.input) });
                // Deferred at most once a reply (and only while it can still resume): then it runs with the time there is.
                if (remaining < AUDIT_MIN_MS && !JSON.stringify(tail).includes(AUDIT_DEFER_TEXT) && (resumed?.n ?? 0) + 1 < MAX_RESUMES) {
                  auditDeferred = true;
                  const content = JSON.stringify({ error: AUDIT_DEFER_TEXT });
                  mark({ id: b.id, state: "done", label: "Audit continues in the next step", ok: true, ms: 0, result: content });
                  return { name: b.name, ok: true, content, label: "Audit continues in the next step", ms: 0 } satisfies DeskToolOutcome;
                }
                await Promise.all(pending);
                // Re-runs a slow script could not finish here continue in the next request (saved in the sandbox; lib/desk/audit-run.ts shouldContinue).
                const canContinue = (resumed?.n ?? 0) + 1 < MAX_RESUMES;
                const r = await runAuditTool({ client, container: state.container, input: b.input, files: state.files, lastScript: state.lastScript, result: state.lastResult, tail, messages, budgetMs: Math.max(8_000, remaining - 5_000), signal: ctl.signal, canContinue });
                if (r.continued) auditDeferred = true;
                if (r.audit) runMark({ t: "audit", id: state.runId, audit: r.audit });
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content });
                extraUsd += r.usd;
                console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms, usd: Number(r.usd.toFixed(4)) }));
                return { name: b.name, ok: r.ok, content: r.content, label: r.label, ms: r.ms } satisfies DeskToolOutcome;
              }
              if (MEMORY_TOOL_NAMES.includes(b.name)) {
                // remember / forget (lib/desk/tools/memory.ts): the client applies `memory` from the done line.
                mark({ id: b.id, state: "running", label: memoryLabel(b.name, b.input), ...deskToolCommand(b.name, b.input) });
                const { event, ...r } = runMemoryTool(b.name, b.input, memory);
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content, ...(event ? { memory: event } : {}) });
                return r satisfies DeskToolOutcome;
              }
              if (b.name === EVENTS_TOOL.name) {
                // Historical earnings reactions (lib/desk/tools/events.ts): Falcon's own table, read-only.
                mark({ id: b.id, state: "running", label: eventsLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                const r = await runEventsTool(b.input, { signal: ctl.signal, timeoutMs: Math.max(MIN_TOOL_MS, timeoutMs) });
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content });
                console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms }));
                return r;
              }
              if (b.name === SCOREBOARD_TOOL.name) {
                // Falcon vs the options market (lib/desk/tools/scoreboard.ts): Falcon's own tables, read-only.
                mark({ id: b.id, state: "running", label: scoreboardLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                const r = await runScoreboardTool(b.input, { signal: ctl.signal, timeoutMs: Math.max(MIN_TOOL_MS, timeoutMs) });
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content });
                console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms }));
                return r;
              }
              if (b.name === CHART_TOOL.name) {
                // A chart (lib/desk/tools/chart.ts): the client draws `chart` where this call sits in the reply.
                mark({ id: b.id, state: "running", label: chartLabel(b.input, "running"), ...deskToolCommand(b.name, b.input) });
                const { chart, ...r } = await runChartTool(b.input, { signal: ctl.signal, timeoutMs: Math.max(MIN_TOOL_MS, timeoutMs) });
                mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content, ...(chart ? { chart } : {}) });
                console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms }));
                return r satisfies DeskToolOutcome;
              }
              if (isFalconTool(b.name)) {
                // Falcon's own data and the app actions (lib/desk/tools/falcon.ts): an action rides on the done line and the client runs it once.
                mark({ id: b.id, state: "running", label: falconToolLabel(b.name, b.input, "running"), ...deskToolCommand(b.name, b.input) });
                return runFalconCall(b, remaining, timeoutMs);
              }
              mark({ id: b.id, state: "running", label: deskToolLabel(b.name, b.input, "running"), ...deskToolCommand(b.name, b.input) });
              const r: DeskToolOutcome = outOfTime
                ? { name: b.name, ok: false, content: JSON.stringify({ error: "out of time" }), label: deskToolLabel(b.name, b.input, "done"), ms: 0 }
                : await runDeskTool(b.name, b.input, { signal: ctl.signal, timeoutMs: b.name === "flow" ? Math.max(timeoutMs, Math.min(FLOW_TIMEOUT_MS, remaining - ANSWER_RESERVE_MS)) : timeoutMs });
              mark({ id: b.id, state: "done", label: r.label, ok: r.ok, ms: r.ms, result: r.content });
              // Inputs are tickers, forms and filing URLs, never member data.
              console.info("[api/desk/chat] tool", JSON.stringify({ name: b.name, ok: r.ok, ms: r.ms }));
              return r;
            }),
          );
          if (prep.p) {
            const p = await prep.p;
            state.container = p.id ?? state.container;
            usage.in += p.usage.in;
            usage.out += p.usage.out;
            prep.p = null;
          }
          if (ctl.signal.aborted && !late) throw new Error("aborted");
          // The deadline passed while tools ran: their results (a cut one as an error) go back and the reply carries on in a new request.
          const toolsCut = late;
          // The assistant turn goes back unchanged (thinking blocks included), then all results in one user message;
          // uploaded price files ride along so they appear in the sandbox.
          tail.push({ role: "assistant", content });
          const results = [
            ...calls.map((b, i) => ({ type: "tool_result" as const, tool_use_id: b.id, content: withSourceId(srcOf.get(b.id), outcomes[i].content), is_error: !outcomes[i].ok })),
            ...uploads.map((file_id) => ({ type: "container_upload" as const, file_id })),
          ];
          // A history pull still loading (runFalconCall): the round's other results ride in the token and the next request waits on it.
          if (deferred.size && !ask.chosen && !toolsCut) {
            await Promise.all(pending);
            stop = "resume";
            const loaded = waitLoaded(deferred);
            handOff(undefined, false, { ids: [...deferred], results: results.filter((x) => x.type !== "tool_result" || !deferred.has(x.tool_use_id)), since: toolsSince, ...(loaded !== undefined ? { loaded } : {}) });
            break;
          }
          // Calls left loading go back as they are (the model reads what to do); their rows end neutral.
          for (const b of calls) if (deferred.has(b.id)) mark({ id: b.id, state: "done", label: b.name === LOAD_PRICES_TOOL.name ? loadPricesLabel(b.input, "done") : falconToolLabel(b.name, b.input, "done"), ok: false, pending: true, ms: Date.now() - toolsSince, result: JSON.stringify({ status: "still loading" }) });
          // The member is asked: the reply ends here with the card; its signed token holds this turn and the round's other results.
          if (ask.chosen) {
            await Promise.all(pending);
            const token = signAsk({ tail, results, askId: ask.chosen.id, questions: ask.chosen.questions, container: state.container, runId: state.runId, dataFiles: state.dataFiles, files: state.files, n: resumed?.n ?? 0 }, apiKey, g.userId);
            runMark({ t: "ask", id: ask.chosen.id, questions: ask.chosen.questions, token });
            stop = "ask";
            break;
          }
          tail.push({ role: "user", content: results });
          if (toolsCut) {
            if (!resumable()) throw new Error("timeout");
            await Promise.all(pending);
            stop = "resume";
            handOff();
            break;
          }
          const left = deadlineMs - (Date.now() - arrived);
          // A strategy test with too little time for its next round carries on in a new request.
          if (state.runId && (left < RUN_ROUND_MIN_MS || auditDeferred) && (resumed?.n ?? 0) + 1 < MAX_RESUMES) {
            await Promise.all(pending);
            stop = "resume";
            handOff();
            break;
          }
          // Tool rounds of this whole reply (the tail carries over a resume). After the cap, one more round answers in text,
          // so tools of the last tool round (a chart) still run and nothing pending is lost.
          const toolRounds = tail.filter((m) => m.role === "assistant").length;
          const short = !state.runId && (outOfTime || left - ANSWER_RESERVE_MS < MIN_TOOL_MS + 4_000);
          // A research reply out of time but not out of rounds carries on in a new request (same resume as a strategy test).
          if (short && toolRounds < MAX_TOOL_ROUNDS && (resumed?.n ?? 0) + 1 < MAX_RESUMES && !request.signal.aborted) {
            stop = "resume";
            handOff();
            break;
          }
          // The reply's last request (no hand-off left) with too little time for another test round: answer now in text,
          // saying what ran and what did not (FINAL_NOTE), rather than be cut off with nothing.
          const finalStretch = !!state.runId && !resumable() && !request.signal.aborted && (left < RUN_ROUND_MIN_MS + ANSWER_RESERVE_MS || auditDeferred);
          if (finalStretch) {
            const turn = tail[tail.length - 1];
            if (turn?.role === "user" && Array.isArray(turn.content)) turn.content.push({ type: "text", text: FINAL_NOTE });
          }
          answerNow = toolRounds >= MAX_TOOL_ROUNDS || short || finalStretch;
          await openRound(answerNow);
        }
        await Promise.all(pending);
        // The reply is complete (not handed off): every citation checked against this reply's tool results (no model call).
        if (stop !== "resume") {
          const turns = (lastContent && !tail.some((m) => m.content === lastContent) ? [...tail, { role: "assistant" as const, content: lastContent }] : tail) as Turn[];
          try {
            const report = checkReply(replyText(turns), buildRegistry(messages as Turn[], turns, srcBase, (name, input) => deskToolCommand(name, input).cmd));
            runMark({ t: "cites", report });
            console.info("[api/desk/chat] cites", JSON.stringify(report.stats));
          } catch (error) {
            console.warn("[api/desk/chat] cites failed", logLine(error));
          }
        }
        if (stop !== "resume" && stop !== "ask" && state.runId) {
          runMark({ t: "finished", id: state.runId });
          // The price files are only needed while this reply runs.
          await Promise.race([Promise.allSettled(state.dataFiles.map((id) => client.files.delete(id))), new Promise((r) => setTimeout(r, 1_500))]);
        }
        record();
        console.info(
          "[api/desk/chat]",
          JSON.stringify({ model, stop, fallback, images, turns: messages.length, resumed: resumed?.n ?? 0, run: state.runId, rounds, tools, retries, guardMs, startMs, firstMs, resumeAt, totalMs: Date.now() - arrived, usage, usd: Number(cost(usage).toFixed(4)) }),
        );
        if (stop === "refusal") say(`${ERROR_MARK}${sent ? "This answer was stopped. Try asking another way." : "I can't help with that one. Try asking another way."}`);
        else if (stop === "max_tokens") say(" …\n\n_The answer reached its length limit. Ask me to continue._");
      } catch (error) {
        // The viewer stopped it or went away: nothing to say and nowhere to say it.
        if (request.signal.aborted || (ctl.signal.aborted && !late)) {
          takeCut();
          record();
          console.info("[api/desk/chat]", JSON.stringify({ stop: "client_abort", rounds, tools, guardMs, firstMs, totalMs: Date.now() - arrived, usage, usd: Number(cost(usage).toFixed(4)) }));
          return;
        }
        // The deadline passed on the last request of a strategy test (no hand-off left): what ran, instead of only an error.
        if (late && !resumable() && state.runId && !request.signal.aborted && !devNoResume) {
          takeCut();
          record();
          await Promise.all(pending).catch(() => undefined);
          sayPartial();
          runMark({ t: "finished", id: state.runId });
          void Promise.allSettled(state.dataFiles.map((id) => client.files.delete(id)));
          console.info("[api/desk/chat]", JSON.stringify({ model, stop: "partial", resumed: resumed?.n ?? 0, run: state.runId, rounds, tools, retries, guardMs, firstMs, totalMs: Date.now() - arrived, usage, usd: Number(cost(usage).toFixed(4)) }));
          return;
        }
        // The deadline passed between rounds (a slow start of the next round, a download past its budget): carry on in a new request.
        if (late && resumable()) {
          const cut = takeCut();
          record();
          await Promise.all(pending).catch(() => undefined);
          stop = "resume";
          handOff(cut);
          console.info("[api/desk/chat]", JSON.stringify({ model, stop, resumed: resumed?.n ?? 0, run: state.runId, rounds, tools, retries, guardMs, firstMs, resumeAt, totalMs: Date.now() - arrived, usage, usd: Number(cost(usage).toFixed(4)) }));
          return;
        }
        const f = failure(error);
        // What can go back (lib/desk/resume.ts): with a token, the member's Retry carries on from here instead of starting over.
        const cut = takeCut();
        record();
        const retryable = tail.length > 0 && (resumed?.n ?? 0) + 1 < MAX_RESUMES;
        console.error("[api/desk/chat]", JSON.stringify({ error: f.log, run: state.runId, rounds, tools, retries, guardMs, firstMs, retryable, totalMs: Date.now() - arrived, usage, usd: Number(cost(usage).toFixed(4)) }));
        if (state.runId) runMark({ t: "error", id: state.runId, message: f.kind === "timeout" ? "The test was cut off at the time limit." : "The test stopped because Falcon AI failed." });
        if (retryable) handOff(cut, true);
        say(`${ERROR_MARK}${streamFailure(f.kind, sent, retryable)}`);
      } finally {
        clearInterval(heartbeat);
        done();
        try {
          controller.close();
        } catch {
          // already closed by a cancel
        }
      }
    },
    cancel() {
      ctl.abort();
      current?.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { ...corsHeaders(g.origin), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
