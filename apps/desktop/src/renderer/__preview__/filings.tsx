import { createRoot } from "react-dom/client";
import "../globals.css";
import FilingChangesCard from "../components/filings/FilingChangesCard";
import FilingChangesSection from "../components/stock-tab/sections/FilingChangesSection";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { overviewRows, type FilingChangeItem, type FilingChanges, type FilingChangesResult, type FilingOverviewRequest, type FilingOverviewResult } from "../../shared/filing-changes";

/**
 * Scratch harness for the Filing changes card and the Stock tab section
 * against a stubbed main process. The items are fixtures for the harness
 * only, shaped like what main/filings reads from EDGAR; no network.
 *
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the chrome in that language
 *   ?state=error       every request fails
 *   ?state=restart     a bridge without the channels
 *   ?state=loading     the requests never answer
 *   ?state=empty       nothing notable in any name
 *   ?state=reading     the overview still has names to read
 *   ?names=0           no positions, no watchlist
 *   ?ticker=SMCI       the company the section shows (AMKR, SMCI)
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const state = params.get("state");
const noNames = params.get("names") === "0";
const ticker = (params.get("ticker") ?? "AMKR").toUpperCase();

const positions: Record<string, PaperPosition> = {};
if (!noNames) {
  for (const [symbol, shares] of [
    ["AMKR", 300],
    ["SMCI", 120],
    ["AMD", 90],
  ] as const) {
    positions[symbol] = { symbol, shares, costUsd: shares * 40 };
  }
}
seedPaperAccount({ cash: 18_400, positions });
localStorage.setItem("meridian-watchlist", JSON.stringify(noNames ? [] : [{ ticker: "NVDA", companyName: "NVIDIA" }]));

const SEC = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/doc.htm";

function item(extra: Partial<FilingChangeItem> & Pick<FilingChangeItem, "id" | "kind">): FilingChangeItem {
  return { form: "10-K", date: "2026-02-20", url: SEC, text: null, previous: null, name: null, pct: null, previousPct: null, detail: null, notable: true, repeat: false, ...extra };
}

const doc = (form: string, filedAt: string) => ({ form, accession: `${form}-${filedAt}`, filedAt, url: SEC, sectionUrl: `${SEC}#risk` });

const FIXTURES: Record<string, FilingChanges> = {
  AMKR: {
    ticker: "AMKR",
    checkedAt: "2026-10-15T14:00:00.000Z",
    latest: doc("10-K", "2026-02-20"),
    previous: doc("10-K", "2025-02-21"),
    quarter: doc("10-Q", "2026-07-28"),
    quarterRisk: "updated",
    riskCount: { latest: 29, previous: 28 },
    relationships: "compared",
    missing: [],
    items: [
      item({ id: "q1", kind: "quarter_risk_new", form: "10-Q", date: "2026-07-28", text: "We may be unable to raise the funds necessary to repurchase the 2031 Notes for cash following a fundamental change." }),
      item({ id: "q2", kind: "quarter_risk_new", form: "10-Q", date: "2026-07-28", text: "Transactions relating to our 2031 Notes may affect the value of our common stock." }),
      item({ id: "q3", kind: "quarter_risk_new", form: "10-Q", date: "2026-07-28", text: "We are subject to counterparty risk with respect to the Capped Calls." }),
      item({ id: "r1", kind: "risk_new", text: "If interest rates increase, our debt service obligations under our variable rate indebtedness would increase, which could have a material adverse effect on our results of operations." }),
      item({ id: "c1", kind: "customer_share", name: "Apple", pct: 29.8, previousPct: 30.8, detail: "revenue", notable: false, text: "Direct sales to Apple and Qualcomm accounted for 29.8% and 11.1% of our net sales, respectively, for the year ended December 31, 2025." }),
    ],
  },
  SMCI: {
    ticker: "SMCI",
    checkedAt: "2026-10-15T14:00:00.000Z",
    latest: doc("10-K", "2026-08-31"),
    previous: doc("10-K", "2025-08-28"),
    quarter: null,
    quarterRisk: null,
    riskCount: { latest: 35, previous: 39 },
    relationships: "graph_older",
    missing: [],
    items: [
      item({ id: "mw", kind: "material_weakness", date: "2026-08-31", repeat: true, notable: false, text: "Based upon this evaluation, our Chief Executive Officer and Chief Financial Officer concluded that our disclosure controls and procedures were not effective at the reasonable assurance level as of June 30, 2026." }),
      item({ id: "s1", kind: "risk_new", date: "2026-08-31", text: "We were delinquent in certain SEC reporting obligations in prior fiscal years, which may increase the risk of SEC enforcement actions." }),
      item({ id: "s2", kind: "risk_new", date: "2026-08-31", text: "Our operating results may be adversely impacted by additional tax liabilities, higher than expected tax rates, changes in tax laws, and other tax-related factors." }),
      item({ id: "s3", kind: "risk_removed", date: "2026-08-31", notable: false, text: "We face risks related to previously being delinquent in our SEC reporting obligations." }),
      item({ id: "s4", kind: "risk_reworded", date: "2026-08-31", notable: false, text: "We do not expect to pay any cash dividends in the foreseeable future, except for the 7.00% dividend on our Mandatory Convertible Preferred Stock.", previous: "We do not expect to pay any cash dividends in the foreseeable future." }),
      item({ id: "s5", kind: "customer_share_new", date: "2026-08-31", name: "One customer", pct: 28.1, detail: "revenue", text: "For the fiscal year ended June 30, 2026, sales to one customer represented 28.1% of total net sales." }),
    ],
  },
  AMD: {
    ticker: "AMD",
    checkedAt: "2026-10-15T14:00:00.000Z",
    latest: doc("10-K", "2026-02-04"),
    previous: doc("10-K", "2025-02-05"),
    quarter: doc("10-Q", "2026-08-05"),
    quarterRisk: "updated",
    riskCount: { latest: 43, previous: 45 },
    relationships: "compared",
    missing: [],
    items: [
      item({ id: "a1", kind: "risk_new", date: "2026-02-04", text: "We may be required to satisfy financial obligations under guarantees and other commercial commitments." }),
      item({ id: "a2", kind: "customer_named", date: "2026-02-04", name: "OpenAI OpCo, LLC", text: "In October 2025, we entered into a product purchase agreement with OpenAI OpCo, LLC, (OpenAI) to deploy 6 gigawatts of AMD GPUs." }),
      item({ id: "a3", kind: "auditor_change", form: "8-K", date: "2026-05-12", detail: "4.01" }),
    ],
  },
  NVDA: {
    ticker: "NVDA",
    checkedAt: "2026-10-15T14:00:00.000Z",
    latest: doc("10-K", "2026-02-25"),
    previous: doc("10-K", "2025-02-26"),
    quarter: doc("10-Q", "2026-08-26"),
    quarterRisk: "updated",
    riskCount: { latest: 25, previous: 24 },
    relationships: "compared",
    missing: [],
    items: [
      item({ id: "n1", kind: "quarter_risk_new", form: "10-Q", date: "2026-08-26", text: "Our indebtedness may adversely affect our financial condition and cash flows from operations." }),
      item({ id: "n2", kind: "supplier_named", date: "2026-02-25", name: "Groq, Inc.", text: "We have entered into an intellectual property license arrangement with Groq, Inc., or Groq." }),
    ],
  },
};

const never = new Promise<never>(() => undefined);
let overviewAsks = 0;

async function changes(t: string): Promise<FilingChangesResult> {
  if (state === "loading") return never;
  if (state === "error") return { ok: false, error: "unavailable" };
  const c = FIXTURES[t.toUpperCase()];
  return c ? { ok: true, changes: state === "empty" ? { ...c, items: [] } : c } : { ok: false, error: "unavailable" };
}

async function overview(request: FilingOverviewRequest): Promise<FilingOverviewResult> {
  if (state === "loading") return never;
  if (state === "error") return { ok: false, error: "unavailable" };
  overviewAsks++;
  const names = [...request.held, ...request.watchlist];
  const answers = names
    .filter((t) => FIXTURES[t])
    .map((t) => ({ changes: state === "empty" ? { ...FIXTURES[t]!, items: [] } : FIXTURES[t]!, held: request.held.includes(t), watchlist: request.watchlist.includes(t) }));
  const pending = state === "reading" && overviewAsks < 3 ? names.slice(1) : [];
  return { ok: true, rows: overviewRows(state === "reading" && overviewAsks < 3 ? answers.slice(0, 1) : answers, "2026-10-15"), pending, checked: names.length - pending.length };
}

(window as unknown as { meridian: unknown }).meridian =
  state === "restart" ? {} : { getFilingChanges: changes, getFilingOverview: overview, openExternal: async () => undefined };

createRoot(document.getElementById("root")!).render(
  <div
    className="h-screen overflow-y-auto pt-10"
    style={{ minWidth: 1060, background: document.documentElement.dataset.theme === "dark" ? "hsl(0 0% 3.5%)" : "#EAEAE6" }}
  >
    <div className="flex gap-4 px-8 pb-10">
      <div style={{ width: 340, height: 560 }}>
        <FilingChangesCard />
      </div>
      <div style={{ width: 460, height: 560 }}>
        <FilingChangesCard />
      </div>
    </div>
    <div className="mx-auto max-w-[1120px] px-8 pb-16">
      <section className="mt-2">
        <h2 className="mb-4 text-[13px] font-medium text-content-secondary">Filing changes</h2>
        <div>
          <FilingChangesSection ticker={ticker} />
        </div>
      </section>
    </div>
  </div>,
);
