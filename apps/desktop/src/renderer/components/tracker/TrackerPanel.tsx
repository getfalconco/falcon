import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, RefreshCw, X } from "lucide-react";
import TrackerDataView from "./TrackerDataView";
import { Toaster } from "@/components/ui/sonner";
import {
  TRACKER_ANOMALY_TYPES,
  TRACKER_TYPE_LABELS,
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

function fmtPct(value: number | null, digits = 2): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtNum(value: number | null, digits = 2): string {
  if (value == null) return "—";
  return value.toFixed(digits);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function headlineFor(message: TrackerMessage): string {
  const p = message.payload as Record<string, unknown>;
  switch (message.type) {
    case "news_item":
      return String(p.headline ?? "");
    case "filing_item": {
      const items = Array.isArray(p.item_codes) && p.item_codes.length > 0
        ? ` — items ${(p.item_codes as string[]).join(", ")}`
        : "";
      return `${String(p.form_type ?? "")} filed${items}`;
    }
    case "insider_filing":
      return `${String(p.insider_name ?? "")} (${String(p.role ?? "")}) — code ${String(
        p.transaction_code ?? "?",
      )}${p.is_10b5_1_plan ? " · 10b5-1" : ""}`;
    case "scheduled_event":
      return `Earnings ${String(p.fiscal_period ?? "")} due ${String(p.due_at ?? "").slice(0, 10)}${
        p.rescheduled ? " (rescheduled)" : ""
      }`;
    case "gap_event":
      return `Gap ${fmtPct(p.gap_pct as number)} · z ${fmtNum(p.gap_z as number)} ${String(
        p.direction ?? "",
      )}`;
    case "volume_anomaly":
      return `Volume ${fmtNum(p.volume_ratio as number)}× baseline`;
    case "silence_anomaly":
      return `${String(p.trading_days_silent ?? "")} silent trading days vs ${fmtNum(
        p.expected_daily_article_rate as number,
        1,
      )}/day baseline`;
    case "filing_overdue":
      return `${String(p.expected_form ?? "")} overdue by ${String(
        p.business_days_overdue ?? "",
      )} business days`;
    case "unexplained_move":
      return `${String(p.direction ?? "")} move, ${String(p.measure_used ?? "")} ${fmtNum(
        p.residual_zscore as number,
      )}, no news`;
    case "drift_event":
      return `Drift ${fmtPct(p.momentum_5d as number)} over 5d · z ${fmtNum(p.drift_z as number)}`;
    case "news_burst":
      return `${String(p.articles_last_24h ?? "")} articles in 24h · ${fmtNum(
        p.burst_multiple as number,
        1,
      )}× baseline`;
    case "insider_cluster":
      return `${String(p.insider_count ?? "")} insiders ${String(p.direction ?? "")} in ${String(
        p.window_business_days ?? "",
      )} business days`;
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
        ? "—"
        : `${fmtNum(quant.volume_ratio, 1)}${quant.volume_ratio_partial ? "*" : ""}`,
    ],
    ["5d", fmtPct(quant.momentum_5d)],
    ["52wH", fmtPct(quant.pct_from_52w_high)],
    ["rhythm", fmtPct(quant.earnings_rhythm)],
  ];
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-[#8b8b86]">
      {cells.map(([label, value]) => (
        <span key={label}>
          <span className="text-[#b4b4ae]">{label}</span> {value}
        </span>
      ))}
    </div>
  );
}

export default function TrackerPanel({ onClose }: { onClose: () => void }) {
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
      <div className="flex h-[86%] w-[92%] flex-col overflow-hidden rounded-xl border border-[#e0e0da] bg-[#f7f7f4] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#e6e6e0] px-4 py-3">
          <Activity className="h-4 w-4 text-[#1d1b1b]" strokeWidth={2} aria-hidden />
          <span className="font-baskerville text-[15px] text-[#1d1b1b]">Tracker</span>
          <span className="font-mono text-[11px] text-[#8b8b86]">
            {status?.running ? "running" : "stopped"} · {status?.messagesEmitted ?? 0} emitted
            {progress.pending > 0 && (
              <span className="text-[#b45309]">
                {" "}
                · backfilling {progress.done}/{progress.total}
              </span>
            )}
            {status?.rateLimits &&
              status.rateLimits.news +
                status.rateLimits.calendar +
                status.rateLimits.filings +
                status.rateLimits.price >
                0 && (
                <span
                  className="text-[#b45309]"
                  title={`HTTP 429 today (${status.rateLimits.day}, ET)`}
                >
                  {" "}
                  · 429 today: news {status.rateLimits.news} · cal {status.rateLimits.calendar} ·
                  filings {status.rateLimits.filings}
                </span>
              )}
            {progress.pending === 0 && progress.insiderPending > 0 && (
              <span className="text-[#b45309]">
                {" "}
                · seeding insiders {progress.insiderDone}/{progress.total}
              </span>
            )}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-md border border-[#e0e0da] bg-white p-0.5">
              {(["stream", "data"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded px-2 py-1 text-[11px] transition-colors ${
                    mode === m ? "bg-[#1d1b1b] text-white" : "text-[#6b7280] hover:text-[#1d1b1b]"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {mode === "stream" && (
              <div className="flex rounded-md border border-[#e0e0da] bg-white p-0.5">
                {(["all", "anomalies", "channels"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`rounded px-2 py-1 text-[11px] transition-colors ${
                      filter === f
                        ? "bg-[#1d1b1b] text-white"
                        : "text-[#6b7280] hover:text-[#1d1b1b]"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}

            {mode === "stream" ? (
              <select
                value={tickerFilter}
                onChange={(e) => setTickerFilter(e.target.value)}
                className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]"
              >
                <option value="all">all tickers</option>
                {tickers.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={activeDataTicker ?? ""}
                onChange={(e) => setDataTicker(e.target.value)}
                className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]"
              >
                {tickers.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => void runCycle()}
              disabled={cycling}
              className="flex items-center gap-1.5 rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${cycling ? "animate-spin" : ""}`}
                strokeWidth={2}
                aria-hidden
              />
              cycle
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close tracker"
              className="rounded-md p-1 text-[#6b7280] transition-colors hover:bg-[#ececE6] hover:text-[#1d1b1b]"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>

        {/* Ticker health row — click a ticker to inspect its raw data */}
        <div className="max-h-[76px] overflow-y-auto border-b border-[#eeeee8] px-4 py-2">
          <div className="flex flex-wrap gap-1.5">
            {(status?.tickers ?? []).map((t) => {
              const errors = Object.entries(t.health).filter(([, h]) => h.last_error);
              const selected = mode === "data" && activeDataTicker === t.ticker;
              return (
                <button
                  key={t.ticker}
                  type="button"
                  onClick={() => {
                    setDataTicker(t.ticker);
                    setMode("data");
                  }}
                  title={[
                    errors.length > 0
                      ? errors.map(([c, h]) => `${c}: ${h.last_error}`).join("\n")
                      : "all channels healthy",
                    t.insiderSeeded ? null : "insider window not seeded yet",
                  ]
                    .filter(Boolean)
                    .join("\n")}
                  className={`flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 transition-colors ${
                    selected
                      ? "border-[#1d1b1b] bg-[#1d1b1b]"
                      : "border-[#e6e6e0] bg-white hover:border-[#c9c9c1]"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      !t.backfilled
                        ? "bg-[#d1d1c9]"
                        : errors.length > 0
                          ? "bg-[#d97706]"
                          : "bg-[#16a34a]"
                    }`}
                    aria-hidden
                  />
                  <span
                    className={`font-mono text-[11px] ${selected ? "text-white" : "text-[#1d1b1b]"}`}
                  >
                    {t.ticker}
                  </span>
                </button>
              );
            })}
            {(status?.tickers.length ?? 0) === 0 && (
              <span className="font-mono text-[11px] text-[#a3a39c]">no tickers tracked</span>
            )}
          </div>
        </div>

        {/* Raw data browser */}
        {mode === "data" && (
          <div className="min-h-0 flex-1 overflow-hidden px-4 py-2">
            {activeDataTicker ? (
              <TrackerDataView ticker={activeDataTicker} />
            ) : (
              <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#a3a39c]">
                no ticker selected
              </div>
            )}
          </div>
        )}

        {/* Message stream */}
        {mode === "stream" && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {visible.length === 0 ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#a3a39c]">
              no messages yet — the engine emits on channel arrivals and detector windows
            </div>
          ) : (
            <ul className="divide-y divide-[#eeeee8]">
              {visible.map((message) => (
                <li key={message.id} className="py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-[#a3a39c]">
                      {fmtTime(message.timestamp)}
                    </span>
                    <span className="font-mono text-[11px] font-medium text-[#1d1b1b]">
                      {message.ticker}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        ANOMALY_SET.has(message.type)
                          ? "bg-[#fef3c7] text-[#92400e]"
                          : "bg-[#eef2f6] text-[#475569]"
                      }`}
                    >
                      {TRACKER_TYPE_LABELS[message.type] ?? message.type}
                    </span>
                    {message.context_flags.map((flag) => (
                      <span
                        key={flag}
                        className="rounded bg-[#e0e7ff] px-1.5 py-0.5 font-mono text-[10px] text-[#3730a3]"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 text-[12px] leading-snug text-[#3f3f46]">
                    {headlineFor(message)}
                  </div>
                  <QuantStrip quant={message.quant_context} />
                </li>
              ))}
            </ul>
          )}
        </div>
        )}

        <div className="border-t border-[#eeeee8] px-4 py-1.5 font-mono text-[10px] text-[#a3a39c]">
          Shift+T to toggle · Esc to close · click a ticker for its raw data ·{" "}
          {status?.tickers.length ?? 0} tracked · * = partial (pre-close) volume ratio · — = not
          computable
        </div>
      </div>
    </div>
  );
}
