/**
 * Handover briefing: what the chain noticed about one held name since the
 * last US close, cut out of a Base replay.
 *
 * The desktop host and the replay script both already run `replayBase` over
 * the Tracker's message log; this module turns that result into the
 * `ChainTickerSlice` the briefing's `chainSlice` port returns, so neither side
 * writes its own reading of a Tracker payload.
 *
 * Pure: no clock, no I/O. Messages come off disk as JSON, so every payload
 * field is read defensively and nothing here throws on a shape it does not
 * know.
 */

import { articleKey } from "../base/article-dedupe.js";
import { DEFAULT_BASE_CONFIG } from "../base/config.js";
import type { BaseReplayResult } from "../base/replay.js";
import type { BaseMessage } from "../base/types.js";
import type {
  BriefingPriorityBand,
  ChainTickerSlice,
  HeldCoverage,
  HeldFiling,
  HeldMeasurement,
  HeldNewsItem,
} from "./types.js";

const MAX_HEADLINE_CHARS = 300;
const MAX_SOURCE_CHARS = 80;

const BAND_RANK: Record<BriefingPriorityBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * The 8-K items a reader can act on by name. 9.01 (financial statements and
 * exhibits) rides along with nearly every 8-K, so its name would be printed on
 * every row and say nothing; the code itself is still listed.
 */
const ITEM_NAMES: Record<string, string> = {
  "1.01": "material agreement",
  "2.02": "results of operations",
  "5.02": "officer or director change",
  "7.01": "Regulation FD disclosure",
  "8.01": "other events",
};

type Fields = Record<string, unknown>;

function fieldsOf(payload: unknown): Fields {
  return payload && typeof payload === "object" ? (payload as Fields) : {};
}

/** Flattens control characters and whitespace runs; third-party text lands in a one-line row. */
function plain(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) out += ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch;
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxChars ? `${out.slice(0, maxChars).trimEnd()}...` : out;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Only http(s) links are passed on. The URL ends up behind a click in the
 * panel, and a provider feed is not a place to trust for the scheme of a link.
 */
function webUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

/** Magnitude only: the sentence around it carries the direction in words. */
function fixed(value: number, decimals: number): string {
  return Math.abs(value).toFixed(decimals);
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function direction(value: unknown, signed: number | null): "up" | "down" {
  if (value === "up" || value === "down") return value;
  return signed !== null && signed < 0 ? "down" : "up";
}

function filingLabel(payload: Fields): string {
  const form = plain(payload.form_type, 20) || "Filing";
  const codes = Array.isArray(payload.item_codes)
    ? payload.item_codes.filter((c): c is string => typeof c === "string" && /^\d{1,2}\.\d{2}$/.test(c.trim())).map((c) => c.trim())
    : [];
  if (!/^8-K/i.test(form) || codes.length === 0) return form;
  const named = codes.map((c) => ITEM_NAMES[c]).filter((name): name is string => name !== undefined);
  const list = `${codes.length === 1 ? "item" : "items"} ${codes.join(", ")}`;
  return named.length > 0 ? `${form}, ${list} (${named.join(", ")})` : `${form}, ${list}`;
}

/**
 * One plain line per measurement, built from the payload's own numbers.
 * Percent moves, standard deviations, multiples and counts only: the payloads
 * also carry price levels and insider dollar totals, and a line that repeats
 * those would read as a quote or a position size rather than as a measurement.
 * Returns null when the payload lacks the number the line is about.
 */
function measurementDetail(type: HeldMeasurement["type"], payload: Fields): string | null {
  switch (type) {
    case "gap_event": {
      const gap = num(payload.gap_pct);
      const z = num(payload.gap_z);
      if (gap === null) return null;
      // The Tracker stores the gap as a fraction of the prior close.
      const side = direction(payload.direction, gap) === "up" ? "above" : "below";
      const size = `Opened ${fixed(gap * 100, 1)}% ${side} the prior close`;
      return z === null ? `${size}.` : `${size}, a ${fixed(z, 1)} standard deviation gap.`;
    }
    case "volume_anomaly": {
      const ratio = num(payload.volume_ratio);
      return ratio === null ? null : `Volume ran at ${fixed(ratio, 1)} times its usual level in the last measured session.`;
    }
    case "unexplained_move": {
      const z = num(payload.residual_zscore);
      if (z === null) return null;
      const way = direction(payload.direction, z);
      const news = num(payload.news_items_since_prev_close);
      // Under the low-fit fallback the figure is the name's own move, not the
      // part left over after the market, and the line has to say which.
      const measure =
        payload.measure_used === "move_zscore"
          ? `Moved ${way} ${fixed(z, 1)} standard deviations in the last measured session`
          : `Moved ${way} ${fixed(z, 1)} standard deviations more than the market explains`;
      if (news === null) return `${measure}.`;
      return news === 0
        ? `${measure}, with no company news in that session.`
        : `${measure}, against ${count(news, "company news item", "company news items")} in that session.`;
    }
    case "drift_event": {
      const momentum = num(payload.momentum_5d);
      const z = num(payload.drift_z);
      if (momentum === null) return null;
      const way = direction(payload.direction, momentum) === "up" ? "Up" : "Down";
      const news = num(payload.news_items_last_5d);
      const size = `${way} ${fixed(momentum * 100, 1)}% over five sessions`;
      const scaled = z === null ? size : `${size}, ${fixed(z, 1)} standard deviations of drift`;
      return news === null ? `${scaled}.` : `${scaled}, with ${count(news, "company news item", "company news items")} in that span.`;
    }
    case "news_burst": {
      const articles = num(payload.articles_last_24h);
      const multiple = num(payload.burst_multiple);
      if (articles === null) return null;
      const size = `${count(articles, "article", "articles")} in 24 hours`;
      return multiple === null ? `${size}.` : `${size}, ${fixed(multiple, 1)} times the usual daily rate.`;
    }
    case "insider_cluster": {
      const insiders = num(payload.insider_count);
      const days = num(payload.window_business_days);
      if (insiders === null) return null;
      // The payload's own direction words are trade verbs; the line names the
      // kind of transaction instead. A direction this build does not know is
      // not read as a sale: purchases reported as sales is the worst misprint
      // this line can make, so it falls back to the neutral word.
      const kind =
        payload.direction === "buy"
          ? "open-market purchases"
          : payload.direction === "sell"
            ? "open-market sales"
            : "open-market transactions";
      const who = `${count(insiders, "insider", "insiders")} reported ${kind}`;
      return days === null ? `${who}.` : `${who} within ${count(days, "business day", "business days")}.`;
    }
  }
}

const MEASUREMENT_TYPES: ReadonlySet<string> = new Set<HeldMeasurement["type"]>([
  "unexplained_move",
  "volume_anomaly",
  "drift_event",
  "gap_event",
  "news_burst",
  "insider_cluster",
]);

function byRecency(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a);
}

/**
 * The slice of a replay that belongs to `ticker` and to the night.
 *
 * "Since the close" is decided on the message timestamp, which is when the
 * Tracker saw the item. News carries a second test on its own publication
 * time: a name followed for the first time is back-filled with three trading
 * days of articles, all stamped with the poll that fetched them, and without
 * the second test last week's stories would be listed as overnight news.
 * Filings are not given that test, because a filing without an acceptance
 * instant is stamped midnight UTC of its filing date and would always fail it.
 *
 * Scheduled earnings are a forward calendar, not an overnight event: the
 * Tracker announces a date once, usually weeks ahead, so the since-filter
 * would drop nearly all of them. They are kept while the due time is still
 * ahead of the last close.
 */
export function sliceFromReplay(
  ticker: string,
  replay: BaseReplayResult,
  overnightSince: string,
  coverage: HeldCoverage,
): ChainTickerSlice {
  const symbol = typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
  const slice: ChainTickerSlice = { ticker: symbol, coverage, news: [], filings: [], measurements: [], scheduled_earnings: [] };

  // With no readable boundary nothing can be shown to be overnight, and
  // returning everything would pass a week of items off as last night's.
  const since = Date.parse(overnightSince);
  if (symbol === "" || !Number.isFinite(since)) return slice;

  const news = new Map<string, HeldNewsItem>();
  const filings = new Map<string, HeldFiling>();
  const earnings = new Map<string, { due_at: string; confirmed: boolean; fiscal_period: string | null; seen_at: number }>();

  for (const replayed of Array.isArray(replay?.incidents) ? replay.incidents : []) {
    const incident = replayed?.incident;
    if (!incident || !Array.isArray(incident.messages)) continue;
    const band: BriefingPriorityBand = incident.priority_band in BAND_RANK ? incident.priority_band : "P3";
    const tags = Array.isArray(incident.composite_tags) ? incident.composite_tags.map(String) : [];

    for (const message of incident.messages as BaseMessage[]) {
      if (!message || typeof message.ticker !== "string" || message.ticker.trim().toUpperCase() !== symbol) continue;
      const seenAt = Date.parse(message.timestamp);
      if (!Number.isFinite(seenAt)) continue;
      const payload = fieldsOf(message.payload);
      const type: string = message.type;

      if (type === "scheduled_event") {
        const dueAt = isoInstant(payload.due_at);
        if (dueAt === null || Date.parse(dueAt) < since) continue;
        const period = plain(payload.fiscal_period, 40) || null;
        // A rescheduled date arrives as a newer message for the same fiscal
        // period; only the newest one is the company's current word.
        const key = period ?? dueAt;
        const known = earnings.get(key);
        if (!known || seenAt > known.seen_at) {
          // The Tracker emits a scheduled_event for company-announced dates
          // only; its projected dates never become messages.
          earnings.set(key, { due_at: dueAt, confirmed: true, fiscal_period: period, seen_at: seenAt });
        }
        continue;
      }

      if (seenAt < since) continue;

      if (type === "news_item") {
        const headline = plain(payload.headline, MAX_HEADLINE_CHARS);
        if (headline === "") continue;
        const publishedAt = isoInstant(payload.published_at) ?? new Date(seenAt).toISOString();
        if (Date.parse(publishedAt) < since) continue;
        const url = webUrl(payload.url);
        const key = articleKey(message, DEFAULT_BASE_CONFIG)?.key ?? `raw:${url || headline.toLowerCase()}`;
        const item: HeldNewsItem = {
          ticker: symbol,
          also: [],
          headline,
          source: plain(payload.source, MAX_SOURCE_CHARS),
          url,
          published_at: publishedAt,
          band,
          tags,
          incident_id: String(incident.incident_id ?? ""),
        };
        const known = news.get(key);
        // The same article inside two incidents keeps the more urgent reading.
        if (!known || BAND_RANK[item.band] < BAND_RANK[known.band]) news.set(key, item);
        continue;
      }

      if (type === "filing_item" || type === "insider_filing") {
        const filing: HeldFiling = {
          ticker: symbol,
          kind: type === "insider_filing" ? "insider" : "filing",
          label: type === "insider_filing" ? "Insider filing (Form 4)" : filingLabel(payload),
          filed_at: isoInstant(payload.filed_at) ?? new Date(seenAt).toISOString(),
          url: webUrl(payload.filing_url),
        };
        const key = `${filing.kind}|${filing.url || `${filing.label}|${filing.filed_at}`}`;
        if (!filings.has(key)) filings.set(key, filing);
        continue;
      }

      if (MEASUREMENT_TYPES.has(type)) {
        const measurementType = type as HeldMeasurement["type"];
        const detail = measurementDetail(measurementType, payload);
        if (detail !== null) {
          slice.measurements.push({ ticker: symbol, type: measurementType, detail, at: new Date(seenAt).toISOString() });
        }
      }
      // Anything else (silence_anomaly, filing_overdue, tape_structure, a type
      // added later) has no place in the briefing's contract and is skipped.
    }
  }

  slice.news = [...news.values()].sort(
    (a, b) => BAND_RANK[a.band] - BAND_RANK[b.band] || byRecency(a.published_at, b.published_at) || (a.headline < b.headline ? -1 : 1),
  );
  slice.filings = [...filings.values()].sort((a, b) => byRecency(a.filed_at, b.filed_at) || (a.label < b.label ? -1 : 1));
  slice.measurements.sort((a, b) => byRecency(a.at, b.at) || (a.type < b.type ? -1 : 1));
  slice.scheduled_earnings = [...earnings.values()]
    .map(({ seen_at: _seenAt, ...row }) => row)
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  return slice;
}
