import { AlertTriangle, KeyRound, ScanSearch, Server, ShieldCheck, Wallet } from "lucide-react";
import {
  getApiUsage,
  runBillingProbe,
  type BillingProbe,
  type EngineCounters,
  type ProviderUsage,
} from "@/lib/admin-api-usage";
import { CARD, MICRO_LABEL, formatNumber } from "../../components/overview/helpers";
import AdminPageHeader from "../../components/AdminPageHeader";
import { ADMIN_SHELL, ADMIN_MONO } from "../../admin-theme";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 7;

function usd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return formatNumber(n);
}

function formatUptime(seconds: number | null): string {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Stat({
  label,
  value,
  hint,
  tone = "plain",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "plain" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "bad"
          ? "text-red-700"
          : "text-[#1d1b1b]";
  return (
    <div className={`${CARD} p-4`}>
      <p className={MICRO_LABEL}>{label}</p>
      <p className={`mt-2 text-[22px] font-medium leading-none tabular-nums ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-2 text-[11.5px] leading-snug text-[#6b7280]">{hint}</p> : null}
    </div>
  );
}

/**
 * Cache writes cost ~1.25x base and only pay for themselves when something
 * later reads them. A high write-to-read ratio is the signature of a prompt
 * whose variable part sits before its reusable part, so the shared prefix is
 * re-uploaded every call and never hit again — worth surfacing as its own
 * number rather than leaving it to be inferred from two token counters.
 */
function cacheEfficiency(
  p: ProviderUsage,
  scope: "lifetime" | "today" = "lifetime",
): { ratio: number | null; tone: "good" | "warn" | "bad" } {
  const write = scope === "today" ? (p.todayCacheCreationTokens ?? 0) : p.cacheCreationTokens;
  const read = scope === "today" ? (p.todayCacheReadTokens ?? 0) : p.cacheReadTokens;
  if (write === 0) return { ratio: null, tone: "good" };
  const ratio = read / write;
  return { ratio, tone: ratio >= 2 ? "good" : ratio >= 0.5 ? "warn" : "bad" };
}


/**
 * The billing check.
 *
 * Both numbers come from the provider: what its own tokeniser COUNTS for a
 * payload, and what it BILLS for that identical payload. A gap is the provider
 * disagreeing with itself, which is the only version of this argument that
 * cannot be waved away as our estimate being wrong.
 */
function BillingCheck({ probe, label }: { probe: BillingProbe; label: string }) {
  if (!probe.configured) {
    return (
      <div className={`${CARD} px-5 py-4`}>
        <p className={MICRO_LABEL}>Billing check · {label}</p>
        <p className="mt-2 text-[13px] text-[#6b7280]">
          Not configured — no key for {probe.host}.
        </p>
      </div>
    );
  }

  if (!probe.ok) {
    return (
      <div className={`${CARD} flex items-start gap-2.5 px-5 py-4`}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
        <div>
          <p className={MICRO_LABEL}>Billing check · {label}</p>
          <p className="mt-1.5 text-[13px] text-[#6b7280]">
            {probe.error ?? "probe did not complete"}
          </p>
        </div>
      </div>
    );
  }

  const ratio = probe.ratio ?? 1;
  const inflated = ratio > 1.05;
  const Icon = inflated ? AlertTriangle : ShieldCheck;

  return (
    <div
      className={`${CARD} overflow-hidden ${inflated ? "border-red-300/70" : "border-emerald-200/70"}`}
    >
      <header
        className={`flex items-center gap-2.5 border-b px-5 py-3 ${
          inflated ? "border-red-200/70 bg-red-50" : "border-emerald-200/70 bg-emerald-50"
        }`}
      >
        <Icon
          className={`h-4 w-4 shrink-0 ${inflated ? "text-red-700" : "text-emerald-700"}`}
          aria-hidden
        />
        <p
          className={`text-[13px] font-medium ${inflated ? "text-red-900" : "text-emerald-900"}`}
        >
          {inflated
            ? `${label} is billing ${ratio.toFixed(2)}x the tokens its own counter reports`
            : `${label} bills what it counts (${ratio.toFixed(2)}x)`}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-px bg-black/[0.07] sm:grid-cols-4">
        <div className="bg-white px-5 py-4">
          <p className={MICRO_LABEL}>It counts</p>
          <p className="mt-2 text-[19px] font-medium tabular-nums text-[#1d1b1b]">
            {formatNumber(probe.countedTokens)}
          </p>
          <p className="mt-1.5 text-[11px] text-[#9a9a9a]">
            {probe.countedCharsPerToken?.toFixed(2)} chars/token
          </p>
        </div>
        <div className="bg-white px-5 py-4">
          <p className={MICRO_LABEL}>It bills</p>
          <p
            className={`mt-2 text-[19px] font-medium tabular-nums ${
              inflated ? "text-red-700" : "text-[#1d1b1b]"
            }`}
          >
            {formatNumber(probe.billedTokens)}
          </p>
          <p className="mt-1.5 text-[11px] text-[#9a9a9a]">
            {probe.billedCharsPerToken?.toFixed(2)} chars/token
          </p>
        </div>
        <div className="bg-white px-5 py-4">
          <p className={MICRO_LABEL}>Ratio</p>
          <p
            className={`mt-2 text-[19px] font-medium tabular-nums ${
              inflated ? "text-red-700" : "text-emerald-700"
            }`}
          >
            {ratio.toFixed(2)}×
          </p>
          <p className="mt-1.5 text-[11px] text-[#9a9a9a]">1.00× is honest</p>
        </div>
        <div className="bg-white px-5 py-4">
          <p className={MICRO_LABEL}>Implied excess</p>
          <p
            className={`mt-2 text-[19px] font-medium tabular-nums ${
              probe.impliedOverchargeUsd ? "text-red-700" : "text-[#1d1b1b]"
            }`}
          >
            {usd(probe.impliedOverchargeUsd)}
          </p>
          <p className="mt-1.5 text-[11px] text-[#9a9a9a]">on this window&rsquo;s billed input</p>
        </div>
      </div>

      <p className="border-t border-black/[0.07] px-5 py-3 text-[12px] leading-relaxed text-[#6b7280]">
        Identical payload of {formatNumber(probe.requestChars)} characters sent to{" "}
        <span style={{ fontFamily: ADMIN_MONO }}>{probe.host}</span> twice — once to{" "}
        <span style={{ fontFamily: ADMIN_MONO }}>/v1/messages/count_tokens</span>, once to{" "}
        <span style={{ fontFamily: ADMIN_MONO }}>/v1/messages</span> with{" "}
        <span style={{ fontFamily: ADMIN_MONO }}>max_tokens: 1</span>. Both numbers are the
        provider&rsquo;s own. Re-measured at most every six hours &mdash; it sends a real billed
        message, so it runs on a slower clock than the read-only usage figures above.
      </p>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderUsage }) {
  const isGateway = p.kind === "gateway";
  const Icon = isGateway ? Server : KeyRound;
  const cache = cacheEfficiency(p);
  const cacheToday = cacheEfficiency(p, "today");

  return (
    <section className={`${CARD} overflow-hidden`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-black/[0.07] px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 bg-[#fbfbf9]">
            <Icon className="h-4 w-4 text-[#6b7280]" aria-hidden />
          </span>
          <div>
            <h2 className="text-[15px] font-medium leading-tight text-[#1d1b1b]">{p.label}</h2>
            <p className="mt-1 text-[11.5px] text-[#6b7280]" style={{ fontFamily: ADMIN_MONO }}>
              {p.host}
            </p>
          </div>
        </div>
        {isGateway ? (
          <span className="rounded-full border border-emerald-200/80 bg-emerald-50 px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wider text-emerald-800">
            Falcon bills here
          </span>
        ) : (
          <span className="rounded-full border border-black/10 bg-[#f3f3f0] px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wider text-[#6b7280]">
            Dev / tooling
          </span>
        )}
      </header>

      {!p.configured ? (
        <div className="px-5 py-6">
          <p className="text-[13.5px] text-[#6b7280]">
            Not configured. Set{" "}
            <code className="rounded bg-[#f3f3f0] px-1.5 py-0.5 text-[12px] text-[#1d1b1b]">
              {isGateway ? "FALCON_GATEWAY_KEY" : "ANTHROPIC_ADMIN_KEY"}
            </code>{" "}
            {isGateway ? (
              <>
                (and{" "}
                <code className="rounded bg-[#f3f3f0] px-1.5 py-0.5 text-[12px] text-[#1d1b1b]">
                  FALCON_GATEWAY_BASE_URL
                </code>{" "}
                if the gateway moves) to read production spend and the remaining balance.
              </>
            ) : (
              <>
                to an Admin key (<span style={{ fontFamily: ADMIN_MONO }}>sk-ant-admin…</span>). A
                workspace-scoped key cannot read the usage and cost reports.
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          {p.error ? (
            <div className="flex items-start gap-2.5 border-b border-amber-200/60 bg-amber-50 px-5 py-3">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden />
              <p className="text-[12.5px] leading-snug text-amber-900">{p.error}</p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-px bg-black/[0.07] sm:grid-cols-4">
            <div className="bg-white px-5 py-4">
              <p className={MICRO_LABEL}>Charged</p>
              <p className="mt-2 text-[20px] font-medium leading-none tabular-nums text-[#1d1b1b]">
                {usd(p.totalCostUsd)}
              </p>
              {isGateway && !p.moneyCalibrated ? (
                <p className="mt-1.5 text-[11px] leading-snug text-red-700">
                  gateway units, not dollars — set FALCON_GATEWAY_TOPUP_USD
                </p>
              ) : isGateway && p.moneyScale ? (
                <p className="mt-1.5 text-[11px] leading-snug text-[#9a9a9a]">
                  calibrated ×{p.moneyScale.toFixed(2)} to real dollars
                </p>
              ) : null}
              {p.listCostUsd && p.totalCostUsd && p.listCostUsd > p.totalCostUsd * 1.05 ? (
                <p className="mt-1.5 text-[11px] leading-snug text-[#9a9a9a]">
                  list {usd(p.listCostUsd)} · billed at{" "}
                  {(100 * (p.totalCostUsd / p.listCostUsd)).toFixed(0)}%
                </p>
              ) : null}
            </div>
            <div className="bg-white px-5 py-4">
              <p className={MICRO_LABEL}>Quota left</p>
              <p className="mt-2 text-[20px] font-medium leading-none tabular-nums text-[#1d1b1b]">
                {usd(p.quotaRemainingUsd)}
              </p>
              <p className="mt-1.5 text-[11px] leading-snug text-[#9a9a9a]">
                {p.quotaLimitUsd
                  ? `of ${usd(p.quotaLimitUsd)} cap${p.quotaMode ? ` · ${p.quotaMode}` : ""}`
                  : "spend cap, not balance"}
              </p>
            </div>
            <div className="bg-white px-5 py-4">
              <p className={MICRO_LABEL}>Requests</p>
              <p className="mt-2 text-[20px] font-medium leading-none tabular-nums text-[#1d1b1b]">
                {p.totalRequests == null ? "—" : formatNumber(p.totalRequests)}
              </p>
            </div>
            <div className="bg-white px-5 py-4">
              <p className={MICRO_LABEL}>Cache read ÷ write</p>
              <p
                className={`mt-2 text-[20px] font-medium leading-none tabular-nums ${
                  cache.tone === "good"
                    ? "text-emerald-700"
                    : cache.tone === "warn"
                      ? "text-amber-700"
                      : "text-red-700"
                }`}
              >
                {cache.ratio == null ? "—" : `${cache.ratio.toFixed(2)}×`}
              </p>
              {cacheToday.ratio != null ? (
                <p
                  className={`mt-1.5 text-[11px] leading-snug ${
                    cacheToday.tone === "good"
                      ? "text-emerald-700"
                      : cacheToday.tone === "warn"
                        ? "text-amber-700"
                        : "text-red-700"
                  }`}
                >
                  today {cacheToday.ratio.toFixed(2)}× · lifetime figure lags a fix
                </p>
              ) : cache.ratio != null && cache.ratio < 0.5 ? (
                <p className="mt-1.5 text-[11px] leading-snug text-red-700">
                  writes never read back
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-px border-t border-black/[0.07] bg-black/[0.07] sm:grid-cols-4">
            {(
              [
                ["Input", p.inputTokens],
                ["Output", p.outputTokens],
                ["Cache read", p.cacheReadTokens],
                ["Cache write", p.cacheCreationTokens],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="bg-[#fbfbf9] px-5 py-3">
                <p className="text-[10.5px] uppercase tracking-wider text-[#9a9a9a]">{label}</p>
                <p className="mt-1 text-[14px] font-medium tabular-nums text-[#1d1b1b]">
                  {compactTokens(value)}
                </p>
              </div>
            ))}
          </div>

          {p.byModel.length > 0 ? (
            <div className="overflow-x-auto px-5 py-4">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-black/10 text-left">
                    <th className={`${MICRO_LABEL} pb-2 font-normal`}>Model</th>
                    <th className={`${MICRO_LABEL} pb-2 text-right font-normal`}>Requests</th>
                    <th className={`${MICRO_LABEL} pb-2 text-right font-normal`}>Input</th>
                    <th className={`${MICRO_LABEL} pb-2 text-right font-normal`}>Output</th>
                    <th className={`${MICRO_LABEL} pb-2 text-right font-normal`}>Cache w/r</th>
                  </tr>
                </thead>
                <tbody>
                  {p.byModel.map((m) => (
                    <tr key={m.model} className="border-b border-black/[0.06] last:border-0">
                      <td className="py-2 pr-3 text-[#1d1b1b]" style={{ fontFamily: ADMIN_MONO }}>
                        {m.model}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[#6b7280]">
                        {m.requests == null ? "—" : formatNumber(m.requests)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[#6b7280]">
                        {compactTokens(m.inputTokens)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[#6b7280]">
                        {compactTokens(m.outputTokens)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[#6b7280]">
                        {compactTokens(m.cacheCreationTokens)} / {compactTokens(m.cacheReadTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {p.raw != null && p.byModel.length === 0 ? (
            <details className="border-t border-black/[0.07] px-5 py-3">
              <summary className="cursor-pointer text-[12px] text-[#6b7280]">
                Raw provider response
              </summary>
              <pre
                className="mt-2 max-h-64 overflow-auto rounded-lg bg-[#fbfbf9] p-3 text-[11px] leading-relaxed text-[#1d1b1b]"
                style={{ fontFamily: ADMIN_MONO }}
              >
                {JSON.stringify(p.raw, null, 2)}
              </pre>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function EngineStrip({ e }: { e: EngineCounters }) {
  if (!e.reachable) {
    return (
      <div className={`${CARD} flex items-start gap-2.5 px-5 py-4`}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
        <div>
          <p className="text-[13.5px] font-medium text-[#1d1b1b]">Engine unreachable</p>
          <p className="mt-1 text-[12.5px] text-[#6b7280]">{e.error ?? "no response"}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={`${CARD} px-5 py-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className={MICRO_LABEL}>Falcon engine</p>
          <p className="mt-1.5 text-[13px] text-[#1d1b1b]">
            Model traffic routes to{" "}
            <span className="font-medium" style={{ fontFamily: ADMIN_MONO }}>
              {e.upstreamHost ?? "unknown"}
            </span>
            {e.keyKind ? (
              <span className="text-[#6b7280]"> · {e.keyKind} key</span>
            ) : null}
            {e.routeOk === false ? (
              <span className="ml-2 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-800">
                route failing
              </span>
            ) : null}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px]">
          <div>
            <dt className="text-[10.5px] uppercase tracking-wider text-[#9a9a9a]">Uptime</dt>
            <dd className="tabular-nums text-[#1d1b1b]">{formatUptime(e.uptimeSeconds)}</dd>
          </div>
          <div>
            <dt className="text-[10.5px] uppercase tracking-wider text-[#9a9a9a]">Tracked</dt>
            <dd className="tabular-nums text-[#1d1b1b]">{e.trackedTickers ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10.5px] uppercase tracking-wider text-[#9a9a9a]">Runs</dt>
            <dd className="tabular-nums text-[#1d1b1b]">{e.propagationRuns ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10.5px] uppercase tracking-wider text-[#9a9a9a]">Loop</dt>
            <dd className={e.loopRunning ? "text-emerald-700" : "text-amber-700"}>
              {e.loopRunning == null ? "—" : e.loopRunning ? "running" : "stopped"}
            </dd>
          </div>
          <div>
            <dt className="text-[10.5px] uppercase tracking-wider text-[#9a9a9a]">Build</dt>
            <dd className="text-[#1d1b1b]" style={{ fontFamily: ADMIN_MONO }}>
              {e.version ?? "—"}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export default async function ApiUsagePage() {
  const snapshot = await getApiUsage(WINDOW_DAYS);
  const { gateway, anthropic, engine } = snapshot;

  // Both accounts get the same check. Verifying only the one we suspect would
  // leave no baseline to say what "honest" looks like on this payload.
  // Sequential, and only once the usage read has finished: the gateway caps
  // concurrency per key, and the engine is already spending part of that budget.
  const gatewayProbe = await runBillingProbe(
    "gateway",
    gateway.inputTokens + gateway.cacheCreationTokens,
  );
  const anthropicProbe = await runBillingProbe(
    "anthropic",
    anthropic.inputTokens + anthropic.cacheCreationTokens,
  );

  const combinedSpend =
    gateway.totalCostUsd == null && anthropic.totalCostUsd == null
      ? null
      : (gateway.totalCostUsd ?? 0) + (anthropic.totalCostUsd ?? 0);

  return (
    <div className={ADMIN_SHELL}>
      <AdminPageHeader
        title="API usage"
        description="Model spend across both billing accounts. Falcon's production traffic and developer tooling bill separately — they are never summed into one number here. The gateway reports its key's lifetime; Anthropic reports the last 7 days."
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Combined charged"
          value={usd(combinedSpend)}
          hint={
            gateway.moneyCalibrated
              ? `Real dollars — gateway units ×${gateway.moneyScale?.toFixed(2)} via FALCON_GATEWAY_TOPUP_USD.`
              : "CAUTION: gateway money fields are internal units, ~7x under real dollars. Set FALCON_GATEWAY_TOPUP_USD to the dashboard lifetime top-ups to calibrate."
          }
        />
        <Stat
          label="Production quota left"
          value={usd(gateway.quotaRemainingUsd)}
          hint={
            gateway.quotaLimitUsd
              ? `${gateway.moneyCalibrated ? "Real credit left" : "Gateway units, NOT dollars"} — of ${usd(gateway.quotaLimitUsd)} ${gateway.moneyCalibrated ? "topped up" : "(uncalibrated)"}. The key stops at zero.`
              : "Spend cap, not the account balance."
          }
          tone={
            gateway.quotaRemainingUsd != null && gateway.quotaLimitUsd
              ? gateway.quotaRemainingUsd < gateway.quotaLimitUsd * 0.1
                ? "bad"
                : gateway.quotaRemainingUsd < gateway.quotaLimitUsd * 0.3
                  ? "warn"
                  : "plain"
              : "plain"
          }
        />
        <Stat
          label="Production spend"
          value={usd(gateway.totalCostUsd)}
          hint={`${gateway.host} · ${gateway.moneyCalibrated ? "real dollars, calibrated" : "gateway units — not dollars until FALCON_GATEWAY_TOPUP_USD is set"}`}
        />
        <Stat label="Dev / tooling spend" value={usd(anthropic.totalCostUsd)} hint={anthropic.host} />
      </div>

      <div className="mt-4">
        <EngineStrip e={engine} />
      </div>

      <section className="mt-6">
        <div className="mb-3 flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-[#6b7280]" aria-hidden />
          <h2 className="text-[14px] font-medium text-[#1d1b1b]">Billing verification</h2>
        </div>
        <div className="grid gap-4">
          <BillingCheck probe={gatewayProbe} label="Gateway" />
          <BillingCheck probe={anthropicProbe} label="Anthropic" />
        </div>
      </section>

      <div className="mt-4 grid gap-4">
        <ProviderCard p={gateway} />
        <ProviderCard p={anthropic} />
      </div>

      <div className={`${CARD} mt-4 flex items-start gap-2.5 px-5 py-4`}>
        <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-[#6b7280]" aria-hidden />
        <p className="text-[12.5px] leading-relaxed text-[#6b7280]">
          Numbers refresh at most every 5 minutes — both providers ask for no more than one poll a
          minute, and usage can lag a request by a few minutes. A high cache write-to-read ratio
          means prompts are paying the 1.25× write premium and never collecting the 0.1× read
          discount, which is worth chasing before anything else on the bill.
        </p>
      </div>
    </div>
  );
}
