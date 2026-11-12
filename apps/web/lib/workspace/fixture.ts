import type { LinkEvidence, RippleCard, RippleHit, SightingsFeed } from "@falcon/ripple";

/**
 * Development only: a sample feed in the @falcon/ripple shape, used to design
 * the Workspace while GET /api/sightings is not there yet. Imported lazily
 * behind a NODE_ENV check (lib/workspace/sightings.ts), so production builds
 * never load it. Events, numbers and quotes are made up.
 */

export const SAMPLE_FOCUS = [
  { ticker: "NVDA", name: "NVIDIA Corp" },
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "TSM", name: "Taiwan Semiconductor Manufacturing" },
  { ticker: "AMD", name: "Advanced Micro Devices" },
  { ticker: "MSFT", name: "Microsoft Corp" },
];

function edgar(ticker: string, form: string) {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker}&type=${encodeURIComponent(form)}`;
}

function quote(ticker: string, form: string, daysAgo: number, text: string, now: number): LinkEvidence {
  return { quote: text, form, filedAt: new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10), url: edgar(ticker, form) };
}

type HitInput = Omit<RippleHit, "evidence" | "history" | "window"> & {
  window?: string;
  evidence?: LinkEvidence[];
  history?: RippleHit["history"];
};

function hit(h: HitInput): RippleHit {
  return { window: "1 to 5 trading days", evidence: [], history: null, ...h };
}

export function sampleFeed(nowMs = Date.now()): SightingsFeed {
  const at = (hoursAgo: number) => new Date(nowMs - hoursAgo * 3_600_000).toISOString();
  const q = (ticker: string, form: string, daysAgo: number, text: string) => quote(ticker, form, daysAgo, text, nowMs);

  const cards: RippleCard[] = [
    {
      id: "sample-nvda-q3",
      sector: "Semiconductors",
      generatedAt: at(1),
      event: {
        id: "evt-nvda-q3",
        ticker: "NVDA",
        companyName: "NVIDIA Corp",
        kind: "earnings_surprise",
        headline: "NVIDIA revenue came in 6% above the consensus estimate",
        occurredAt: at(2),
        summary:
          "Quarterly revenue was $38.2B against a $36.0B estimate. Data center revenue rose 14% from the prior quarter and next quarter guidance was set above expectations.",
        source: { title: "NVIDIA announces financial results for the third quarter", url: edgar("NVDA", "8-K"), publisher: "SEC EDGAR", publishedAt: at(2) },
      },
      hits: [
        hit({
          ticker: "TSM",
          companyName: "Taiwan Semiconductor Manufacturing",
          relation: "supplier",
          degree: 1,
          direction: "up",
          confidence: "high",
          mechanism: "TSMC manufactures NVIDIA's data center GPUs. Higher GPU demand means more advanced node wafer orders.",
          evidence: [
            q("NVDA", "10-K", 260, "We utilize foundries, such as Taiwan Semiconductor Manufacturing Company Limited, to produce our semiconductor wafers."),
          ],
          history: { sample: 9, avgMovePct: 2.1, hitRate: 0.67, windowDays: 5 },
        }),
        hit({
          ticker: "MU",
          companyName: "Micron Technology",
          relation: "supplier",
          degree: 1,
          direction: "up",
          confidence: "medium",
          mechanism: "Each data center GPU ships with high bandwidth memory. Micron is one of three HBM suppliers.",
          evidence: [q("MU", "10-K", 90, "Our HBM products are designed into leading AI accelerator platforms, including those of a major GPU customer.")],
        }),
        hit({
          ticker: "SMCI",
          companyName: "Super Micro Computer",
          relation: "customer",
          degree: 1,
          direction: "up",
          confidence: "medium",
          mechanism: "Super Micro builds servers around NVIDIA GPUs. A stronger GPU supply line usually means more server shipments.",
          evidence: [q("SMCI", "10-K", 120, "A significant portion of our net sales depends on products that incorporate GPUs from a single supplier.")],
        }),
        hit({
          ticker: "AMD",
          companyName: "Advanced Micro Devices",
          relation: "competitor",
          degree: 1,
          direction: "unclear",
          confidence: "low",
          mechanism: "AMD sells competing accelerators. The beat signals a bigger market but also share held by NVIDIA.",
          evidence: [q("AMD", "10-K", 280, "Our primary competitor in the data center GPU market is NVIDIA.")],
        }),
        hit({
          ticker: "ASML",
          companyName: "ASML Holding",
          relation: "supplier",
          degree: 2,
          via: "TSM",
          direction: "up",
          confidence: "low",
          window: "5 to 20 trading days",
          mechanism: "More advanced node wafer demand at TSMC supports lithography tool orders.",
          evidence: [q("TSM", "20-F", 210, "We purchase lithography equipment from a limited number of suppliers, including ASML.")],
        }),
      ],
    },
    {
      id: "sample-aapl-guide",
      sector: "Hardware",
      generatedAt: at(4),
      event: {
        id: "evt-aapl-guide",
        ticker: "AAPL",
        companyName: "Apple Inc.",
        kind: "guidance",
        headline: "Apple guided iPhone revenue below the prior year for the holiday quarter",
        occurredAt: at(5),
        summary: "Apple expects iPhone revenue to decline in the low single digits year over year, citing softer demand in Greater China.",
        source: { title: "Apple Q4 earnings call", url: edgar("AAPL", "8-K"), publisher: "SEC EDGAR", publishedAt: at(5) },
      },
      hits: [
        hit({
          ticker: "QCOM",
          companyName: "Qualcomm",
          relation: "supplier",
          degree: 1,
          direction: "down",
          confidence: "high",
          mechanism: "Qualcomm supplies the iPhone modem. Fewer units shipped means fewer modems sold.",
          evidence: [q("QCOM", "10-K", 300, "A significant portion of our revenues is derived from Apple, which purchases our modem products.")],
        }),
        hit({
          ticker: "SWKS",
          companyName: "Skyworks Solutions",
          relation: "supplier",
          degree: 1,
          direction: "down",
          confidence: "high",
          mechanism: "Apple was the largest share of Skyworks revenue in the last fiscal year.",
          evidence: [q("SWKS", "10-K", 40, "Apple accounted for approximately 66% of our net revenue in fiscal year 2026.")],
        }),
        hit({
          ticker: "TSM",
          companyName: "Taiwan Semiconductor Manufacturing",
          relation: "supplier",
          degree: 1,
          direction: "down",
          confidence: "low",
          mechanism: "TSMC builds Apple's A series chips, but Apple is a smaller share of TSMC revenue than AI accelerators now.",
          evidence: [q("TSM", "20-F", 210, "Our largest customer accounted for 22% of our net revenue.")],
        }),
      ],
    },
    {
      id: "sample-mu-q1",
      sector: "Semiconductors",
      generatedAt: at(20),
      event: {
        id: "evt-mu-q1",
        ticker: "MU",
        companyName: "Micron Technology",
        kind: "earnings_surprise",
        headline: "Micron gross margin was 3 points above the estimate on memory pricing",
        occurredAt: at(22),
        summary: "Gross margin was 41.2% against a 38.0% estimate. DRAM contract prices rose for the third quarter in a row.",
        source: { title: "Micron reports results for the first quarter", url: edgar("MU", "8-K"), publisher: "SEC EDGAR", publishedAt: at(22) },
      },
      hits: [
        hit({
          ticker: "WDC",
          companyName: "Western Digital",
          relation: "peer",
          degree: 1,
          direction: "up",
          confidence: "medium",
          mechanism: "Memory and storage pricing tends to move together across the industry.",
          evidence: [q("WDC", "10-K", 150, "Our industry is highly cyclical and pricing is driven by supply and demand across all memory suppliers.")],
        }),
        hit({
          ticker: "LRCX",
          companyName: "Lam Research",
          relation: "supplier",
          degree: 1,
          direction: "up",
          confidence: "medium",
          window: "5 to 20 trading days",
          mechanism: "Higher memory margins tend to come before more spending on etch and deposition tools.",
          evidence: [q("LRCX", "10-K", 130, "Memory customers represented 39% of our systems revenue.")],
        }),
        hit({
          ticker: "AMAT",
          companyName: "Applied Materials",
          relation: "supplier",
          degree: 2,
          via: "LRCX",
          direction: "up",
          confidence: "low",
          window: "5 to 20 trading days",
          mechanism: "Equipment budgets usually move across tool makers together.",
          evidence: [q("AMAT", "10-K", 340, "We compete with Lam Research in deposition and etch.")],
        }),
      ],
    },
    {
      id: "sample-intc-10q",
      sector: "Semiconductors",
      generatedAt: at(30),
      event: {
        id: "evt-intc-10q",
        ticker: "INTC",
        companyName: "Intel Corp",
        kind: "filing",
        headline: "Intel's 10-Q moves its next foundry node to the second half of next year",
        occurredAt: at(31),
        summary: "The quarterly filing says high volume production on the next node is now expected in the second half, two quarters later than stated before.",
        source: { title: "Intel Corp 10-Q", url: edgar("INTC", "10-Q"), publisher: "SEC EDGAR", publishedAt: at(31) },
      },
      hits: [
        hit({
          ticker: "ASML",
          companyName: "ASML Holding",
          relation: "supplier",
          degree: 1,
          direction: "down",
          confidence: "medium",
          window: "5 to 20 trading days",
          mechanism: "A later ramp can push out EUV tool deliveries scheduled for Intel fabs.",
          evidence: [q("ASML", "20-F", 250, "A small number of customers, including Intel, account for most of our EUV system sales.")],
        }),
        hit({
          ticker: "TSM",
          companyName: "Taiwan Semiconductor Manufacturing",
          relation: "competitor",
          degree: 1,
          direction: "up",
          confidence: "low",
          mechanism: "Foundry customers weighing Intel's node have fewer near term alternatives to TSMC.",
          evidence: [q("INTC", "10-K", 270, "Our foundry business competes with Taiwan Semiconductor Manufacturing Company.")],
        }),
        hit({
          ticker: "AMD",
          companyName: "Advanced Micro Devices",
          relation: "competitor",
          degree: 1,
          direction: "up",
          confidence: "low",
          mechanism: "A slower Intel roadmap has in the past coincided with server CPU share moving to AMD.",
          evidence: [q("AMD", "10-K", 280, "Intel is our principal competitor in the x86 microprocessor market.")],
        }),
      ],
    },
    {
      id: "sample-msft-capex",
      sector: "Software",
      generatedAt: at(46),
      event: {
        id: "evt-msft-capex",
        ticker: "MSFT",
        companyName: "Microsoft Corp",
        kind: "news",
        headline: "Microsoft raised its capital spending plan for the fiscal year",
        occurredAt: at(48),
        summary: "Management said capital spending will grow faster than last year, mostly for data center buildout.",
        source: { title: "Microsoft fiscal year capital plan", url: edgar("MSFT", "8-K"), publisher: "SEC EDGAR", publishedAt: at(48) },
      },
      hits: [
        hit({
          ticker: "NVDA",
          companyName: "NVIDIA Corp",
          relation: "supplier",
          degree: 1,
          direction: "up",
          confidence: "medium",
          window: "5 to 20 trading days",
          mechanism: "Microsoft is one of NVIDIA's largest direct customers for data center systems.",
          evidence: [q("NVDA", "10-K", 260, "One direct customer accounted for 12% of total revenue, attributable to the Compute and Networking segment.")],
        }),
        hit({
          ticker: "AMD",
          companyName: "Advanced Micro Devices",
          relation: "supplier",
          degree: 1,
          direction: "up",
          confidence: "low",
          window: "5 to 20 trading days",
          mechanism: "Microsoft runs AMD accelerators in part of its fleet.",
          evidence: [q("AMD", "10-K", 280, "Our data center GPUs are deployed by major cloud providers.")],
        }),
        hit({
          ticker: "TSM",
          companyName: "Taiwan Semiconductor Manufacturing",
          relation: "supplier",
          degree: 2,
          via: "NVDA",
          direction: "up",
          confidence: "low",
          window: "5 to 20 trading days",
          mechanism: "Accelerators bought by Microsoft are built at TSMC.",
          evidence: [q("NVDA", "10-K", 260, "We utilize foundries, such as Taiwan Semiconductor Manufacturing Company Limited, to produce our semiconductor wafers.")],
        }),
      ],
    },
    {
      id: "sample-avgo-q4",
      sector: "Semiconductors",
      generatedAt: at(70),
      event: {
        id: "evt-avgo-q4",
        ticker: "AVGO",
        companyName: "Broadcom Inc.",
        kind: "earnings_surprise",
        headline: "Broadcom AI networking revenue was 9% above the estimate",
        occurredAt: at(72),
        summary: "AI semiconductor revenue was $5.4B. Management guided custom accelerator revenue higher for the next quarter.",
        source: { title: "Broadcom announces fourth quarter results", url: edgar("AVGO", "8-K"), publisher: "SEC EDGAR", publishedAt: at(72) },
      },
      hits: [
        hit({
          ticker: "ANET",
          companyName: "Arista Networks",
          relation: "customer",
          degree: 1,
          direction: "up",
          confidence: "medium",
          mechanism: "Arista switches are built on Broadcom silicon. Strong networking chip demand reflects switch demand.",
          evidence: [q("ANET", "10-K", 200, "We depend on Broadcom as the sole source for the merchant silicon in most of our switches.")],
        }),
        hit({
          ticker: "MRVL",
          companyName: "Marvell Technology",
          relation: "competitor",
          degree: 1,
          direction: "unclear",
          confidence: "low",
          mechanism: "Marvell competes for the same custom accelerator programs.",
          evidence: [q("MRVL", "10-K", 230, "Our competitors include Broadcom in custom silicon and networking.")],
        }),
      ],
    },
    {
      id: "sample-asml-orders",
      sector: "Semiconductors",
      generatedAt: at(96),
      event: {
        id: "evt-asml-orders",
        ticker: "ASML",
        companyName: "ASML Holding",
        kind: "guidance",
        headline: "ASML guided next year's sales from China lower",
        occurredAt: at(98),
        summary: "China is expected to fall to about 25% of system sales next year, from over 40% this year, under export rules.",
        source: { title: "ASML investor update", url: edgar("ASML", "6-K"), publisher: "SEC EDGAR", publishedAt: at(98) },
      },
      hits: [
        hit({
          ticker: "LRCX",
          companyName: "Lam Research",
          relation: "peer",
          degree: 1,
          direction: "down",
          confidence: "medium",
          mechanism: "Lam has a similar share of revenue from China under the same export rules.",
          evidence: [q("LRCX", "10-K", 130, "China accounted for 37% of our revenue in fiscal year 2026.")],
        }),
        hit({
          ticker: "AMAT",
          companyName: "Applied Materials",
          relation: "peer",
          degree: 1,
          direction: "down",
          confidence: "medium",
          mechanism: "Applied sells into the same Chinese fabs.",
          evidence: [q("AMAT", "10-K", 340, "Sales to customers in China represented 32% of net revenue.")],
        }),
        hit({
          ticker: "KLAC",
          companyName: "KLA Corp",
          relation: "peer",
          degree: 1,
          direction: "down",
          confidence: "low",
          mechanism: "Inspection tools follow the same fab buildouts.",
          evidence: [q("KLAC", "10-K", 160, "Export regulations have limited our ability to ship to certain customers in China.")],
        }),
      ],
    },
  ];

  return { generatedAt: at(1), cards };
}
