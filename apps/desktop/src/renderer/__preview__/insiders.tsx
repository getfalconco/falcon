import { createRoot } from "react-dom/client";
import "./fonts";
import "../globals.css";
import InsidersCard from "../components/insiders/InsidersCard";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { STOCK_OPEN_EVENT } from "../lib/stock-open";
import type { InsiderActivityRequest, InsiderActivityResult, InsiderEvent, InsiderTrade } from "../../shared/insider-types";
import { addDaysYmd, nyToday } from "../../shared/earnings-view";

/**
 * Scratch harness for the Insider activity card against a stubbed main
 * process. The events are fixtures for the harness only: no EDGAR request.
 *
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the chrome in that language
 *   ?state=error       every request fails
 *   ?state=restart     a bridge without the channel
 *   ?state=loading     the request never answers
 *   ?state=reading     nothing read yet, filings pending
 *   ?state=empty       nothing found
 *   ?names=0           no positions, no watchlist
 *
 * Probes: `window.__insiders.asks` lists the requests, `.opened` the Stock tab opens.
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
    ["KO", 80],
  ] as const) {
    positions[symbol] = { symbol, shares, costUsd: shares * 150 };
  }
}
seedPaperAccount({ cash: 18_400, positions });
localStorage.setItem("meridian-watchlist", JSON.stringify(noNames ? [] : [{ ticker: "MSFT", companyName: "Microsoft" }]));

const today = nyToday();
const d = (n: number) => addDaysYmd(today, n);
const sec = (cik: string, acc: string) => `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/doc.xml`;

function trade(over: Partial<InsiderTrade> & Pick<InsiderTrade, "name" | "role" | "lastDate" | "shares" | "value">): InsiderTrade {
  return {
    title: null,
    code: "P",
    firstDate: over.lastDate,
    filedAt: over.lastDate,
    accession: `0001-26-${over.name.length}${over.shares}`,
    url: sec("1045810", `0001-26-${over.shares}`),
    sharesBefore: 40_000,
    sharesAfter: 40_000 + over.shares,
    increase: over.shares / 40_000,
    firstPosition: false,
    plan: false,
    ...over,
  };
}

const EVENTS: InsiderEvent[] = [
  {
    id: "AMD:purchase_cluster",
    ticker: "AMD",
    kind: "purchase_cluster",
    date: d(-3),
    firstDate: d(-12),
    insiders: 3,
    value: 4_230_000,
    roles: ["ceo", "director"],
    trades: [
      trade({ name: "SU LISA T", role: "ceo", title: "Chair and CEO", lastDate: d(-12), shares: 20_000, value: 3_100_000 }),
      trade({ name: "DOE JANE", role: "director", lastDate: d(-6), shares: 5_000, value: 760_000 }),
      trade({ name: "ROE RICHARD", role: "director", lastDate: d(-3), shares: 2_400, value: 370_000 }),
    ],
    filing: null,
    scope: "held",
    via: null,
    score: 82,
  },
  {
    id: "TSM:activist_13d",
    ticker: "TSM",
    kind: "activist_13d",
    date: d(-2),
    firstDate: d(-2),
    insiders: 0,
    value: null,
    roles: [],
    trades: [],
    filing: { form: "SC 13D", filer: "Example Partners LP", filedAt: d(-2), accession: "0002-26-1", url: sec("1046179", "0002-26-1"), percent: 7.2 },
    scope: "linked",
    via: { holding: "NVDA", relation: "supplier", tier: "critical", namedBy: "NVDA", sourceUrl: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000019/nvda-20260125.htm" },
    score: 48,
  },
  {
    id: "NVDA:unplanned_sale",
    ticker: "NVDA",
    kind: "unplanned_sale",
    date: d(-5),
    firstDate: d(-5),
    insiders: 1,
    value: 3_100_000,
    roles: ["cfo"],
    trades: [trade({ name: "KRESS COLETTE", role: "cfo", title: "EVP and CFO", code: "S", lastDate: d(-5), shares: 17_000, value: 3_100_000, increase: null })],
    filing: null,
    scope: "held",
    via: null,
    score: 44,
  },
  {
    id: "MSFT:large_purchase",
    ticker: "MSFT",
    kind: "large_purchase",
    date: d(-9),
    firstDate: d(-9),
    insiders: 1,
    value: 610_000,
    roles: ["director"],
    trades: [trade({ name: "LEE SANDRA", role: "director", lastDate: d(-9), shares: 1_400, value: 610_000, sharesBefore: 2_000, increase: 0.7 })],
    filing: null,
    scope: "watchlist",
    via: null,
    score: 41,
  },
  {
    id: "SMCI:sale_cluster",
    ticker: "SMCI",
    kind: "sale_cluster",
    date: d(-20),
    firstDate: d(-34),
    insiders: 4,
    value: 9_800_000,
    roles: ["officer", "director"],
    trades: [
      trade({ name: "A OFFICER", role: "officer", code: "S", lastDate: d(-34), shares: 30_000, value: 4_000_000 }),
      trade({ name: "B DIRECTOR", role: "director", code: "S", lastDate: d(-28), shares: 20_000, value: 2_800_000 }),
      trade({ name: "C DIRECTOR", role: "director", code: "S", lastDate: d(-22), shares: 12_000, value: 1_800_000 }),
      trade({ name: "D OFFICER", role: "officer", code: "S", lastDate: d(-20), shares: 9_000, value: 1_200_000 }),
    ],
    filing: null,
    scope: "linked",
    via: { holding: "NVDA", relation: "customer", tier: "important", namedBy: "SMCI", sourceUrl: null },
    score: 33,
  },
  {
    id: "KO:new_holder_13g",
    ticker: "KO",
    kind: "new_holder_13g",
    date: d(-40),
    firstDate: d(-40),
    insiders: 0,
    value: null,
    roles: [],
    trades: [],
    filing: { form: "SC 13G", filer: "Example Fund Advisors", filedAt: d(-40), accession: "0003-26-1", url: sec("21344", "0003-26-1"), percent: null },
    scope: "held",
    via: null,
    score: 16,
  },
];

const asks: InsiderActivityRequest[] = [];
const opened: string[] = [];
window.addEventListener(STOCK_OPEN_EVENT, (e) => opened.push((e as CustomEvent<{ ticker: string }>).detail.ticker));
(window as unknown as { __insiders: unknown }).__insiders = { asks, opened };

async function activity(request?: InsiderActivityRequest): Promise<InsiderActivityResult> {
  if (request !== undefined) asks.push(request);
  if (state === "loading") return new Promise(() => {});
  if (state === "error") return { ok: false, error: "unavailable" };
  await new Promise((r) => setTimeout(r, 300));
  const reading = state === "reading";
  return {
    ok: true,
    today,
    events: state === "empty" || reading ? [] : EVENTS,
    companies: 9,
    pending: reading ? 9 : state === "partial" ? 3 : 0,
    checkedAt: new Date().toISOString(),
  };
}

(window as unknown as { meridian: unknown }).meridian =
  state === "restart" ? {} : { getInsiderActivity: activity, openExternal: async (url: string) => console.log("openExternal", url) };

createRoot(document.getElementById("root")!).render(
  <div
    className="h-screen overflow-y-auto pt-10"
    style={{ minWidth: 1060, background: document.documentElement.dataset.theme === "dark" ? "hsl(0 0% 3.5%)" : "#EAEAE6" }}
  >
    <div className="flex gap-4 px-8 pb-12">
      <div style={{ width: 340, height: 560 }}>
        <InsidersCard />
      </div>
      <div style={{ width: 460, height: 560 }}>
        <InsidersCard />
      </div>
    </div>
  </div>,
);
