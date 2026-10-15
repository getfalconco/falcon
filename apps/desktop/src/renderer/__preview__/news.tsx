import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { applyTheme } from "../lib/theme";
import { isLanguageCode } from "../lib/i18n/languages";
import "../globals.css";
import NewsCard from "../components/dashboard/NewsCard";
import type { NewsFeedArticle } from "../../shared/news-feed";

// ?lang=tr-TR shows the card in that language (kept, as a pick would be).
{
  const lang = new URLSearchParams(location.search).get("lang");
  if (isLanguageCode(lang)) setLanguage(lang);
  applyLanguage();
}

// ?theme=dark draws the card in the dark theme (default light).
applyTheme(new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light");

/**
 * Scratch harness: the News card over a made-up feed, so the scopes, the
 * search and the row layout can be looked at without the engine.
 */

const now = Math.floor(Date.now() / 1000);
const story = (
  id: number,
  minutesAgo: number,
  headline: string,
  source: string,
  tickers: string[],
  sectors: string[],
  event: NewsFeedArticle["event"] = null,
): NewsFeedArticle => ({
  id,
  headline,
  summary: "",
  url: `https://example.com/${id}`,
  source,
  datetime: now - minutesAgo * 60,
  tickers,
  event,
  first_seen: new Date().toISOString(),
  sectors,
});

/** The engine's decision, as the card receives it (news/curation.ts on the engine). */
const shown = (
  headline: string,
  tickers: string[],
  event_type: NonNullable<NewsFeedArticle["falcon"]>["event_type"],
  direction: NonNullable<NewsFeedArticle["falcon"]>["direction"],
  primary: NonNullable<NewsFeedArticle["falcon"]>["primary"] = null,
): NewsFeedArticle["falcon"] => ({
  decision: "show",
  reason: primary ? "primary_source" : "material",
  headline,
  headline_source: primary ? "primary" : "falcon",
  article_key: "",
  event_type,
  materiality: event_type ? "standard" : null,
  direction,
  tickers,
  primary,
  duplicate_of: null,
});

/** Falcon's title per story; story 5 has no verdict yet and stays off the card. */
const FALCON: Record<number, NewsFeedArticle["falcon"]> = {
  1: shown("Nvidia guides third-quarter revenue to $32.5 billion, above consensus", ["NVDA"], "guidance", "positive"),
  2: shown("Microsoft cuts 3% of its workforce", ["MSFT"], "management_governance", "negative"),
  3: shown("US export licence review widens to older accelerators", ["NVDA", "AMD", "INTC"], "regulatory_decision", "negative"),
  4: shown("Oracle signs a multi-year cloud agreement with a European bank", ["ORCL"], "contract_partnership", "positive"),
  6: shown("Snowflake Inc issues a press release via Business Wire", ["SNOW"], null, null, "press_release"),
};

const FEED_RAW: NewsFeedArticle[] = [
  story(1, 4, "Nvidia guides above consensus on data-center demand; shares rise after hours", "Reuters", ["NVDA", "AMD", "TSM"], ["Semiconductors"], {
    material: true, event_type: "guidance", affected_ticker: "NVDA", direction: "positive", summary: "", confidence: 0.92,
  }),
  story(2, 27, "Microsoft to cut 3% of workforce as it reallocates spend toward AI infrastructure", "Bloomberg", ["MSFT"], ["Technology"], {
    material: true, event_type: "management_change", affected_ticker: "MSFT", direction: "negative", summary: "", confidence: 0.7,
  }),
  story(3, 95, "Chipmakers slide as export-licence review widens to older accelerators", "Financial Times", ["NVDA", "AMD", "INTC", "AVGO", "QCOM"], ["Semiconductors"]),
  story(4, 240, "Oracle signs multi-year cloud agreement with a European bank", "CNBC", ["ORCL"], ["Technology"], {
    material: true, event_type: "partnership", affected_ticker: "ORCL", direction: "positive", summary: "", confidence: 0.81,
  }),
  story(5, 60 * 26, "Dell raises full-year outlook on AI server backlog", "MarketWatch", ["DELL", "HPQ"], ["Technology Hardware"]),
  story(6, 60 * 50, "Snowflake names new CFO", "Business Wire", ["SNOW"], ["Software"]),
];
const FEED: NewsFeedArticle[] = FEED_RAW.map((a) => (FALCON[a.id] ? { ...a, falcon: FALCON[a.id] } : a));

/**
 * The stubbed bridge counts its calls on `window.__newsCalls`, so a check can
 * hide and show the cards (the "remount" button) and confirm that coming back
 * inside the freshness window asks for nothing.
 */
const calls = { feed: 0, cached: 0 };
(window as unknown as { __newsCalls: typeof calls }).__newsCalls = calls;
const STATUS = {
  running: false, lastPollAt: new Date().toISOString(), lastError: null, lastNewEvents: 2,
  articlesChecked: 40, lastSummary: "2 events (40 articles checked)", currentTicker: null,
  tickersCompleted: 15, totalTickers: 15,
};
/**
 * The article panel's bridge, one scenario per story:
 *   1 NVDA   full article, the feed's material event (server reading)
 *   2 MSFT   full article, a classifier verdict (server reading)
 *   3 chips  full article, no server reading: Falcon's read, translated
 *   4 ORCL   paywall with the provider's summary; Falcon's read of the summary
 *   5 DELL   publisher refused, no summary: too thin to read
 *   6 SNOW   page out of reach; the read fails once, then works on retry
 */
const P = [
  "Nvidia said revenue in its data-center segment rose to $30.8 billion in the quarter, up 112% from a year earlier, as cloud providers kept ordering its accelerators.",
  "The company guided third-quarter revenue to $32.5 billion, plus or minus 2%, above the $31.7 billion analysts had pencilled in, according to LSEG data.",
  "Chief Financial Officer Colette Kress told analysts that supply of the newest systems remained tight and that lead times had lengthened for some customers.",
  "Shares of Taiwan Semiconductor Manufacturing, which makes the chips, rose 1.4% in Taipei trading on Thursday morning after the results were published.",
];
const ARTICLE_TEXT = [...P, ...P.map((p) => p.replace("the quarter", "the period"))];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const body = (status: string, paragraphs: string[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  body: { status, paragraphs, truncated: false, origin: paragraphs.length ? "publisher" : "none", finalUrl: "https://www.example.com/story", fetchedAt: Date.now(), ...extra },
});
const ORCL_SUMMARY =
  "Oracle signed a multi-year agreement to host the core banking systems of a European lender on Oracle Cloud Infrastructure, the companies said on Tuesday, without giving financial terms. The bank will move its payments platform first.";
const READS: Record<string, { summary: string[]; companies: Array<[string, string]> }> = {
  "en-US": {
    summary: [
      "Export-licence reviews in the United States now cover older accelerators as well as the newest ones, the article reports.",
      "Chipmakers with large China sales fell on the news, with the article naming Nvidia, AMD and Intel.",
    ],
    companies: [
      ["NVDA", "China is one of Nvidia's larger markets for data-center accelerators, so a wider review reaches more of its product line."],
      ["AMD", "AMD sells older accelerators that the article says now fall under the review."],
      ["AVGO", "Broadcom's filing names TSMC as a critical supplier; the article does not say its own products are covered."],
    ],
  },
  "tr-TR": {
    summary: [
      "Habere göre ABD'deki ihracat lisansı incelemeleri artık en yeni hızlandırıcıların yanı sıra eski modelleri de kapsıyor.",
      "Çin satışları yüksek çip üreticileri haberle düştü; makale Nvidia, AMD ve Intel'i adıyla anıyor.",
    ],
    companies: [
      ["NVDA", "Çin, Nvidia'nın veri merkezi hızlandırıcıları için büyük pazarlarından biri; daha geniş bir inceleme ürün yelpazesinin daha fazlasına uzanıyor."],
      ["AMD", "AMD, makaleye göre artık incelemeye giren eski hızlandırıcıları satıyor."],
      ["AVGO", "Broadcom'un başvurusu TSMC'yi kritik tedarikçi olarak gösteriyor; makale kendi ürünlerinin kapsandığını söylemiyor."],
    ],
  },
  "de-DE": {
    summary: [
      "Laut dem Artikel erfassen die US-Prüfungen von Exportlizenzen nun auch ältere Beschleuniger, nicht nur die neuesten.",
      "Chiphersteller mit hohem China-Umsatz gaben nach; der Artikel nennt Nvidia, AMD und Intel.",
    ],
    companies: [
      ["NVDA", "China ist einer der größeren Märkte für Nvidias Rechenzentrumsbeschleuniger, die breitere Prüfung erreicht also mehr seiner Produktlinie."],
      ["AMD", "AMD verkauft ältere Beschleuniger, die laut dem Artikel nun unter die Prüfung fallen."],
    ],
  },
  "ja-JP": {
    summary: [
      "記事によると、米国の輸出許可審査は最新製品に加えて旧世代のアクセラレーターも対象になりました。",
      "中国向け売上の大きい半導体メーカーが下落し、記事は Nvidia、AMD、Intel を挙げています。",
    ],
    companies: [
      ["NVDA", "中国は Nvidia のデータセンター向けアクセラレーターの大きな市場の一つで、審査の拡大は製品ラインのより多くに及びます。"],
      ["AMD", "AMD は、記事によれば新たに審査対象となった旧世代のアクセラレーターを販売しています。"],
    ],
  },
};
let snowAttempts = 0;
const meridianArticle = {
  openExternal: async (url: string) => console.info("[preview] openExternal", url),
  getNewsArticle: async (req: { id: number }) => {
    await sleep(500);
    switch (req.id) {
      case 4: return body("paywall", [ORCL_SUMMARY], { origin: "provider" });
      case 5: return body("blocked", []);
      case 6: return body("error", []);
      default: return body("full", ARTICLE_TEXT);
    }
  },
  getNewsArticleReading: async (req: { id: number }) => {
    await sleep(250);
    if (req.id !== 2) return { ok: true, verdict: null };
    return {
      ok: true,
      verdict: {
        schema_version: 1, prompt_version: "p", model: "m", article_key: "id:2", kind: "news",
        event_type: "management_governance", event_label: "Workforce cut of 3% to fund AI infrastructure",
        syndication_scope: 1, unassessed_tickers: [], status: "ok", metadata_missing: false,
        classified_at: new Date().toISOString(), failure_reason: null,
        tickers: [
          { ticker: "MSFT", relevance: "direct", materiality: "standard", direction: "mixed" },
          { ticker: "NVDA", relevance: "indirect", materiality: "low", direction: "positive" },
          { ticker: "ORCL", relevance: "none" },
        ],
      },
    };
  },
  analyzeNewsArticle: async (req: { id: number; language?: string }) => {
    await sleep(1400);
    if (req.id === 5) return { ok: false, error: "thin", reason: "thin" };
    if (req.id === 6 && snowAttempts++ === 0) return { ok: false, error: "model", reason: "failed" };
    const lang = req.language ?? "en-US";
    const en = READS["en-US"]!;
    const local = READS[lang];
    const line = (i: number, list: "summary") => ({ en: en[list][i]!, text: local?.[list][i] ?? en[list][i]!, untranslated: !local && !lang.startsWith("en") });
    return {
      ok: true,
      cached: false,
      analysis: {
        summary: en.summary.map((_, i) => line(i, "summary")),
        companies: en.companies.map(([ticker, text], i) => {
          const tr = local?.companies[i]?.[1];
          return { ticker, en: text, text: tr ?? text, untranslated: !tr && !lang.startsWith("en") };
        }),
        language: lang,
        basis: req.id === 4 ? "summary" : "article",
        graphEdges: req.id === 3 ? 2 : 0,
        model: "claude-haiku-5-5",
        generatedAt: new Date().toISOString(),
      },
    };
  },
};
FEED[3] = { ...FEED[3]!, event: null, summary: ORCL_SUMMARY };

(window as unknown as { meridian: unknown }).meridian = {
  ...meridianArticle,
  getNewsFeed: async () => {
    calls.feed += 1;
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, articles: FEED, status: STATUS };
  },
  getCachedNewsFeed: async () => {
    calls.cached += 1;
    return { ok: false, error: "no cached feed" };
  },
};

// A book with two of the feed's names, so Positions has something to show.
localStorage.setItem(
  "falcon.paperPositions",
  JSON.stringify({
    NVDA: { symbol: "NVDA", shares: 10, costUsd: 1500 },
    ORCL: { symbol: "ORCL", shares: 5, costUsd: 700 },
  }),
);
localStorage.setItem("falcon.paperBalance", "3000");

function Harness() {
  const [shown, setShown] = useState(true);
  return (
    <div className="min-h-screen bg-[#EAEAE6] p-10">
      <button
        type="button"
        data-testid="remount"
        onClick={() => setShown((v) => !v)}
        className="mb-4 rounded-full bg-white px-3 py-1 text-[12px] text-[#1d1b1b]"
      >
        {shown ? "unmount" : "mount"}
      </button>
      {shown ? (
        <div className="flex items-start justify-center gap-6">
          <div className="h-[560px] w-[380px] shrink-0">
            <NewsCard onDuplicate={() => {}} onRemove={() => {}} />
          </div>
          <div className="h-[560px] w-[640px] shrink-0">
            <NewsCard onDuplicate={() => {}} onRemove={() => {}} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
