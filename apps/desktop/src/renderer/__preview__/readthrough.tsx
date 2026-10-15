import { createRoot } from "react-dom/client";
import "./fonts";
import "../globals.css";
import ReadthroughCard from "../components/readthrough/ReadthroughCard";
import ReadthroughSection from "../components/readthrough/ReadthroughSection";
import { requestReadthroughView } from "../lib/readthrough-store";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import type { ReadthroughEvent, ReadthroughRequest, ReadthroughResult, ReadthroughRow, ReadthroughStats } from "../../shared/readthrough-types";
import { addDaysYmd, nyToday } from "../../shared/earnings-view";

/**
 * Scratch harness for the Read-through card and the Earnings tab's
 * Read-through section against a stubbed main process. The rows are
 * fixtures for the harness only: no provider, key or model.
 *
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the chrome in that language
 *   ?state=error       every request fails
 *   ?state=restart     a bridge without the channel
 *   ?state=loading     the request never answers
 *   ?state=empty       no linked company reports in view
 *   ?names=0           no positions, no watchlist
 *
 * Probe: `window.__readthrough.asks` lists the requests.
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const state = params.get("state");
const noNames = params.get("names") === "0";

const positions: Record<string, PaperPosition> = {};
if (!noNames) {
  for (const [symbol, shares] of [
    ["NVDA", 120],
    ["AMD", 90],
    ["AAPL", 80],
  ] as const) {
    positions[symbol] = { symbol, shares, costUsd: shares * 150 };
  }
}
seedPaperAccount({ cash: 18_400, positions });
localStorage.setItem("meridian-watchlist", JSON.stringify(noNames ? [] : [{ ticker: "MSFT", companyName: "Microsoft" }]));

const today = nyToday();
const d = (n: number) => addDaysYmd(today, n);

/** Eight quarterly reports back from `last`, with H following C `withIt` times. */
function events(last: string, cSize: number, hSize: number, withIt: boolean[]): ReadthroughEvent[] {
  return withIt.map((w, k) => {
    const date = addDaysYmd(last, -91 * k);
    const c = (k % 3 === 1 ? -1 : 1) * cSize * (1 + (k % 4) * 0.15);
    const h = (w ? Math.sign(c) : -Math.sign(c)) * hSize * (1 + (k % 3) * 0.2);
    return {
      date,
      reactionDay: addDaysYmd(date, 1),
      counterpartyMove: c + 0.002,
      counterpartyAbnormal: c,
      holdingMove: h + 0.003,
      holdingAbnormal: h,
      holdingNextAbnormal: h * 0.2,
      marketMove: 0.002,
      surprisePct: k % 2 === 0 ? 6.2 : -3.1,
      withIt: w,
    };
  });
}

function statsOf(ev: ReadthroughEvent[], normal: number, beta: number): ReadthroughStats {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const avgAbsAbnormal = mean(ev.map((e) => Math.abs(e.holdingAbnormal)));
  return {
    events: ev.length,
    withIt: ev.filter((e) => e.withIt).length,
    avgAbsMove: mean(ev.map((e) => Math.abs(e.holdingMove))),
    avgAbsAbnormal,
    avgFollow: mean(ev.map((e) => e.holdingAbnormal * Math.sign(e.counterpartyAbnormal))),
    avgNextFollow: mean(ev.map((e) => (e.holdingNextAbnormal ?? 0) * Math.sign(e.counterpartyAbnormal))),
    nextEvents: ev.length,
    normalAbsAbnormal: normal,
    sensitivity: Math.round((avgAbsAbnormal / normal) * 1000) / 1000,
    surpriseEvents: ev.length,
    withSurprise: Math.max(0, ev.filter((e) => e.withIt).length - 1),
    beta,
    betaFallback: false,
    from: ev[ev.length - 1]!.reactionDay,
    to: ev[0]!.reactionDay,
  };
}

function row(over: Partial<ReadthroughRow> & Pick<ReadthroughRow, "counterparty" | "holding">, ev: ReadthroughEvent[], normal = 0.011, beta = 1.3): ReadthroughRow {
  const stats = ev.length >= 3 ? statsOf(ev, normal, beta) : null;
  return {
    id: `${over.counterparty}>${over.holding}`,
    counterpartyName: null,
    held: true,
    watchlist: false,
    relation: "supplier",
    tier: "critical",
    namedBy: over.holding,
    form: "10-K",
    filingDate: "2026-02-26",
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000019/nvda-20260125.htm",
    kind: "upcoming",
    date: d(1),
    time: "bmo",
    status: "confirmed",
    report: null,
    sample: ev.length,
    stats,
    events: ev,
    weight: 1,
    score: stats?.sensitivity ?? 0,
    ...over,
  };
}

const ROWS: ReadthroughRow[] = [
  row({ counterparty: "TSM", holding: "NVDA", counterpartyName: "Taiwan Semiconductor", namedBy: "NVDA", date: d(1), time: "bmo" }, events(d(-90), 0.04, 0.021, [true, true, false, true, true, true, false, true])),
  row(
    {
      counterparty: "ASML",
      holding: "AMD",
      kind: "recent",
      date: d(-1),
      time: "bmo",
      form: "20-F",
      namedBy: "ASML",
      relation: "supplier",
      report: { epsActual: 5.48, epsEstimate: 5.12, surprisePct: 7.03, reactionDay: d(-1), counterpartyMove: 0.052, holdingOnDay: 0.018, holdingSince: 0.024, sinceTo: today },
    },
    events(d(-92), 0.05, 0.012, [true, true, true, false, true, true]),
    0.013,
    1.6,
  ),
  row({ counterparty: "MU", holding: "NVDA", relation: "competitor", date: d(9), time: "amc", namedBy: "MU" }, events(d(-80), 0.06, 0.009, [false, true, false, true, true])),
  row({ counterparty: "SMCI", holding: "NVDA", relation: "customer", date: d(12), time: "unknown", namedBy: "NVDA", tier: "important" }, events(d(-70), 0.08, 0.01, [true, true])),
  row(
    { counterparty: "AVGO", holding: "MSFT", held: false, watchlist: true, relation: "supplier", date: d(20), time: "amc", namedBy: "MSFT", weight: 0.25 },
    events(d(-60), 0.03, 0.006, [true, false, true, true]),
    0.009,
    0.9,
  ),
];

const asks: ReadthroughRequest[] = [];
(window as unknown as { __readthrough: unknown }).__readthrough = { asks };

async function radar(request: ReadthroughRequest): Promise<ReadthroughResult> {
  asks.push(request);
  if (state === "loading") return new Promise(() => {});
  if (state === "error") return { ok: false, error: "unavailable" };
  await new Promise((r) => setTimeout(r, 300));
  return {
    ok: true,
    today,
    builtAt: new Date().toISOString(),
    rows: state === "empty" ? [] : ROWS,
    links: 9,
    truncated: false,
    degraded: [],
  };
}

(window as unknown as { meridian: unknown }).meridian = state === "restart" ? {} : { getReadthroughRadar: radar, openExternal: async () => undefined };

createRoot(document.getElementById("root")!).render(
  <div
    className="h-screen overflow-y-auto pt-10"
    style={{ minWidth: 1060, background: document.documentElement.dataset.theme === "dark" ? "hsl(0 0% 3.5%)" : "#EAEAE6" }}
  >
    <div className="px-8 pb-6">
      <ReadthroughSection />
    </div>
    <div className="flex gap-4 px-8 pb-12">
      <div style={{ width: 300, height: 560 }}>
        <ReadthroughCard onOpenReadthrough={() => requestReadthroughView()} />
      </div>
      <div style={{ width: 420, height: 560 }}>
        <ReadthroughCard />
      </div>
    </div>
  </div>,
);
