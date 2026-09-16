import "server-only";

/**
 * Server-only readers for what Falcon spends on model inference.
 *
 * There are two accounts, and confusing them is the whole reason this file
 * exists. Falcon's own traffic does not go to Anthropic: every service reports
 * `upstreamHost: api.oneprovider.dev`, `keyKind: gateway`, so production spend
 * and the balance that can actually run out live at the **gateway**. The direct
 * Anthropic org key bills separately and is mostly developer tooling. A single
 * "API usage" number that silently mixes them tells you nothing, so both are
 * fetched independently and rendered side by side, each labelled with the host
 * it came from.
 *
 * Everything degrades to a `configured: false` panel rather than throwing — an
 * admin page that 500s because a billing key is unset is worse than one that
 * says which key is missing.
 */

/** Anthropic's Usage/Cost Admin API reports money as decimal strings in cents. */
const CENTS_PER_USD = 100;

const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const USER_AGENT = "FalconAdmin/1.0 (+https://falcon.trade)";

/** Usage/cost data lands within ~5 min; the docs ask for at most 1 poll/min. */
export const USAGE_REVALIDATE_SECONDS = 300;

/**
 * The probe sends a real billed message, so it runs on its own much slower
 * clock than the read-only usage fetch. Six hours is often enough to catch a
 * provider changing how it bills, and rare enough that an open admin tab is
 * not a line item.
 */
export const PROBE_REVALIDATE_SECONDS = 21_600;

export type ProviderKind = "gateway" | "anthropic";

export type ModelUsage = {
  model: string;
  requests: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** USD, when the provider reports money per model. */
  costUsd: number | null;
};

export type DayUsage = {
  /** YYYY-MM-DD. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
};

export type ProviderUsage = {
  kind: ProviderKind;
  /** What to call this account in the UI. */
  label: string;
  /** The host the numbers came from — the thing that disambiguates the two. */
  host: string;
  /** False when the key/base URL is unset: render a setup hint, not an error. */
  configured: boolean;
  /** Set when configured but the fetch failed. */
  error: string | null;
  windowDays: number;
  totalCostUsd: number | null;
  totalRequests: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  byModel: ModelUsage[];
  byDay: DayUsage[];
  /** Remaining prepaid credit, when the provider exposes one. */
  balanceUsd: number | null;
  /** List price for the same usage, where the provider reports one separately. */
  listCostUsd: number | null;
  /** Spend cap left — NOT the account balance; a key can stop on a full balance. */
  quotaRemainingUsd: number | null;
  quotaLimitUsd: number | null;
  quotaMode: string | null;
  expiresAt: string | null;
  /**
   * Today alone. The lifetime totals bury a change: a cache fix that starts
   * working now sits under every write made before it, so the ratio that
   * actually answers "did it take effect" has to be a recent one.
   */
  todayCacheReadTokens: number | null;
  todayCacheCreationTokens: number | null;
  /** Credit granted for the period, when known — lets the UI show a burn bar. */
  creditLimitUsd: number | null;
  /**
   * Multiplier applied to every money figure from this provider, and whether
   * one was applied at all. The gateway labels its money fields "USD" but they
   * are an internal unit: the real dashboard for the same key showed $10.00
   * topped up / $3.76 spent / $6.24 left while /v1/usage reported
   * limit 1.35 / used 0.51 / remaining 0.84 — one flat factor (~7.4x) apart,
   * with remaining/limit matching the dashboard percentage exactly. So the
   * RATIOS are trustworthy and the absolute numbers are not. Set
   * FALCON_GATEWAY_TOPUP_USD to the key lifetime top-ups the gateway
   * dashboard shows and everything is rescaled onto real dollars; unset, the
   * raw units pass through and the UI must say they are not dollars.
   */
  moneyScale: number | null;
  moneyCalibrated: boolean;
  /**
   * Anything the provider returned that this adapter did not recognise. Shown
   * verbatim in a details block so an unknown balance field can be wired up
   * from the panel itself rather than by redeploying to read a log line.
   */
  raw: unknown;
};

function emptyProvider(
  kind: ProviderKind,
  label: string,
  host: string,
  windowDays: number,
): ProviderUsage {
  return {
    kind,
    label,
    host,
    configured: false,
    error: null,
    windowDays,
    totalCostUsd: null,
    totalRequests: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    byModel: [],
    byDay: [],
    balanceUsd: null,
    listCostUsd: null,
    quotaRemainingUsd: null,
    quotaLimitUsd: null,
    quotaMode: null,
    expiresAt: null,
    todayCacheReadTokens: null,
    todayCacheCreationTokens: null,
    creditLimitUsd: null,
    moneyScale: null,
    moneyCalibrated: false,
    raw: null,
  };
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** `starting_at` / `ending_at` for a whole-day window ending tomorrow (UTC). */
function windowIso(days: number): { startingAt: string; endingAt: string } {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { startingAt: start.toISOString(), endingAt: end.toISOString() };
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}


/**
 * The gateway enforces a concurrency cap, not just a rate.
 *
 * This panel used to fire five calls at once against one key — usage, plus a
 * count/send pair per provider — while the engine was running its own chain on
 * the same credential. That reliably returned
 * `429 API rate or concurrency limit exceeded`, and a 429 on the usage call
 * blanked every number on the page.
 *
 * So: never more than one request in flight per host from here (see the
 * sequential calls in `getApiUsage`), and a 429 waits and retries rather than
 * being rendered as "no data" — the difference between "we are over the cap"
 * and "the account is empty" matters a great deal to whoever reads this page.
 */
async function fetchWithBackoff(
  url: string,
  init: RequestInit & { next?: { revalidate: number } },
  attempts = 3,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    last = res;
    if (i < attempts - 1) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5_000)
        : 400 * 2 ** i;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return last!;
}

// ---------------------------------------------------------------------------
// Anthropic — direct org key (Usage & Cost Admin API)
// ---------------------------------------------------------------------------

/**
 * Requires an **Admin** credential (`sk-ant-admin…`, or an org-scoped key that
 * is not workspace-scoped). A regular `sk-ant-api…` key returns 401 here, which
 * is a common and confusing misconfiguration — so that case gets its own
 * message rather than a bare "401".
 */
async function fetchAnthropic(
  path: string,
  params: URLSearchParams,
  adminKey: string,
): Promise<unknown> {
  const res = await fetchWithBackoff(`${ANTHROPIC_API}${path}?${params.toString()}`, {
    headers: {
      "x-api-key": adminKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "User-Agent": USER_AGENT,
    },
    next: { revalidate: USAGE_REVALIDATE_SECONDS },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Anthropic rejected the key (401/403). The Usage & Cost endpoints need an Admin key " +
          "(sk-ant-admin…) or an org-scoped key — a workspace-scoped key will not work.",
      );
    }
    throw new Error(`Anthropic HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

type AnthropicBucket = {
  starting_at?: string;
  results?: Array<Record<string, unknown>>;
};

/** Sum the four token quantities out of one usage result row. */
function readUsageRow(row: Record<string, unknown>): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
} {
  const creation = row.cache_creation as Record<string, unknown> | undefined;
  const cacheCreate = creation
    ? num(creation.ephemeral_5m_input_tokens) + num(creation.ephemeral_1h_input_tokens)
    : num(row.cache_creation_input_tokens);
  return {
    input: num(row.uncached_input_tokens ?? row.input_tokens),
    output: num(row.output_tokens),
    cacheRead: num(row.cache_read_input_tokens),
    cacheCreate,
  };
}

export async function getAnthropicUsage(windowDays = 7): Promise<ProviderUsage> {
  const out = emptyProvider("anthropic", "Anthropic (direct)", "api.anthropic.com", windowDays);
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY?.trim();
  if (!adminKey) return out;
  out.configured = true;

  const { startingAt, endingAt } = windowIso(windowDays);

  try {
    const usageParams = new URLSearchParams({
      starting_at: startingAt,
      ending_at: endingAt,
      bucket_width: "1d",
      limit: String(Math.min(31, Math.max(1, windowDays))),
    });
    usageParams.append("group_by[]", "model");

    const usage = (await fetchAnthropic(
      "/v1/organizations/usage_report/messages",
      usageParams,
      adminKey,
    )) as { data?: AnthropicBucket[] };

    const perModel = new Map<string, ModelUsage>();
    const perDay = new Map<string, DayUsage>();

    for (const bucket of usage.data ?? []) {
      const day = dayOf(bucket.starting_at ?? "");
      for (const row of bucket.results ?? []) {
        const t = readUsageRow(row);
        const model = String(row.model ?? "unattributed");

        const m = perModel.get(model) ?? {
          model,
          requests: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: null,
        };
        m.inputTokens += t.input;
        m.outputTokens += t.output;
        m.cacheReadTokens += t.cacheRead;
        m.cacheCreationTokens += t.cacheCreate;
        perModel.set(model, m);

        if (day) {
          const d = perDay.get(day) ?? {
            day,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: null,
          };
          d.inputTokens += t.input;
          d.outputTokens += t.output;
          d.cacheReadTokens += t.cacheRead;
          d.cacheCreationTokens += t.cacheCreate;
          perDay.set(day, d);
        }
      }
    }

    // Cost is a separate endpoint — the usage report carries no money at all.
    const costParams = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt });
    costParams.append("group_by[]", "description");

    let totalCostUsd: number | null = null;
    try {
      const cost = (await fetchAnthropic(
        "/v1/organizations/cost_report",
        costParams,
        adminKey,
      )) as { data?: AnthropicBucket[] };

      let total = 0;
      for (const bucket of cost.data ?? []) {
        const day = dayOf(bucket.starting_at ?? "");
        let dayTotal = 0;
        for (const row of bucket.results ?? []) {
          // Decimal strings in cents.
          const cents = num(row.amount ?? row.cost ?? row.value);
          dayTotal += cents / CENTS_PER_USD;
        }
        total += dayTotal;
        if (day) {
          const d = perDay.get(day);
          if (d) d.costUsd = (d.costUsd ?? 0) + dayTotal;
        }
      }
      totalCostUsd = total;
    } catch (err) {
      // Usage without cost is still worth rendering; note it and move on.
      out.error = `cost report unavailable — ${err instanceof Error ? err.message : String(err)}`;
    }

    out.byModel = Array.from(perModel.values()).sort(
      (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
    out.byDay = Array.from(perDay.values()).sort((a, b) => a.day.localeCompare(b.day));
    out.inputTokens = out.byModel.reduce((s, m) => s + m.inputTokens, 0);
    out.outputTokens = out.byModel.reduce((s, m) => s + m.outputTokens, 0);
    out.cacheReadTokens = out.byModel.reduce((s, m) => s + m.cacheReadTokens, 0);
    out.cacheCreationTokens = out.byModel.reduce((s, m) => s + m.cacheCreationTokens, 0);
    out.totalCostUsd = totalCostUsd;
    return out;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Gateway — where Falcon's production traffic actually bills
// ---------------------------------------------------------------------------

/**
 * The gateway speaks the Anthropic wire format (it serves `/v1/models`), and
 * `/v1/usage` exists — unauthenticated it answers 429, not 404. Its exact body
 * is not documented anywhere we control, so this reads defensively: several
 * plausible field spellings for each quantity, and the whole payload kept on
 * `raw` so an unrecognised balance field is visible in the panel instead of
 * silently reading as "no balance".
 */
function pick(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * The gateway's `/v1/usage`, read against its real shape.
 *
 * Three things in that payload are easy to get wrong, and getting them wrong is
 * what this comment exists to prevent:
 *
 *  * `cost` is LIST price and `actual_cost` is what the account is actually
 *    charged — measured at a flat 4.545x apart, with `quota.used` tracking
 *    `actual_cost` to the eighth decimal. Money is `actual_cost`; `cost` is a
 *    display figure that makes spend look ~4.5x bigger than it is.
 *  * `quota.remaining` is a spend CAP, not the account balance. The balance
 *    ($9.86 at time of writing) does not appear in this response at all, so it
 *    must never be rendered as one — a key can sit on a full balance and still
 *    stop working because its quota ran out.
 *  * `usage.total` and `daily_usage` cover the key's own lifetime, which for a
 *    fresh key is not the same window the caller asked for.
 */
export async function getGatewayUsage(windowDays = 7): Promise<ProviderUsage> {
  const baseUrl = (process.env.FALCON_GATEWAY_BASE_URL?.trim() || "https://api.oneprovider.dev")
    .replace(/\/+$/, "");
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  })();

  const out = emptyProvider("gateway", "Falcon production (gateway)", host, windowDays);
  const key = process.env.FALCON_GATEWAY_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return out;
  out.configured = true;

  try {
    const res = await fetchWithBackoff(`${baseUrl}/v1/usage`, {
      headers: {
        "x-api-key": key,
        Authorization: `Bearer ${key}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "User-Agent": USER_AGENT,
      },
      next: { revalidate: USAGE_REVALIDATE_SECONDS },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429) {
        // Distinct wording on purpose: a blank card beside a bare "429" reads
        // as an empty account, and the two call for opposite reactions.
        throw new Error(
          "Gateway concurrency/rate cap hit after retries — the figures below are unavailable, " +
            "not zero. The engine shares this key; try again shortly.",
        );
      }
      throw new Error(`gateway HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const payload = (await res.json()) as Record<string, unknown>;
    out.raw = payload;

    const usage = (payload.usage as Record<string, unknown>) ?? {};
    const total = (usage.total as Record<string, unknown>) ?? {};
    const quota = (payload.quota as Record<string, unknown>) ?? {};

    // Spend: the charged figure, not the list-price one.
    out.totalCostUsd = num(total.actual_cost);
    out.listCostUsd = num(total.cost);
    out.totalRequests = num(total.requests);
    out.inputTokens = num(total.input_tokens);
    out.outputTokens = num(total.output_tokens);
    out.cacheReadTokens = num(total.cache_read_tokens);
    out.cacheCreationTokens = num(total.cache_creation_tokens ?? total.cache_write_tokens);

    // A cap, deliberately not assigned to `balanceUsd`.
    out.quotaRemainingUsd = num(quota.remaining ?? payload.remaining);
    out.quotaLimitUsd = num(quota.limit);
    out.quotaMode = typeof payload.mode === "string" ? payload.mode : null;
    out.expiresAt = typeof payload.expires_at === "string" ? payload.expires_at : null;

    const today = (usage.today as Record<string, unknown>) ?? {};
    out.todayCacheReadTokens = num(today.cache_read_tokens);
    out.todayCacheCreationTokens = num(
      today.cache_creation_tokens ?? today.cache_write_tokens,
    );

    const models = payload.model_stats;
    if (Array.isArray(models)) {
      out.byModel = models
        .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
        .map((m) => ({
          model: String(m.model ?? "unknown"),
          requests: num(m.requests),
          inputTokens: num(m.input_tokens),
          outputTokens: num(m.output_tokens),
          cacheReadTokens: num(m.cache_read_tokens),
          cacheCreationTokens: num(m.cache_creation_tokens),
          costUsd: num(m.actual_cost),
        }))
        .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
    }

    const daily = payload.daily_usage;
    if (Array.isArray(daily)) {
      out.byDay = daily
        .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
        .map((d) => ({
          day: String(d.date ?? ""),
          inputTokens: num(d.input_tokens),
          outputTokens: num(d.output_tokens),
          cacheReadTokens: num(d.cache_read_tokens),
          cacheCreationTokens: num(d.cache_write_tokens ?? d.cache_creation_tokens),
          costUsd: num(d.actual_cost),
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
    }

    // Calibrate the gateway units onto real dollars (see moneyScale docs).
    const topup = Number.parseFloat(process.env.FALCON_GATEWAY_TOPUP_USD ?? "");
    if (Number.isFinite(topup) && topup > 0 && out.quotaLimitUsd && out.quotaLimitUsd > 0) {
      const scale = topup / out.quotaLimitUsd;
      const mul = (v: number | null) => (v == null ? null : v * scale);
      out.totalCostUsd = mul(out.totalCostUsd);
      out.listCostUsd = mul(out.listCostUsd);
      out.quotaRemainingUsd = mul(out.quotaRemainingUsd);
      out.quotaLimitUsd = topup;
      out.byModel = out.byModel.map((m) => ({ ...m, costUsd: mul(m.costUsd) }));
      out.byDay = out.byDay.map((d) => ({ ...d, costUsd: mul(d.costUsd) }));
      out.moneyScale = scale;
      out.moneyCalibrated = true;
    }
    return out;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Falcon's own counters — what the engine thinks it spent
// ---------------------------------------------------------------------------

export type EngineCounters = {
  reachable: boolean;
  error: string | null;
  version: string | null;
  uptimeSeconds: number | null;
  trackedTickers: number | null;
  propagationRuns: number | null;
  loopRunning: boolean | null;
  /** The host the engine routes model traffic to — proves which account bills. */
  upstreamHost: string | null;
  keyKind: string | null;
  routeOk: boolean | null;
};

/**
 * `/health` is deliberately unauthenticated on the engine (Railway's probe runs
 * before any user exists), which is exactly what makes it usable here: it
 * reports the upstream host, so the panel can *show* which account Falcon bills
 * rather than asserting it in a comment.
 */
export async function getEngineCounters(): Promise<EngineCounters> {
  const base = (
    process.env.FALCON_ENGINE_URL?.trim() || "https://falcon-engine-production.up.railway.app"
  ).replace(/\/+$/, "");
  const out: EngineCounters = {
    reachable: false,
    error: null,
    version: null,
    uptimeSeconds: null,
    trackedTickers: null,
    propagationRuns: null,
    loopRunning: null,
    upstreamHost: null,
    keyKind: null,
    routeOk: null,
  };
  try {
    const res = await fetch(`${base}/health`, { next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`engine HTTP ${res.status}`);
    const h = (await res.json()) as Record<string, unknown>;
    const anthropic = (h.anthropic as Record<string, unknown> | undefined) ?? {};
    out.reachable = true;
    out.version = typeof h.version === "string" ? h.version : null;
    out.uptimeSeconds = typeof h.uptime_s === "number" ? h.uptime_s : null;
    out.trackedTickers = typeof h.tracker === "number" ? h.tracker : null;
    out.propagationRuns = typeof h.propagation_runs === "number" ? h.propagation_runs : null;
    out.loopRunning = typeof h.loop === "boolean" ? h.loop : null;
    out.upstreamHost = typeof anthropic.upstreamHost === "string" ? anthropic.upstreamHost : null;
    out.keyKind = typeof anthropic.keyKind === "string" ? anthropic.keyKind : null;
    out.routeOk = typeof anthropic.routeOk === "boolean" ? anthropic.routeOk : null;
    return out;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
}

export type ApiUsageSnapshot = {
  gateway: ProviderUsage;
  anthropic: ProviderUsage;
  engine: EngineCounters;
  windowDays: number;
  fetchedAt: string;
};

export async function getApiUsage(windowDays = 7): Promise<ApiUsageSnapshot> {
  // The engine is a different host and can overlap; the two provider reads are
  // deliberately sequential so this page never contributes its own concurrency
  // spike to a key the engine is already using.
  const enginePromise = getEngineCounters();
  const gateway = await getGatewayUsage(windowDays);
  const anthropic = await getAnthropicUsage(windowDays);
  const engine = await enginePromise;
  return { gateway, anthropic, engine, windowDays, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Billing verification — is the provider billing the tokens it says we sent?
// ---------------------------------------------------------------------------

/**
 * Prose in the register the pipeline actually sends. The probe is a ratio, so
 * any text shows a discrepancy — but a tokeniser behaves differently on legal
 * English than on lorem ipsum, and this is the register that is being billed.
 */
const PROBE_PARAGRAPH =
  "We depend on a limited number of suppliers for certain components used in our products, " +
  "and in some cases a single source. Our agreements with these suppliers generally do not " +
  "obligate them to supply us with any minimum quantity, and they may terminate on relatively " +
  "short notice. Any disruption in supply, whether caused by capacity constraints, financial " +
  "difficulty, natural disaster, geopolitical developments, or a decision to prioritise other " +
  "customers, could materially and adversely affect our results of operations. We compete with " +
  "companies that have substantially greater financial, technical and marketing resources than " +
  "we do, and consolidation among our competitors could further increase their scale advantage. ";

function probeText(chars: number): string {
  const reps = Math.ceil(chars / PROBE_PARAGRAPH.length);
  return PROBE_PARAGRAPH.repeat(reps).slice(0, chars);
}

export type BillingProbe = {
  configured: boolean;
  host: string;
  model: string;
  ok: boolean;
  error: string | null;
  requestChars: number;
  /** What the provider's own tokeniser says the payload is. */
  countedTokens: number;
  /** What the provider billed for the identical payload. */
  billedTokens: number;
  /** billed ÷ counted. 1.0 honest; the gateway measured 1.75 by hand. */
  ratio: number | null;
  countedCharsPerToken: number | null;
  billedCharsPerToken: number | null;
  /** Applied to the period's billed input, what the excess is worth. */
  impliedOverchargeUsd: number | null;
};

const PROBE_TOLERANCE = 0.05;

/**
 * Ask the provider to COUNT a payload, then send that exact payload and read
 * what it BILLED. Both numbers come from the provider itself, so a gap is the
 * provider contradicting its own tokeniser — not our estimate disagreeing with
 * their meter, which is an argument nobody can settle.
 *
 * `max_tokens: 1` keeps the output to a single token; the input is billed in
 * full, which is the quantity under test. One probe costs about two cents.
 */
export async function runBillingProbe(
  which: ProviderKind,
  periodBilledInputTokens?: number,
  inputUsdPerM = 3.1,
): Promise<BillingProbe> {
  const isGateway = which === "gateway";
  const baseUrl = isGateway
    ? (process.env.FALCON_GATEWAY_BASE_URL?.trim() || "https://api.oneprovider.dev").replace(/\/+$/, "")
    : ANTHROPIC_API;
  const key = isGateway
    ? process.env.FALCON_GATEWAY_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim()
    : process.env.ANTHROPIC_ADMIN_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  const model = process.env.FALCON_MODEL?.trim() || "claude-sonnet-5";

  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  })();

  const out: BillingProbe = {
    configured: Boolean(key),
    host,
    model,
    ok: false,
    error: null,
    requestChars: 0,
    countedTokens: 0,
    billedTokens: 0,
    ratio: null,
    countedCharsPerToken: null,
    billedCharsPerToken: null,
    impliedOverchargeUsd: null,
  };
  if (!key) return out;

  const system = "You read SEC filing text. Reply with the single word OK and nothing else.";
  const user = `Source excerpt:\n"""${probeText(24_000)}"""\n\nReply OK.`;
  out.requestChars = system.length + user.length;

  const headers = {
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    "User-Agent": USER_AGENT,
  };
  const body = { model, system, messages: [{ role: "user", content: user }] };

  try {
    const countRes = await fetchWithBackoff(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      next: { revalidate: PROBE_REVALIDATE_SECONDS },
    });
    if (!countRes.ok) throw new Error(`count_tokens HTTP ${countRes.status}`);
    const counted = (await countRes.json()) as { input_tokens?: number };

    const sendRes = await fetchWithBackoff(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, max_tokens: 1 }),
      next: { revalidate: PROBE_REVALIDATE_SECONDS },
    });
    if (!sendRes.ok) throw new Error(`messages HTTP ${sendRes.status}`);
    const sent = (await sendRes.json()) as {
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    const countedTokens = num(counted.input_tokens);
    // Every input-side bucket. A provider splitting one payload across
    // `input` and `cache_creation` looks honest on either field alone.
    const billedTokens =
      num(sent.usage?.input_tokens) +
      num(sent.usage?.cache_creation_input_tokens) +
      num(sent.usage?.cache_read_input_tokens);

    out.ok = countedTokens > 0 && billedTokens > 0;
    out.countedTokens = countedTokens;
    out.billedTokens = billedTokens;
    out.ratio = countedTokens > 0 ? billedTokens / countedTokens : null;
    out.countedCharsPerToken = countedTokens > 0 ? out.requestChars / countedTokens : null;
    out.billedCharsPerToken = billedTokens > 0 ? out.requestChars / billedTokens : null;

    if (
      out.ratio != null &&
      out.ratio > 1 + PROBE_TOLERANCE &&
      periodBilledInputTokens != null &&
      periodBilledInputTokens > 0
    ) {
      const shouldHaveBeen = periodBilledInputTokens / out.ratio;
      out.impliedOverchargeUsd =
        ((periodBilledInputTokens - shouldHaveBeen) / 1_000_000) * inputUsdPerM;
    }
    return out;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
}
