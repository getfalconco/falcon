import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/libre-baskerville/400.css";
import "../globals.css";
import AgentsCard from "../components/agents/AgentsCard";
import AgentsTab from "../components/agents/AgentsTab";
import { createFixtureAgents } from "../components/agents/agent-fixtures";
import { onAgentsOpenRequest } from "../components/agents/agents-store";
import { installAgentsAdapter } from "../lib/agents-client";
import { applyTheme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { applyMotion } from "../lib/motion";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import type { StockCatalogEntry } from "../../shared/stock-catalog";

/**
 * Scratch harness for the Agents tab and the dashboard's Agents card, against
 * the in-memory fixture engine (components/agents/agent-fixtures.ts). Nothing
 * here reaches a provider or the main process.
 *
 *   ?view=both        default: the card beside the tab, as on the dashboard
 *   ?view=tab         the tab alone, at the window's size
 *   ?view=card        the card alone (?w=px ?h=px, default 300 by 560)
 *   ?state=empty      no agents yet: the setup wizard over the empty state
 *   ?state=loading    list() never answers
 *   ?state=error      every call fails
 *   ?state=none       no engine at all: what a build without the bridge shows
 *   ?theme=dark       the dark theme (default light)
 *   ?motion=reduce    reduced motion
 *   ?latency=ms       how long each fixture call takes (default 350)
 *   ?draft=fail       reading words into a draft always fails, as with the
 *                     model and the fallback both unavailable (a starter's
 *                     own draft still opens the confirm step)
 *   ?lang=tr-TR       show the screens in that language (kept, as a pick would be)
 *   ?holdings=AMD,NVDA  seed the paper account with these positions, so the
 *                     create flow's starters are built from them (and the
 *                     stubbed earnings calendar has them reporting soon)
 *
 * Probes: `__agents.fire(id)` pushes a new report for an agent as the engine
 * would; `__agents.open(id)` sends an `open-agent` request.
 */
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "default";
const view = params.get("view") ?? "both";
const width = Math.max(220, Number(params.get("w") ?? 300) || 300);
const height = Math.max(320, Number(params.get("h") ?? 560) || 560);
/**
 * `?pan=x,y`: the tab is laid out in a fixed 1060 by 680 frame (the window's
 * minimum) and shifted so that point sits at the top left, for looking at a
 * part of the minimum-size window at full scale in a narrow pane.
 */
const pan = /^\d+,\d+$/.test(params.get("pan") ?? "") ? (params.get("pan") as string).split(",").map(Number) : null;
if (pan) document.documentElement.style.overflow = "hidden";

applyTheme(params.get("theme") === "dark" ? "dark" : "light");
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
applyMotion(params.get("motion") === "reduce" ? "reduce" : "full");

const CATALOG: StockCatalogEntry[] = [
  { symbol: "NVDA", companyName: "NVIDIA Corporation" },
  { symbol: "AAPL", companyName: "Apple Inc." },
  { symbol: "AMD", companyName: "Advanced Micro Devices" },
  { symbol: "AMZN", companyName: "Amazon.com, Inc." },
  { symbol: "AVGO", companyName: "Broadcom Inc." },
  { symbol: "MSFT", companyName: "Microsoft Corporation" },
  { symbol: "META", companyName: "Meta Platforms, Inc." },
  { symbol: "TSM", companyName: "Taiwan Semiconductor" },
  { symbol: "TSLA", companyName: "Tesla, Inc." },
];

const holdings = (params.get("holdings") ?? "")
  .split(",")
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
if (holdings.length > 0) {
  const positions: Record<string, PaperPosition> = {};
  for (const symbol of holdings) positions[symbol] = { symbol, shares: 10, costUsd: 1500 };
  seedPaperAccount({ cash: 10_000, positions });
}
const dayPlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** The earnings calendar, stubbed: each held name reports a few days apart; the tracked list for a reader with none. */
const earningsRows = (scope: string, held: string[]) =>
  (scope === "mine" ? held : ["ORCL", "JPM", "AVGO"]).map((ticker, i) => ({
    ticker,
    company: null,
    date: dayPlus(5 + i * 9),
    held: scope === "mine",
    watchlist: false,
    tracked: scope !== "mine",
  }));

(window as unknown as { meridian: unknown }).meridian = {
  getEarningsUpcoming: async (req: { scope: string; held?: string[] }) => ({
    ok: true,
    scope: req.scope,
    from: dayPlus(0),
    to: dayPlus(28),
    rows: earningsRows(req.scope, req.held ?? []),
    builtAt: new Date().toISOString(),
    scopes: { tracked: true, all: false },
    unavailable: [],
    marketCalendar: "missing",
  }),
  searchStockSymbols: async (q: string, limit = 6) => {
    const s = q.trim().toUpperCase();
    return CATALOG.filter((c) => c.symbol.startsWith(s) || c.companyName.toUpperCase().includes(s)).slice(0, limit);
  },
  openExternal: async (url: string) => {
    console.info("[preview] openExternal", url);
  },
};

if (state !== "none") {
  const adapter = createFixtureAgents({
    latency: Number(params.get("latency") ?? 350),
    empty: state === "empty",
    failing: state === "error",
    hanging: state === "loading",
  }) as ReturnType<typeof createFixtureAgents> & { __fire: (id: string) => void; __open: (id: string) => void };
  if (params.get("draft") === "fail") {
    adapter.draftFromBrief = async () => {
      console.info("[preview] draftFromBrief called, failing");
      return { ok: false, error: "The brief could not be read right now." };
    };
  }
  installAgentsAdapter(adapter);
  (window as unknown as { __agents: unknown }).__agents = { fire: adapter.__fire, open: adapter.__open };
}

function Harness() {
  const [tab, setTab] = useState<"dashboard" | "agents">(view === "card" ? "dashboard" : "agents");
  useEffect(() => onAgentsOpenRequest(() => setTab("agents")), []);

  const card = (
    <div className="[&>*]:!min-h-0" style={{ width, height }}>
      <AgentsCard onOpenAgents={() => setTab("agents")} />
    </div>
  );

  if (view === "card") return <div className="min-h-screen bg-background p-8">{card}</div>;
  if (view === "tab" || tab === "agents") {
    return (
      <div
        className="relative overflow-hidden bg-background font-sans"
        style={pan ? { width: 1060, height: 680, transform: `translate(${-pan[0]}px, ${-pan[1]}px)` } : { height: "100vh" }}
      >
        <main className="h-full overflow-y-auto pt-16">
          <div className="flex items-center gap-6 pl-9 pr-8">
            <span className="font-baskerville text-[30px] text-[#1d1b1b]">Afternoon, Kuzey</span>
            {view === "both" ? (
              <button type="button" onClick={() => setTab("dashboard")} className="text-[13px] text-[#6b7280] underline">
                Back to the card
              </button>
            ) : null}
          </div>
          <AgentsTab />
        </main>
      </div>
    );
  }
  return <div className="min-h-screen bg-background p-8">{card}</div>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
