import { useCallback, useEffect, useState } from "react";
import type {
  MergedCandidate,
  RejectedCandidate,
  Step1Result,
  Step1Stats,
  ValidatedEdge,
} from "../../../shared/step1-research";
import StockLivePrice from "@/components/stock/StockLivePrice";
import StockPaperTradePanel from "@/components/stock/StockPaperTradePanel";
import ResearchQuotaPill, { type ResearchQuota } from "./ResearchQuotaPill";
import GaugeContextBlock from "@/components/gauge/GaugeContextBlock";
import { useLiveQuote } from "@/hooks/useLiveQuote";
import { hasPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { parseFalconError } from "../../../shared/falcon-errors";
import { fetchLatestSharedStep1, getAccessToken, saveSharedStep1 } from "@/lib/research-jobs";
import { cn } from "@/lib/utils";
import { upperEnglish, useI18n, useT, type MessageKey, type TFunction } from "@/lib/i18n";

type Props = {
  symbol: string;
  companyName?: string;
  exchange?: string;
  /**
   * The filing research alone, for a page that already shows the price, the
   * tape state and the paper account (the Stock tab's Financials section):
   * no price is polled here, and the blocks lose their full-screen spacing.
   */
  researchOnly?: boolean;
};

type UiState =
  | { kind: "idle" }
  | { kind: "running"; stage: string; progress: { current: number; total: number } | null }
  | { kind: "done"; result: Step1Result; fromCache: boolean }
  | { kind: "error"; message: string; code?: string };

type StrengthTier = "critical" | "important" | "marginal";

const STRENGTH_LABEL: Record<StrengthTier, MessageKey> = {
  critical: "stock.strength.critical",
  important: "stock.strength.important",
  marginal: "stock.strength.marginal",
};

/** `.one` or `.other` of a counted message, by the language's plural rule. */
function plural(locale: string, count: number, one: MessageKey, other: MessageKey): MessageKey {
  return new Intl.PluralRules(locale).select(count) === "one" ? one : other;
}

/** A filing date ("2025-02-26") as the reader's language writes it; anything else as given. */
function formatFiledDate(raw: string, locale: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function StrengthChip({
  tier,
  strength,
}: {
  tier?: StrengthTier | null;
  strength?: number | null;
}) {
  const t = useT();
  if (tier !== "critical" && tier !== "important" && tier !== "marginal") {
    return <span className="text-fg-faint">{t("common.na")}</span>;
  }
  const label = t(STRENGTH_LABEL[tier]);
  const title =
    typeof strength === "number" && Number.isFinite(strength)
      ? t("stock.strength.title", { value: strength.toFixed(2), tier: label })
      : label;
  return (
    <span
      title={title}
      className={cn(
        "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
        tier === "critical" && "bg-violet-400/10 text-violet-300/90",
        tier === "important" && "bg-sky-400/10 text-sky-300/90",
        tier === "marginal" && "bg-white/[0.05] text-fg-muted",
      )}
    >
      {label}
    </span>
  );
}

function QuoteCell({ quote }: { quote: string }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const truncated = quote.length > 80 ? `${quote.slice(0, 80)}…` : quote;
  return (
    <button
      type="button"
      className="max-w-md text-left text-xs text-fg-muted hover:text-foreground"
      onClick={() => setOpen((v) => !v)}
      title={t("stock.edges.expandQuote")}
    >
      {open ? quote : truncated}
    </button>
  );
}

function groupEdges(edges: ValidatedEdge[]): Array<{ groupId: string; edges: ValidatedEdge[] }> {
  const byGroup = new Map<string, ValidatedEdge[]>();
  const order: string[] = [];
  for (const edge of edges) {
    const groupId =
      edge.shared_evidence_group ??
      `solo_${edge.counterparty_name}_${edge.category}_${edge.evidence[0]?.quote ?? ""}`;
    if (!byGroup.has(groupId)) {
      byGroup.set(groupId, []);
      order.push(groupId);
    }
    byGroup.get(groupId)!.push(edge);
  }
  return order.map((groupId) => ({ groupId, edges: byGroup.get(groupId)! }));
}

function CompactCounterparties({ edges }: { edges: ValidatedEdge[] }) {
  return (
    <div className="space-y-1">
      {edges.map((e) => (
        <div key={`${e.counterparty_name}-${e.category}`} className="flex flex-wrap items-center gap-1.5 leading-snug">
          <span className="text-foreground">{e.counterparty_name}</span>
          {e.counterparty_ticker ? (
            <span className="tabular-nums text-fg-muted">({e.counterparty_ticker})</span>
          ) : null}
          <span className="text-fg-muted">
            · {e.category}
            {e.subtype ? ` · ${e.subtype}` : ""}
          </span>
          <StrengthChip tier={e.strength_tier} strength={e.strength} />
        </div>
      ))}
    </div>
  );
}

function EdgeRow({
  edge,
  showEvidence,
  evidenceRowSpan,
}: {
  edge: ValidatedEdge;
  showEvidence: boolean;
  evidenceRowSpan?: number;
}) {
  const t = useT();
  return (
    <tr className="border-b border-white/[0.06]">
      <td className="px-2 py-2 text-foreground">{edge.counterparty_name}</td>
      <td className="px-2 py-2 tabular-nums text-fg-muted">{edge.counterparty_ticker ?? t("common.na")}</td>
      <td className="px-2 py-2 text-fg-muted">{edge.category}</td>
      <td className="px-2 py-2 text-fg-muted">{edge.subtype || t("common.na")}</td>
      <td className="px-2 py-2">
        <StrengthChip tier={edge.strength_tier} strength={edge.strength} />
      </td>
      {showEvidence ? (
        <td className="px-2 py-2 align-top" rowSpan={evidenceRowSpan}>
          <QuoteCell quote={edge.evidence[0]?.quote ?? ""} />
        </td>
      ) : null}
    </tr>
  );
}

function EvidenceGroupBlock({ group }: { group: { groupId: string; edges: ValidatedEdge[] } }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const quote = group.edges[0]?.evidence[0]?.quote ?? "";
  const isMulti = group.edges.length > 1;

  if (!isMulti) {
    return <EdgeRow edge={group.edges[0]!} showEvidence evidenceRowSpan={1} />;
  }

  if (!open) {
    return (
      <tr className="border-b border-white/[0.06]">
        <td className="px-2 py-2 align-top" colSpan={5}>
          <button
            type="button"
            className="mb-1.5 text-xs text-fg-muted hover:text-foreground"
            onClick={() => setOpen(true)}
          >
            ▸ {t("stock.edges.sharedEvidence", { count: group.edges.length })}
          </button>
          <CompactCounterparties edges={group.edges} />
        </td>
        <td className="px-2 py-2 align-top">
          <QuoteCell quote={quote} />
        </td>
      </tr>
    );
  }

  return (
    <>
      {group.edges.map((edge, i) => (
        <tr key={`${edge.counterparty_name}-${edge.category}-${i}`} className="border-b border-white/[0.06]">
          <td className="px-2 py-2 text-foreground">{edge.counterparty_name}</td>
          <td className="px-2 py-2 tabular-nums text-fg-muted">{edge.counterparty_ticker ?? t("common.na")}</td>
          <td className="px-2 py-2 text-fg-muted">{edge.category}</td>
          <td className="px-2 py-2 text-fg-muted">{edge.subtype || t("common.na")}</td>
          <td className="px-2 py-2">
            <StrengthChip tier={edge.strength_tier} strength={edge.strength} />
          </td>
          {i === 0 ? (
            <td className="px-2 py-2 align-top" rowSpan={group.edges.length}>
              <button
                type="button"
                className="mb-1.5 block text-xs text-fg-muted hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                ▾ {t("stock.edges.collapse")}
              </button>
              <QuoteCell quote={quote} />
            </td>
          ) : null}
        </tr>
      ))}
    </>
  );
}

function EdgesTable({ edges }: { edges: ValidatedEdge[] }) {
  const groups = groupEdges(edges);
  const t = useT();
  return (
    <div className="w-full overflow-auto">
      <table className="w-full min-w-[800px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-white/[0.1] text-fg-faint">
            <th className="px-2 py-2 font-medium">{t("stock.edges.counterparty")}</th>
            <th className="px-2 py-2 font-medium">{t("stock.edges.ticker")}</th>
            <th className="px-2 py-2 font-medium">{t("stock.edges.category")}</th>
            <th className="px-2 py-2 font-medium">{t("stock.edges.subtype")}</th>
            <th className="px-2 py-2 font-medium">{t("stock.edges.strength")}</th>
            <th className="px-2 py-2 font-medium">{t("stock.edges.evidence")}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <EvidenceGroupBlock key={group.groupId} group={group} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isContentSuspect(stats: Step1Stats): boolean {
  return stats.content_suspect === true;
}

function isSectionSuspect(stats: Step1Stats, form: string): boolean {
  const is10K = form === "10-K" || stats.form_type === "10-K";
  if (is10K && stats.section_chars < 60_000) return true;
  if (stats.chunks > 0 && stats.parse_errors / stats.chunks > 0.3) return true;
  return false;
}

function formatStatsLine(stats: Step1Stats, t: TFunction, locale: string): string {
  const perChunk =
    stats.candidates_per_chunk.length > 0
      ? `[${stats.candidates_per_chunk.join(",")}]`
      : "[]";
  const parts = [
    stats.section_extraction_failed ? t("stock.stats.sectionFailed") : null,
    t("stock.stats.section", { method: stats.section_method }),
    t("stock.stats.chars", { count: stats.section_chars.toLocaleString("en-US") }),
    t(plural(locale, stats.chunks, "stock.stats.chunks.one", "stock.stats.chunks.other"), { count: stats.chunks }),
    t("stock.stats.perChunk", { list: perChunk }),
    t("stock.stats.apiErrors", { count: stats.api_errors }),
    t("stock.stats.parseErrors", { count: stats.parse_errors }),
    t("stock.stats.extracted", { count: stats.candidates_extracted }),
    t("stock.stats.dropped", { count: stats.dropped_low_confidence }),
    t("stock.stats.deduped", { count: stats.deduped }),
    t("stock.stats.quoteRejected", { count: stats.rejected_quote_not_found }),
    t("stock.stats.auditorRejected", { count: stats.rejected_by_auditor }),
    t("stock.stats.validated", { count: stats.validated }),
    stats.fetch_seconds != null ||
    stats.extract_seconds != null ||
    stats.audit_seconds != null
      ? t("stock.stats.timing", {
          fetch: stats.fetch_seconds ?? 0,
          extract: stats.extract_seconds ?? 0,
          audit: stats.audit_seconds ?? 0,
        })
      : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function MergedSection({ merged }: { merged: MergedCandidate[] }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  if (merged.length === 0) return null;
  return (
    <div className="mt-6 border-t border-white/[0.08] pt-4">
      <button
        type="button"
        className="text-xs text-fg-muted hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} {t("stock.merged", { count: merged.length })}
      </button>
      {open ? (
        <ul className="mt-3 max-h-64 space-y-2 overflow-auto text-xs text-fg-muted">
          {merged.map((m, i) => (
            <li key={`${m.counterparty_name}-${i}`}>
              <span className="text-foreground">{m.counterparty_name}</span>
              {" · "}
              {m.category}
              {" → "}
              {m.merged_into}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RejectedSection({ rejected }: { rejected: RejectedCandidate[] }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  if (rejected.length === 0) return null;
  return (
    <div className="mt-6 border-t border-white/[0.08] pt-4">
      <button
        type="button"
        className="text-xs text-fg-muted hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} {t("stock.rejected", { count: rejected.length })}
      </button>
      {open ? (
        <ul className="mt-3 max-h-64 space-y-2 overflow-auto text-xs text-fg-muted">
          {rejected.map((r, i) => (
            <li key={`${r.counterparty_name}-${i}`}>
              <span className="text-foreground">{r.counterparty_name}</span>
              {" · "}
              {r.category}
              {": "}
              {r.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function StockView({ symbol, researchOnly = false }: Props) {
  const [ui, setUi] = useState<UiState>({ kind: "idle" });
  const [paperAccount, setPaperAccount] = useState(hasPaperAccount);
  const { t, locale } = useI18n();

  // Shown on every screen except the analysis progress view.
  const live = useLiveQuote(symbol, { enabled: !researchOnly && ui.kind !== "running" });

  useEffect(() => subscribePaperAccount(() => setPaperAccount(hasPaperAccount())), []);

  useEffect(() => {
    let cancelled = false;
    const api = window.meridian;
    if (!api?.getStep1ResearchResult) {
      setUi({ kind: "idle" });
      return;
    }

    void (async () => {
      try {
        const shared = await fetchLatestSharedStep1(symbol);
        if (cancelled) return;
        if (shared) {
          setUi({ kind: "done", result: shared, fromCache: true });
          return;
        }
      } catch {
        /* fall through to local disk */
      }

      const token = await getAccessToken().catch(() => undefined);
      const res = await api.getStep1ResearchResult!(symbol, token);
      if (cancelled) return;
      if (res.ok) {
        setUi({ kind: "done", result: res.result, fromCache: res.result.fromCache !== false });
      } else {
        setUi({ kind: "idle" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const run = useCallback(async (force = false) => {
    const api = window.meridian;
    if (!api?.startStep1Research || !api.getStep1ResearchStatus || !api.getStep1ResearchResult) {
      setUi({
        kind: "error",
        message: t("stock.error.restart"),
        code: "FAL-INT-01",
      });
      return;
    }

    const token = await getAccessToken().catch(() => undefined);
    setUi({ kind: "running", stage: t("stock.running.starting"), progress: null });

    let jobId: string;
    let via: "worker" | "local" | undefined;
    try {
      const started = await api.startStep1Research(symbol, { force, accessToken: token });
      if (!started.ok) {
        setUi({ kind: "error", message: started.error, code: started.code });
        return;
      }
      jobId = started.jobId;
      via = started.via;

      if (started.fromCache) {
        const resultRes = await api.getStep1ResearchResult!(symbol, token);
        if (resultRes.ok) {
          if (via === "local") void saveSharedStep1(resultRes.result);
          setUi({ kind: "done", result: resultRes.result, fromCache: true });
          return;
        }
      }
    } catch (e) {
      const mapped = parseFalconError(e instanceof Error ? e.message : String(e));
      setUi({ kind: "error", message: mapped.message, code: mapped.code });
      return;
    }

    // poll every 2s; retry "job not found" once (race on first call)
    let notFoundRetries = 0;

    const poll = async () => {
      try {
        const status = await api.getStep1ResearchStatus(jobId, token);

        if (!status.ok) {
          if (notFoundRetries < 2) {
            notFoundRetries++;
            window.setTimeout(() => void poll(), 1500);
          } else {
            setUi({ kind: "error", message: status.error, code: status.code });
          }
          return;
        }

        notFoundRetries = 0;

        if (status.error) {
          setUi({
            kind: "error",
            message: status.error,
            code: status.code ?? undefined,
          });
          return;
        }

        if (status.done) {
          const resultRes = await api.getStep1ResearchResult!(symbol, token);
          if (!resultRes.ok) {
            setUi({ kind: "error", message: resultRes.error, code: resultRes.code });
            return;
          }
          if (via === "local") void saveSharedStep1(resultRes.result);
          setUi({ kind: "done", result: resultRes.result, fromCache: false });
          return;
        }

        setUi({ kind: "running", stage: status.stage, progress: status.progress ?? null });
        window.setTimeout(() => void poll(), 2000);
      } catch (e) {
        const mapped = parseFalconError(e instanceof Error ? e.message : String(e));
        setUi({ kind: "error", message: mapped.message, code: mapped.code });
      }
    };

    window.setTimeout(() => void poll(), 1200);
  }, [symbol, t]);

  const [quota, setQuota] = useState<ResearchQuota | null>(null);
  useEffect(() => {
    // Refreshed when the view opens and after a run finishes — the countdown
    // itself ticks locally, so this does not need to poll.
    let cancelled = false;
    void (async () => {
      const api = window.meridian;
      if (!api?.getStep1ResearchQuota) return;
      const token = await getAccessToken().catch(() => undefined);
      const res = await api.getStep1ResearchQuota(token);
      if (!cancelled) setQuota(res.ok ? res.quota : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, ui.kind]);

  if (ui.kind === "idle" && researchOnly) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run(false)}
          disabled={quota ? !quota.allowed : false}
          className="glass-cta btn-quiet rounded-full px-4 py-1.5 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("stock.begin")}
        </button>
        <ResearchQuotaPill quota={quota} />
      </div>
    );
  }

  if (ui.kind === "idle") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto py-6">
        <p lang="en" className="text-xs uppercase tracking-[0.12em] text-fg-faint">{symbol}</p>

        <StockLivePrice state={live} />

        {/* Gauge (spec §8 stock page block): standalone tape state — tracked tickers only say more than "not tracked". */}
        <GaugeContextBlock ticker={symbol} context={null} surface="stock" title={t("stock.gaugeTitle")} className="w-full max-w-md rounded-xl border border-[#e6e6e0] bg-[#fbfbf9] px-3.5 py-3 text-left" />

        {paperAccount ? (
          <StockPaperTradePanel symbol={symbol} price={live.quote?.price ?? null} />
        ) : null}

        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => void run(false)}
            disabled={quota ? !quota.allowed : false}
            className="border-0 bg-white px-8 py-2.5 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("stock.begin")}
          </button>
          <ResearchQuotaPill quota={quota} />
        </div>
      </div>
    );
  }

  if (ui.kind === "running") {
    const stageLower = ui.stage.toLowerCase();
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col gap-3",
          researchOnly ? "items-start" : "flex-1 items-center justify-center px-8",
        )}
      >
        {researchOnly ? null : <p lang="en" className="text-xs uppercase tracking-[0.12em] text-fg-faint">{symbol}</p>}
        <ul className="w-full max-w-md space-y-2 text-sm">
          <li
            className={
              stageLower.includes("10-k") || stageLower.includes("fetching")
                ? "text-foreground"
                : "text-fg-muted"
            }
          >
            {t("stock.running.fetch")}
          </li>
          <li
            className={stageLower.includes("extracting") ? "text-foreground" : "text-fg-muted"}
          >
            {stageLower.includes("extracting") ? ui.stage : t("stock.running.extract")}
          </li>
          <li className={stageLower.includes("auditing") ? "text-foreground" : "text-fg-muted"}>
            {stageLower.includes("auditing") ? ui.stage : t("stock.running.audit")}
          </li>
        </ul>
        <p className="mt-1 text-xs text-fg-faint">{ui.stage}</p>
      </div>
    );
  }

  if (ui.kind === "error") {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col gap-4",
          researchOnly ? "items-start" : "flex-1 items-center justify-center px-8",
        )}
      >
        {researchOnly ? null : <p lang="en" className="text-xs uppercase tracking-[0.12em] text-fg-faint">{symbol}</p>}
        <p className={cn("max-w-md text-sm text-red-300", !researchOnly && "text-center")}>{ui.message}</p>
        {ui.code ? (
          <p className="text-[11px] uppercase tracking-[0.12em] text-fg-faint">{t("stock.errorRef", { code: upperEnglish(ui.code) })}</p>
        ) : null}
        <button
          type="button"
          onClick={() => void run(false)}
          className="border-0 bg-white px-8 py-2.5 text-sm font-semibold text-black transition hover:bg-white/90"
        >
          {t("stock.retry")}
        </button>
      </div>
    );
  }

  // done
  const form = ui.result.form || ui.result.stats?.form_type || "10-K";
  const filedRaw = ui.result.filingDate || ui.result.stats?.filing_date || "";
  const filed = filedRaw ? formatFiledDate(filedRaw, locale) : null;
  const sectionSuspect =
    ui.result.stats != null && isSectionSuspect(ui.result.stats, form);
  const contentSuspect =
    ui.result.stats != null && isContentSuspect(ui.result.stats);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", researchOnly ? "" : "flex-1 overflow-auto px-8 py-6")}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          {researchOnly ? null : <p lang="en" className="text-xs uppercase tracking-[0.12em] text-fg-faint">{symbol}</p>}
          <p className="mt-1 text-sm text-fg-muted">
            {t(
              plural(locale, ui.result.validated.length, "stock.result.validated.one", "stock.result.validated.other"),
              { count: ui.result.validated.length },
            )}
            {` · ${form}`}
            {filed ? ` · ${t("stock.result.filed", { date: filed })}` : null}
            {ui.fromCache ? (
              <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-faint">
                {t("stock.badge.cached")}
              </span>
            ) : null}
            {sectionSuspect ? (
              <span className="ml-2 rounded bg-yellow-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-yellow-300">
                {t("stock.badge.sectionSuspect")}
              </span>
            ) : null}
            {contentSuspect ? (
              <span className="ml-2 rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-orange-300">
                {t("stock.badge.contentSuspect")}
              </span>
            ) : null}
          </p>
          {ui.result.stats ? (
            <p className="mt-1 text-xs text-fg-faint">{formatStatsLine(ui.result.stats, t, locale)}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {researchOnly ? null : <StockLivePrice state={live} variant="inline" />}
          <button
            type="button"
            onClick={() => void run(true)}
            className="border-0 bg-white px-4 py-1.5 text-xs font-semibold text-black transition hover:bg-white/90"
          >
            {t("stock.forceRerun")}
          </button>
        </div>
      </div>
      {paperAccount && !researchOnly ? (
        <StockPaperTradePanel
          symbol={symbol}
          price={live.quote?.price ?? null}
          variant="bar"
          className="mb-4"
        />
      ) : null}
      <EdgesTable edges={ui.result.validated} />
      <MergedSection merged={ui.result.merged ?? []} />
      <RejectedSection rejected={ui.result.rejected} />
    </div>
  );
}
