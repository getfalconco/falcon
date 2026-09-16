import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { getConfig } from "@meridian/research";
import {
  getJobStatus,
  getResearchResult,
  startResearchJob,
} from "@meridian/research/step1";
import { persistGraphToSupabase } from "@meridian/research/propagation";
import { applyCors, lookupUserById, requireApprovedUser, resolveUserFromReq, type AuthedUser } from "./auth.js";
import { formatRetryAfter, researchQuotaFor } from "./research-quota.js";
import { clientIp, rateLimit } from "./rate-limit.js";
import { reportFalconError } from "./discord-error-log.js";
import {
  createJob,
  getJob,
  getLatestJobForTicker,
  isJobStoreConfigured,
  listJobs,
  updateJob,
  type JobRow,
} from "./jobs-store.js";
import { classifyEngineError, falconError, type FalconCode, type FalconError } from "./errors.js";
import { loadEnvFile } from "./loadEnv.js";
import { edgesFromStep1Result } from "./step1-graph.js";
import {
  anthropicKeyKind,
  anthropicUpstream,
  handleAnthropicProxy,
  handleFinnhubProxy,
} from "./provider-proxy.js";
import { handleOnboardingSubmit } from "./onboarding.js";
import {
  disconnectBrokerage,
  getBrokerageNetWorth,
  getConnectionUrl,
  isSnaptradeConfigured,
  listBrokerages,
} from "./brokerage.js";

loadEnvFile();

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

type ErrorNotifyCtx = {
  user?: AuthedUser | null;
  ticker?: string | null;
  /** Force a Discord post on 4xx (e.g. FAL-SEC-01). AUTH/REQ codes still skip. */
  notify?: boolean;
};

function notifyFalconError(
  error: FalconError,
  ctx?: { user?: AuthedUser | null; ticker?: string | null },
): void {
  reportFalconError({
    code: error.code,
    message: error.message,
    user: ctx?.user
      ? { email: ctx.user.email, displayName: ctx.user.displayName }
      : null,
    ticker: ctx?.ticker,
  });
}

/** Prefer the authed JWT user; fall back to a service-role lookup by job `user_id`. */
async function notifyJobError(
  error: FalconError,
  ctx: { user?: AuthedUser | null; userId?: string | null; ticker?: string | null },
): Promise<void> {
  let user = ctx.user ?? null;
  if ((!user?.email || !user.displayName) && (user?.id || ctx.userId)) {
    user = (await lookupUserById(user?.id ?? ctx.userId ?? "")) ?? user;
  }
  notifyFalconError(error, { user, ticker: ctx.ticker });
}

function sendError(
  res: ServerResponse,
  status: number,
  error: FalconError,
  ctx?: ErrorNotifyCtx,
): void {
  sendJson(res, status, { error });
  if (ctx?.notify || status >= 500) {
    void notifyJobError(error, ctx ?? {});
  }
}

function sendCode(
  res: ServerResponse,
  status: number,
  code: FalconCode,
  ctx?: ErrorNotifyCtx,
): void {
  sendError(res, status, falconError(code), ctx);
}

/**
 * Per-user quota on the paid LLM routes so a single approved (or compromised)
 * account can't drain the Anthropic/OpenAI/Perplexity budget. Returns true when
 * the request may proceed; otherwise writes a 429 and returns false. FAL-REQ-*
 * is intentionally excluded from the Discord error log, so this won't spam it.
 */
function withinUserRate(
  res: ServerResponse,
  user: AuthedUser,
  name: string,
  opts: { limit: number; windowMs: number },
): boolean {
  const rl = rateLimit(`${name}:${user.id}`, opts);
  if (rl.ok) return true;
  sendError(
    res,
    429,
    falconError("FAL-REQ-01", "You're going too fast. Please wait a moment and try again."),
    { user },
  );
  return false;
}

async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    sendCode(res, 400, "FAL-REQ-01");
    return null;
  }
}

function jobToClient(row: JobRow) {
  const rawResult = row.result;
  const isResultObject =
    rawResult !== null && typeof rawResult === "object";
  const errorCode = isResultObject && "errorCode" in rawResult
    ? String((rawResult as { errorCode?: unknown }).errorCode ?? "")
    : null;

  // Never surface raw engine/provider error text (stack traces, upstream API
  // messages) to clients — keep it server-side; clients get the mapped code.
  let result = rawResult;
  if (isResultObject && "engineError" in (rawResult as Record<string, unknown>)) {
    const clone = { ...(rawResult as Record<string, unknown>) };
    delete clone.engineError;
    result = clone;
  }

  return {
    ...row,
    result,
    error_code: errorCode || (row.error ? classifyEngineError(row.error).code : null),
  };
}

/* ------------------------------- health ---------------------------------- */

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Which provider the Anthropic traffic goes to, and whether the key on this
  // service belongs to that route. Host and key *shape* only — no secret — so
  // this misconfiguration can be spotted from outside without a deploy log.
  const upstream = anthropicUpstream();
  const keyKind = anthropicKeyKind();
  const host = (() => {
    try { return new URL(upstream).host; } catch { return "invalid"; }
  })();
  sendJson(res, 200, {
    ok: true,
    jobStore: isJobStoreConfigured() ? "supabase" : "memory-only",
    uptimeSeconds: Math.round(process.uptime()),
    anthropic: {
      upstreamHost: host,
      keyKind,
      routeOk: keyKind === "anthropic" ? host === "api.anthropic.com" : keyKind === "gateway" && host !== "api.anthropic.com",
    },
  });
}

async function handleCapabilities(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getConfig();
  sendJson(res, 200, {
    analyses: [
      {
        id: "step1",
        name: "SEC relationship map",
        description:
          "Reads the latest 10-K or 20-F and maps suppliers, customers, and partners.",
        available: Boolean(config.anthropicApiKey),
        model: config.falconModel,
      },
    ],
  });
}

/* ------------------------------ step 1 ----------------------------------- */

async function persistStep1(rowId: string, ticker: string, user: AuthedUser): Promise<void> {
  const result = await getResearchResult(ticker);
  if (!result) {
    const mapped = falconError("FAL-SEC-01");
    await updateJob(rowId, {
      status: "error",
      error: mapped.message,
      result: { errorCode: mapped.code },
    });
    void notifyJobError(mapped, { user, ticker });
    return;
  }

  await updateJob(rowId, { status: "done", stage: "done", result });
  try {
    await persistGraphToSupabase(edgesFromStep1Result(result));
  } catch (err) {
    console.warn("[step1] graph persist failed:", err instanceof Error ? err.message : err);
  }
}

/** The account's current research standing — read by the dashboard countdown. */
async function handleResearchQuota(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;
  sendJson(res, 200, { ok: true, quota: await researchQuotaFor(user.id) });
}

async function handleResearchStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;
  // Burst guard first — cheap, in-memory, catches a stuck client hammering the
  // button. The real cap is below and is derived from the jobs table so it
  // survives a deploy.
  if (!withinUserRate(res, user, "step1-start", { limit: 5, windowMs: 60_000 })) return;

  const quota = await researchQuotaFor(user.id);
  if (!quota.allowed) {
    // 429 with the numbers the client needs to render a countdown rather than
    // a bare refusal: how many were used, and exactly when the slot returns.
    res.setHeader("retry-after", String(quota.retryAfterSeconds ?? 0));
    sendError(
      res,
      429,
      falconError(
        "FAL-REQ-02",
        `Research limit reached — next one available in ${formatRetryAfter(quota.retryAfterSeconds ?? 0)}.`,
      ),
      { user },
    );
    return;
  }

  const data = await readJson<{ ticker?: string; force?: boolean }>(req, res);
  if (!data) return;

  const ticker = data.ticker?.trim().toUpperCase() ?? "";
  if (!ticker) {
    sendCode(res, 400, "FAL-REQ-02");
    return;
  }

  try {
    const job = await createJob({ userId: user.id, kind: "step1", ticker });
    const { jobId } = await startResearchJob(ticker, { force: data.force === true });

    if (job) {
      void trackStep1(job.id, jobId, ticker, user);
      sendJson(res, 200, { jobId: job.id, engineJobId: jobId });
      return;
    }
    sendJson(res, 200, { jobId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[step1] start failed:", raw);
    sendError(res, 500, classifyEngineError(raw), { user, ticker });
  }
}

/** Poll the engine's Map and copy each change into Supabase until it settles. */
async function trackStep1(
  rowId: string,
  engineJobId: string,
  ticker: string,
  user: AuthedUser,
): Promise<void> {
  await updateJob(rowId, { status: "running" });

  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = getJobStatus(engineJobId);
    if (!status) {
      const mapped = falconError("FAL-JOB-02");
      await updateJob(rowId, {
        status: "error",
        error: mapped.message,
        result: { errorCode: mapped.code },
      });
      void notifyJobError(mapped, { user, ticker });
      return;
    }

    await updateJob(rowId, {
      stage: status.stage,
      progress_current: status.progress?.current ?? 0,
      progress_total: status.progress?.total ?? 0,
    });

    if (status.error) {
      const mapped = classifyEngineError(status.error);
      console.error("[step1] engine error:", status.error);
      await updateJob(rowId, {
        status: "error",
        error: mapped.message,
        result: { errorCode: mapped.code, engineError: status.error },
      });
      void notifyJobError(mapped, { user, ticker });
      return;
    }
    if (status.done) {
      await persistStep1(rowId, ticker, user);
      return;
    }
  }
}

async function handleJobStatus(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  const jobId = url.searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) {
    sendCode(res, 400, "FAL-REQ-03");
    return;
  }

  const row = await getJob(jobId, user.id);
  if (row) {
    sendJson(res, 200, { job: jobToClient(row) });
    return;
  }

  const engine = getJobStatus(jobId);
  if (engine) {
    sendJson(res, 200, {
      job: {
        id: jobId,
        kind: "step1",
        ticker: null,
        status: engine.error ? "error" : engine.done ? "done" : "running",
        stage: engine.stage,
        progress_current: engine.progress?.current ?? 0,
        progress_total: engine.progress?.total ?? 0,
        error: engine.error ? classifyEngineError(engine.error).message : null,
        error_code: engine.error ? classifyEngineError(engine.error).code : null,
        result: null,
      },
    });
    return;
  }

  sendCode(res, 404, "FAL-JOB-01");
}

async function handleResearchJobs(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  const ticker = url.searchParams.get("ticker")?.trim().toUpperCase() ?? "";
  const rows = ticker
    ? await listJobs(user.id, { kind: "step1", ticker, limit: 20 })
    : await listJobs(user.id, { kind: "step1", limit: 40 });
  sendJson(res, 200, { jobs: rows.map(jobToClient) });
}

async function handleLatestJob(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  const ticker = url.searchParams.get("ticker")?.trim().toUpperCase() ?? "";
  if (!ticker) {
    sendCode(res, 400, "FAL-REQ-02");
    return;
  }

  const row = await getLatestJobForTicker(user.id, ticker);
  sendJson(res, 200, { job: row ? jobToClient(row) : null });
}

async function handleResearchResult(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  const ticker = url.searchParams.get("ticker")?.trim().toUpperCase() ?? "";
  if (!ticker) {
    sendCode(res, 400, "FAL-REQ-02");
    return;
  }

  try {
    const latest = await getLatestJobForTicker(user.id, ticker);
    if (latest?.status === "done" && latest.result && !("errorCode" in (latest.result as object))) {
      sendJson(res, 200, { result: latest.result });
      return;
    }

    const result = await getResearchResult(ticker);
    if (!result) {
      sendCode(res, 404, "FAL-SEC-01", { user, ticker, notify: true });
      return;
    }
    sendJson(res, 200, { result });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[step1] result failed:", raw);
    sendError(res, 500, classifyEngineError(raw), { user, ticker });
  }
}


/* ------------------------------ brokerage -------------------------------- */

async function handleBrokerageList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  if (!isSnaptradeConfigured()) {
    sendJson(res, 200, { configured: false, brokerages: [] });
    return;
  }

  try {
    const brokerages = await listBrokerages();
    sendJson(res, 200, { configured: true, brokerages });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[brokerage] list failed:", raw);
    if (raw.toLowerCase().includes("not configured")) {
      sendJson(res, 200, { configured: false, brokerages: [] });
      return;
    }
    const error = falconError("FAL-INT-01");
    void notifyJobError(error, { user });
    // 200 so mobile can still offer paper + a generic live connect; catalog is optional.
    sendJson(res, 200, { configured: true, brokerages: [], error });
  }
}

/**
 * Only forward a return URL to SnapTrade if it targets this app. Prevents an
 * attacker-crafted `redirectUrl` from turning the SnapTrade OAuth return into an
 * open redirect. Accepts the app's own scheme (falcon://), Expo dev URLs, and
 * getfalcon.co; anything else is dropped (SnapTrade falls back to its default).
 */
function safeBrokerRedirect(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === "falcon:" || scheme === "exp:" || scheme === "exp+falcon:") return value;
  if (scheme === "https:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "getfalcon.co" || host.endsWith(".getfalcon.co")) return value;
  }
  return undefined;
}

async function handleBrokerageConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  if (!isSnaptradeConfigured()) {
    sendError(res, 503, falconError("FAL-JOB-03", "Brokerage connect isn't available right now."));
    return;
  }

  const data = await readJson<{ broker?: string; redirectUrl?: string }>(req, res);
  if (!data) return;

  try {
    const url = await getConnectionUrl(
      user.id,
      data.broker?.trim() || undefined,
      safeBrokerRedirect(data.redirectUrl),
    );
    sendJson(res, 200, { url });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[brokerage] connect failed:", raw);
    sendError(res, 502, falconError("FAL-INT-01"), { user });
  }
}

async function handleBrokerageStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  try {
    const networth = await getBrokerageNetWorth(user.id);
    sendJson(res, 200, { networth });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[brokerage] status failed:", raw);
    sendError(res, 502, falconError("FAL-INT-01"), { user });
  }
}

async function handleBrokerageDisconnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const user = await requireApprovedUser(req, res);
  if (!user) return;

  if (!isSnaptradeConfigured()) {
    sendError(res, 503, falconError("FAL-JOB-03", "Brokerage connect isn't available right now."));
    return;
  }

  const data = await readJson<{ authorizationId?: string }>(req, res);
  if (!data) return;
  const authorizationId = data.authorizationId?.trim() ?? "";
  if (!authorizationId) {
    sendCode(res, 400, "FAL-REQ-01");
    return;
  }

  try {
    const networth = await disconnectBrokerage(user.id, authorizationId);
    sendJson(res, 200, { networth });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[brokerage] disconnect failed:", raw);
    sendError(res, 502, falconError("FAL-INT-01"), { user });
  }
}

/* -------------------------------- router --------------------------------- */

const server = createServer(async (req, res) => {
  applyCors(res, req);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    // Provider proxies for the packaged desktop (see provider-proxy.ts). Prefix
    // routes, so they sit outside the exact-match switch below.
    if (url.pathname.startsWith("/api/anthropic/")) {
      return await handleAnthropicProxy(req, res, url, url.pathname.slice("/api/anthropic".length));
    }
    if (url.pathname.startsWith("/api/finnhub/")) {
      return await handleFinnhubProxy(req, res, url, url.pathname.slice("/api/finnhub".length));
    }

    switch (route) {
      case "GET /health":
        return await handleHealth(req, res);
      case "GET /api/capabilities":
        return await handleCapabilities(req, res);

      case "POST /api/research/start":
        return await handleResearchStart(req, res);
      case "GET /api/research/quota":
        return await handleResearchQuota(req, res);
      case "GET /api/research/status":
        return await handleJobStatus(req, res, url);
      case "GET /api/research/jobs":
        return await handleResearchJobs(req, res, url);
      case "GET /api/research/latest":
        return await handleLatestJob(req, res, url);
      case "GET /api/research/result":
        return await handleResearchResult(req, res, url);

      case "POST /api/onboarding/submit":
        return await handleOnboardingSubmit(req, res);

      case "GET /api/brokerage/list":
        return await handleBrokerageList(req, res);
      case "POST /api/brokerage/connect":
        return await handleBrokerageConnect(req, res);
      case "GET /api/brokerage/status":
        return await handleBrokerageStatus(req, res);
      case "POST /api/brokerage/disconnect":
        return await handleBrokerageDisconnect(req, res);

      default:
        return sendJson(res, 404, { error: falconError("FAL-JOB-01", "That endpoint does not exist.") });
    }
  } catch (err) {
    console.error("[api] unhandled:", err instanceof Error ? err.stack : err);
    const user = await resolveUserFromReq(req);
    sendCode(res, 500, "FAL-INT-01", { user });
  }
});

server.listen(PORT, HOST, () => {
  console.info(`[api] listening on ${HOST}:${PORT}`);
  console.info(`[api] job store: ${isJobStoreConfigured() ? "supabase" : "MEMORY ONLY"}`);
  console.info(
    `[api] discord error-log: ${process.env.DISCORD_ERROR_LOG_WEBHOOK_URL?.trim() ? "on" : "off"}`,
  );
});
