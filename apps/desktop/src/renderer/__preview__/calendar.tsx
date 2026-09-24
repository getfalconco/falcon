import { createRoot } from "react-dom/client";
import "../globals.css";
import CalendarCard from "../components/dashboard/CalendarCard";
import { mulberry32 } from "../lib/demo-mode";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { buildDemoBriefing } from "../../shared/briefing-demo";
import { resolveBriefingWindow, type BriefingHolding, type BriefingReport, type BriefingWindow } from "../../shared/briefing-types";

/**
 * Scratch harness for the dashboard's calendar card, against a stubbed main
 * process. The report is the demo builder's (seed 7, a fixed book), so every
 * row is reproducible and no provider, key or model is involved. The card is
 * flagged demo so it reads "now" from the report's own stamp: the rail then
 * shows a coherent day whatever the wall clock says.
 *
 *   ?state=pre             default: 07:16 ET, every timed row ahead, the now line at the top
 *   ?state=open            11:00 ET, the morning prints behind the line, the afternoon ahead
 *   ?state=after           17:30 ET, every row behind the line, the line under the last one
 *   ?state=next            21:30 ET the evening before: the report has rolled to the next session
 *   ?state=ended           01:00 ET the night after: a report the clock has left behind (a refetch that failed)
 *   ?state=empty           nothing on the session's calendar
 *   ?state=stale           the curated calendar ends before this session (covers_target: false)
 *   ?state=early-close     a 13:00 ET close
 *   ?state=loading         getBriefing never resolves
 *   ?state=error           getBriefing answers { ok: false, error: "build_failed" }
 *   ?state=old-main        a bridge with no briefing handlers at all: the "unsupported" state
 *
 *   ?w=px ?h=px            the card's box (default 420 by 560), the way the canvas sizes it
 *   ?delay=ms              how long the stubbed getBriefing takes (default 400)
 *
 * Probes: `window.__calendar.gets` counts requests to the bridge.
 */
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "pre";
const width = Math.max(200, Number(params.get("w") ?? 420) || 420);
const height = Math.max(200, Number(params.get("h") ?? 560) || 560);
const delayMs = Math.max(0, Number(params.get("delay") ?? 400) || 0);

/** The scene: Monday 2026-09-28. The demo builder stamps 2 h 14 min before the open. */
const SCENE_DAY_OPEN_MS = Date.parse("2026-09-28T13:30:00Z");
const HOUR_MS = 3_600_000;
const CLOCKS: Record<string, number> = {
  pre: SCENE_DAY_OPEN_MS - 2.2333 * HOUR_MS,
  open: SCENE_DAY_OPEN_MS + 1.5 * HOUR_MS,
  after: SCENE_DAY_OPEN_MS + 8 * HOUR_MS,
  // 01:30Z Monday: 21:30 ET on Sunday, the evening before the scene day.
  next: SCENE_DAY_OPEN_MS - 12 * HOUR_MS,
  // 05:00Z Tuesday: 01:00 ET the night after the scene day, the session behind the clock.
  ended: SCENE_DAY_OPEN_MS + 15.5 * HOUR_MS,
};

const CASH = 18_400;
const HOLDINGS: BriefingHolding[] = [
  { symbol: "NVDA", shares: 120, cost_usd: 21_000 },
  { symbol: "AAPL", shares: 80, cost_usd: 16_500 },
  { symbol: "MSFT", shares: 40, cost_usd: 15_800 },
  { symbol: "AVGO", shares: 60, cost_usd: 14_900 },
  { symbol: "LLY", shares: 12, cost_usd: 9_800 },
  { symbol: "JPM", shares: 50, cost_usd: 12_400 },
  { symbol: "SPY", shares: 45, cost_usd: 26_500 },
  { symbol: "QQQ", shares: 30, cost_usd: 15_200 },
];

/** `?at=HH:MM` pins the scene clock to that New York time on the scene day, whatever the state. */
const at = /^\d\d:\d\d$/.test(params.get("at") ?? "") ? (params.get("at") as string).split(":").map(Number) : null;
const sceneNowMs = at ? SCENE_DAY_OPEN_MS + ((at[0] - 9) * 60 + (at[1] - 30)) * 60_000 : (CLOCKS[state] ?? CLOCKS.pre);
// The window is resolved at 07:16 on the scene day for every state, so the
// same session (and so the same rows) is listed whichever clock views it; a
// window resolved at 21:30 the evening before would already be that session.
const sceneWindow: BriefingWindow = resolveBriefingWindow(new Date(CLOCKS.pre));

/**
 * `?clock=real`: the report is not flagged demo, so the card reads the wall
 * clock and prints the real New York minute on the "now" line, ticking as the
 * minute turns. The window is slid along the time axis so its session is the
 * one the wall clock is on; the ET labels on the rows still belong to the
 * scene, so where the line falls among them is cosmetic here.
 */
const realClock = params.get("clock") === "real";
const shiftMs = realClock ? Date.now() - CLOCKS.pre : 0;
function shifted(w: BriefingWindow): BriefingWindow {
  if (shiftMs === 0) return w;
  const move = (iso: string) => new Date(Date.parse(iso) + shiftMs).toISOString();
  const nyYmd = (iso: string) => {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso))) parts[p.type] = p.value;
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
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

function baseReport(): BriefingReport {
  const window = shifted(sceneWindow);
  const built = buildDemoBriefing(mulberry32(7), window, HOLDINGS, CASH);
  return {
    ...built,
    generated_at: new Date(sceneNowMs + shiftMs).toISOString(),
    demo: !realClock,
    synthetic_now: !realClock,
    window,
    calendar_today: built.calendar_today.map((c) => (c.at ? { ...c, at: new Date(Date.parse(c.at) + shiftMs).toISOString() } : c)),
  };
}

/** An instant on the scene day at a New York wall time, for rows made up here. */
function etInstant(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(SCENE_DAY_OPEN_MS + ((h - 9) * 60 + (m - 30)) * 60_000).toISOString();
}

const VARIANTS: Record<string, (r: BriefingReport) => BriefingReport> = {
  empty: (r) => ({ ...r, calendar_today: [] }),
  // More rows than a 560px card can show at once, all day and timed, so the
  // list has to scroll and the "now" line has to be put into view.
  crowded: (r) => ({
    ...r,
    calendar_today: [
      { id: "c-opex", kind: "opex", time_et: null, at: null, title: "Monthly options expiry", detail: "Standard monthly equity and index options expire at the close.", importance: 2, tickers: [], source: "rule" },
      { id: "c-earn", kind: "earnings", time_et: null, at: null, title: "NVDA earnings report", detail: "After the close, or at an hour not yet announced.", importance: 3, tickers: ["NVDA"], source: "tracker" },
      ...["07:00", "07:30", "08:15", "08:30", "09:00", "09:45", "10:00", "10:30", "11:30", "12:00", "13:00", "14:00", "14:30", "15:30", "16:15"].map((t, i) => ({
        id: `c-${t}`,
        kind: (t === "14:00" ? "fomc" : "data") as "fomc" | "data",
        time_et: t,
        at: etInstant(t),
        title: t === "14:00" ? "FOMC rate decision and projections" : `Release ${i + 1}`,
        detail: t === "14:00" ? null : "Covers 2026-08.",
        importance: (t === "14:00" ? 3 : ((i % 3) + 1)) as 1 | 2 | 3,
        tickers: [],
        source: "bls",
      })),
    ],
  }),
  stale: (r) => ({
    ...r,
    calendar_today: r.calendar_today.filter((c) => c.kind !== "data" && c.kind !== "fomc"),
    calendar_coverage: { ...r.calendar_coverage, until: "2026-09-16", covers_target: false, days_left: -12 },
  }),
  "early-close": (r) => ({ ...r, window: { ...r.window, early_close: true } }),
};

const report = (VARIANTS[state] ?? ((r: BriefingReport) => r))(baseReport());

const probes = { gets: 0 };
(window as any).__calendar = probes;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(window as any).meridian =
  state === "old-main"
    ? {}
    : {
        getBriefingWindow: async () => ({ ok: true, window: report.window, calendar_coverage: report.calendar_coverage }),
        getBriefing: async () => {
          probes.gets += 1;
          if (state === "loading") return new Promise(() => {});
          await wait(delayMs);
          if (state === "error") return { ok: false, error: "build_failed" };
          return { ok: true, report, source: "cache" };
        },
        getBriefingNarrative: async () => ({ ok: false, error: "not_found" }),
      };

const positions: Record<string, PaperPosition> = {};
for (const h of HOLDINGS) positions[h.symbol] = { symbol: h.symbol, shares: h.shares, costUsd: h.cost_usd };
seedPaperAccount({ cash: CASH, positions });

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-[#EAEAE6] p-8">
    {/* The canvas gives every card a box and overrides its resting min-height, as here. */}
    <div className="[&>*]:!min-h-0" style={{ width, height }}>
      <CalendarCard onDuplicate={() => undefined} onRemove={() => undefined} />
    </div>
  </div>,
);
