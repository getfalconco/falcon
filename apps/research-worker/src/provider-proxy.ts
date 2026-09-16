import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { bearerFrom, resolveUser, type AuthedUser } from "./auth.js";
import { falconError } from "./errors.js";
import { rateLimit } from "./rate-limit.js";

/**
 * Provider proxies for the packaged desktop app.
 *
 * A distributed Falcon.exe must not carry provider keys, yet its in-process
 * engines (tracker, classifier, gloss, risk, screen, …) talk to Anthropic and
 * Finnhub directly. Instead of rewriting every engine, the desktop points the
 * Anthropic SDK at `/api/anthropic` (via ANTHROPIC_BASE_URL) and every Finnhub
 * call at `/api/finnhub` (via FINNHUB_BASE_URL), and uses the signed-in user's
 * Supabase JWT as the "api key". These handlers verify that JWT the same way
 * every other route does, swap in the real key, and forward the request.
 *
 * Both are strict allow-lists — only the endpoints Falcon's engines use — and
 * both are metered per user so one account cannot drain the budget.
 */

const ANTHROPIC_DIRECT = "https://api.anthropic.com";
const FINNHUB_UPSTREAM = "https://finnhub.io/api/v1";

/**
 * Where this service sends Anthropic traffic: the gateway named by
 * ANTHROPIC_BASE_URL when one is configured, else Anthropic itself. The same
 * variable the SDK reads for this service own calls, so the proxy and step1
 * can never disagree about which provider the key belongs to.
 *
 * A value pointing back at this proxy is ignored — that would loop forever.
 */
export function anthropicUpstream(): string {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  if (!configured) return ANTHROPIC_DIRECT;
  if (/\/api\/anthropic$/i.test(configured)) {
    console.warn("[proxy] ANTHROPIC_BASE_URL points at this proxy — ignoring it and calling Anthropic directly");
    return ANTHROPIC_DIRECT;
  }
  return configured;
}

/** "sk-ant-…" belongs to Anthropic; anything else only works against a gateway. */
export function anthropicKeyKind(): "anthropic" | "gateway" | "missing" {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return "missing";
  return key.startsWith("sk-ant-") ? "anthropic" : "gateway";
}

/** Anthropic paths the engines call. Nothing else is forwarded. */
const ANTHROPIC_ALLOWED = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

/** Finnhub paths the engines call (see packages/research/src/finnhub.ts users). */
const FINNHUB_ALLOWED = new Set([
  "/quote",
  "/company-news",
  "/stock/profile2",
  "/stock/candle",
  "/calendar/earnings",
  "/calendar/economic",
]);

/** Per-user budgets. Generous for a single desktop; tight enough to contain abuse. */
const ANTHROPIC_LIMIT = { limit: 120, windowMs: 60_000 };
const FINNHUB_LIMIT = { limit: 240, windowMs: 60_000 };

/** Hop-by-hop + host-specific headers we never forward in either direction. */
const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "authorization",
  "x-api-key",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "x-railway-request-id",
]);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The user's JWT may arrive three ways, depending on which client put it there:
 * `Authorization: Bearer` (our own clients), `x-api-key` (the Anthropic SDK),
 * or `?token=` (Finnhub's query-string convention).
 */
function tokenFrom(req: IncomingMessage, url: URL): string | null {
  const bearer = bearerFrom(req);
  if (bearer) return bearer;
  const apiKey = req.headers["x-api-key"];
  const fromHeader = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (fromHeader?.trim()) return fromHeader.trim();
  const fromQuery = url.searchParams.get("token")?.trim();
  return fromQuery || null;
}

async function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<AuthedUser | null> {
  const token = tokenFrom(req, url);
  if (!token) {
    sendJson(res, 401, { error: falconError("FAL-AUTH-01") });
    return null;
  }
  const user = await resolveUser(token);
  if (!user) {
    sendJson(res, 401, { error: falconError("FAL-AUTH-02") });
    return null;
  }
  if (!user.approved) {
    sendJson(res, 403, { error: falconError("FAL-AUTH-03") });
    return null;
  }
  return user;
}

function forwardHeaders(req: IncomingMessage): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (STRIP_HEADERS.has(name.toLowerCase()) || value == null) continue;
    out.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return out;
}

/** Copies the upstream reply (status, headers, body — streamed) to the client. */
async function relay(res: ServerResponse, upstream: Response): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (STRIP_HEADERS.has(name.toLowerCase())) return;
    if (name.toLowerCase() === "content-encoding") return; // fetch already decoded
    headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const stream = Readable.fromWeb(upstream.body as never);
    stream.on("error", () => res.end());
    res.on("close", () => stream.destroy());
    stream.pipe(res).on("finish", resolve).on("close", resolve);
  });
}

function upstreamFailure(res: ServerResponse, provider: string, err: unknown): void {
  console.warn(`[proxy] ${provider} upstream failed:`, err instanceof Error ? err.message : err);
  sendJson(res, 502, { error: falconError("FAL-NET-01") });
}

/* ------------------------------ Anthropic -------------------------------- */

export async function handleAnthropicProxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  subpath: string,
): Promise<void> {
  if (req.method !== "POST" || !ANTHROPIC_ALLOWED.has(subpath)) {
    sendJson(res, 404, { error: falconError("FAL-JOB-01", "That endpoint does not exist.") });
    return;
  }
  const user = await authenticate(req, res, url);
  if (!user) return;

  const rl = rateLimit(`anthropic:${user.id}`, ANTHROPIC_LIMIT);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    sendJson(res, 429, { error: falconError("FAL-REQ-01", "You're going too fast. Please wait a moment and try again.") });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    sendJson(res, 503, { error: falconError("FAL-AI-01") });
    return;
  }

  // A gateway key sent to api.anthropic.com is a guaranteed 401 whose message
  // blames the key ("API key is invalid") rather than the missing route, which
  // is what makes this misconfiguration expensive to diagnose. Say it plainly,
  // in the log where it can be fixed, instead of relaying the confusing answer.
  const upstreamBase = anthropicUpstream();
  if (upstreamBase === ANTHROPIC_DIRECT && anthropicKeyKind() === "gateway") {
    console.error(
      "[proxy] ANTHROPIC_API_KEY is not an Anthropic key (no sk-ant- prefix) and ANTHROPIC_BASE_URL is unset — " +
        "set ANTHROPIC_BASE_URL to the gateway this key belongs to.",
    );
    sendJson(res, 503, {
      error: falconError("FAL-AI-01", "Falcon is not configured to reach the model right now."),
    });
    return;
  }

  const headers = forwardHeaders(req);
  headers.set("x-api-key", apiKey);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  headers.set("content-type", "application/json");

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: falconError("FAL-REQ-01") });
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamBase}${subpath}`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
  } catch (err) {
    upstreamFailure(res, "anthropic", err);
    return;
  }
  await relay(res, upstream);
}

/* ------------------------------- Finnhub --------------------------------- */

export async function handleFinnhubProxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  subpath: string,
): Promise<void> {
  if (req.method !== "GET" || !FINNHUB_ALLOWED.has(subpath)) {
    sendJson(res, 404, { error: falconError("FAL-JOB-01", "That endpoint does not exist.") });
    return;
  }
  const user = await authenticate(req, res, url);
  if (!user) return;

  const rl = rateLimit(`finnhub:${user.id}`, FINNHUB_LIMIT);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    sendJson(res, 429, { error: "rate limited" });
    return;
  }

  const token = process.env.FINNHUB_API_KEY?.trim();
  if (!token) {
    sendJson(res, 503, { error: "Finnhub is not configured on the server." });
    return;
  }

  const target = new URL(`${FINNHUB_UPSTREAM}${subpath}`);
  url.searchParams.forEach((value, name) => {
    if (name === "token") return;
    target.searchParams.append(name, value);
  });
  target.searchParams.set("token", token);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    });
  } catch (err) {
    upstreamFailure(res, "finnhub", err);
    return;
  }
  await relay(res, upstream);
}
