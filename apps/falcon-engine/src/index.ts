/**
 * Falcon engine — the deterministic chain, always on.
 *
 * Tracker → Classifier → Base → Propagation used to live in the Electron main
 * process, which meant the chain only advanced while somebody had the desktop
 * open. Measured on the live store that cost a median 43.5 hours between an
 * article being published and the run that reacted to it: by then the
 * second-order move was already priced. This process runs the same hosts, on
 * the same code, without waiting for anyone.
 *
 * What it owns:
 *   * the Tracker poll loop (news, filings, insiders, quant, gap events)
 *   * the Classifier Phase A cycle (Anthropic, budgeted by Base)
 *   * the Propagation cycle, the fast path, and the reprice sweep
 *   * the shared mirrors — `propagation_runs` and `tracker_universe` — written
 *     with the service-role key
 *
 * What it does NOT own: the desktop's panels. Those read this service over the
 * HTTP API below and render what it produced.
 */

import http from "node:http";
import { portfolioTrackerHealth, startPortfolioTracker } from "./portfolio-tracker.js";
import { newsCycleHealth, startNewsCycle } from "./news-cycle.js";
import { startPaperCompetition } from "./paper-competition.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getTrackerEngine } from "@meridian/research/tracker";
import { getClassifierHost } from "@meridian/research/classifier";
import { classifierBudgetOverrideValue } from "@meridian/research/base";
import { providerGateStats, providerRouteSummary } from "@meridian/research";
import {
  configurePropagationHost,
  getPropagationHost,
} from "@meridian/research/propagation/engine";
import { getRiskHost } from "@meridian/research/risk";
import { getScreenHost } from "@meridian/research/screen";
import { getAnalystHost } from "@meridian/research/analyst";
import { requireApprovedUser } from "./auth.js";
import { getInsightExplanation } from "./insight-explanation.js";
import { isEngineChannel } from "@meridian/research/engine-channels";
import { CHANNELS, channelNames } from "./channels.js";
import { loadEnvFile } from "./loadEnv.js";
import { remoteRuns } from "./remote-runs.js";
import { applySeedUniverse, seedAllDataDirs } from "./seed.js";
import { deactivateTicker, loadRemoteUniverse, publishUniverse } from "./universe.js";

loadEnvFile();

const PORT = Number.parseInt(process.env.PORT ?? "8788", 10) || 8788;
const VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.npm_package_version ?? "dev";

/**
 * Keys the chain cannot run without. Finnhub and the SEC feed the Tracker;
 * Anthropic is the Classifier and propagation stage-2. Supabase is how the
 * desktop ever sees any of it. Missing keys are named, not guessed at, because
 * a silent half-running engine is worse than one that refuses to start.
 */
/**
 * Which provider this service's Anthropic traffic goes to, and whether the key
 * it holds belongs to that route. A gateway key (no `sk-ant-` prefix) sent to
 * api.anthropic.com is a guaranteed 401 whose message blames the key rather
 * than the missing route — worth naming up front instead of discovering it
 * through a failed cycle. Host and key *shape* only, never the key itself.
 */
export function anthropicRoute(): { upstreamHost: string; keyKind: string; routeOk: boolean } {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  let upstreamHost = "api.anthropic.com";
  if (configured) {
    try {
      upstreamHost = new URL(configured).host;
    } catch {
      upstreamHost = "invalid";
    }
  }
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const keyKind = !key ? "missing" : key.startsWith("sk-ant-") ? "anthropic" : "gateway";
  // Only one pairing is guaranteed broken: a key without the `sk-ant-` prefix
  // sent to api.anthropic.com, which is a certain 401.
  //
  // The reverse is NOT an error. This check used to require an `sk-ant-` key to
  // go to Anthropic, on the assumption that gateways issue their own key
  // format — true of the first one we used, and false of the next, which
  // issues `sk-ant-` keys of its own. That assumption turned a working route
  // into a red light on the healthcheck.
  const routeOk = !(keyKind === "gateway" && upstreamHost === "api.anthropic.com") && upstreamHost !== "invalid";
  return { upstreamHost, keyKind, routeOk };
}

function reportEnv(): void {
  const required = ["FINNHUB_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length) console.warn(`[engine] missing env: ${missing.join(", ")}`);
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.warn("[engine] no ANTHROPIC_API_KEY — Classifier off, propagation ships stage-1 only");
    return;
  }
  const route = anthropicRoute();
  if (route.routeOk) {
    console.info(`[engine] Anthropic via ${route.upstreamHost} (${route.keyKind} key)`);
  } else {
    console.error(
      `[engine] ANTHROPIC_API_KEY is a ${route.keyKind} key but calls go to ${route.upstreamHost} — ` +
        "set ANTHROPIC_BASE_URL to the gateway this key belongs to, or supply an Anthropic key.",
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) return null;
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}


/**
 * Cache read/write across the hosts that use prompt caching.
 *
 * These run on a 15-minute cycle against what was a 5-minute default TTL, so
 * every entry expired before the next cycle could read it — 19,625 tokens
 * written against 560 read on the live key. The TTL is 1h now, and this is how
 * anyone checks whether that actually took effect: `ratio` should climb well
 * above zero within a couple of cycles. If it does not, the gateway is ignoring
 * the ttl and the right answer is to stop caching in these hosts entirely.
 */
function cacheHealth(): {
  write_tokens: number;
  read_tokens: number;
  ratio: number | null;
  by_host: Record<string, { write: number; read: number }>;
} {
  const by_host: Record<string, { write: number; read: number }> = {};
  let write = 0;
  let read = 0;
  const add = (name: string, w: unknown, r: unknown) => {
    const wn = typeof w === "number" && Number.isFinite(w) ? w : 0;
    const rn = typeof r === "number" && Number.isFinite(r) ? r : 0;
    by_host[name] = { write: wn, read: rn };
    write += wn;
    read += rn;
  };
  try {
    const m = getClassifierHost().status().metrics as Record<string, unknown> | undefined;
    add("classifier", m?.cache_creation_tokens, m?.cache_read_tokens);
  } catch {
    // A host that cannot report is not a reason to fail the healthcheck.
  }
  return { write_tokens: write, read_tokens: read, ratio: write > 0 ? read / write : null, by_host };
}


/** Classifier call volume and the two things that are supposed to bound it. */
function classifierHealth(): Record<string, unknown> {
  try {
    const st = getClassifierHost().status() as Record<string, unknown>;
    const m = (st.metrics ?? {}) as Record<string, unknown>;
    const b = (st.budget ?? {}) as Record<string, unknown>;
    return {
      enabled: st.enabled,
      // Calls that actually reached the model today, against the cap.
      budget_used: b.used ?? null,
      budget_daily: b.daily ?? null,
      // Non-null means a deployment variable is raising the cap above the code
      // default. Visible here so a temporary override cannot quietly outlive
      // the reason it was set.
      budget_override: classifierBudgetOverrideValue(),
      budget_remaining: b.remaining ?? null,
      // Answers served from the verdict store instead of the model. A low
      // number beside a high call count means we are re-paying for articles we
      // have already classified.
      cache_hits: m.cache_hits ?? null,
      verdicts_ok: m.verdicts_ok ?? null,
      verdicts_failed: m.verdicts_failed ?? null,
      /** Articles with a stored answer — the dedupe surface. */
      verdict_count: st.verdict_count ?? null,
      next_cycle_at: st.next_cycle_at ?? null,
      // Why the failures happen, not just how many — the difference between
      // shipping a fix and shipping a guess.
      failure_reasons: st.failure_reasons ?? null,
      // Last cycle's own counts. verdicts_ok climbed 334 while budget_used sat
      // at 500, and static analysis says that cannot happen: one service, one
      // classifyBatch caller, consumeBudget on the next line. So the answer is
      // in what a cycle actually did, not in what the code says it should.
      last_run: st.last_run ?? null,
      cycle_interval_ms: st.cycle_interval_ms ?? null,
    };
  } catch {
    return { enabled: null };
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === "OPTIONS") return send(res, 204, {});

  // Railway's healthcheck runs before any user exists, so it stays open.
  if (route === "GET /health") {
    const propagation = getPropagationHost().status();
    return send(res, 200, {
      ok: true,
      version: VERSION,
      uptime_s: Math.round(process.uptime()),
      tracker: getTrackerEngine().getStatus().tickers.length,
      propagation_runs: propagation.run_count,
      loop: propagation.enabled,
      portfolio: portfolioTrackerHealth(),
      news: newsCycleHealth(),
      anthropic: anthropicRoute(),
      // Which provider each engine resolves to. The chain is split now — the
      // classifier and step1 can run on a free model because their inputs are
      // public filings and published news, while the propagation judge and the
      // Insight write-up stay on Claude. Hosts only, never keys.
      routes: providerRouteSummary(),
      // Requests actually started per minute against each host, beside that
      // host's ceiling. `rate_waits` counts calls that gave up waiting — the
      // number that says the free tier's 20/min is too tight for the cycle,
      // rather than leaving it to be inferred from a failure count.
      gate: providerGateStats(),
      // Cache accounting, deliberately on the OPEN route.
      //
      // Whether prompt caching is earning its keep is the one question that
      // needed a provider key, an admin login and a panel to answer — and the
      // provider caps concurrency per key, so asking cost us the very budget we
      // were trying to measure. These counters are ours, already in memory, and
      // reveal nothing a healthcheck should not: `write` is tokens paid for at
      // 1.25x, `read` is tokens served back at 0.1x, and a ratio near zero means
      // every write is pure loss. Watch it with curl, no credential involved.
      cache: cacheHealth(),
      // Call volume, on the open route for the same reason as the cache
      // counters: "why are we making so many requests with no users?" should
      // not need a login to answer. `budget` is the cap that is supposed to
      // hold the daily total down; `verdicts` is how many articles we have
      // already answered for and must never pay to answer again.
      classifier: classifierHealth(),
    });
  }

  const user = await requireApprovedUser(req, res);
  if (!user) return;

  const host = getPropagationHost();
  switch (route) {
    case "GET /status":
      return send(res, 200, {
        ok: true,
        propagation: host.status(),
        classifier: getClassifierHost().status(),
        tracker: getTrackerEngine().getStatus(),
      });

    case "GET /runs": {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const synthetic = url.searchParams.get("synthetic");
      return send(res, 200, {
        ok: true,
        runs: host.listRuns({
          limit: Number.isFinite(limit) ? limit : undefined,
          synthetic: synthetic === "only" || synthetic === "all" ? synthetic : "exclude",
        }),
      });
    }

    case "GET /run": {
      const runId = url.searchParams.get("id") ?? "";
      const run = host.getRun(runId);
      if (!run) return send(res, 404, { ok: false, error: "no such run" });
      return send(res, 200, { ok: true, run, chain: host.runsForIncident(run.incident_id) });
    }

    // The write-up under an Insight headline. Cached in Supabase under the
    // desktop's own key, so whichever client opens the event first pays for it
    // and every other one reads that row.
    case "GET /insight": {
      const runId = url.searchParams.get("run") ?? "";
      const insightRun = host.getRun(runId);
      if (!insightRun) return send(res, 404, { ok: false, error: "no such run" });
      try {
        const { explanation, source } = await getInsightExplanation(insightRun);
        return send(res, 200, { ok: true, explanation, source });
      } catch (err) {
        return send(res, 502, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    case "GET /absorption": {
      const runId = url.searchParams.get("run") ?? "";
      const target = url.searchParams.get("target") ?? "";
      return send(res, 200, { ok: true, curve: host.absorption(runId, target) });
    }

    case "GET /pair": {
      const root = url.searchParams.get("root") ?? "";
      const target = url.searchParams.get("target") ?? "";
      return send(res, 200, { ok: true, history: host.pairHistory(root, target) });
    }

    // The desktop's "Run now" — the work happens here, not there.
    case "POST /run-cycle": {
      const body = await readJson<{ limit?: number; dryRun?: boolean; maxRequests?: number; stage2?: boolean }>(req);
      if (!body) return send(res, 400, { ok: false, error: "bad JSON" });
      const summary = await host.runCycle({
        limit: body.limit,
        dryRun: body.dryRun,
        maxRequests: body.maxRequests,
        stage2: body.stage2,
      });
      return send(res, 200, { ok: true, summary });
    }

    // Force the fast lane for one ticker — the rehearsal path, and the manual
    // escape hatch when a filing lands and nobody wants to wait for the cycle.
    case "POST /fast-path": {
      const body = await readJson<{ ticker?: string }>(req);
      const ticker = body?.ticker?.trim().toUpperCase() ?? "";
      if (!ticker) return send(res, 400, { ok: false, error: "ticker required" });
      const run = await host.runFastPath(ticker);
      return send(res, 200, { ok: true, run });
    }

    case "POST /set-enabled": {
      const body = await readJson<{ enabled?: boolean }>(req);
      if (typeof body?.enabled !== "boolean") return send(res, 400, { ok: false, error: "enabled required" });
      host.setEnabled(body.enabled);
      return send(res, 200, { ok: true, status: host.status() });
    }

    // The desktop panels speak in channel names, not routes. One allowlisted
    // entry point answers all of them (see channels.ts) so the panels keep the
    // contract they already have while the work happens here.
    case "GET /channels":
      return send(res, 200, { ok: true, channels: channelNames() });

    case "POST /channel": {
      const body = await readJson<{ channel?: string; args?: unknown[] }>(req);
      if (!body) return send(res, 400, { ok: false, error: "bad JSON" });
      const name = String(body.channel ?? "");
      // The allowlist is the type: anything not in it is not a channel.
      if (!isEngineChannel(name)) return send(res, 404, { ok: false, error: `unknown channel ${name}` });
      const handler = CHANNELS[name];
      const result = await handler(Array.isArray(body.args) ? body.args : []);
      return send(res, 200, result);
    }

    default:
      return send(res, 404, { ok: false, error: `no route ${route}` });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  reportEnv();
  // Before any store is constructed: they read their files on first touch and
  // cache what they find, so an empty volume seeded afterwards is not seen.
  seedAllDataDirs();
  applySeedUniverse();

  // The shared host, wired to this process: runs mirror through the
  // service-role key, verdicts come from the Classifier host running here, and
  // there is nobody to notify — the desktop polls the API.
  configurePropagationHost({
    remote: remoteRuns,
    classifier: getClassifierHost(),
  });

  const tracker = getTrackerEngine();

  // Which names to follow is an account-level decision, so the server list is
  // the starting point exactly as it is on a desktop install.
  tracker.onUniverseChange((event) => {
    if (event.type === "add") void publishUniverse([event.ticker], "engine");
    else void deactivateTicker(event.ticker);
  });
  const remote = await loadRemoteUniverse();
  tracker.setRemoteUniverse(remote);
  await tracker.start();
  console.info(`[engine] tracker started · ${tracker.getStatus().tickers.length} ticker(s)`);

  const classifier = getClassifierHost();
  classifier.start();
  console.info(`[engine] classifier ${classifier.status().enabled ? "on" : "off"}`);

  const propagation = getPropagationHost();
  // Pull what other installs produced before this process starts adding to it,
  // so supersession is decided against the full history rather than a fresh
  // volume's empty one.
  await propagation.syncRemoteRuns("boot");
  propagation.start();
  // Independent of the timer: the fast lane is how a second-order move is
  // caught while it is still open, so it arms even when the loop is off.
  propagation.watchTracker();
  console.info(`[engine] propagation ${propagation.status().enabled ? "on" : "off"} · fast path armed`);

  // Risk follows the Tracker it reads. Without this the host exists only as
  // whatever a `risk:account-update` happens to build: no startup snapshot and
  // none of the §5 triggers (close-run, incident band, earnings horizon), so
  // the panel sits on "No snapshot yet" until the reader trades.
  const risk = getRiskHost();
  risk.start();
  console.info(`[engine] risk started · ${risk.status().snapshotCount} snapshot(s)`);

  // Screen and Analyst read the Tracker too, and answer engine channels — so
  // they have to run in the process that owns it. They were being answered
  // here from hosts nobody had started while the desktop quietly ran the real
  // loops against its own copy: the panel read one machine and the work
  // happened on another.
  const screen = getScreenHost();
  screen.start();
  console.info(`[engine] screen started · ${screen.status().scanCount} scan(s)`);

  const analyst = getAnalystHost();
  analyst.start();
  console.info(`[engine] analyst ${analyst.status().enabled ? "on" : "off"}`);

  // Net-worth snapshots for every synced portfolio. This used to live in the
  // news-worker; it belongs here, with the rest of the always-on chain and
  // the service the desktop actually talks to. It is what keeps a chart
  // moving overnight, so a stalled tracker is a silent, invisible failure —
  // hence the counters in /health.
  startPortfolioTracker();

  // The last two duties of the retired news-worker service, adopted whole:
  // the classified-events feed mobile renders (plus the graph sync riding on
  // it), and the 60-day paper-competition book the admin panel reads. One
  // always-on process now owns everything that runs around the clock.
  startNewsCycle();
  startPaperCompetition();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[engine] request failed:", err);
      if (!res.headersSent) send(res, 500, { ok: false, error: "internal error" });
    });
  });
  server.listen(PORT, () => console.info(`[engine] listening on :${PORT} (${VERSION})`));

  const shutdown = (signal: string) => {
    console.info(`[engine] ${signal} — stopping`);
    propagation.stop();
    classifier.stop();
    tracker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void boot().catch((err) => {
  console.error("[engine] boot failed:", err);
  process.exit(1);
});
