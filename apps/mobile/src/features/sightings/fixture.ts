import type { DocumentedBy, LinkEvidence, RippleCard, RippleHit, SightingsFeed, Source } from "@falcon/ripple";

/**
 * DEVELOPMENT ONLY. A Sightings feed in the @falcon/ripple shape, for
 * designing the screens while the engine API is not up. The cards are
 * modeled on a real engine run (packages/engine/out/sightings.json): the
 * same event types, details, tiers and research, with times moved to "just
 * now" so the screens read as today. lib/sightings.ts loads it only when
 * __DEV__ is true, so release builds never show it.
 */

const HOUR = 60 * 60 * 1000;

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

/** YYYY-MM-DD, `hours` ago. */
function day(hours: number): string {
  return ago(hours).slice(0, 10);
}

function edgar(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}

function source(title: string, url: string, hours: number): Source {
  return { title, url, publisher: "SEC EDGAR", publishedAt: ago(hours) };
}

function quote(text: string, form: string, filedAt: string, url: string): LinkEvidence {
  return { quote: text, form, filedAt, url };
}

function hit(h: Omit<RippleHit, "history" | "degree"> & Partial<Pick<RippleHit, "degree" | "history">>): RippleHit {
  return { degree: 1, history: null, ...h };
}

/** The research behind insider purchase cards, with Falcon's own estimate since 2015. */
const INSIDER_RESEARCH: DocumentedBy = {
  citation: "Cohen, Malloy & Pomorski (2012), Journal of Finance 67(3)",
  url: "https://doi.org/10.1111/j.1540-6261.2012.01740.x",
  effect:
    "In US insider trades from 1986 to 2007, a long-short portfolio of opportunistic (non-routine) insider buys minus opportunistic sells earned value-weighted abnormal returns of about 82 basis points a month, while routine insiders' trades earned about zero.",
  period: "1986-2007",
  match: "exact",
  ownEstimate: { n: 2844, meanAbnPct: 0.96, windowDays: 20, period: "2015-01 to 2026-06" },
};

/** An own-firm insider purchase hit (Documented tier). */
function insiderHit(ticker: string, companyName: string, evidence: LinkEvidence[]): RippleHit {
  return hit({
    ticker,
    companyName,
    relation: "self",
    direction: "up",
    confidence: "medium",
    window: "1 to 4 weeks",
    mechanism: `${companyName}'s officers or directors bought its shares on the open market and reported the purchases to the SEC on Form 4.`,
    evidence,
    pricedIn: false,
    tier: "documented",
    family: "F7",
    channel: "own_firm",
    linkClarity: "direct",
    opportunityEligible: true,
    documentedBy: INSIDER_RESEARCH,
    invalidatedBy: "Later Form 4 filings showing the same insiders selling these shares would undo this reading.",
  });
}

export function sampleFeed(): SightingsFeed {
  const kgsUrl = edgar("1767042", "0001193125-26-460666");
  const funUrl = edgar("1999001", "0001999001-26-000113");
  const ctevUrl = edgar("1793229", "0001628280-26-073944");
  const kalaUrl = edgar("1479419", "0001829126-26-012407");
  const apmdUrl = edgar("1745648", "0001193125-26-460864");
  const tsmUrl = "https://www.sec.gov/Archives/edgar/data/1046179/000104617926000796/tsm-revenue20261110.htm";
  const ontoUrl = "https://www.sec.gov/Archives/edgar/data/704532/000119312526453582/onto-ex99_1.htm";
  const onto10k = "https://www.sec.gov/Archives/edgar/data/704532/000119312526066937/onto-20260103.htm";

  const cards: RippleCard[] = [
    {
      id: "sample-kgs-insiders",
      sector: "all",
      generatedAt: ago(1),
      tier: "documented",
      confidence: "medium",
      pricedIn: false,
      event: {
        id: "evt-kgs-insiders",
        ticker: "KGS",
        companyName: "Kodiak Gas Services, Inc.",
        kind: "filing",
        eventType: "insider_cluster",
        eventLabel: "Insider purchase cluster",
        acceptedAt: ago(3),
        headline: "3 insiders bought $544,115 of Kodiak Gas Services, Inc. stock",
        occurredAt: ago(3),
        summary:
          "Form 4 filings show open-market purchases by Alexander Newsom Darden (Director) 10,000 shares for $449,900; Gretchen Lynn Holloway (Director) 1,145 shares for $49,955; Margaret C Montana (Director) 1,000 shares for $44,260.",
        source: source("Form 4: Gretchen Lynn Holloway, Kodiak Gas Services, Inc.", kgsUrl, 3),
        details: {
          rule: "3+ insiders within 5 business days",
          insiders: 3,
          insiderNames:
            "Alexander Newsom Darden (Director); Gretchen Lynn Holloway (Director); Margaret C Montana (Director)",
          totalUsd: 544115,
          totalShares: 12145,
          firstTradeDate: day(50),
          lastTradeDate: day(26),
          filings: 3,
          marketValueUsd: 4530558976,
          marketValueSource: "Yahoo market cap",
        },
      },
      hits: [
        insiderHit("KGS", "Kodiak Gas Services, Inc.", [
          quote("Montana Margaret C (Director): Common Stock, code P, 1000 shares at 44.26", "4", day(3), kgsUrl),
          quote("Darden Alexander Newsom (Director): Common Stock, code P, 10000 shares at 44.99", "4", day(26), kgsUrl),
          quote("Holloway Gretchen Lynn (Director): Common Stock, code P, 1145 shares at 43.629", "4", day(3), kgsUrl),
        ]),
      ],
    },
    {
      id: "sample-ctev-ceo",
      sector: "all",
      generatedAt: ago(1),
      tier: "documented",
      confidence: "medium",
      pricedIn: false,
      event: {
        id: "evt-ctev-ceo",
        ticker: "CTEV",
        companyName: "Claritev Corp",
        kind: "filing",
        eventType: "insider_cluster",
        eventLabel: "Insider purchase cluster",
        acceptedAt: ago(5),
        headline: "Travis Dalton (Pres., CEO & Executive Chair, Director) bought $149,927 of Claritev Corp stock",
        occurredAt: ago(5),
        summary:
          "A Form 4 filing shows an open-market purchase by Travis Dalton (Pres., CEO & Executive Chair, Director) 5,110 shares for $149,927.",
        source: source("Form 4: Travis Dalton, Claritev Corp", ctevUrl, 5),
        details: {
          rule: "officer or director purchase of $100k+ at a company under $2B",
          insiders: 1,
          insiderNames: "Travis Dalton (Pres., CEO & Executive Chair, Director)",
          totalUsd: 149927,
          totalShares: 5110,
          firstTradeDate: day(50),
          lastTradeDate: day(50),
          filings: 1,
          marketValueUsd: 457945696,
          marketValueSource: "Yahoo market cap",
        },
      },
      hits: [
        insiderHit("CTEV", "Claritev Corp", [
          quote(
            "Dalton Travis (Pres., CEO & Executive Chair, Director): Class A common stock, code P, 5110 shares at 29.34",
            "4",
            day(5),
            ctevUrl,
          ),
        ]),
      ],
    },
    {
      id: "sample-fun-insiders",
      sector: "all",
      generatedAt: ago(1),
      tier: "documented",
      confidence: "medium",
      pricedIn: false,
      event: {
        id: "evt-fun-insiders",
        ticker: "FUN",
        companyName: "Six Flags Entertainment Corporation",
        kind: "filing",
        eventType: "insider_cluster",
        eventLabel: "Insider purchase cluster",
        acceptedAt: ago(26),
        headline: "3 insiders bought $15.1M of Six Flags Entertainment Corporation stock",
        occurredAt: ago(26),
        summary:
          "Form 4 filings show open-market purchases by Rehan Jaffer (Director) 1,450,000 shares for $14.9M; Richard M Haddrill (Executive Chair, Director) 9,000 shares for $90,720; Christopher Lawrence Bennett (Chief Legal Officer) 5,000 shares for $46,600.",
        source: source("Form 4: Rehan Jaffer, Six Flags Entertainment Corporation", funUrl, 26),
        details: {
          rule: "3+ insiders within 5 business days",
          insiders: 3,
          insiderNames:
            "Rehan Jaffer (Director); Richard M Haddrill (Executive Chair, Director); Christopher Lawrence Bennett (Chief Legal Officer)",
          totalUsd: 15066320,
          totalShares: 1464000,
          firstTradeDate: day(120),
          lastTradeDate: day(30),
          filings: 3,
          marketValueUsd: 1181678464,
          marketValueSource: "Yahoo market cap",
        },
      },
      hits: [
        insiderHit("FUN", "Six Flags Entertainment Corporation", [
          quote(
            "JAFFER REHAN (Director): Common Stock, par value $0.01 per share, code P, 700000 shares at 10",
            "4",
            day(26),
            funUrl,
          ),
          quote(
            "HADDRILL RICHARD M (Executive Chair, Director): Common Stock, par value $0.01 per share, code P, 9000 shares at 10.08",
            "4",
            day(26),
            funUrl,
          ),
        ]),
      ],
    },
    {
      id: "sample-tsm-revenue",
      sector: "semis",
      generatedAt: ago(1),
      tier: "watch",
      confidence: "low",
      pricedIn: false,
      event: {
        id: "evt-tsm-revenue",
        ticker: "TSM",
        companyName: "TSMC",
        kind: "filing",
        eventType: "monthly_revenue",
        eventLabel: "Monthly revenue",
        acceptedAt: ago(8),
        headline: "TSMC October revenue up 59.7% from a year earlier",
        occurredAt: ago(8),
        summary:
          "TSMC filed its monthly revenue report for October 2026. Revenue was approximately NT$586.89 billion, an increase of 14.7 percent from September 2026 and an increase of 59.7 percent from October 2025.",
        source: source("6-K: TSMC October 2026 revenue report", tsmUrl, 8),
      },
      hits: [
        hit({
          ticker: "CRDO",
          companyName: "Credo",
          relation: "customer",
          direction: "up",
          confidence: "low",
          window: "1 to 4 weeks",
          mechanism:
            "Credo exclusively used TSMC for wafer production in fiscal 2026. TSMC's 59.7% year-over-year October revenue growth signals strong demand for the foundry that makes all of Credo's wafers.",
          evidence: [
            quote(
              "In fiscal year 2026, we exclusively used Taiwan Semiconductor Manufacturing Company Limited (TSMC) for semiconductor wafer production.",
              "10-K",
              "2026-06-15",
              "https://www.sec.gov/Archives/edgar/data/1807794/000162828026043303/crdo-20260502.htm",
            ),
          ],
          history: { sample: 48, avgMovePct: 5.2, hitRate: 0.5417, windowDays: 20, benchmark: "SPY", from: "2022-02-10", to: "2026-10-08" },
          sinceEvent: { movePct: -1.26, fromDate: day(32), reactionDate: day(8), asOf: day(1), benchmark: "SPY", pricedInAtPct: 2.6 },
          pricedIn: false,
          tier: "watch",
          family: "F11",
          channel: "supply_chain",
          linkClarity: "direct",
          opportunityEligible: false,
        }),
        hit({
          ticker: "KLAC",
          companyName: "KLA",
          relation: "supplier",
          direction: "up",
          confidence: "low",
          window: "1 to 3 months",
          mechanism:
            "TSMC accounted for more than 10% of KLA's revenues in fiscal 2026, mainly in process control. TSMC's revenue growth points to strong activity at a major customer, though the filing does not tie it to equipment orders.",
          evidence: [
            quote(
              "For the fiscal years ended June 30, 2026, 2025 and 2024, the following customers each accounted for more than 10% of total revenues, primarily in the Semiconductor Process Control segment: ... Taiwan Semiconductor Manufacturing Company Limited",
              "10-K",
              "2026-08-06",
              "https://www.sec.gov/Archives/edgar/data/319201/000031920126000027/klac-20260630.htm",
            ),
          ],
          history: { sample: 50, avgMovePct: 0.83, hitRate: 0.54, windowDays: 20, benchmark: "SPY", from: "2021-11-10", to: "2026-10-08" },
          sinceEvent: { movePct: 0.4, fromDate: day(32), reactionDate: day(8), asOf: day(1), benchmark: "SPY", pricedInAtPct: 0.42 },
          pricedIn: false,
          tier: "watch",
          family: "F11",
          channel: "supply_chain",
          linkClarity: "direct",
          opportunityEligible: false,
        }),
        hit({
          ticker: "ALAB",
          companyName: "Astera Labs",
          relation: "customer",
          direction: "up",
          confidence: "low",
          window: "1 to 4 weeks",
          mechanism:
            "TSMC is Astera Labs' sole manufacturing partner for its integrated circuits. TSMC's October revenue, up 59.7% from a year earlier, points to strong wafer activity at the foundry that makes all of Astera's chips.",
          evidence: [
            quote(
              "TSMC is our sole manufacturing partner for our integrated circuits and we currently have not qualified another source.",
              "10-K",
              "2026-02-20",
              "https://www.sec.gov/Archives/edgar/data/1736297/000173629726000010/alab-20251231.htm",
            ),
          ],
          history: { sample: 31, avgMovePct: 6.19, hitRate: 0.5161, windowDays: 20, benchmark: "SPY", from: "2024-04-10", to: "2026-10-08" },
          sinceEvent: { movePct: 2.06, fromDate: day(32), reactionDate: day(8), asOf: day(1), benchmark: "SPY", pricedInAtPct: 3.1 },
          pricedIn: false,
          tier: "watch",
          family: "F11",
          channel: "supply_chain",
          linkClarity: "direct",
          opportunityEligible: false,
        }),
        hit({
          ticker: "NVDA",
          companyName: "NVIDIA",
          relation: "customer",
          direction: "up",
          confidence: "low",
          window: "1 to 4 weeks",
          mechanism:
            "NVIDIA uses TSMC, along with Samsung, to produce its semiconductor wafers. TSMC's October revenue, up 59.7% from a year earlier, suggests strong demand for the foundry capacity NVIDIA relies on.",
          evidence: [
            quote(
              "We utilize foundries, such as Taiwan Semiconductor Manufacturing Company Limited, or TSMC, and Samsung Electronics Co., Ltd., or Samsung, to produce our semiconductor wafers.",
              "10-K",
              "2026-02-25",
              "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm",
            ),
          ],
          history: { sample: 50, avgMovePct: 1.73, hitRate: 0.56, windowDays: 20, benchmark: "SPY", from: "2021-11-10", to: "2026-10-08" },
          sinceEvent: { movePct: -9.08, fromDate: day(32), reactionDate: day(8), asOf: day(1), benchmark: "SPY", pricedInAtPct: 0.87 },
          pricedIn: false,
          tier: "watch",
          family: "F11",
          channel: "supply_chain",
          linkClarity: "direct",
          opportunityEligible: false,
        }),
      ],
    },
    {
      id: "sample-kala-late",
      sector: "all",
      generatedAt: ago(1),
      tier: "watch",
      confidence: "low",
      pricedIn: false,
      event: {
        id: "evt-kala-late",
        ticker: "KALA",
        companyName: "KALA BIO, Inc.",
        kind: "filing",
        eventType: "distress_nt",
        eventLabel: "Late filing notice",
        acceptedAt: ago(2),
        headline: "KALA BIO, Inc. filed a late-filing notice for its 10-Q",
        occurredAt: ago(2),
        summary: "KALA BIO, Inc. told the SEC it will not file its 10-Q on time (Form 12b-25).",
        source: source("NT 10-Q: KALA BIO, Inc.", kalaUrl, 2),
        details: {
          lateReport: "10-Q",
          reason:
            "the Company requires additional time to complete its analysis and disclosure regarding its liquidity and capital resources.",
          significantChangeExpected: false,
          changeNarrative: null,
        },
      },
      hits: [
        hit({
          ticker: "KALA",
          companyName: "KALA BIO, Inc.",
          relation: "self",
          direction: "down",
          confidence: "low",
          window: "1 to 5 trading days",
          mechanism:
            "KALA BIO, Inc. told the SEC it could not file a periodic report on time, a filed risk item for holders of KALA BIO, Inc.",
          evidence: [
            quote(
              "KALA BIO, Inc. (the “Company”) will not, without unreasonable effort and expense, be able to file its Quarterly Report on Form 10-Q for the quarter ended September 30, 2026 (the “Form 10-Q”) within the prescribed time period because the Company requires additional time to complete its analysis and disclosure regarding its liquidity and capital resources.",
              "NT 10-Q",
              day(2),
              kalaUrl,
            ),
          ],
          pricedIn: false,
          tier: "watch",
          family: "F6",
          channel: "own_firm",
          linkClarity: "direct",
          opportunityEligible: false,
          invalidatedBy: "The late report filed within the extension period with no change in results would undo this reading.",
        }),
      ],
    },
    {
      id: "sample-apmd-restatement",
      sector: "all",
      generatedAt: ago(1),
      tier: "watch",
      confidence: "low",
      pricedIn: false,
      event: {
        id: "evt-apmd-restatement",
        ticker: "APMD",
        companyName: "Apnimed, Inc.",
        kind: "filing",
        eventType: "restatement_402",
        eventLabel: "Restatement notice",
        acceptedAt: ago(2.5),
        headline: "Apnimed, Inc. said past financial statements cannot be relied on",
        occurredAt: ago(2.5),
        summary:
          "Apnimed, Inc. said previously issued financial statements should no longer be relied upon (8-K Item 4.02).",
        source: source("8-K Item 4.02: Apnimed, Inc.", apmdUrl, 2.5),
        details: {
          revenueRestated: "no",
          periods: "the three and six months ended June 30, 2026",
          reason:
            "Gain on disposition of equity method investment in SASS incorrectly classified in continuing operations rather than discontinued operations.",
        },
      },
      hits: [
        hit({
          ticker: "APMD",
          companyName: "Apnimed, Inc.",
          relation: "self",
          direction: "down",
          confidence: "low",
          window: "1 to 5 trading days",
          mechanism:
            "Apnimed, Inc. reported that earlier financial statements can no longer be relied on, a filed risk item for holders of Apnimed, Inc.",
          evidence: [
            quote(
              "This gain was incorrectly classified within other income (expense) from continuing operations, rather than within discontinued operations in accordance with ASC 205-20, Discontinued Operations.",
              "8-K",
              day(2.5),
              apmdUrl,
            ),
          ],
          pricedIn: false,
          tier: "watch",
          family: "F5",
          channel: "own_firm",
          linkClarity: "direct",
          opportunityEligible: false,
          invalidatedBy:
            "A restatement limited to presentation, with no change in reported revenue or earnings, would weaken this reading.",
        }),
      ],
    },
    {
      id: "sample-onto-earnings",
      sector: "semis",
      generatedAt: ago(1),
      tier: "watch",
      confidence: "low",
      pricedIn: false,
      event: {
        id: "evt-onto-earnings",
        ticker: "ONTO",
        companyName: "Onto Innovation",
        kind: "earnings_surprise",
        eventType: "earnings_read_through",
        eventLabel: "Earnings read-through",
        acceptedAt: ago(30),
        headline: "Onto Innovation quarterly EPS 6.0% above consensus",
        occurredAt: ago(30),
        summary:
          "Onto Innovation reported EPS of $2.44 for the quarter ended September 30, 2026, 6.0% above the $2.30 consensus estimate, on record quarterly revenue of $410 million, up 88% from a year earlier.",
        source: source("8-K, EX-99.1: Onto Innovation Reports 2026 Third Quarter Results", ontoUrl, 30),
      },
      hits: [
        hit({
          ticker: "NVMI",
          companyName: "Nova",
          relation: "competitor",
          direction: "unclear",
          confidence: "medium",
          window: "1 to 4 weeks",
          mechanism:
            "Nova and Onto name each other as competitors in CD and thin film metrology. Onto's record $410 million revenue can signal strong demand for Nova too, or share taken from Nova.",
          evidence: [
            quote(
              "We compete mainly with Onto Innovation Inc., and KLA Corp., which manufacture and sell CD, thin films and chemical metrology and process control systems.",
              "20-F",
              "2026-02-17",
              "https://www.sec.gov/Archives/edgar/data/1109345/000117891326000504/zk2634307.htm",
            ),
          ],
          tier: "watch",
          family: "F10",
          channel: "competitor",
          linkClarity: "direct",
          opportunityEligible: false,
        }),
        hit({
          ticker: "CAMT",
          companyName: "Camtek",
          relation: "competitor",
          direction: "unclear",
          confidence: "medium",
          window: "1 to 4 weeks",
          mechanism:
            "Onto names Camtek as a principal competitor in advanced packaging inspection. Onto's 88% revenue growth may point to healthy demand for both, or to share taken from Camtek.",
          evidence: [
            quote(
              "Our principal competitors for advanced packaging inspection are KLA and Camtek Ltd. (“Camtek”).",
              "10-K",
              "2026-02-24",
              onto10k,
            ),
          ],
          tier: "watch",
          family: "F10",
          channel: "competitor",
          linkClarity: "direct",
          opportunityEligible: false,
        }),
      ],
    },
  ];
  return { generatedAt: ago(1), cards };
}
