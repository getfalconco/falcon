import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers, RefreshCw, X } from "lucide-react";
import {
  BASE_DESTINATIONS,
  BASE_PRIORITY_BANDS,
  type BaseCompositeTag,
  type BaseConfigSummary,
  type BaseDestinationKey,
  type BasePriorityBand,
  type BaseReplayResult,
  type BaseReplayedIncident,
} from "../../../shared/base-types";
import { TRACKER_TYPE_LABELS, type TrackerMessage } from "../../../shared/tracker-types";
import { readPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { getWatchlist, subscribeWatchlist } from "@/lib/watchlist";
import ClassifierView from "./ClassifierView";
import AnalystView from "./AnalystView";

/**
 * B8: user proximity is read from the live sources at every score — the
 * paper-account positions (held) and the followed list (watchlist) — not from
 * a box the operator has to type into. The boxes below are what-if extras.
 */
function liveHeld(): string[] {
  return Object.keys(readPaperAccount().positions).map((s) => s.toUpperCase()).sort();
}
function liveWatchlist(): string[] {
  return getWatchlist().map((e) => e.ticker.toUpperCase()).sort();
}

/**
 * Base Engine (§9 replay) instrument panel. Opened only by Shift+B.
 *
 * Base has no dispatch loop yet, so this runs the incident model, the
 * priority scorer and the routing table over Tracker's recorded message
 * stream and shows what would have been routed. Nothing is dispatched.
 */

const BAND_STYLE: Record<BasePriorityBand, string> = {
  P0: "bg-[#fee2e2] text-[#991b1b]",
  P1: "bg-[#fef3c7] text-[#92400e]",
  P2: "bg-[#e0f2fe] text-[#075985]",
  P3: "bg-[#f1f1ec] text-[#6b7280]",
};

const DESTINATION_STYLE: Record<BaseDestinationKey, string> = {
  analyst: "bg-[#ede9fe] text-[#5b21b6]",
  propagation: "bg-[#dcfce7] text-[#166534]",
  classifier: "bg-[#e0e7ff] text-[#3730a3]",
  extraction: "bg-[#fae8ff] text-[#86198f]",
  scheduler: "bg-[#ffedd5] text-[#9a3412]",
  store_only: "bg-[#f1f1ec] text-[#8b8b86]",
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function fmtNum(value: number | null, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

/** One-line summary of a constituent message. */
function messageLine(message: TrackerMessage): string {
  const p = message.payload as Record<string, unknown>;
  switch (message.type) {
    case "news_item":
      return String(p.headline ?? "");
    case "filing_item": {
      const items = Array.isArray(p.item_codes) && p.item_codes.length > 0
        ? ` items ${(p.item_codes as string[]).join(", ")}`
        : "";
      return `${String(p.form_type ?? "")}${items}`;
    }
    case "insider_filing":
      return `${String(p.insider_name ?? "")} (${String(p.role ?? "")}) code ${String(p.transaction_code ?? "?")}`;
    case "scheduled_event":
      return `${String(p.fiscal_period ?? "")} due ${String(p.due_at ?? "").slice(0, 10)}`;
    case "gap_event":
      return `gap z ${fmtNum(p.gap_z as number)} ${String(p.direction ?? "")}`;
    case "volume_anomaly":
      return `${fmtNum(p.volume_ratio as number, 1)}× baseline volume`;
    case "unexplained_move":
      return `${String(p.measure_used ?? "")} ${fmtNum(p.residual_zscore as number)} ${String(p.direction ?? "")}`;
    case "drift_event":
      return `drift z ${fmtNum(p.drift_z as number)} ${String(p.direction ?? "")}`;
    case "news_burst":
      return `${String(p.articles_last_24h ?? "")} articles / 24h · ${fmtNum(p.burst_multiple as number, 1)}×`;
    case "silence_anomaly":
      return `${String(p.trading_days_silent ?? "")} silent trading days`;
    case "filing_overdue":
      return `${String(p.expected_form ?? "")} overdue ${String(p.business_days_overdue ?? "")}bd`;
    case "insider_cluster": {
      // Notional drives both the severity multiplier and the standalone tag,
      // so it belongs on the line rather than buried in the payload.
      const notional =
        typeof p.total_notional === "number"
          ? ` · $${Math.round(p.total_notional).toLocaleString()}`
          : "";
      return `${String(p.insider_count ?? "")} insiders ${String(p.direction ?? "")}${notional}`;
    }
    default:
      return message.type;
  }
}

function StatBar({
  label,
  value,
  max,
  className,
}: {
  label: string;
  value: number;
  max: number;
  className: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className={`w-[92px] shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${className}`}>
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#ececE6]">
        <div className="h-full rounded-full bg-[#1d1b1b]/25" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-6 shrink-0 text-right font-mono text-[10px] text-[#6b7280]">{value}</span>
    </div>
  );
}

function IncidentRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: BaseReplayedIncident;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { incident, routing } = entry;
  const start = Date.parse(incident.window_start);
  const end = incident.window_end ? Date.parse(incident.window_end) : null;
  const destinations: BaseDestinationKey[] = routing.store_only
    ? ["store_only"]
    : routing.destinations.map((d) => d.destination);

  return (
    <li className="py-2">
      <button type="button" onClick={onToggle} className="w-full text-left">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${BAND_STYLE[incident.priority_band]}`}
          >
            {incident.priority_band}
          </span>
          <span className="w-7 font-mono text-[12px] font-medium text-[#1d1b1b]">
            {incident.priority}
          </span>
          <span className="font-mono text-[11px] font-medium text-[#1d1b1b]">
            {incident.ticker}
          </span>
          <span className="font-mono text-[10px] text-[#a3a39c]">
            {fmtTime(incident.window_start)} →{" "}
            {incident.window_end ? fmtTime(incident.window_end) : "open"}
            {end !== null && ` · ${fmtDuration(end - start)}`}
          </span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              incident.window_status === "open" ? "bg-[#16a34a]" : "bg-[#d1d1c9]"
            }`}
            aria-hidden
          />
          <span className="font-mono text-[10px] text-[#a3a39c]">
            {incident.messages.length} msg
          </span>
          {incident.trigger_type === "scheduled" && (
            <span className="rounded bg-[#ffedd5] px-1.5 py-0.5 font-mono text-[10px] text-[#9a3412]">
              scheduled
            </span>
          )}
          {incident.user_proximity !== "tracked" && (
            <span className="rounded bg-[#dcfce7] px-1.5 py-0.5 font-mono text-[10px] text-[#166534]">
              {incident.user_proximity}
            </span>
          )}
          {incident.discovery_floor_applied && (
            <span
              className="rounded bg-[#ede9fe] px-1.5 py-0.5 font-mono text-[10px] text-[#5b21b6]"
              title="Promoted by the discovery floor: strong enough regardless of proximity"
            >
              floor
            </span>
          )}
          {incident.degraded_context && (
            <span className="rounded bg-[#fef3c7] px-1.5 py-0.5 font-mono text-[10px] text-[#92400e]">
              degraded
            </span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {incident.composite_tags.map((tag) => (
            <span
              key={tag}
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                tag === "explained_move"
                  ? "bg-[#fee2e2] text-[#991b1b]"
                  : tag === "event_gap"
                    ? "bg-[#f1f1ec] text-[#6b7280]"
                    : "bg-[#fef3c7] text-[#92400e]"
              }`}
            >
              {tag}
            </span>
          ))}
          {incident.composite_tags.length === 0 && (
            <span className="font-mono text-[10px] text-[#c9c9c1]">no tags</span>
          )}
          <span className="font-mono text-[10px] text-[#c9c9c1]">→</span>
          {destinations.map((d) => (
            <span
              key={d}
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${DESTINATION_STYLE[d]}`}
            >
              {d}
            </span>
          ))}
        </div>
      </button>

      {expanded && (
        <div className="mt-2 rounded-md border border-[#eeeee8] bg-white px-3 py-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-[#8b8b86]">
            <span>
              <span className="text-[#b4b4ae]">incident</span> {incident.incident_id.slice(0, 8)}
            </span>
            <span>
              <span className="text-[#b4b4ae]">related</span>{" "}
              {incident.related_incident_id ? incident.related_incident_id.slice(0, 8) : "—"}
            </span>
            <span>
              <span className="text-[#b4b4ae]">proximity</span> {incident.user_proximity}
            </span>
            <span>
              <span className="text-[#b4b4ae]">status</span> {incident.window_status}
            </span>
            {routing.destinations.map((d) => (
              <span key={d.destination}>
                <span className="text-[#b4b4ae]">{d.destination}</span> {d.rules.join(", ")}
              </span>
            ))}
          </div>

          <ul className="mt-2 divide-y divide-[#f4f4ef]">
            {incident.messages.map((m) => {
              const outcome = routing.per_message.find((r) => r.message_id === m.id)?.outcome;
              return (
                <li key={m.id} className="flex items-baseline gap-2 py-1">
                  <span className="w-10 shrink-0 font-mono text-[10px] text-[#a3a39c]">
                    {fmtTime(m.timestamp)}
                  </span>
                  <span className="w-[104px] shrink-0 font-mono text-[10px] text-[#475569]">
                    {TRACKER_TYPE_LABELS[m.type] ?? m.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#3f3f46]">
                    {messageLine(m)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-[#a3a39c]">
                    {outcome?.action === "route" ? outcome.destination : "store"}
                  </span>
                </li>
              );
            })}
          </ul>

          {incident.quant_context && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-[#f4f4ef] pt-2 font-mono text-[10px] text-[#8b8b86]">
              {(
                [
                  ["move z", fmtNum(incident.quant_context.move_zscore)],
                  ["resid z", fmtNum(incident.quant_context.residual_zscore)],
                  ["vol×", fmtNum(incident.quant_context.volume_ratio, 1)],
                  ["r²", fmtNum(incident.quant_context.r_squared)],
                  ["session", incident.quant_context.session],
                ] as Array<[string, string]>
              ).map(([label, value]) => (
                <span key={label}>
                  <span className="text-[#b4b4ae]">{label}</span> {value}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export type BasePanelView = "incidents" | "classifier" | "analyst";

export default function BasePanel({
  onClose,
  initialView = "incidents",
}: {
  onClose: () => void;
  /** Shift+B opens on incidents; Shift+A opens straight on the analyst tab. */
  initialView?: BasePanelView;
}) {
  const [result, setResult] = useState<BaseReplayResult | null>(null);
  const [config, setConfig] = useState<BaseConfigSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(1000);
  // Live user context (B8): held = paper-account positions, watchlist = the
  // followed list. Both are re-read whenever their stores change, and every
  // re-score sends the current lists — proximity is an input, not a frozen
  // property of the incident.
  const [held, setHeld] = useState<string[]>(liveHeld);
  const [watchlist, setWatchlist] = useState<string[]>(liveWatchlist);
  // What-if extras typed by the operator; merged on top of the live lists.
  const [heldInput, setHeldInput] = useState("");
  const [watchlistInput, setWatchlistInput] = useState("");
  const [bandFilter, setBandFilter] = useState<BasePriorityBand | "all">("all");
  const [destinationFilter, setDestinationFilter] = useState<BaseDestinationKey | "all">("all");
  const [tickerFilter, setTickerFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<BasePanelView>(initialView);

  const parseTickers = (raw: string): string[] =>
    raw
      .split(/[\s,]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);

  const effectiveHeld = useMemo(
    () => [...new Set([...held, ...parseTickers(heldInput)])].sort(),
    [held, heldInput],
  );
  const effectiveWatchlist = useMemo(
    () => [...new Set([...watchlist, ...parseTickers(watchlistInput)])].sort(),
    [watchlist, watchlistInput],
  );

  useEffect(() => {
    const offAccount = subscribePaperAccount(() => setHeld(liveHeld()));
    const offWatch = subscribeWatchlist(() => setWatchlist(liveWatchlist()));
    return () => {
      offAccount();
      offWatch();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.meridian?.runBaseReplay({
        limit,
        held: effectiveHeld,
        watchlist: effectiveWatchlist,
      });
      if (res?.ok) {
        setResult(res.result);
        setError(null);
      } else {
        setError(res?.error ?? "replay unavailable");
      }
    } finally {
      setLoading(false);
    }
  }, [limit, effectiveHeld, effectiveWatchlist]);

  // Re-runs on a limit change and whenever the live held/watchlist sources
  // change (a position opened, a ticker followed) — the scores must follow
  // the user context, not the moment the panel was opened. The replay is
  // deterministic, so nothing else needs polling.
  const liveKey = `${held.join(",")}|${watchlist.join(",")}`;
  useEffect(() => {
    void load();
    void window.meridian?.getBaseConfig().then((res) => {
      if (res?.ok) setConfig(res.config);
    });
  }, [limit, liveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const summary = result?.summary ?? null;

  const visible = useMemo(() => {
    const all = result?.incidents ?? [];
    return all
      .filter((e) => {
        if (bandFilter !== "all" && e.incident.priority_band !== bandFilter) return false;
        if (tickerFilter !== "all" && e.incident.ticker !== tickerFilter) return false;
        if (destinationFilter !== "all") {
          if (destinationFilter === "store_only") return e.routing.store_only;
          return e.routing.destinations.some((d) => d.destination === destinationFilter);
        }
        return true;
      })
      .sort(
        (a, b) =>
          b.incident.priority - a.incident.priority ||
          Date.parse(b.incident.window_start) - Date.parse(a.incident.window_start),
      );
  }, [result, bandFilter, destinationFilter, tickerFilter]);

  const tagRows = useMemo(() => {
    if (!summary) return [];
    return (Object.entries(summary.by_tag) as Array<[BaseCompositeTag, number]>)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
  }, [summary]);

  const maxBand = Math.max(1, ...Object.values(summary?.by_band ?? { P0: 0 }));
  const maxDestination = Math.max(1, ...Object.values(summary?.by_destination ?? { a: 0 }));
  const maxTag = Math.max(1, ...tagRows.map(([, c]) => c));

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="app-no-drag fixed inset-0 z-[200] flex items-center justify-center bg-black/25 backdrop-blur-[2px]">
      <div className="flex h-[86%] w-[92%] flex-col overflow-hidden rounded-xl border border-[#e0e0da] bg-[#f7f7f4] shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#e6e6e0] px-4 py-3">
          <Layers className="h-4 w-4 text-[#1d1b1b]" strokeWidth={2} aria-hidden />
          <span className="font-baskerville text-[15px] text-[#1d1b1b]">Base</span>
          <div className="flex rounded-md border border-[#e0e0da] bg-white p-0.5">
            {(["incidents", "classifier", "analyst"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  view === v ? "bg-[#1d1b1b] text-white" : "text-[#6b7280] hover:text-[#1d1b1b]"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-[#8b8b86]">
            replay · {summary?.message_count ?? 0} messages → {summary?.incident_count ?? 0}{" "}
            incidents · {summary?.ticker_count ?? 0} tickers
            {summary && summary.open_incidents > 0 && (
              <span className="text-[#16a34a]"> · {summary.open_incidents} open</span>
            )}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]"
            >
              {[300, 1000, 3000, 10000].map((n) => (
                <option key={n} value={n}>
                  last {n}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
                strokeWidth={2}
                aria-hidden
              />
              replay
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close base panel"
              className="rounded-md p-1 text-[#6b7280] transition-colors hover:bg-[#ececE6] hover:text-[#1d1b1b]"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>

        {view === "classifier" ? (
          <ClassifierView />
        ) : view === "analyst" ? (
          <AnalystView
            onOpenIncident={(ticker, incidentId) => {
              setTickerFilter(ticker);
              setExpanded((prev) => new Set(prev).add(incidentId));
              setView("incidents");
            }}
          />
        ) : (
        <div className="flex min-h-0 flex-1">
          {/* Distribution sidebar (§8 observability) */}
          <aside className="w-[264px] shrink-0 overflow-y-auto border-r border-[#eeeee8] px-3 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">
              priority bands
            </div>
            <div className="mt-1.5 space-y-1">
              {BASE_PRIORITY_BANDS.map((band) => (
                <StatBar
                  key={band}
                  label={`${band}${
                    config
                      ? ` ≥${band === "P0" ? config.bands.P0 : band === "P1" ? config.bands.P1 : band === "P2" ? config.bands.P2 : 0}`
                      : ""
                  }`}
                  value={summary?.by_band[band] ?? 0}
                  max={maxBand}
                  className={BAND_STYLE[band]}
                />
              ))}
            </div>

            <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">
              destinations
            </div>
            <div className="mt-1.5 space-y-1">
              {BASE_DESTINATIONS.map((d) => (
                <StatBar
                  key={d}
                  label={d}
                  value={summary?.by_destination[d] ?? 0}
                  max={maxDestination}
                  className={DESTINATION_STYLE[d]}
                />
              ))}
            </div>

            <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">
              composite tags
            </div>
            <div className="mt-1.5 space-y-1">
              {tagRows.length === 0 && (
                <div className="font-mono text-[10px] text-[#c9c9c1]">none fired</div>
              )}
              {tagRows.map(([tag, count]) => (
                <div key={tag} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[#6b7280]">
                    {tag}
                    {config && (
                      <span className="text-[#c9c9c1]">
                        {" "}
                        {config.tagWeights[tag] > 0 ? "+" : ""}
                        {config.tagWeights[tag]}
                      </span>
                    )}
                  </span>
                  <div className="h-1.5 w-14 overflow-hidden rounded-full bg-[#ececE6]">
                    <div
                      className="h-full rounded-full bg-[#1d1b1b]/25"
                      style={{ width: `${Math.round((count / maxTag) * 100)}%` }}
                    />
                  </div>
                  <span className="w-5 text-right font-mono text-[10px] text-[#6b7280]">
                    {count}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 font-mono text-[10px] uppercase tracking-wide text-[#b4b4ae]">
              user proximity
            </div>
            <div className="mt-1.5 space-y-1.5">
              {/* Live sources (B8) — what the scorer actually sees right now. */}
              <div className="font-mono text-[10px] text-[#8b8b86]">
                <span className="text-[#b4b4ae]">held</span> ×{config?.proximityMultipliers.held ?? 1.5}{" "}
                <span className="text-[#1d1b1b]">
                  {effectiveHeld.length ? effectiveHeld.join(", ") : "— none (paper account has no positions)"}
                </span>
              </div>
              <div className="font-mono text-[10px] text-[#8b8b86]">
                <span className="text-[#b4b4ae]">watchlist</span> ×{config?.proximityMultipliers.watchlist ?? 1.25}{" "}
                <span className="text-[#1d1b1b]">
                  {effectiveWatchlist.length ? effectiveWatchlist.join(", ") : "— none followed"}
                </span>
              </div>
              <label className="block">
                <span className="font-mono text-[10px] text-[#a3a39c]">what-if: also treat as held</span>
                <input
                  value={heldInput}
                  onChange={(e) => setHeldInput(e.target.value)}
                  placeholder="extra tickers, comma-separated"
                  className="mt-0.5 w-full rounded border border-[#e0e0da] bg-white px-1.5 py-1 font-mono text-[10px] text-[#1d1b1b]"
                />
              </label>
              <label className="block">
                <span className="font-mono text-[10px] text-[#a3a39c]">what-if: also treat as watchlist</span>
                <input
                  value={watchlistInput}
                  onChange={(e) => setWatchlistInput(e.target.value)}
                  placeholder="extra tickers, comma-separated"
                  className="mt-0.5 w-full rounded border border-[#e0e0da] bg-white px-1.5 py-1 font-mono text-[10px] text-[#1d1b1b]"
                />
              </label>
              <button
                type="button"
                onClick={() => void load()}
                className="w-full rounded border border-[#e0e0da] bg-white py-1 font-mono text-[10px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
              >
                re-score
              </button>
            </div>

            {summary && (
              <div className="mt-4 space-y-0.5 border-t border-[#eeeee8] pt-2 font-mono text-[10px] text-[#8b8b86]">
                <div>
                  <span className="text-[#b4b4ae]">span</span> {fmtDate(summary.first_message_at)} →{" "}
                  {fmtDate(summary.last_message_at)}
                </div>
                <div>
                  <span className="text-[#b4b4ae]">closed</span> {summary.closed_incidents} ·{" "}
                  <span className="text-[#b4b4ae]">open</span> {summary.open_incidents}
                </div>
                <div>
                  <span className="text-[#b4b4ae]">degraded</span> {summary.degraded_incidents} ·{" "}
                  <span className="text-[#b4b4ae]">floor</span>{" "}
                  {summary.discovery_floor_promotions}
                </div>
                <div title="Cross-ticker article dedupe: classifier requests after collapsing syndicated articles">
                  <span className="text-[#b4b4ae]">classifier</span>{" "}
                  {summary.dedupe.classifier_requests}/{summary.dedupe.news_messages} req ·{" "}
                  <span className="text-[#16a34a]">-{summary.dedupe.requests_saved}</span> ·{" "}
                  <span className="text-[#b4b4ae]">syndicated</span> {summary.dedupe.syndicated_articles}
                </div>
                <div title="Classifier verdicts applied to this replay (B9). Re-score is Phase B; promotions/demotions vs the same replay with re-score off.">
                  <span className="text-[#b4b4ae]">verdicts</span>{" "}
                  {summary.classification.messages_with_verdict}/{summary.classification.classifier_bound_messages} msgs ·{" "}
                  <span className="text-[#b4b4ae]">re-score</span>{" "}
                  {summary.classification.rescore_applied ? (
                    <span className="text-[#16a34a]">
                      on · +{summary.classification.incidents_promoted} / -{summary.classification.incidents_demoted}
                    </span>
                  ) : (
                    "off"
                  )}{" "}
                  · <span className="text-[#b4b4ae]">prop. cands</span> {summary.classification.propagation_candidates}
                </div>
                {config && (
                  <div>
                    <span className="text-[#b4b4ae]">window</span>{" "}
                    {fmtDuration(config.measurementSilenceMs)} silence /{" "}
                    {fmtDuration(config.hardCapMs)} cap
                  </div>
                )}
              </div>
            )}
          </aside>

          {/* Incident list */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#eeeee8] px-4 py-2">
              <div className="flex rounded-md border border-[#e0e0da] bg-white p-0.5">
                {(["all", ...BASE_PRIORITY_BANDS] as Array<BasePriorityBand | "all">).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBandFilter(b)}
                    className={`rounded px-2 py-1 text-[11px] transition-colors ${
                      bandFilter === b
                        ? "bg-[#1d1b1b] text-white"
                        : "text-[#6b7280] hover:text-[#1d1b1b]"
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
              <select
                value={destinationFilter}
                onChange={(e) => setDestinationFilter(e.target.value as BaseDestinationKey | "all")}
                className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]"
              >
                <option value="all">all destinations</option>
                {BASE_DESTINATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                value={tickerFilter}
                onChange={(e) => setTickerFilter(e.target.value)}
                className="rounded-md border border-[#e0e0da] bg-white px-2 py-1 text-[11px] text-[#1d1b1b]"
              >
                <option value="all">all tickers</option>
                {(summary?.by_ticker ?? []).map((t) => (
                  <option key={t.ticker} value={t.ticker}>
                    {t.ticker} ({t.incidents})
                  </option>
                ))}
              </select>
              <span className="ml-auto font-mono text-[10px] text-[#a3a39c]">
                {visible.length} shown
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
              {error ? (
                <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#b45309]">
                  {error}
                </div>
              ) : visible.length === 0 ? (
                <div className="flex h-full items-center justify-center font-mono text-[12px] text-[#a3a39c]">
                  {loading ? "replaying…" : "no incidents — Tracker has emitted nothing to group"}
                </div>
              ) : (
                <ul className="divide-y divide-[#eeeee8]">
                  {visible.map((entry) => (
                    <IncidentRow
                      key={entry.incident.incident_id}
                      entry={entry}
                      expanded={expanded.has(entry.incident.incident_id)}
                      onToggle={() => toggle(entry.incident.incident_id)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
        )}

        <div className="border-t border-[#eeeee8] px-4 py-1.5 font-mono text-[10px] text-[#a3a39c]">
          Shift+B to toggle · Shift+A opens the analyst tab · Esc to close · replay only — nothing is dispatched · click an incident
          for its messages{config ? ` · config ${config.configFile}` : ""}
        </div>
      </div>
    </div>
  );
}
