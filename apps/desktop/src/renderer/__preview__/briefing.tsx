import { createRoot } from "react-dom/client";
import "../globals.css";
import BriefingHost from "../components/briefing/BriefingHost";
import { BRIEFING_OPEN_EVENT, openBriefing } from "../lib/briefing-open";
import { BRIEFING_SHOWN_LAUNCH_KEY, markShownThisLaunch } from "../lib/briefing-seen";
import { mulberry32 } from "../lib/demo-mode";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { buildDemoBriefing } from "../../shared/briefing-demo";
import {
  resolveBriefingWindow,
  type BriefingHolding,
  type BriefingNarrative,
  type BriefingReport,
  type BriefingWindow,
  type MarketHeadline,
  type Story,
  type StoryReaction,
} from "../../shared/briefing-types";
import { narrativeView } from "../../shared/briefing-view";

/**
 * Scratch harness for the handover briefing: the dashboard card and the panel
 * host, against a stubbed main process. The report is the demo builder's
 * (seed 7, a fixed book), so every figure is reproducible and no provider, key
 * or model is involved.
 *
 *   ?state=stories             default: the report as the demo builder writes it, headlines and stories included (a held name reporting,
 *                              a top-band headline on another, the tape, Asia as one session), 2 h 14 min before the open
 *   ?state=pre                 the same report with no stories: the "nothing rises to a story" line, and a card led by the first conclusion
 *   ?state=degraded            several sections failed, two more stale rows, two unavailable rows, no risk block
 *   ?state=markets-down        no market row has a move: the story chips print n/a and the table gives way to the quiet line
 *   ?state=empty-book          an account with cash and no positions: markets and calendar still show
 *   ?state=open-market         90 min into the session: phase "in_session", "Session so far" title, held moves on the "today" basis
 *   ?state=loading             getBriefing never resolves
 *   ?state=error               getBriefing answers { ok: false, error: "build_failed" }
 *   ?state=stale-calendar      the curated calendar ends before this session (covers_target: false)
 *   ?state=narrative-pending   the template ships with pending: true; the model lead AND model-written stories arrive 1.5 s later
 *   ?state=old-main            a bridge with no briefing handlers at all: the "unsupported" state
 *
 *   ?masked=1                  the dashboard's privacy switch
 *   ?auto=1                    clears the launch mark first, so the host's own open-by-itself path runs
 *   ?open=1                    dispatches openBriefing("shortcut") once the host is up
 *   ?shown=0 | 1 | keep        overrides the launch mark: 0 clears it (dot lit), 1 writes it (dot out), keep leaves it
 *                              as the last load left it (reload after ?auto=1 with this to watch "once per launch" hold)
 *   ?delay=ms                  how long the stubbed getBriefing takes (default 600)
 *   ?clock=demo                see "The clock" below
 *
 * The clock. A real report is viewed from the wall clock, so a report pinned to
 * 2026-09-28 would read "Closed" on every day but that one. By default the
 * scene is slid along the time axis instead: every instant in the window moves
 * by (now - scene time), which puts the wall clock 2 h 14 min before the open
 * whenever the page is loaded, and the two session dates are re-read from the
 * moved instants so "today" still means today. The price of that is cosmetic:
 * the ET labels on calendar rows ("08:30") belong to the scene, while the
 * panel's NOW line prints the real New York time, so the two can look out of
 * step, and the session can fall on a weekend. `?clock=demo` is the coherent
 * picture: the window stays on Mon 2026-09-28, and the report is flagged
 * demo: true (the view then reads "now" from generated_at) and
 * synthetic_now: true. What it costs: a demo book never opens by itself, and
 * the store drops a demo report it finds on a first hold while demo mode is
 * off, which shows as one extra loading pass on open.
 *
 * The stories. The default state shows the demo builder's own headlines and
 * stories, told by the engine's `deriveStories` over the same figures, so the
 * chips in a story and the rows in the tables say the same numbers. The other
 * variants still build three stories of their own from the report's figures
 * (the tape, a held name, a release), which is what keeps the model-swap and
 * degraded scenes independent of what the builder happens to draw.
 *
 * The launch mark. The panel opens by itself once per launch, recorded in
 * this origin's sessionStorage under `falcon.ui.briefingShownLaunch.v1`. A
 * reload keeps sessionStorage, so to watch the open-by-itself path again pass
 * ?auto=1 (which clears the mark) or open the page in a new tab.
 *
 * The account. BriefingHost only opens by itself for someone who has a paper
 * account, and the store builds its request from that account, so one is
 * seeded through the paper account's own `seedPaperAccount`. No user is signed
 * in here, so that lands in the unscoped keys `falcon.paperBalance`,
 * `falcon.paperPositions` and `falcon.paperUpdatedAt`. All of it is this dev
 * origin's storage, which the app never reads, though other harness pages on
 * the same port do.
 *
 * The gloss. Highlight a word in the panel's main column and the selection
 * gloss asks the bridge; here `explainSelection` answers after 500 ms with a
 * canned gloss that echoes the ticker and context it was given, so the
 * resolver on story blocks, conclusions and held rows can be checked by eye.
 *
 * Probes for a headless check: `window.__briefing` counts what the page asked
 * of the bridge and how often the open event fired, and keeps the last
 * request. An opening the host decided on by itself fires no event; look for
 * `[role="dialog"]` instead.
 */
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "stories";
const masked = params.get("masked") === "1";
const auto = params.get("auto") === "1";
const shownParam = params.get("shown") ?? params.get("seen");
const demoClock = params.get("clock") === "demo";
const delayMs = Math.max(0, Number(params.get("delay") ?? 600) || 0);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 07:16 ET on a Monday: the demo builder stamps its report 2 h 14 min before the open, which is this minute. */
const SCENE_PRE_OPEN_MS = Date.parse("2026-09-28T11:16:00Z");
/** 11:00 ET the same day, for the in-session state. */
const SCENE_IN_SESSION_MS = Date.parse("2026-09-28T15:00:00Z");

const CASH = 18_400;
const FIXED_POSITIONS: BriefingHolding[] = [
  { symbol: "NVDA", shares: 120, cost_usd: 21_000 },
  { symbol: "AAPL", shares: 80, cost_usd: 16_500 },
  { symbol: "MSFT", shares: 40, cost_usd: 15_800 },
  { symbol: "AVGO", shares: 60, cost_usd: 14_900 },
  { symbol: "LLY", shares: 12, cost_usd: 9_800 },
  { symbol: "JPM", shares: 50, cost_usd: 12_400 },
  // One borrowed position, so the weights bar's "borrowed" note and a signed P&L are on screen.
  { symbol: "TSLA", shares: -20, cost_usd: -6_900 },
  { symbol: "SPY", shares: 45, cost_usd: 26_500 },
  { symbol: "QQQ", shares: 30, cost_usd: 15_200 },
  { symbol: "TLT", shares: 100, cost_usd: 9_300 },
];

const NY_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function nyYmd(iso: string): string {
  const parts: Record<string, string> = {};
  for (const part of NY_DATE.formatToParts(new Date(iso))) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Slides the whole window along the time axis; see "The clock" in the header. */
function shiftWindow(w: BriefingWindow, deltaMs: number): BriefingWindow {
  if (deltaMs === 0) return w;
  const move = (iso: string) => new Date(Date.parse(iso) + deltaMs).toISOString();
  const open = move(w.target_open_at);
  const since = move(w.overnight_since);
  return {
    ...w,
    overnight_since: since,
    window_opens_at: move(w.window_opens_at),
    target_open_at: open,
    target_close_at: move(w.target_close_at),
    target_session_ymd: nyYmd(open),
    prev_session_ymd: nyYmd(since),
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const sceneNowMs = state === "open-market" ? SCENE_IN_SESSION_MS : SCENE_PRE_OPEN_MS;
const deltaMs = demoClock ? 0 : Date.now() - sceneNowMs;
// Resolved by the engine's own rule at the scene's moment, so phase and
// auto_show are the ones the main process would send, not a guess made here.
const sceneWindow = shiftWindow(resolveBriefingWindow(new Date(sceneNowMs)), deltaMs);
const holdings = state === "empty-book" ? [] : FIXED_POSITIONS;

function baseReport(): BriefingReport {
  const built = buildDemoBriefing(mulberry32(7), sceneWindow, holdings, CASH);
  return {
    ...built,
    // The builder writes both lists (schema 3); the guards keep an older or
    // hand-built report from crashing the page, with the panel then showing
    // its "nothing rises" line.
    headlines: Array.isArray(built.headlines) ? built.headlines : [],
    stories: Array.isArray(built.stories) ? built.stories : [],
    // The builder stamps 2 h 14 min before the open whatever the scene; the
    // in-session state is viewed from later than that.
    generated_at: new Date(sceneNowMs + deltaMs).toISOString(),
    demo: demoClock,
    synthetic_now: demoClock,
    // The builder forces pre_open and auto_show: false (a demo must never open
    // by itself on stage). Here the engine's own answer is put back, because
    // the open-by-itself path is one of the things this page exists to show.
    window: sceneWindow,
  };
}

const MINUS = "−";

function signedPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? "+" : rounded < 0 ? MINUS : ""}${Math.abs(rounded).toFixed(2)}%`;
}

/**
 * Three stories over the report's own figures: the tape, one held name, one
 * release. The chips read the market rows, so a story and the table under it
 * never disagree. `source` is "model" for the version the stubbed narrative
 * call delivers, with a different lead sentence so the exchange is visible.
 */
function withStories(report: BriefingReport, source: Story["source"]): BriefingReport {
  const row = (symbol: string) => report.overnight.markets.find((r) => r.symbol === symbol);
  const chip = (symbol: string, label: string): StoryReaction => {
    const r = row(symbol);
    return { label, symbol, move: r?.move ?? null, unit: r?.unit ?? "pct" };
  };
  const since = Date.parse(report.window.overnight_since);
  const at = (hoursAfterClose: number) => new Date(since + hoursAfterClose * HOUR_MS).toISOString();
  const es = row("ES=F")?.move ?? null;
  const nq = row("NQ=F")?.move ?? null;
  const vix = row("^VIX")?.last ?? null;
  const nikkei = row("^N225")?.move ?? null;
  const lead = report.implications[0];
  const mover = report.overnight.held_movers[0];
  const item = mover ? report.overnight.held_news.find((n) => n.ticker === mover.ticker) : undefined;

  const headlines: MarketHeadline[] = [
    {
      id: "hl-futures",
      title: "Equity Futures Lower Pre-Bell Amid Ongoing Middle East Tensions",
      source: "Preview Desk",
      url: "https://example.test/hl-futures",
      published_at: at(13),
      related: ["SPY", "QQQ"],
      via: "SPY",
    },
    {
      id: "hl-boj",
      title: "Bank of Japan Holds Policy Rate, Points to Wage Growth",
      source: "Preview Desk",
      url: "https://example.test/hl-boj",
      published_at: at(8),
      related: ["^N225"],
      via: "^GSPC",
    },
  ];

  const stories: Story[] = [
    {
      id: "market:futures",
      scope: "market",
      at: at(13),
      what:
        source === "model"
          ? "Futures are lower into the open, and the one market-wide headline of the night ties the move to renewed Middle East tensions."
          : `US equity futures are ${es !== null && es < 0 ? "lower" : "higher"} into the open; the overnight headline names renewed Middle East tensions.`,
      reaction: `S&P 500 futures are ${signedPct(es)} against the prior settle, Nasdaq-100 futures ${signedPct(nq)}, and the VIX is at ${vix !== null ? vix.toFixed(2) : "n/a"}.`,
      reactions: [chip("ES=F", "S&P fut"), chip("NQ=F", "Nasdaq fut"), chip("^STOXX50E", "Euro Stoxx"), chip("^VIX", "VIX")],
      meaning: lead?.headline ?? null,
      tickers: [],
      evidence: ["hl-futures", ...(lead ? [lead.id] : [])],
      source,
    },
  ];

  if (mover) {
    const named = report.implications.find((i) => i.kind === "name_specific" && i.tickers.includes(mover.ticker));
    const when = mover.basis === "today" ? "so far today" : "in the pre-market";
    stories.push({
      id: `name:${mover.ticker}`,
      scope: "name",
      at: item?.published_at ?? at(10),
      what: item
        ? `${mover.ticker} carried a ${item.source} item through the night: ${item.headline}.`
        : `${mover.ticker} moved apart from the market overnight, with nothing on the wire to go with it.`,
      reaction: `${mover.ticker} is ${signedPct(mover.move_pct)} ${when}${mover.move_z !== null ? `, ${Math.abs(mover.move_z).toFixed(1)} of its daily volatility` : ""}.`,
      reactions: [{ label: mover.ticker, symbol: mover.ticker, move: mover.move_pct, unit: "pct" }, chip("ES=F", "S&P fut")],
      meaning: named?.headline ?? null,
      tickers: [mover.ticker],
      evidence: [item?.incident_id ?? `mover:${mover.ticker}`, ...(named ? [named.id] : [])],
      source,
    });
  }

  stories.push({
    id: "release:boj",
    scope: "release",
    at: at(8),
    what: "The Bank of Japan left its policy rate unchanged at this morning's meeting and pointed to wage growth.",
    reaction: `The Nikkei closed ${signedPct(nikkei)} and the yen is little changed.`,
    reactions: [chip("^N225", "Nikkei")],
    meaning: null,
    tickers: [],
    evidence: ["hl-boj"],
    source,
  });

  return { ...report, headlines, stories };
}

function degraded(report: BriefingReport): BriefingReport {
  const stalePrint = new Date(Date.parse(report.window.overnight_since) - 14 * HOUR_MS).toISOString();
  const quietOnVol = ["NVDA", "AVGO"];
  return {
    ...report,
    overnight: {
      ...report.overnight,
      // Not the Nikkei: the narrative quotes it, and a quoted row with no move
      // is a state the engine never produces.
      markets: report.overnight.markets.map((row) => {
        if (row.symbol === "^HSI" || row.symbol === "000001.SS") {
          return { ...row, last: row.prev_close ?? row.last, move: null, state: "stale" as const, as_of: stalePrint };
        }
        if (row.symbol === "^FTSE" || row.symbol === "CL=F") {
          return { ...row, last: null, prev_close: null, move: null, state: "unavailable" as const, as_of: null };
        }
        return row;
      }),
      held_movers: report.overnight.held_movers.map((m) => (quietOnVol.includes(m.ticker) ? { ...m, move_z: null } : m)),
      held_news: [],
      filings: [],
      measurements: [],
    },
    risk: null,
    corporate_events: report.corporate_events.filter((e) => e.kind === "rebalance"),
    // The details are never shown (the view prints its own line per section);
    // they are here to prove that on screen.
    degraded: [
      { section: "chain_news", detail: "PREVIEW DETAIL, MUST NOT RENDER: chain unreachable" },
      { section: "quant", detail: "PREVIEW DETAIL, MUST NOT RENDER: no series", symbols: quietOnVol },
      { section: "risk", detail: "PREVIEW DETAIL, MUST NOT RENDER: risk engine unreachable" },
      { section: "corporate_actions", detail: "PREVIEW DETAIL, MUST NOT RENDER: provider 502", symbols: ["AAPL", "MSFT", "JPM"] },
      { section: "narrative", detail: "PREVIEW DETAIL, MUST NOT RENDER: model unreachable" },
    ],
  };
}

function marketsDown(report: BriefingReport): BriefingReport {
  return {
    ...report,
    overnight: {
      ...report.overnight,
      markets: report.overnight.markets.map((row) => ({ ...row, last: null, prev_close: null, move: null, state: "unavailable" as const, as_of: null })),
    },
    degraded: [{ section: "markets", detail: "PREVIEW DETAIL, MUST NOT RENDER: provider down" }],
  };
}

function inSession(report: BriefingReport): BriefingReport {
  return {
    ...report,
    overnight: {
      ...report.overnight,
      held_movers: report.overnight.held_movers.map((m) => ({ ...m, basis: "today" as const, session: "regular" as const })),
    },
  };
}

function staleCalendar(report: BriefingReport): BriefingReport {
  const until = addDays(report.window.target_session_ymd, -12);
  return {
    ...report,
    // Past the end of the curated file the engine has no releases to list;
    // what is left is what it derives by rule (expiries, held earnings).
    calendar_today: report.calendar_today.filter((c) => c.kind !== "data" && c.kind !== "fomc"),
    calendar_coverage: { ...report.calendar_coverage, until, covers_target: false, days_left: -12 },
  };
}

function narrativePending(report: BriefingReport): BriefingReport {
  return { ...report, narrative: { ...report.narrative, pending: true, reason: null } };
}

/** A different lead sentence over the same facts, so the exchange is visible on the card as well as in the panel. */
function modelNarrative(report: BriefingReport): BriefingNarrative {
  const es = report.overnight.markets.find((r) => r.symbol === "ES=F")?.move ?? 0;
  const lead = `US equity futures point ${es < 0 ? "lower" : "higher"} into the open, with S&P 500 contracts ${es < 0 ? "down" : "up"} ${Math.abs(es).toFixed(2)}%.`;
  const rest = narrativeView(report, false).sentences.slice(1);
  return {
    text: [lead, ...rest].join(" "),
    source: "model",
    model: "preview-stub",
    generated_at: new Date().toISOString(),
    facts_hash: report.facts_hash,
    pending: false,
    reason: null,
  };
}

const VARIANTS: Record<string, (report: BriefingReport) => BriefingReport> = {
  stories: (r) => r,
  pre: (r) => r,
  degraded: (r) => withStories(degraded(r), "template"),
  "markets-down": (r) => withStories(marketsDown(r), "template"),
  "open-market": (r) => withStories(inSession(r), "template"),
  "stale-calendar": (r) => withStories(staleCalendar(r), "template"),
  "narrative-pending": (r) => narrativePending(withStories(r, "template")),
};

// Built once: every poll has to answer with the same facts_hash, or the store
// would treat each one as a new set of facts and ask for the narrative again.
const report = (VARIANTS[state] ?? ((r: BriefingReport) => r))(baseReport());

// ---------------------------------------------------------------------------
// The bridge, the account and the launch mark: all in place BEFORE createRoot
// ---------------------------------------------------------------------------

const probes = { opens: 0, windows: 0, gets: 0, forced: 0, narratives: 0, glosses: 0, lastRequest: null as unknown, lastGloss: null as unknown };
(window as any).__briefing = probes;
window.addEventListener(BRIEFING_OPEN_EVENT, () => {
  probes.opens += 1;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(window as any).meridian =
  state === "old-main"
    ? {}
    : {
        getBriefingWindow: async () => {
          probes.windows += 1;
          return { ok: true, window: report.window, calendar_coverage: report.calendar_coverage };
        },
        getBriefing: async (request: { force?: boolean }) => {
          probes.gets += 1;
          if (request?.force) probes.forced += 1;
          probes.lastRequest = request;
          if (state === "loading") return new Promise(() => {});
          await wait(delayMs);
          if (state === "error") return { ok: false, error: "build_failed" };
          return { ok: true, report, source: request?.force ? "fresh" : "cache" };
        },
        getBriefingNarrative: async () => {
          probes.narratives += 1;
          if (state !== "narrative-pending") return { ok: false, error: "not_found" };
          await wait(1_500);
          // The stories ride along with the narrative answer; the store
          // splices both into the report it already has.
          return { ok: true, narrative: modelNarrative(report), stories: withStories(report, "model").stories };
        },
        // The selection gloss. A canned answer that echoes what it was asked
        // with, so the panel's resolver (ticker and context per block) can be
        // read straight off the popover.
        explainSelection: async (request: { selection: string; context?: string; ticker?: string }) => {
          probes.glosses += 1;
          probes.lastGloss = request;
          await wait(500);
          const passage = request.selection.length > 40;
          return {
            ok: true,
            cached: false,
            gloss: {
              kind: passage ? "passage" : "term",
              term: request.selection,
              english: passage
                ? `Preview passage gloss. This sentence is about ${request.ticker ?? "the market as a whole"}.`
                : `Preview gloss for "${request.selection}"${request.ticker ? ` about ${request.ticker}` : ""}.`,
              in_context: passage ? "" : `Context handed over: ${request.context ?? "(none)"}`,
              finance_specific: true,
            },
          };
        },
        translateGloss: async () => {
          await wait(500);
          return { ok: true, cached: false, turkish: "Önizleme çevirisi: bu bir yer tutucudur." };
        },
      };

const positions: Record<string, PaperPosition> = {};
for (const h of holdings) positions[h.symbol] = { symbol: h.symbol, shares: h.shares, costUsd: h.cost_usd };
seedPaperAccount({ cash: CASH, positions });

// Without ?auto=1 the popup has to stay shut until it is asked for, so the mark
// is written for the scene's session.
const markAsShown = shownParam === null ? !auto : shownParam === "1";
try {
  // "keep" is the one load that does not touch the mark: sessionStorage
  // survives a reload, so this is how the once-per-launch rule is watched
  // holding after the host opened the panel by itself on the load before.
  if (shownParam !== "keep") {
    window.sessionStorage.removeItem(BRIEFING_SHOWN_LAUNCH_KEY);
    if (markAsShown) markShownThisLaunch(window.sessionStorage, report.window.target_session_ymd, new Date().toISOString());
  }
} catch {
  /* a blocked store only costs the preview its mark */
}

// The host attaches its listener in an effect, after the first commit.
if (params.get("open") === "1") setTimeout(() => openBriefing("shortcut"), 150);

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-[#EAEAE6] p-8">
    <div className="font-sans text-[12px] text-[#6b7280]">dashboard stays mounted behind the popup (Shift+M, or ?open=1)</div>
    <BriefingHost masked={masked} view="dashboard" />
  </div>,
);
