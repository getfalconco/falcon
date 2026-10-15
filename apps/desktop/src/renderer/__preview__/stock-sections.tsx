import { createRoot } from "react-dom/client";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { applyTheme } from "../lib/theme";
import { isLanguageCode } from "../lib/i18n/languages";
import "../globals.css";
import ChangesSection from "../components/stock-tab/sections/ChangesSection";
import EarningsSection from "../components/stock-tab/sections/EarningsSection";
import CompetitorsSection from "../components/stock-tab/sections/CompetitorsSection";
import type { ChangeItem, ChangeTag, StockChanges, StockEarnings, StockPeers } from "../../shared/stock-tab-data";
import fixture from "./stock-sections-fixture.json";

/**
 * Scratch harness for the Stock tab's Changes, Earnings and Competitors
 * sections. The fixture is one live read of NVDA (stock-tab-data service,
 * 2026-10-15) with a few made-up rows added so every kind of change shows.
 * ?theme=dark and ?lang=tr-TR as in the other harnesses, ?thesis=0 shows the
 * changes untagged.
 */

const params = new URLSearchParams(location.search);
{
  const lang = params.get("lang");
  if (isLanguageCode(lang)) setLanguage(lang);
  applyLanguage();
}
applyTheme(params.get("theme") === "dark" ? "dark" : "light");
const withThesis = params.get("thesis") !== "0";

const EXTRA: ChangeItem[] = [
  {
    kind: "insider",
    id: "ins:preview-1",
    date: "2026-10-09",
    source: { kind: "form4", url: "https://www.sec.gov/" },
    name: "Kress Colette",
    role: "EVP and CFO",
    code: "S",
    shares: 27_000,
    value: 4_860_000,
    plan: true,
    fact: "",
  },
  {
    kind: "price_estimate",
    id: "pe:preview",
    date: "2026-10-15",
    source: { kind: "yahoo", url: null },
    value: 328.72,
    previous: 311.4,
    previousDate: "2026-09-15",
    analysts: 59,
    currency: "USD",
    fact: "",
  },
  {
    kind: "link_added",
    id: "link:preview",
    date: "2026-10-12",
    source: { kind: "filing", url: "https://www.sec.gov/" },
    counterparty: "CRWV",
    counterpartyName: null,
    category: "customer",
    direction: "named",
    form: "10-K",
    filingDate: "2026-03-30",
    fact: "",
  },
];

const EXTRA_TAGS: ChangeTag[] = [
  { id: "ins:preview-1", tag: "neutral", reason: "A planned sale set up in advance." },
  { id: "pe:preview", tag: "supports", reason: null },
];

const NAMES: Record<string, string> = { AMD: "Advanced Micro Devices", INTC: "Intel", ANET: "Arista Networks" };

const base = fixture as unknown as { changes: StockChanges; tags: ChangeTag[]; earnings: StockEarnings; peers: StockPeers };
const changes: StockChanges = {
  ...base.changes,
  items: [...base.changes.items, ...EXTRA].sort((a, b) => b.date.localeCompare(a.date)),
};
const peers: StockPeers = { ...base.peers, peers: base.peers.peers.map((p) => ({ ...p, name: p.name ?? NAMES[p.ticker] ?? null })) };

window.meridian = {
  ...(window.meridian ?? {}),
  openExternal: async (url: string) => {
    console.info("[preview] open", url);
  },
  getStockThesis: async (ticker: string) => ({
    ok: true,
    thesis: withThesis ? { ticker, text: "Data center demand keeps estimates rising.", updated_at: new Date().toISOString() } : null,
  }),
  setStockThesis: async () => ({ ok: true, thesis: null }),
  getStockTabChanges: async () => ({ ok: true, changes }),
  getStockTabChangeTags: async () => ({ ok: true, itemsHash: changes.itemsHash, tags: [...base.tags, ...EXTRA_TAGS] }),
  getStockTabEarnings: async () => ({ ok: true, earnings: base.earnings }),
  getStockTabPeers: async () => ({ ok: true, peers }),
} as unknown as Window["meridian"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12 first:mt-0">
      <h2 className="mb-4 select-none text-[13px] font-medium tracking-[0.01em] text-content-secondary">{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function Harness() {
  const ticker = params.get("t") ?? "NVDA";
  return (
    <div className="min-h-screen bg-surface-0 px-8 py-6">
      <div className="mx-auto w-full max-w-[1120px]">
        <Section title="Last 7 days">
          <ChangesSection ticker={ticker} />
        </Section>
        <Section title="Earnings">
          <EarningsSection ticker={ticker} />
        </Section>
        <Section title="Competitors">
          <CompetitorsSection ticker={ticker} />
        </Section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
