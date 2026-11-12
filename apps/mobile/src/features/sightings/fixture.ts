import type { LinkEvidence, RippleCard, RippleHit, SightingsFeed, Source } from "@falcon/ripple";

/**
 * DEVELOPMENT ONLY. A made-up Sightings feed in the @falcon/ripple shape, for
 * designing the screens while the engine API is not up. The numbers, quotes
 * and links are placeholders, not real data. lib/sightings.ts loads it only
 * when __DEV__ is true, so release builds never show it.
 */

const HOUR = 60 * 60 * 1000;

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

function edgar(ticker: string, form: string): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker}&type=${encodeURIComponent(form)}`;
}

function source(ticker: string, title: string, hours: number): Source {
  return { title, url: edgar(ticker, "8-K"), publisher: "SEC EDGAR", publishedAt: ago(hours) };
}

function quote(ticker: string, form: string, text: string, filedAt: string): LinkEvidence {
  return { quote: text, form, filedAt, url: edgar(ticker, form) };
}

function hit(h: Omit<RippleHit, "history" | "degree"> & Partial<Pick<RippleHit, "degree">>): RippleHit {
  return { degree: 1, history: null, ...h };
}

export function sampleFeed(): SightingsFeed {
  const cards: RippleCard[] = [
    {
      id: "sample-nvda-earnings",
      sector: "Semiconductors",
      generatedAt: ago(1.5),
      event: {
        id: "evt-nvda-q3",
        ticker: "NVDA",
        companyName: "NVIDIA",
        kind: "earnings_surprise",
        headline: "Nvidia beats on data center revenue",
        occurredAt: ago(2),
        summary:
          "Data center revenue came in at $41.2B against $39.0B expected. Guidance for next quarter was set above the consensus range.",
        source: source("NVDA", "NVIDIA quarterly results, Form 8-K", 2),
      },
      hits: [
        hit({
          ticker: "TSM",
          companyName: "Taiwan Semiconductor",
          relation: "supplier",
          direction: "up",
          confidence: "high",
          window: "1 to 5 trading days",
          mechanism:
            "TSMC makes Nvidia's data center GPUs. Higher GPU demand means more advanced wafer and packaging orders.",
          evidence: [
            quote(
              "NVDA",
              "10-K",
              "We utilize foundries, such as Taiwan Semiconductor Manufacturing Company Limited, to produce our semiconductor wafers.",
              "2026-02-25",
            ),
          ],
        }),
        hit({
          ticker: "MU",
          companyName: "Micron Technology",
          relation: "supplier",
          direction: "up",
          confidence: "medium",
          window: "1 to 5 trading days",
          mechanism: "Each data center GPU ships with high bandwidth memory. Micron is one of the few HBM suppliers.",
          evidence: [
            quote(
              "MU",
              "10-K",
              "Our HBM products are used in AI accelerators, and demand for these products has grown significantly.",
              "2026-10-03",
            ),
          ],
        }),
        hit({
          ticker: "SMCI",
          companyName: "Super Micro Computer",
          relation: "customer",
          direction: "up",
          confidence: "medium",
          window: "2 to 10 trading days",
          mechanism: "Super Micro builds servers around Nvidia GPUs. More GPU supply supports its server shipments.",
          evidence: [
            quote(
              "SMCI",
              "10-K",
              "We rely on a limited number of suppliers for GPUs, including NVIDIA, which are critical components of our systems.",
              "2026-08-28",
            ),
          ],
        }),
        hit({
          ticker: "AMD",
          companyName: "Advanced Micro Devices",
          relation: "competitor",
          direction: "unclear",
          confidence: "low",
          window: "1 to 5 trading days",
          mechanism:
            "AMD sells competing accelerators. A strong market can lift both, or share can move toward Nvidia.",
          evidence: [
            quote("AMD", "10-K", "In the data center GPU market, our primary competitor is NVIDIA.", "2026-02-04"),
          ],
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
          mechanism: "TSMC buys ASML's lithography systems. Sustained wafer demand supports its capacity plans.",
          evidence: [
            quote("TSM", "20-F", "We rely on a limited number of suppliers for lithography equipment.", "2026-04-17"),
          ],
        }),
      ],
    },
    {
      id: "sample-msft-capex",
      sector: "Technology",
      generatedAt: ago(4.5),
      event: {
        id: "evt-msft-capex",
        ticker: "MSFT",
        companyName: "Microsoft",
        kind: "guidance",
        headline: "Microsoft raises its capital spending outlook",
        occurredAt: ago(5),
        summary:
          "Microsoft now plans about $94B of capital spending this fiscal year, up from $80B, mostly for data centers.",
        source: source("MSFT", "Microsoft earnings call remarks", 5),
      },
      hits: [
        hit({
          ticker: "NVDA",
          companyName: "NVIDIA",
          relation: "supplier",
          direction: "up",
          confidence: "high",
          window: "1 to 5 trading days",
          mechanism: "Microsoft is one of Nvidia's largest buyers. A bigger data center budget means more GPU orders.",
          evidence: [
            quote(
              "NVDA",
              "10-K",
              "A significant portion of our revenue is derived from a limited number of customers, including cloud service providers.",
              "2026-02-25",
            ),
          ],
        }),
        hit({
          ticker: "VRT",
          companyName: "Vertiv",
          relation: "supplier",
          direction: "up",
          confidence: "medium",
          window: "2 to 10 trading days",
          mechanism: "New data centers need power and cooling gear, which Vertiv sells to the large cloud builders.",
          evidence: [
            quote(
              "VRT",
              "10-K",
              "Our largest customers include hyperscale cloud providers building and expanding data centers.",
              "2026-02-21",
            ),
          ],
        }),
        hit({
          ticker: "ANET",
          companyName: "Arista Networks",
          relation: "supplier",
          direction: "up",
          confidence: "medium",
          window: "2 to 10 trading days",
          mechanism: "Microsoft is Arista's largest customer. More data center buildout means more switching orders.",
          evidence: [
            quote(
              "ANET",
              "10-K",
              "Microsoft accounted for a significant percentage of our total revenue.",
              "2026-02-14",
            ),
          ],
        }),
      ],
    },
    {
      id: "sample-mu-pricing",
      sector: "Semiconductors",
      generatedAt: ago(7.5),
      event: {
        id: "evt-mu-pricing",
        ticker: "MU",
        companyName: "Micron Technology",
        kind: "news",
        headline: "Micron raises memory contract prices",
        occurredAt: ago(8),
        summary: "Micron told customers DRAM contract prices rise about 15% next quarter as AI servers absorb supply.",
        source: source("MU", "Micron pricing update", 8),
      },
      hits: [
        hit({
          ticker: "AAPL",
          companyName: "Apple",
          relation: "customer",
          direction: "down",
          confidence: "medium",
          window: "5 to 20 trading days",
          mechanism: "Apple buys DRAM for every iPhone and Mac. Higher memory prices press on hardware margins.",
          evidence: [
            quote(
              "AAPL",
              "10-K",
              "We depend on component suppliers, and component costs can rise significantly.",
              "2026-10-31",
            ),
          ],
        }),
        hit({
          ticker: "DELL",
          companyName: "Dell Technologies",
          relation: "customer",
          direction: "down",
          confidence: "medium",
          window: "5 to 20 trading days",
          mechanism:
            "Memory is one of the largest costs in a PC or server. Dell has raised prices before when it rose.",
          evidence: [
            quote(
              "DELL",
              "10-K",
              "Increases in the cost of components such as memory can reduce our gross margin.",
              "2026-03-24",
            ),
          ],
        }),
        hit({
          ticker: "NVDA",
          companyName: "NVIDIA",
          relation: "customer",
          direction: "unclear",
          confidence: "low",
          window: "5 to 20 trading days",
          mechanism:
            "Nvidia buys high bandwidth memory from Micron. Its pricing power makes the cost effect hard to call.",
          evidence: [
            quote(
              "NVDA",
              "10-K",
              "We depend on a limited number of suppliers for memory used in our products.",
              "2026-02-25",
            ),
          ],
        }),
      ],
    },
    {
      id: "sample-aapl-guide",
      sector: "Technology",
      generatedAt: ago(19),
      event: {
        id: "evt-aapl-guide",
        ticker: "AAPL",
        companyName: "Apple",
        kind: "guidance",
        headline: "Apple guides iPhone revenue below estimates",
        occurredAt: ago(20),
        summary: "Apple expects iPhone revenue to grow low single digits next quarter. Analysts had modeled about 7%.",
        source: source("AAPL", "Apple quarterly results, Form 8-K", 20),
      },
      hits: [
        hit({
          ticker: "SWKS",
          companyName: "Skyworks Solutions",
          relation: "supplier",
          direction: "down",
          confidence: "high",
          window: "1 to 5 trading days",
          mechanism: "Apple is Skyworks' largest customer. Fewer iPhone builds mean fewer radio chip orders.",
          evidence: [
            quote(
              "SWKS",
              "10-K",
              "Apple accounted for a majority of our net revenue, and the loss of or reduction in its orders would hurt our results.",
              "2026-11-06",
            ),
          ],
        }),
        hit({
          ticker: "CRUS",
          companyName: "Cirrus Logic",
          relation: "supplier",
          direction: "down",
          confidence: "medium",
          window: "1 to 5 trading days",
          mechanism: "Cirrus Logic's audio and power chips ship mostly in iPhones.",
          evidence: [
            quote(
              "CRUS",
              "10-K",
              "Our largest customer, Apple, represented most of our total net sales.",
              "2026-05-23",
            ),
          ],
        }),
        hit({
          ticker: "QCOM",
          companyName: "Qualcomm",
          relation: "supplier",
          direction: "down",
          confidence: "low",
          window: "2 to 10 trading days",
          mechanism: "Qualcomm still supplies iPhone modems, though Apple is moving that work in house.",
          evidence: [
            quote(
              "QCOM",
              "10-K",
              "Apple has begun using its own modem in some devices, which will reduce our modem revenue from Apple.",
              "2026-11-05",
            ),
          ],
        }),
      ],
    },
    {
      id: "sample-avgo-ai",
      sector: "Semiconductors",
      generatedAt: ago(26),
      event: {
        id: "evt-avgo-ai",
        ticker: "AVGO",
        companyName: "Broadcom",
        kind: "earnings_surprise",
        headline: "Broadcom AI revenue tops estimates",
        occurredAt: ago(27),
        summary:
          "AI semiconductor revenue reached $6.2B against $5.8B expected, on custom accelerator and networking demand.",
        source: source("AVGO", "Broadcom quarterly results, Form 8-K", 27),
      },
      hits: [
        hit({
          ticker: "MRVL",
          companyName: "Marvell Technology",
          relation: "competitor",
          direction: "up",
          confidence: "medium",
          window: "1 to 5 trading days",
          mechanism: "Marvell sells the same kind of custom AI chips to cloud companies. Strong demand reads across.",
          evidence: [
            quote(
              "MRVL",
              "10-K",
              "We compete with Broadcom in custom silicon and data center networking.",
              "2026-03-12",
            ),
          ],
        }),
        hit({
          ticker: "ANET",
          companyName: "Arista Networks",
          relation: "customer",
          direction: "up",
          confidence: "low",
          window: "2 to 10 trading days",
          mechanism: "Arista's switches run on Broadcom silicon. Networking strength points to switch demand.",
          evidence: [
            quote(
              "ANET",
              "10-K",
              "We depend on Broadcom as the supplier of merchant silicon for most of our switches.",
              "2026-02-14",
            ),
          ],
        }),
      ],
    },
    {
      id: "sample-tsla-deliveries",
      sector: "Consumer",
      generatedAt: ago(30),
      event: {
        id: "evt-tsla-deliveries",
        ticker: "TSLA",
        companyName: "Tesla",
        kind: "news",
        headline: "Tesla deliveries come in under estimates",
        occurredAt: ago(31),
        summary: "Tesla delivered 384,000 vehicles in the quarter against about 410,000 expected.",
        source: source("TSLA", "Tesla production and deliveries report", 31),
      },
      hits: [
        hit({
          ticker: "ALB",
          companyName: "Albemarle",
          relation: "supplier",
          direction: "down",
          confidence: "medium",
          window: "2 to 10 trading days",
          mechanism: "Fewer cars built means less battery lithium bought, a large share of Albemarle's sales.",
          evidence: [
            quote(
              "ALB",
              "10-K",
              "Demand for our lithium products depends heavily on electric vehicle adoption.",
              "2026-02-12",
            ),
          ],
        }),
        hit({
          ticker: "ON",
          companyName: "onsemi",
          relation: "supplier",
          direction: "down",
          confidence: "medium",
          window: "2 to 10 trading days",
          mechanism: "onsemi sells silicon carbide power chips used in Tesla drivetrains.",
          evidence: [
            quote(
              "ON",
              "10-K",
              "Sales to the automotive market, including electric vehicles, are a large part of our revenue.",
              "2026-02-05",
            ),
          ],
        }),
        hit({
          ticker: "RIVN",
          companyName: "Rivian",
          relation: "competitor",
          direction: "unclear",
          confidence: "low",
          window: "1 to 5 trading days",
          mechanism: "Weak demand can weigh on all EV makers, or buyers can move between brands.",
          evidence: [
            quote("RIVN", "10-K", "We face competition from established EV makers, including Tesla.", "2026-02-20"),
          ],
        }),
      ],
    },
  ];
  return { generatedAt: ago(1.5), cards };
}
