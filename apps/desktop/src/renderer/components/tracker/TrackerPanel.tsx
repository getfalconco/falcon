import { na } from "@/lib/i18n/na";
import { withClock } from "@/lib/clock";
import { shortcutText } from "@/lib/shortcuts";
import { useIsStaff } from "@/lib/staff";
import { useI18n, type MessageKey, type TFunction } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, RefreshCw, X } from "lucide-react";
import TrackerDataView from "./TrackerDataView";
import { Toaster } from "@/components/ui/sonner";
import { trackerTypeLabel } from "./tracker-labels";
import {
  TRACKER_ANOMALY_TYPES,
  type TrackerMessage,
  type TrackerMessageType,
  type TrackerQuantContext,
  type TrackerStatus,
} from "../../../shared/tracker-types";

/**
 * Tracker (Engine1) live monitor. Opened only by Shift+T — it is an internal
 * instrument panel, not part of the product surface.
 */

type Filter = "all" | "anomalies" | "channels";

const CHANNEL_TYPES: TrackerMessageType[] = [
  "news_item",
  "filing_item",
  "insider_filing",
  "scheduled_event",
];

const ANOMALY_SET = new Set<TrackerMessageType>(TRACKER_ANOMALY_TYPES);

const FILTER_LABEL: Record<Filter, MessageKey> = {
  all: "instruments.common.all",
  anomalies: "instruments.tracker.filter.anomalies",
  channels: "instruments.tracker.filter.channels",
};

const MODE_LABEL: Record<"stream" | "data", MessageKey> = {
  stream: "instruments.tracker.mode.stream",
  data: "instruments.tracker.mode.data",
};

function fmtPct(value: number | null, digits = 2): string {
  if (value == null) return na();
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtNum(value: number | null, digits = 2): string {
  if (value == null) return na();
  return value.toFixed(digits);
}

function fmtTime(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(locale, withClock({ hour: "2-digit", minute: "2-digit", second: "2-digit" }));
}

function headlineFor(message: TrackerMessage, t: TFunction): string {
  const p = message.payload as Record<string, unknown>;
  switch (message.type) {
    case "news_item":
      return String(p.headline ?? "");
    case "filing_item": {
      const form = String(p.form_type ?? "");
      return Array.isArray(p.item_codes) && p.item_codes.length > 0
        ? t("instruments.tracker.line.filedItems", { form, items: (p.item_codes as string[]).join(", ") })
        : t("instruments.tracker.line.filed", { form });
    }
    case "insider_filing":
      return `${t("instruments.tracker.line.insider", {
        name: String(p.insider_name ?? ""),
        role: String(p.role ?? ""),
        code: String(p.transaction_code ?? "?"),
      })}${p.is_10b5_1_plan ? " · 10b5-1" : ""}`;
    case "scheduled_event":
      return `${t("instruments.tracker.line.earnings", {
        period: String(p.fiscal_period ?? ""),
        date: String(p.due_at ?? "").slice(0, 10),
      })}${p.rescheduled ? ` ${t("instruments.tracker.line.rescheduled")}` : ""}`;
    case "gap_event":
      return t("instruments.tracker.line.gap", {
        pct: fmtPct(p.gap_pct as number),
        z: fmtNum(p.gap_z as number),
        direction: String(p.direction ?? ""),
      });
    case "volume_anomaly":
      return t("instruments.tracker.line.volume", { ratio: fmtNum(p.volume_ratio as number) });
    case "silence_anomaly":
      return t("instruments.tracker.line.silence", {
        n: String(p.trading_days_silent ?? ""),
        rate: fmtNum(p.expected_daily_article_rate as number, 1),
      });
    case "filing_overdue":
      return t("instruments.tracker.line.overdue", {
        form: String(p.expected_form ?? ""),
        n: String(p.business_days_overdue ?? ""),
      });
    case "unexplained_move":
      return t("instruments.tracker.line.unexplained", {
        direction: String(p.direction ?? ""),
        measure: String(p.measure_used ?? ""),
        z: fmtNum(p.residual_zscore as number),
      });
    case "drift_event":
      return t("instruments.tracker.line.drift", {
        pct: fmtPct(p.momentum_5d as number),
        z: fmtNum(p.drift_z as number),
      });
    case "news_burst":
      return t("instruments.tracker.line.burst", {
        n: String(p.articles_last_24h ?? ""),
        multiple: fmtNum(p.burst_multiple as number, 1),
      });
    case "insider_cluster":
      return t("instruments.tracker.line.cluster", {
        n: String(p.insider_count ?? ""),
        direction: String(p.direction ?? ""),
        days: String(p.window_business_days ?? ""),
      });
    default:
      return message.type;
  }
}

function QuantStrip({ quant }: { quant: TrackerQuantContext }) {
  const cells: Array<[string, string]> = [
    ["β90", fmtNum(quant.beta_90d)],
    ["r²", fmtNum(quant.r_squared)],
    ["vol30", fmtPct(quant.daily_vol_30d)],
    ["regime", fmtNum(quant.vol_regime)],
    ["move", fmtPct(quant.move_today)],
    ["move z", fmtNum(quant.move_zscore)],
    ["resid z", fmtNum(quant.residual_zscore)],
    [
      "vol×",
      quant.volume_ratio == null
        ? na()
        : `${fmtNum(quant.volume_ratio, 1)}${quant.volume_ratio_partial ? "*" : ""}`,
    ],
    ["5d", fmtPct(quant.momentum_5d)],
    ["52wH", fmtPct(quant.pct_from_52w_high)],
    ["rhythm", fmtPct(quant.earnings_rhythm)],
  ];
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-content-tertiary">
      {cells.map(([label, value]) => (
        <span key={label}>
          <span className="text-content-disabled">{label}</span> {value}
        </span>
      ))}
    </div>
  );
}

export default function TrackerPanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  // A manual cycle polls the providers for the shared universe, for every
  // account; the engine takes it from staff only.
  const staff = useIsStaff();
  const [messages, setMessages] = useState<TrackerMessage[]>([]);
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [tickerFilter, setTickerFilter] = useState<string>("all");
  const [mode, setMode] = useState<"stream" | "data">("stream");
  const [dataTicker, setDataTicker] = useState<string | null>(null);
  const [cycling, setCycling] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [msgRes, statusRes] = await Promise.all([
        window.meridian?.getTrackerMessages({ limit: 300 }),
        window.meridian?.getTrackerStatus(),
      ]);
      if (cancelled) return;
      if (msgRes?.ok) setMessages(msgRes.messages);
      if (statusRes?.ok) setStatus(statusRes.status);
    };
    void load();

    const unsubscribe = window.meridian?.onTrackerEvent((message) => {
      setMessages((prev) => [message, ...prev].slice(0, 500));
    });

    const statusTimer = setInterval(() => {
      void window.meridian?.getTrackerStatus().then((res) => {
        if (!cancelled && res?.ok) setStatus(res.status);
      });
    }, 15_000);

    return () => {
      cancelled = true;
      unsubscribe?.();
      clearInterval(statusTimer);
    };
  }, []);

  // Escape closes; Shift+T toggling is owned by the host.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tickers = useMemo(
    () => (status?.tickers ?? []).map((t) => t.ticker),
    [status],
  );

  // Default the data browser to the first tracked ticker once status arrives.
  const activeDataTicker = dataTicker ?? tickers[0] ?? null;

  const progress = useMemo(() => {
    const all = status?.tickers ?? [];
    const done = all.filter((t) => t.backfilled).length;
    const insiderDone = all.filter((t) => t.insiderSeeded).length;
    return {
      total: all.length,
      done,
      pending: all.length - done,
      insiderDone,
      insiderPending: all.length - insiderDone,
    };
  }, [status]);

  const visible = useMemo(() => {
    return messages.filter((m) => {
      if (tickerFilter !== "all" && m.ticker !== tickerFilter) return false;
      if (filter === "anomalies") return ANOMALY_SET.has(m.type);
      if (filter === "channels") return CHANNEL_TYPES.includes(m.type);
      return true;
    });
  }, [messages, filter, tickerFilter]);

  const runCycle = async () => {
    setCycling(true);
    try {
      const res = await window.meridian?.runTrackerCycle();
      if (res?.ok) setStatus(res.status);
      const msgRes = await window.meridian?.getTrackerMessages({ limit: 300 });
      if (msgRes?.ok) setMessages(msgRes.messages);
    } finally {
      setCycling(false);
    }
  };

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-black/25 backdrop-blur-[2px]">
      <Toaster position="bottom-right" style={{ zIndex: 300 }} />
      <div className="flex h-[86%] w-[92%] flex-col overflow-hidden rounded-xl border border-edge bg-surface-2 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
          <Activity className="h-4 w-4 shrink-0 text-content-primary" strokeWidth={2} aria-hidden />
          <span className="font-baskerville text-[15px] text-content-primary">Tracker</span>
          <span className="min-w-0 truncate font-mono text-[11px] text-content-tertiary">
            {status?.running ? t("instruments.tracker.running") : t("instruments.tracker.notRunning")} ·{" "}
            {t("instruments.tracker.emitted", { n: status?.messagesEmitted ?? 0 })}
            {progress.pending > 0 && (
              <span className="text-tone-warning">
                {" "}
                · {t("instruments.tracker.backfilling", { done: progress.done, total: progress.total })}
              </span>
            )}
            {status?.rateLimits &&
              status.rateLimits.news +
                status.rateLimits.calendar +
                status.rateLimits.filings +
                status.rateLimits.price >
                0 && (
                <span
                  className="text-tone-warning"
                  title={t("instruments.tracker.rateLimitHint", { day: status.rateLimits.day })}
                >
                  {" "}
                  ·{" "}
                  {t("instruments.tracker.rateLimits", {
                    news: status.rateLimits.news,
                    calendar: status.rateLimits.calendar,
                    filings: status.rateLimits.filings,
                  })}
                </span>
              )}
            {progress.pending === 0 && progress.insiderPending > 0 && (
              <span className="text-tone-warning">
                {" "}
                · {t("instruments.tracker.seeding", { done: progress.insiderDone, total: progress.total })}
              </span>
            )}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="flex rounded-md border border-edge bg-white p-0.5">
              {(["stream", "data"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded px-2 py-1 text-[11px] transition-colors ${
                    mode === m ? "bg-ink text-white" : "text-content-secondary hover:text-content-primary"
                  }`}
                >
                  {t(MODE_LABEL[m])}
                </button>
              ))}
            </div>

            {mode === "stream" && (
              <div className="flex rounded-md border border-edge bg-white p-0.5">
                {(["all", "anomalies", "channels"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`rounded px-2 py-1 text-[11px] transition-colors ${
                      filter === f
                        ? "bg-ink text-white"
                        : "text-content-secondary hover:text-content-primary"
                    }`}
                  >
                    {t(FILTER_LABEL[f])}
                  </button>
                ))}
              </div>
            )}

            {mode === "stream" ? (
              <select
                value={tickerFilter}
                onChange={(e) => setTickerFilter(e.target.value)}
                className="rounded-md border border-edge bg-white px-2 py-1 text-[11px] text-content-primary"
              >
                <option value="all">{t("instruments.common.allTickers")}</option>
                {tickers.map((tk) => (
                  <option key={tk} value={tk}>
                    {tk}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={activeDataTicker ?? ""}
                onChange={(e) => setDataTicker(e.target.value)}
                className="rounded-md border border-edge bg-white px-2 py-1 text-[11px] text-content-primary"
              >
                {tickers.map((tk) => (
                  <option key={tk} value={tk}>
                    {tk}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => void runCycle()}
              disabled={!staff || cycling}
              title={staff ? undefined : t("access.staffOnly.action")}
              className="flex items-center gap-1.5 rounded-md border border-edge bg-white px-2 py-1 text-[11px] text-content-secondary transition-colors hover:text-content-primary disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${cycling ? "animate-spin" : ""}`}
                strokeWidth={2}
                aria-hidden
              />
              {t("instruments.tracker.cycle")}
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label={t("instruments.tracker.closeLabel")}
              title={t("instruments.tracker.closeLabel")}
              className="rounded-md p-1 text-content-secondary transition-colors hover:bg-surface-3 hover:text-content-primary"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>

        {/* Ticker health row — click a ticker to inspect its raw data */}
        <div className="max-h-[76px] overflow-y-auto border-b border-edge-subtle px-4 py-2">
          <div className="flex flex-wrap gap-1.5">
            {(status?.tickers ?? []).map((tk) => {
              const errors = Object.entries(tk.health).filter(([, h]) => h.last_error);
              const selected = mode === "data" && activeDataTicker === tk.ticker;
              return (
                <button
                  key={tk.ticker}
                  type="button"
                  onClick={() => {
                    setDataTicker(tk.ticker);
                    setMode("data");
                  }}
                  title={[
                    errors.length > 0
                      ? errors.map(([c, h]) => `${c}: ${h.last_error}`).join("\n")
                      : t("instruments.tracker.healthy"),
                    tk.insiderSeeded ? null : t("instruments.tracker.insiderNotSeeded"),
                  ]
                    .filter(Boolean)
                    .join("\n")}
                  className={`flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 transition-colors ${
                    selected
                      ? "border-content-primary bg-ink"
                      : "border-edge bg-white hover:border-edge-strong"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      !tk.backfilled
                        ? "bg-fill-strong"
                        : errors.length > 0
                          ? "bg-tone-warning-fill"
                          : "bg-tone-positive-fill"
                    }`}
                    aria-hidden
                  />
                  <span
                    className={`font-mono text-[11px] ${selected ? "text-white" : "text-content-primary"}`}
                  >
                    {tk.ticker}
                  </span>
                </button>
              );
            })}
            {(status?.tickers.length ?? 0) === 0 && (
              <span className="font-mono text-[11px] text-content-tertiary">{t("instruments.tracker.noTickers")}</span>
            )}
          </div>
        </div>

        {/* Raw data browser */}
        {mode === "data" && (
          <div className="min-h-0 flex-1 overflow-hidden px-4 py-2">
            {activeDataTicker ? (
              <TrackerDataView ticker={activeDataTicker} />
            ) : (
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-content-tertiary">
                {t("instruments.tracker.noTickerSelected")}
              </div>
            )}
          </div>
        )}

        {/* Message stream */}
        {mode === "stream" && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {visible.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center font-mono text-[12px] text-content-tertiary">
              {t("instruments.tracker.empty")}
            </div>
          ) : (
            <ul className="divide-y divide-edge-subtle">
              {visible.map((message) => (
                <li key={message.id} className="py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-content-tertiary">
                      {fmtTime(message.timestamp, locale)}
                    </span>
                    <span className="font-mono text-[11px] font-medium text-content-primary">
                      {message.ticker}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        ANOMALY_SET.has(message.type)
                          ? "bg-tone-warning-soft text-tone-warning"
                          : "bg-surface-2 text-content-body"
                      }`}
                    >
                      {trackerTypeLabel(t, message.type)}
                    </span>
                    {message.context_flags.map((flag) => (
                      <span
                        key={flag}
                        className="rounded bg-tone-info-soft px-1.5 py-0.5 font-mono text-[10px] text-tone-violet"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 text-[12px] leading-snug text-content-body">
                    {headlineFor(message, t)}
                  </div>
                  <QuantStrip quant={message.quant_context} />
                </li>
              ))}
            </ul>
          )}
        </div>
        )}

        <div className="border-t border-edge-subtle px-4 py-1.5 font-mono text-[10px] text-content-tertiary">
          {t("instruments.tracker.footer", { key: shortcutText("tracker"), n: status?.tickers.length ?? 0, dash: na() })}
        </div>
      </div>
    </div>
  );
}
