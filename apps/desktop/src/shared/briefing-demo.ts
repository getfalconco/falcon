/**
 * Handover briefing: the demo report (Ctrl+P presentation mode).
 *
 * Builds a complete `BriefingReport` from the demo book without touching a
 * provider, the chain or a model, so the briefing can be shown on stage with
 * no network and no keys. Every figure is drawn from the injected `rand` (the
 * demo seed's generator) and every instant is derived from the window the
 * caller passes in: no clock is read here, and the same seed and window always
 * give the same report.
 *
 * Figures and copy are the demo's own; the conclusions and the stories are
 * not. The report leads with what happened and what the night means for the
 * book, and a second implementation of either here would let the demo and a
 * real report word the same figures two ways, on the one surface where an
 * audience is watching. So the engine's `deriveImplications` and
 * `deriveStories` are imported for real, from the renderer-safe half of the
 * contract (`briefing/contracts.ts`, whose comments name this file as the
 * reason they are exported), with `leadMarketRows` beside them for the lead's
 * last-resort sentence. The store that builds this report already pulls the
 * same module in for its window rule, so it costs the bundle nothing new.
 * Everything else is types.
 *
 * The lead over the stories is the engine's template lead, assembled here the
 * same way (see "The lead" below): `templateNarrative` lives in narrative.ts,
 * which reaches into the model client, so the renderer cannot import it.
 */

import { deriveImplications, deriveStories, leadMarketRows } from "./briefing-types";
import type {
  BriefingBook,
  BriefingHandover,
  BriefingHolding,
  BriefingNarrative,
  BriefingPriorityBand,
  BriefingReport,
  BriefingRisk,
  BriefingWindow,
  CalendarCoverage,
  CalendarItem,
  CorporateEvent,
  HeldCoverage,
  HeldEarnings,
  HeldFiling,
  HeldMeasurement,
  HeldMover,
  HeldNewsItem,
  Implication,
  ImplicationPosition,
  IndexFamily,
  MarketGroup,
  MarketHeadline,
  MarketRow,
  MarketUnit,
  Story,
} from "./briefing-types";

/**
 * Mirrors the engine's BRIEFING_SCHEMA_VERSION: 3, the shape that carries
 * market-wide headlines and the stories the panel leads with, both of which
 * this file writes. Kept as a literal so a report built here is stamped with
 * the shape this file actually writes: importing the constant would stamp
 * every demo report with whatever the engine has moved on to, whether or not
 * the fields came with it.
 */
const DEMO_SCHEMA_VERSION = 3;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The report is stamped 2 h 14 min before the target open, whatever the wall
 * clock says. A demo opened at 22:00 would otherwise show a countdown of
 * eleven hours over European rows marked "live"; pinned here, the countdown
 * and the now-marker on the calendar read like a real morning at any hour.
 */
const LEAD_BEFORE_OPEN_MS = (2 * 60 + 14) * MINUTE_MS;

/** The regular open, in minutes after midnight ET. Every ET time is placed relative to it. */
const OPEN_MINUTES_ET = 9 * 60 + 30;

/** Matches the paper account's own "flat" test, so dust never counts as a position. */
const FLAT_SHARES = 1e-9;

const TOP_WEIGHTS = 5;

/**
 * The Asian session closes lower across the board: every row down, sized
 * between these two figures in percent. The engine tells a region as one
 * story only when every row printed the same way and the average move clears
 * 1%, and a session left to the shared lean would show that story on one
 * morning in five. Drawn one way, it is on stage every time; Europe and the
 * futures keep the lean, so a night where Asia sold off and the West shrugged
 * is a morning the demo can show.
 */
const ASIA_MOVE_MIN_PCT = 1.05;
const ASIA_MOVE_SPAN_PCT = 1.2;

type MoveRange = { min: number; span: number };

/**
 * The lead name's move, in units of its daily volatility: 1.6 to 2.8 normal
 * days, either way. That clears 1.5% on the lowest volatility in the pool
 * (1.6% a day), which is what makes the top-band headline beside it a story
 * and not a footnote, and gives the volatility multiple something to say.
 */
const LEAD_MOVE_VOLS: MoveRange = { min: 1.6, span: 1.2 };
/** The reporter's move on its results: 0.8 to 2 normal days, either way. */
const RESULTS_MOVE_VOLS: MoveRange = { min: 0.8, span: 1.2 };

/** How many market-wide headlines a night carries. */
const MIN_MARKET_HEADLINES = 4;
const MAX_MARKET_HEADLINES = 6;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type DemoMarket = {
  symbol: string;
  label: string;
  group: MarketGroup;
  unit: MarketUnit;
  basis: "prev_close" | "prior_settle";
  level: number;
  /** Size of a typical overnight move, in the row's own unit. */
  swing: number;
  decimals: number;
  /** Asia only: the local close, in minutes after midnight UTC. */
  closeUtcMinutes?: number;
};

/**
 * Same symbols, labels, groups, units and bases as the engine's
 * `MARKET_SYMBOLS`, in the same order, so the demo exercises the table the
 * real report fills. Levels are rough and sit near the demo book's fund prices
 * (SPY 640 beside S&P futures near 6,400).
 */
const DEMO_MARKETS: DemoMarket[] = [
  { symbol: "^N225", label: "Nikkei 225", group: "asia", unit: "pct", basis: "prev_close", level: 38_600, swing: 1.0, decimals: 2, closeUtcMinutes: 6 * 60 + 30 },
  { symbol: "^HSI", label: "Hang Seng", group: "asia", unit: "pct", basis: "prev_close", level: 19_800, swing: 1.2, decimals: 2, closeUtcMinutes: 8 * 60 },
  { symbol: "000001.SS", label: "Shanghai Composite", group: "asia", unit: "pct", basis: "prev_close", level: 3_260, swing: 0.8, decimals: 2, closeUtcMinutes: 7 * 60 },
  { symbol: "^AXJO", label: "ASX 200", group: "asia", unit: "pct", basis: "prev_close", level: 8_320, swing: 0.7, decimals: 2, closeUtcMinutes: 6 * 60 },

  { symbol: "^STOXX50E", label: "Euro Stoxx 50", group: "europe", unit: "pct", basis: "prev_close", level: 5_310, swing: 0.8, decimals: 2 },
  { symbol: "^GDAXI", label: "DAX", group: "europe", unit: "pct", basis: "prev_close", level: 21_500, swing: 0.8, decimals: 2 },
  { symbol: "^FTSE", label: "FTSE 100", group: "europe", unit: "pct", basis: "prev_close", level: 8_640, swing: 0.6, decimals: 2 },
  { symbol: "^FCHI", label: "CAC 40", group: "europe", unit: "pct", basis: "prev_close", level: 7_900, swing: 0.8, decimals: 2 },

  { symbol: "ES=F", label: "S&P 500 futures", group: "us_futures", unit: "pct", basis: "prior_settle", level: 6_420, swing: 0.6, decimals: 2 },
  { symbol: "NQ=F", label: "Nasdaq-100 futures", group: "us_futures", unit: "pct", basis: "prior_settle", level: 23_100, swing: 0.8, decimals: 2 },
  { symbol: "YM=F", label: "Dow futures", group: "us_futures", unit: "pct", basis: "prior_settle", level: 45_200, swing: 0.5, decimals: 0 },
  { symbol: "RTY=F", label: "Russell 2000 futures", group: "us_futures", unit: "pct", basis: "prior_settle", level: 2_410, swing: 0.9, decimals: 1 },

  { symbol: "^VIX", label: "VIX", group: "macro", unit: "pts", basis: "prev_close", level: 16.4, swing: 1.4, decimals: 2 },
  { symbol: "DX-Y.NYB", label: "US dollar index", group: "macro", unit: "pct", basis: "prev_close", level: 99.2, swing: 0.35, decimals: 3 },
  { symbol: "CL=F", label: "WTI crude", group: "macro", unit: "pct", basis: "prior_settle", level: 68.5, swing: 1.6, decimals: 2 },
  { symbol: "GC=F", label: "Gold", group: "macro", unit: "pct", basis: "prior_settle", level: 3_340, swing: 0.8, decimals: 1 },
  { symbol: "^TNX", label: "US 10-year yield", group: "macro", unit: "bp", basis: "prev_close", level: 4.25, swing: 5, decimals: 3 },
];

/**
 * Reference prices for the symbols a demo book is drawn from. A copy of the
 * pools in `renderer/lib/demo-mode.ts`, not an import: that module pulls in
 * React and the paper-account store, and `shared/` has to stay loadable from a
 * plain node test and from the main process.
 */
const DEMO_COMPANY_PRICES: Readonly<Record<string, number>> = {
  NVDA: 215,
  AAPL: 230,
  MSFT: 430,
  AMZN: 210,
  META: 620,
  GOOGL: 190,
  TSLA: 330,
  AVGO: 290,
  LLY: 780,
  COST: 950,
  PLTR: 150,
  AMD: 165,
  JPM: 280,
  XOM: 115,
  NFLX: 1200,
  MSTR: 380,
};

const DEMO_FUND_PRICES: Readonly<Record<string, number>> = {
  SPY: 640,
  VOO: 590,
  QQQ: 560,
  VTI: 315,
  SCHD: 27,
  IWM: 240,
  SMH: 285,
  XLK: 260,
  ARKK: 75,
  GLD: 320,
  TLT: 90,
  VXUS: 68,
  IBIT: 62,
  JEPI: 58,
};

/** Rough daily volatility in percent; anything unlisted gets the default for its kind. */
const DEMO_DAILY_VOL_PCT: Readonly<Record<string, number>> = {
  NVDA: 2.6,
  TSLA: 3.2,
  PLTR: 3.5,
  AMD: 2.8,
  MSTR: 4.5,
  META: 2.0,
  NFLX: 2.1,
  AVGO: 2.4,
  ARKK: 2.4,
  IBIT: 3.0,
  SMH: 2.0,
  TLT: 0.9,
  GLD: 0.9,
  SCHD: 0.8,
  JEPI: 0.6,
};
const DEFAULT_COMPANY_VOL_PCT = 1.6;
const DEFAULT_FUND_VOL_PCT = 1.0;

/**
 * The markets row a fund moves with, and by how much of it. SPY printing down
 * 2% beside S&P futures that are flat is the first thing a finance audience
 * would catch, so an index fund takes its move from the row it tracks instead
 * of from its own draw. TLT runs against the yield: about 0.16% per basis
 * point, the duration of a 20-year portfolio.
 */
const DEMO_FUND_FOLLOWS: Readonly<Record<string, { symbol: string; factor: number }>> = {
  SPY: { symbol: "ES=F", factor: 1 },
  VOO: { symbol: "ES=F", factor: 1 },
  VTI: { symbol: "ES=F", factor: 1 },
  QQQ: { symbol: "NQ=F", factor: 1 },
  XLK: { symbol: "NQ=F", factor: 1.1 },
  SMH: { symbol: "NQ=F", factor: 1.5 },
  IWM: { symbol: "RTY=F", factor: 1 },
  GLD: { symbol: "GC=F", factor: 1 },
  TLT: { symbol: "^TNX", factor: -0.16 },
};

/**
 * Each name's beta to the S&P contract, which is what the conclusions size the
 * book against. For a name drawn straight off the broad row it IS the
 * coefficient of that draw (see `priceHoldings`), so the part of a move the
 * conclusions call "the name's own" is exactly the idiosyncratic part drawn
 * here. A fund that tracks another row is listed with the beta its index
 * really carries against the S&P, which is the figure an audience would check:
 * gold and long bonds run on their own, and a semiconductor fund runs hot.
 *
 * Anything unlisted gets the default for its kind, which is also the
 * coefficient `priceHoldings` uses for it.
 */
const DEMO_BETA: Readonly<Record<string, number>> = {
  SPY: 1,
  VOO: 1,
  VTI: 1,
  QQQ: 1.15,
  XLK: 1.25,
  SMH: 1.6,
  IWM: 1.1,
  GLD: 0.05,
  TLT: -0.15,
};
const DEFAULT_COMPANY_BETA = 1.2;
const DEFAULT_FUND_BETA = 0.8;

type DemoHeadline = { headline: string; tags: string[]; also: string[] };

/**
 * Invented, deliberately unremarkable headlines. Attributed to generic desks
 * rather than to a real outlet: a made-up story under a real masthead is a
 * fabrication even inside a demo.
 */
const DEMO_HEADLINES: Readonly<Record<string, DemoHeadline>> = {
  NVDA: { headline: "Nvidia supplier commentary points to steady data center orders", tags: ["supply_chain"], also: ["AMD", "AVGO"] },
  AAPL: { headline: "Apple widens its trade-in program to more regions before the holiday quarter", tags: ["product"], also: [] },
  MSFT: { headline: "Microsoft outlines new enterprise pricing for its AI assistant tier", tags: ["product"], also: [] },
  AMZN: { headline: "Amazon opens more same-day delivery sites in the Midwest", tags: ["operations"], also: [] },
  META: { headline: "Meta details capital spending plans for a new data center campus", tags: ["capex"], also: ["NVDA", "AVGO"] },
  GOOGL: { headline: "Alphabet cloud unit announces a multi-year contract with a European bank", tags: ["contract"], also: [] },
  TSLA: { headline: "Tesla reports higher weekly registrations in China", tags: ["sales"], also: [] },
  AVGO: { headline: "Broadcom extends custom chip agreement with a large cloud customer", tags: ["contract"], also: ["NVDA"] },
  LLY: { headline: "Eli Lilly files for an expanded label on its weight-management drug", tags: ["regulatory"], also: [] },
  COST: { headline: "Costco monthly sales update shows steady membership renewals", tags: ["sales"], also: [] },
  PLTR: { headline: "Palantir wins a follow-on government analytics contract", tags: ["contract"], also: [] },
  AMD: { headline: "AMD sets a date for its next accelerator launch event", tags: ["product"], also: ["NVDA"] },
  JPM: { headline: "JPMorgan executive comments on loan demand at an industry conference", tags: ["management"], also: [] },
  XOM: { headline: "Exxon Mobil brings a new offshore production unit online", tags: ["operations"], also: [] },
  NFLX: { headline: "Netflix expands its ad-supported tier to more markets", tags: ["product"], also: [] },
  MSTR: { headline: "Strategy discloses its latest bitcoin holdings in a regulatory filing", tags: ["filing"], also: [] },
};

type DemoLeadHeadline = { up: string; down: string; tags: string[] };

/**
 * The top-band headline on the night's lead name, one wording for each way
 * the name moved: a lifted outlook beside a 5% drop is the first thing a
 * finance audience would catch. Invented and attributed to generic desks, as
 * above. The engine still claims no link between headline and move; the
 * reader draws it, which is the point of putting the two side by side.
 */
const DEMO_LEAD_HEADLINES: Readonly<Record<string, DemoLeadHeadline>> = {
  NVDA: { up: "Nvidia lifts its data center outlook after a large cloud order", down: "Nvidia flags a shipment delay on its newest accelerator", tags: ["guidance"] },
  AAPL: { up: "Apple posts record services revenue in an early holiday update", down: "Apple faces a new EU antitrust complaint over its app store terms", tags: ["regulatory"] },
  MSFT: { up: "Microsoft wins a multi-year cloud contract with a US agency", down: "Microsoft names a new cloud chief as Azure growth slows", tags: ["management"] },
  AMZN: { up: "Amazon reports its fastest cloud growth in two years", down: "Amazon warns on holiday-quarter margins as shipping costs climb", tags: ["guidance"] },
  META: { up: "Meta reports stronger ad demand across its main apps", down: "Meta faces a fresh regulatory inquiry into its ad practices", tags: ["regulatory"] },
  GOOGL: { up: "Alphabet wins a court ruling on its search distribution deals", down: "Alphabet loses a court ruling on its search distribution deals", tags: ["legal"] },
  TSLA: { up: "Tesla reports record quarterly deliveries", down: "Tesla recalls vehicles over a steering software fault", tags: ["product"] },
  AVGO: { up: "Broadcom wins a multi-year custom chip order from a hyperscaler", down: "Broadcom loses a custom chip order to a rival, filing shows", tags: ["contract"] },
  LLY: { up: "Eli Lilly wins US approval for a once-weekly obesity pill", down: "Eli Lilly pauses a late-stage trial after a safety review", tags: ["regulatory"] },
  COST: { up: "Costco raises its membership fee for the first time in years", down: "Costco reports slower comparable sales in its monthly update", tags: ["sales"] },
  PLTR: { up: "Palantir lands its largest government contract to date", down: "Palantir loses a government contract renewal to a rival", tags: ["contract"] },
  AMD: { up: "AMD lands a large accelerator order from a cloud customer", down: "AMD delays its next accelerator after a manufacturing issue", tags: ["product"] },
  JPM: { up: "JPMorgan lifts its net interest income outlook in an early update", down: "JPMorgan sets aside more for credit losses in an early update", tags: ["guidance"] },
  XOM: { up: "Exxon Mobil brings a large Guyana project online ahead of schedule", down: "Exxon Mobil halts output at a Gulf platform after a fire", tags: ["operations"] },
  NFLX: { up: "Netflix reports its strongest subscriber quarter in three years", down: "Netflix reports a subscriber miss as price rises bite", tags: ["sales"] },
  MSTR: { up: "Strategy discloses its largest bitcoin purchase to date", down: "Strategy prices a new convertible note at a steep discount", tags: ["filing"] },
};

const DEMO_NEWS_SOURCES = ["Newswire", "Market desk", "Company release"];

type DemoMarketHeadline = {
  slug: string;
  /** The markets row whose sign picks the wording; null for a headline that claims no direction. */
  symbol: string | null;
  up: string;
  down: string;
  related: string[];
  /** The query symbol that surfaced it: one of the engine's `MARKET_NEWS_SYMBOLS`. */
  via: string;
};

/**
 * Market-wide headlines since the close, invented and generic, the way the
 * provider's search news reads for an index or a future. A headline that
 * names a direction has one wording for each way its row moved, so the tape
 * never says "futures lower" beside a row that is up. Asia is always lower in
 * this demo (see ASIA_MOVE_MIN_PCT), so the two that mention it can say so.
 */
const DEMO_MARKET_HEADLINES: ReadonlyArray<DemoMarketHeadline> = [
  {
    slug: "futures",
    symbol: "ES=F",
    up: "Equity futures higher before the bell despite a weak Asian session",
    down: "Equity futures lower before the bell after a weak Asian session",
    related: ["SPY", "QQQ"],
    via: "SPY",
  },
  {
    slug: "asia",
    symbol: null,
    up: "Asian shares close lower across the board in a broad risk-off session",
    down: "Asian shares close lower across the board in a broad risk-off session",
    related: ["SPY"],
    via: "^GSPC",
  },
  {
    slug: "crude",
    symbol: "CL=F",
    up: "Crude climbs toward a three-week high on supply worries",
    down: "Crude slips as inventories build more than anticipated",
    related: ["CL=F"],
    via: "CL=F",
  },
  {
    slug: "gold",
    symbol: "GC=F",
    up: "Gold edges higher on steady central bank demand",
    down: "Gold eases from last week's record close",
    related: ["GC=F"],
    via: "GC=F",
  },
  {
    slug: "yields",
    symbol: "^TNX",
    up: "Treasury yields tick higher ahead of this week's auctions",
    down: "Treasury yields dip ahead of this week's auctions",
    related: ["TLT"],
    via: "TLT",
  },
  {
    slug: "dollar",
    symbol: "DX-Y.NYB",
    up: "Dollar firms against the yen and the euro",
    down: "Dollar softens against the yen and the euro",
    related: ["DX-Y.NYB"],
    via: "DX-Y.NYB",
  },
  {
    slug: "vix",
    symbol: "^VIX",
    up: "Volatility gauge climbs from a two-month low",
    down: "Volatility gauge eases toward a two-month low",
    related: ["^VIX"],
    via: "^VIX",
  },
  {
    slug: "small-caps",
    symbol: "RTY=F",
    up: "Small caps outpace large caps in early futures trading",
    down: "Small caps lag large caps in early futures trading",
    related: ["IWM"],
    via: "IWM",
  },
  {
    slug: "fed",
    symbol: null,
    up: "Fed speakers strike a cautious tone in overnight remarks",
    down: "Fed speakers strike a cautious tone in overnight remarks",
    related: ["SPY"],
    via: "SPY",
  },
  {
    slug: "chips",
    symbol: null,
    up: "Chipmakers in focus after a supplier's monthly sales update",
    down: "Chipmakers in focus after a supplier's monthly sales update",
    related: ["QQQ"],
    via: "QQQ",
  },
];

/**
 * Filing labels worded as the chain writes them (`briefing/chain-slice.ts`:
 * the form, the item codes, the item names in brackets), so the engine's
 * stories read "results" and the form off a demo label the way they do off a
 * real one.
 */
const RESULTS_FILING_LABEL = "8-K, items 2.02, 9.01 (results of operations)";
const FD_FILING_LABEL = "8-K, item 7.01 (Regulation FD disclosure)";
const INSIDER_FILING_LABEL = "Insider filing (Form 4)";

/** Quarterly cash dividend per share for the well-known payers in the company pool. */
const DEMO_DIVIDENDS: Readonly<Record<string, number>> = {
  AAPL: 0.26,
  MSFT: 0.83,
  AVGO: 0.59,
  LLY: 1.5,
  COST: 1.3,
  JPM: 1.4,
  XOM: 0.99,
  META: 0.53,
  GOOGL: 0.21,
  NVDA: 0.01,
};

type DemoIndexFamily = {
  family: IndexFamily;
  title: string;
  lead: string;
  certainty: "rule" | "confirmed";
  source: "rule" | "curated";
  funds: string[];
};

const DEMO_RULE_LEAD = "Scheduled, per index methodology. Changes take effect after the close.";
const DEMO_CURATED_LEAD = "Announced by the index provider. Changes take effect after the close.";

/**
 * Which pool funds track which index family. VTI (CRSP), VXUS (FTSE), SCHD,
 * SMH and the rest follow indices outside the four families the contract
 * models, so they get no rebalance event, the same as in the real report.
 *
 * Titles, lead sentences, certainty and source are the engine's own
 * (`briefing/rebalance.ts` and the curated calendar). S&P and Nasdaq-100 dates
 * come from a weekday rule there; a Russell reconstitution only ever arrives
 * as a date the provider announced, so showing it as "rule" would put a
 * certainty note on stage that the real report never prints for that family.
 */
const DEMO_INDEX_FUNDS: ReadonlyArray<DemoIndexFamily> = [
  { family: "sp", title: "S&P quarterly index rebalance", lead: DEMO_RULE_LEAD, certainty: "rule", source: "rule", funds: ["SPY", "VOO", "XLK"] },
  { family: "nasdaq100", title: "Nasdaq-100 quarterly rebalance", lead: DEMO_RULE_LEAD, certainty: "rule", source: "rule", funds: ["QQQ"] },
  {
    family: "russell",
    title: "Russell index reconstitution",
    lead: DEMO_CURATED_LEAD,
    certainty: "confirmed",
    source: "curated",
    funds: ["IWM"],
  },
];

type DemoRelease = {
  code: string;
  title: string;
  time: "08:30" | "10:00";
  importance: 1 | 2 | 3;
  source: string;
  weekly?: boolean;
};

const DEMO_RELEASES: DemoRelease[] = [
  { code: "CPI", title: "Consumer Price Index", time: "08:30", importance: 3, source: "bls" },
  { code: "PPI", title: "Producer Price Index", time: "08:30", importance: 2, source: "bls" },
  { code: "RETAIL", title: "Retail sales", time: "08:30", importance: 3, source: "census" },
  { code: "CLAIMS", title: "Initial jobless claims", time: "08:30", importance: 2, source: "dol", weekly: true },
  { code: "DURABLES", title: "Durable goods orders", time: "08:30", importance: 2, source: "census" },
  { code: "HOUSING", title: "Housing starts", time: "08:30", importance: 1, source: "census" },
  { code: "ISM_MFG", title: "ISM Manufacturing PMI", time: "10:00", importance: 3, source: "ism" },
  { code: "ISM_SVC", title: "ISM Services PMI", time: "10:00", importance: 2, source: "ism" },
  { code: "JOLTS", title: "Job openings (JOLTS)", time: "10:00", importance: 2, source: "bls" },
  { code: "SENTIMENT", title: "Consumer sentiment", time: "10:00", importance: 2, source: "umich" },
  { code: "NEW_HOMES", title: "New home sales", time: "10:00", importance: 1, source: "census" },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Rounds to `decimals` places; a rounded negative zero is reported as plain 0. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function intBetween(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Draws `n` items without replacement, in draw order. */
function pickSome<T>(rand: () => number, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

function pickOne<T>(rand: () => number, items: readonly T[]): T {
  return items[intBetween(rand, 0, items.length - 1)];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An instant cut to the minute, the resolution a feed stamps an article or a filing with. */
function minuteIso(ms: number): string {
  return iso(Math.floor(ms / MINUTE_MS) * MINUTE_MS);
}

function ymdToMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function msToYmd(ms: number): string {
  return iso(ms).slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return msToYmd(ymdToMs(ymd) + days * DAY_MS);
}

function isWeekend(ymd: string): boolean {
  const day = new Date(ymdToMs(ymd)).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * `n` weekdays after `ymd`. Weekends only: the demo knows no holidays, so a
 * date it prints can land on one. That is acceptable for invented events and
 * keeps this file free of a second copy of the market calendar; the only
 * promise made is that `sessions_until` and the date agree with each other.
 */
function stepWeekdays(ymd: string, n: number): string {
  let out = ymd;
  let left = n;
  while (left > 0) {
    out = addDays(out, 1);
    if (!isWeekend(out)) left--;
  }
  return out;
}

function weekdaysBetween(fromYmd: string, toYmd: string): number {
  let count = 0;
  for (let d = fromYmd; d < toYmd; ) {
    d = addDays(d, 1);
    if (!isWeekend(d)) count++;
  }
  return count;
}

function fridayOnOrAfter(ymd: string): string {
  let out = ymd;
  while (new Date(ymdToMs(out)).getUTCDay() !== 5) out = addDays(out, 1);
  return out;
}

/**
 * The engine's own wording. Upstream an unannounced hour is stored as after
 * the close, so the real report cannot say "after the close" on its own, and
 * a demo that did would promise a precision the product does not have.
 */
function earningsTimingWords(e: HeldEarnings): string {
  return e.timing === "bmo" ? "before the open" : "after the close, or at an hour not yet announced";
}

/** FNV-1a, 32 bit. The engine hashes with node:crypto, which a renderer bundle does not have. */
function factsHash(facts: unknown): string {
  const text = JSON.stringify(facts);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `demo-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Upper-cased, duplicates summed, flat and unreadable rows dropped: the engine's own merge rule. */
function mergeHoldings(positions: BriefingHolding[]): BriefingHolding[] {
  const merged = new Map<string, BriefingHolding>();
  for (const p of positions) {
    const symbol = typeof p.symbol === "string" ? p.symbol.trim().toUpperCase() : "";
    if (symbol === "" || !Number.isFinite(p.shares) || Math.abs(p.shares) < FLAT_SHARES) continue;
    const cost = Number.isFinite(p.cost_usd) ? p.cost_usd : 0;
    const existing = merged.get(symbol);
    if (existing) {
      existing.shares += p.shares;
      existing.cost_usd += cost;
    } else {
      merged.set(symbol, { symbol, shares: p.shares, cost_usd: cost });
    }
  }
  return [...merged.values()].filter((h) => Math.abs(h.shares) >= FLAT_SHARES);
}

function isFund(symbol: string): boolean {
  return symbol in DEMO_FUND_PRICES;
}

/**
 * A symbol outside the pools (a caller passing a real book through the demo
 * path) is priced at its own cost basis, so its weight in the book stays
 * believable instead of collapsing to a placeholder price.
 */
function referencePrice(holding: BriefingHolding): number {
  const known = DEMO_COMPANY_PRICES[holding.symbol] ?? DEMO_FUND_PRICES[holding.symbol];
  if (known !== undefined) return known;
  const perShare = Math.abs(holding.cost_usd / holding.shares);
  return Number.isFinite(perShare) && perShare > 0 ? perShare : 100;
}

type Clock = {
  openMs: number;
  generatedMs: number;
  sinceMs: number;
  targetYmd: string;
};

/**
 * Every instant in the report hangs off the target open. A window that does
 * not parse (hand-built in a preview, or a contract drift) falls back to a
 * fixed instant instead of throwing: demo mode is switched on in front of an
 * audience, and a blank panel there is worse than a report with odd dates.
 */
function resolveClock(window: BriefingWindow): Clock {
  const ymdOk = /^\d{4}-\d{2}-\d{2}$/.test(window.target_session_ymd) && Number.isFinite(ymdToMs(window.target_session_ymd));
  let openMs = Date.parse(window.target_open_at);
  if (!Number.isFinite(openMs)) {
    openMs = ymdOk ? ymdToMs(window.target_session_ymd) + 13.5 * HOUR_MS : Date.UTC(2026, 0, 5, 14, 30);
  }
  const generatedMs = openMs - LEAD_BEFORE_OPEN_MS;
  const parsedSince = Date.parse(window.overnight_since);
  // "Overnight" has to start before the report is stamped, or every headline
  // and filing time drawn between the two would come out reversed.
  const sinceMs = Number.isFinite(parsedSince) && parsedSince < generatedMs ? parsedSince : openMs - 17.5 * HOUR_MS;
  return { openMs, generatedMs, sinceMs, targetYmd: ymdOk ? window.target_session_ymd : msToYmd(openMs) };
}

/** An "HH:MM" ET wall time on the target day as an instant, placed relative to the 09:30 open. */
function etInstant(clock: Clock, timeEt: string): string {
  const [h, m] = timeEt.split(":").map(Number);
  return iso(clock.openMs + (h * 60 + m - OPEN_MINUTES_ET) * MINUTE_MS);
}

/** A random instant inside the night: between the last close and the report's stamp. */
function overnightMs(rand: () => number, clock: Clock): number {
  return clock.sinceMs + rand() * (clock.generatedMs - clock.sinceMs);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function moveIn(unit: MarketUnit, last: number, prev: number): number {
  if (unit === "pct") return roundTo((last / prev - 1) * 100, 2);
  if (unit === "pts") return roundTo(last - prev, 2);
  // The yield is quoted in percent, so one unit of the quote is a hundred basis points.
  return roundTo((last - prev) * 100, 1);
}

function buildMarkets(rand: () => number, clock: Clock, tone: number): MarketRow[] {
  // About one report in three carries a stale European row (the FTSE shut on
  // a UK bank holiday while the continent trades), so the withheld-move
  // design (a level with no figure beside it) is seen in a demo and not only
  // on the one morning a year London is shut. Europe rather than Asia because
  // the Asian session is told as one story, and the engine tells a region's
  // story only when every row in it printed since the close.
  const europe = DEMO_MARKETS.map((def, index) => (def.group === "europe" ? index : -1)).filter((index) => index >= 0);
  const staleIndex = europe.length > 0 && rand() < 1 / 3 ? pickOne(rand, europe) : -1;
  const targetDayMs = ymdToMs(msToYmd(clock.openMs));

  return DEMO_MARKETS.map((def, index) => {
    const prev = roundTo(def.level * (1 + (rand() - 0.5) * 0.06), def.decimals);
    const noise = (rand() - 0.5) * 0.8 * def.swing;
    // Volatility falls when equities rise; everything else in the macro block
    // is left uncorrelated, which is close enough for one morning.
    const lean = def.group === "macro" ? (def.unit === "pts" ? -0.9 * tone * def.swing : 0) : 0.9 * tone * def.swing;
    // Asia is the one session drawn apart from the lean: see ASIA_MOVE_MIN_PCT.
    const drawn = def.group === "asia" ? -(ASIA_MOVE_MIN_PCT + rand() * ASIA_MOVE_SPAN_PCT) : lean + noise;

    let last: number;
    if (def.unit === "pct") last = roundTo(prev * (1 + drawn / 100), def.decimals);
    else if (def.unit === "pts") last = roundTo(prev + drawn, def.decimals);
    else last = roundTo(prev + drawn / 100, def.decimals);

    const base = { symbol: def.symbol, label: def.label, group: def.group, unit: def.unit, basis: def.basis };

    if (index === staleIndex) {
      // The engine calls a row stale when its print predates the last US
      // close, so the stale row's timestamp is placed before it.
      return { ...base, last: prev, prev_close: prev, move: null, state: "stale" as const, as_of: iso(clock.sinceMs - 14 * HOUR_MS) };
    }

    const move = moveIn(def.unit, last, prev);
    if (def.group === "asia") {
      const closedAt = targetDayMs + (def.closeUtcMinutes ?? 7 * 60) * MINUTE_MS;
      return { ...base, last, prev_close: prev, move, state: "final" as const, as_of: iso(closedAt) };
    }
    // Index levels reach the provider about a quarter of an hour late; futures
    // and the macro contracts print almost as they trade.
    const lagMs = def.group === "europe" ? 15 * MINUTE_MS : MINUTE_MS;
    return { ...base, last, prev_close: prev, move, state: "live" as const, as_of: iso(clock.generatedMs - lagMs) };
  });
}

function buildCoverage(rand: () => number, holdings: BriefingHolding[]): Map<string, HeldCoverage> {
  const coverage = new Map<string, HeldCoverage>();
  for (const h of holdings) coverage.set(h.symbol, isFund(h.symbol) ? "price_only" : "tracked");

  // Now and then the most recent company is "pending", the state a name is in
  // for the first hours after it joins the book. Only with a few companies
  // held, so a small book does not lose its only source of headlines.
  const companies = holdings.filter((h) => !isFund(h.symbol));
  if (companies.length >= 3 && rand() < 0.3) coverage.set(companies[companies.length - 1].symbol, "pending");
  return coverage;
}

/**
 * The two held names the night is about. The lead carries the top-band
 * headline and the move well outside its range; the reporter filed results
 * after the close and moved on them. Both are tracked companies (a fund has no
 * news quota and no filings in the real report, and a pending name is not
 * followed yet), drawn apart when the book allows, so a presentation gets two
 * name stories of different shapes. A one-company book puts both on the one
 * name, which is the most ordinary morning there is: results, a headline
 * about them, and the move.
 */
type Cast = {
  lead: string | null;
  reporter: string | null;
  /** When the results 8-K landed, UTC ms; null without a reporter. */
  resultsAtMs: number | null;
};

function castOf(rand: () => number, holdings: BriefingHolding[], coverage: Map<string, HeldCoverage>, clock: Clock): Cast {
  const tracked = holdings.map((h) => h.symbol).filter((s) => coverage.get(s) === "tracked");
  if (tracked.length === 0) return { lead: null, reporter: null, resultsAtMs: null };
  const lead = pickOne(rand, tracked);
  const others = tracked.filter((s) => s !== lead);
  const reporter = others.length > 0 ? pickOne(rand, others) : lead;
  // Results land in the hour or so after the close, as an 8-K item 2.02 does;
  // capped at the report's stamp for a window too short to hold that hour.
  const resultsAtMs = Math.min(clock.sinceMs + intBetween(rand, 5, 75) * MINUTE_MS, clock.generatedMs);
  return { lead, reporter, resultsAtMs };
}

type Priced = {
  holding: BriefingHolding;
  last: number;
  ref: number;
  /** Unrounded, so the book's sums do not compound rounding. */
  movePct: number;
  pnlUsd: number;
  volPct: number;
  /** Beta to the S&P contract: what the conclusions take out of a move before calling the rest the name's own. */
  beta: number;
};

/** A move that is the name's own, either way, sized in its daily volatility. */
function ownMove(rand: () => number, volPct: number, range: MoveRange): number {
  return (rand() < 0.5 ? -1 : 1) * volPct * (range.min + rand() * range.span);
}

function priceHoldings(rand: () => number, holdings: BriefingHolding[], markets: MarketRow[], cast: Cast): Priced[] {
  const marketMove = (symbol: string): number => markets.find((r) => r.symbol === symbol)?.move ?? 0;
  const broad = marketMove("ES=F");

  return holdings.map((holding) => {
    const fund = isFund(holding.symbol);
    const volPct = DEMO_DAILY_VOL_PCT[holding.symbol] ?? (fund ? DEFAULT_FUND_VOL_PCT : DEFAULT_COMPANY_VOL_PCT);
    const beta = DEMO_BETA[holding.symbol] ?? (fund ? DEFAULT_FUND_BETA : DEFAULT_COMPANY_BETA);
    const ref = roundTo(referencePrice(holding) * (1 + (rand() - 0.5) * 0.04), 2);

    // A pre-market move is a fraction of a full day's: most of the volume, and
    // so most of the range, is still to come. The market part of the draw is
    // the name's own beta, so the residual a conclusion calls the name's own is
    // the idiosyncratic term below and nothing else.
    const follows = DEMO_FUND_FOLLOWS[holding.symbol];
    let drawn: number;
    if (follows) drawn = marketMove(follows.symbol) * follows.factor + (rand() - 0.5) * 0.1;
    else if (fund) drawn = beta * broad + (rand() - 0.5) * 0.6 * volPct;
    else drawn = beta * broad + (rand() - 0.5) * 1.1 * volPct;
    // The two names the night is about move apart from the market: the lead
    // well outside its range, the reporter on its results. Neither draw has a
    // market part, so the conclusions find a move the index does not explain
    // and the story under it says so. Never a fund: those follow their index.
    if (holding.symbol === cast.lead) drawn = ownMove(rand, volPct, LEAD_MOVE_VOLS);
    else if (holding.symbol === cast.reporter) drawn = ownMove(rand, volPct, RESULTS_MOVE_VOLS);

    const last = roundTo(ref * (1 + drawn / 100), 2);
    return { holding, last, ref, movePct: (last / ref - 1) * 100, pnlUsd: holding.shares * (last - ref), volPct, beta };
  });
}

function buildMovers(priced: Priced[], coverage: Map<string, HeldCoverage>, asOf: string): HeldMover[] {
  const movers = priced.map((p): HeldMover => {
    // A pending name has no history behind it yet, so the three figures that
    // are read off one go together: the multiple, the yardstick it is measured
    // in, and the beta a conclusion would take out of the move.
    const pending = coverage.get(p.holding.symbol) === "pending";
    return {
      ticker: p.holding.symbol,
      last: p.last,
      ref_close: p.ref,
      move_pct: roundTo(p.movePct, 2),
      move_z: pending ? null : roundTo(p.movePct / p.volPct, 2),
      pnl_usd: roundTo(p.pnlUsd, 2),
      basis: "since_close",
      session: "pre",
      as_of: asOf,
      flag: null,
      beta: pending ? null : p.beta,
      daily_vol_pct: pending ? null : roundTo(p.volPct, 2),
    };
  });
  // The engine's order: largest move first, ties by name.
  return movers.sort(
    (a, b) => Math.abs(b.move_pct) - Math.abs(a.move_pct) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0),
  );
}

/** The engine's book arithmetic (`briefing/book.ts`), over the demo prices. */
function buildBook(priced: Priced[], cash: number, pricedAt: string): BriefingBook {
  const cashUsd = Number.isFinite(cash) ? cash : 0;
  let signedSum = 0;
  let invested = 0;
  let pnl = 0;
  for (const p of priced) {
    const value = p.holding.shares * p.last;
    signedSum += value;
    invested += Math.abs(value);
    pnl += p.pnlUsd;
  }
  const equity = cashUsd + signedSum;
  const exposure = (amount: number): number => (equity > 0 ? roundTo((amount / equity) * 100, 2) : 0);
  const equityBefore = equity - pnl;
  const pnlKnown = priced.length > 0;

  const topWeights = priced
    .map((p) => ({ ticker: p.holding.symbol, shares: p.holding.shares, value: Math.abs(p.holding.shares * p.last) }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))
    .slice(0, TOP_WEIGHTS)
    .map((p) => ({
      ticker: p.ticker,
      weight: roundTo(p.value / invested, 4),
      side: p.shares > 0 ? ("long" as const) : ("short" as const),
    }));

  return {
    position_count: priced.length,
    equity_usd: roundTo(equity, 2),
    cash_usd: roundTo(cashUsd, 2),
    invested_usd: roundTo(invested, 2),
    net_exposure_pct: exposure(signedSum),
    gross_exposure_pct: exposure(invested),
    overnight_pnl_usd: pnlKnown ? roundTo(pnl, 2) : null,
    overnight_pnl_pct: pnlKnown && equityBefore > 0 ? roundTo((pnl / equityBefore) * 100, 2) : null,
    top_weights: topWeights,
    unpriced: [],
    priced_at: pricedAt,
  };
}

function buildNews(
  rand: () => number,
  holdings: BriefingHolding[],
  coverage: Map<string, HeldCoverage>,
  cast: Cast,
  movers: HeldMover[],
  clock: Clock,
): HeldNewsItem[] {
  // Only tracked names have a news quota; a headline on a price-only fund
  // would show something the real report can never show.
  const tracked = holdings.map((h) => h.symbol).filter((s) => coverage.get(s) === "tracked");
  const moveOf = (ticker: string): number => movers.find((m) => m.ticker === ticker)?.move_pct ?? 0;
  const item = (ticker: string, fields: Pick<HeldNewsItem, "also" | "headline" | "tags" | "band" | "published_at">): HeldNewsItem => ({
    ticker,
    ...fields,
    source: pickOne(rand, DEMO_NEWS_SOURCES),
    // example.com is reserved for documentation, so a click lands nowhere real.
    url: `https://example.com/falcon-demo/news/${ticker.toLowerCase()}`,
    incident_id: `demo-incident-${ticker}`,
  });

  const items: HeldNewsItem[] = [];
  if (cast.lead !== null) {
    const entry = DEMO_LEAD_HEADLINES[cast.lead];
    // The wording follows the way the name moved (see DEMO_LEAD_HEADLINES).
    const down = moveOf(cast.lead) < 0;
    items.push(
      item(cast.lead, {
        also: [],
        headline: entry ? (down ? entry.down : entry.up) : `${cast.lead} ${down ? "lowers" : "raises"} its outlook in an early update`,
        tags: entry ? [...entry.tags] : ["guidance"],
        band: "P0",
        published_at: minuteIso(overnightMs(rand, clock)),
      }),
    );
  }
  if (cast.reporter !== null && cast.reporter !== cast.lead && cast.resultsAtMs !== null) {
    // Published minutes after the 8-K (see buildFilings), so the two agree on when.
    items.push(
      item(cast.reporter, {
        also: [],
        headline: `${cast.reporter} reports quarterly results after the close`,
        tags: ["earnings"],
        band: "P1",
        published_at: minuteIso(Math.min(cast.resultsAtMs + intBetween(rand, 2, 12) * MINUTE_MS, clock.generatedMs)),
      }),
    );
  }

  // The rest of the tape on held names: mild items, the kind a quiet night
  // has, in the two bands that lead no story on their own.
  const rest = tracked.filter((s) => s !== cast.lead && s !== cast.reporter);
  const bands: BriefingPriorityBand[] = ["P2", "P3"];
  for (const ticker of pickSome(rand, rest, Math.min(rest.length, intBetween(rand, 0, 2)))) {
    const entry = DEMO_HEADLINES[ticker] ?? {
      headline: `${ticker} features in a sector roundup after peer results`,
      tags: ["sector"],
      also: [],
    };
    items.push(
      item(ticker, {
        // The chain only attaches an article to names it follows.
        also: entry.also.filter((s) => s !== ticker && coverage.get(s) === "tracked"),
        headline: entry.headline,
        tags: [...entry.tags],
        band: pickOne(rand, bands),
        published_at: minuteIso(overnightMs(rand, clock)),
      }),
    );
  }

  // Heaviest band first, then newest; the name settles two items stamped in the same minute.
  return items.sort((a, b) => {
    if (a.band !== b.band) return a.band < b.band ? -1 : 1;
    if (a.published_at !== b.published_at) return a.published_at > b.published_at ? -1 : 1;
    return a.ticker < b.ticker ? -1 : 1;
  });
}

function buildFilings(rand: () => number, companies: string[], coverage: Map<string, HeldCoverage>, cast: Cast, clock: Clock): HeldFiling[] {
  const filing = (ticker: string, kind: HeldFiling["kind"], label: string, filedMs: number): HeldFiling => ({
    ticker,
    kind,
    label,
    filed_at: minuteIso(filedMs),
    url: `https://example.com/falcon-demo/filing/${ticker.toLowerCase()}`,
  });

  const out: HeldFiling[] = [];
  if (cast.reporter !== null && cast.resultsAtMs !== null) out.push(filing(cast.reporter, "filing", RESULTS_FILING_LABEL, cast.resultsAtMs));

  // One more filing on another name about half the time: an insider Form 4 or
  // a Regulation FD 8-K. Never on the lead, because an insider filing outranks
  // a headline in the engine's wording of what happened, and the lead's night
  // is its headline. Never on a pending name, which the chain does not follow.
  const rest = companies.filter((s) => s !== cast.lead && s !== cast.reporter && coverage.get(s) !== "pending");
  if (rest.length > 0 && rand() < 0.5) {
    const ticker = pickOne(rand, rest);
    const insider = rand() < 0.5;
    out.push(filing(ticker, insider ? "insider" : "filing", insider ? INSIDER_FILING_LABEL : FD_FILING_LABEL, overnightMs(rand, clock)));
  }
  // Newest first, as the chain lists them.
  return out.sort((a, b) => (a.filed_at > b.filed_at ? -1 : a.filed_at < b.filed_at ? 1 : a.ticker < b.ticker ? -1 : 1));
}

function buildMeasurements(
  rand: () => number,
  movers: HeldMover[],
  news: HeldNewsItem[],
  asOf: string,
): HeldMeasurement[] {
  const out: HeldMeasurement[] = [];
  const head = movers[0];
  if (!head) return out;

  // What the largest move is called depends on the news list beside it: a
  // big move with a headline is a gap, the same move with none is unexplained.
  // Calling it unexplained under its own headline would contradict the panel.
  const hasHeadline = news.some((n) => n.ticker === head.ticker || n.also.includes(head.ticker));
  if (!hasHeadline && head.move_z !== null && Math.abs(head.move_z) >= 1.5) {
    out.push({
      ticker: head.ticker,
      type: "unexplained_move",
      detail: `Moved ${Math.abs(head.move_z).toFixed(2)} daily standard deviations with no headline on the name.`,
      at: asOf,
    });
  } else {
    out.push({
      ticker: head.ticker,
      type: "gap_event",
      detail: `Indicated ${Math.abs(head.move_pct).toFixed(2)}% ${head.move_pct < 0 ? "below" : "above"} the prior close in pre-market trading.`,
      at: asOf,
    });
  }

  if (movers.length > 2 && rand() < 0.6) {
    const busy = movers[intBetween(rand, 1, movers.length - 1)];
    out.push({
      ticker: busy.ticker,
      type: "volume_anomaly",
      detail: `Pre-market volume is running ${(2 + rand() * 3).toFixed(1)}x its 30-day average.`,
      at: asOf,
    });
  }
  return out;
}

/** The quarter a company reporting around `ymd` is reporting on: the one before the current. */
function fiscalPeriod(ymd: string): string {
  const year = Number(ymd.slice(0, 4));
  const quarter = Math.ceil(Number(ymd.slice(5, 7)) / 3);
  return quarter === 1 ? `Q4 ${year - 1}` : `Q${quarter - 1} ${year}`;
}

function buildEarnings(rand: () => number, companies: string[], clock: Clock): HeldEarnings[] {
  const chosen = pickSome(rand, companies, Math.min(companies.length, intBetween(rand, 1, 2)));
  const period = fiscalPeriod(clock.targetYmd);

  const out = chosen.map((ticker, index): HeldEarnings => {
    // With two dates, the near one is confirmed and can fall on the target day
    // (so "earnings today" shows up on the calendar); the far one is a
    // provider projection. A single date is always a projection, which is what
    // guarantees every demo with a company in it shows an "estimated" item.
    const confirmed = chosen.length === 2 && index === 0;
    const sessions = confirmed ? intBetween(rand, 0, 2) : chosen.length === 2 ? intBetween(rand, 3, 9) : intBetween(rand, 1, 6);
    return {
      ticker,
      due_ymd: stepWeekdays(clock.targetYmd, sessions),
      timing: confirmed && rand() < 0.5 ? "bmo" : "amc_or_unspecified",
      sessions_until: sessions,
      fiscal_period: period,
      confirmed,
      source: confirmed ? "tracker" : "yahoo",
    };
  });
  return out.sort((a, b) => a.sessions_until - b.sessions_until || (a.ticker < b.ticker ? -1 : 1));
}

function buildCorporateEvents(
  rand: () => number,
  holdings: BriefingHolding[],
  earnings: HeldEarnings[],
  clock: Clock,
): CorporateEvent[] {
  const events: CorporateEvent[] = [];
  const held = new Set(holdings.map((h) => h.symbol));

  const payers = holdings.map((h) => h.symbol).filter((s) => s in DEMO_DIVIDENDS);
  payers.forEach((ticker, index) => {
    // The first payer always gets a date so a book that holds one never shows
    // an empty dividend list; the rest are a coin flip, as not every payer
    // goes ex-dividend inside any given fortnight.
    if (index > 0 && rand() < 0.4) return;
    const sessions = intBetween(rand, 1, 12);
    const date = stepWeekdays(clock.targetYmd, sessions);
    const amount = DEMO_DIVIDENDS[ticker].toFixed(2);
    // Near dates have been declared; far ones are the provider extending the
    // company's usual schedule, which is how the real feed behaves.
    const declared = sessions <= 6;
    events.push({
      id: `demo-dividend-${ticker}-${date}`,
      kind: "dividend",
      date,
      sessions_until: sessions,
      ticker,
      index: null,
      title: `${ticker} ex-dividend date`,
      detail: declared
        ? `$${amount} per share. Shares held before this date carry the payment.`
        : `$${amount} per share, date projected by the data provider. The company has not declared it yet.`,
      affects_held: [ticker],
      certainty: declared ? "confirmed" : "estimated",
      source: "yahoo_calendar",
    });
  });

  for (const family of DEMO_INDEX_FUNDS) {
    const funds = family.funds.filter((f) => held.has(f));
    if (funds.length === 0) continue;
    // Index changes take effect after a Friday close, so the date is a Friday:
    // this week's, or one or two weeks out.
    const date = addDays(fridayOnOrAfter(clock.targetYmd), 7 * intBetween(rand, 0, 2));
    events.push({
      id: `demo-rebalance-${family.family}-${date}`,
      kind: "rebalance",
      date,
      sessions_until: weekdaysBetween(clock.targetYmd, date),
      ticker: null,
      index: family.family,
      title: family.title,
      detail: `${family.lead} Held funds tracking it: ${funds.join(", ")}.`,
      affects_held: funds,
      certainty: family.certainty,
      source: family.source,
    });
  }

  for (const e of earnings) {
    const period = e.fiscal_period ?? "Quarterly";
    events.push({
      id: `demo-earnings-${e.ticker}-${e.due_ymd}`,
      kind: "earnings",
      date: e.due_ymd,
      sessions_until: e.sessions_until,
      ticker: e.ticker,
      index: null,
      title: `${e.ticker} earnings report`,
      detail: e.confirmed
        ? `${period} results ${earningsTimingWords(e)}. Date confirmed by the company.`
        : `${period} results, hour not announced. Date projected by the data provider and not confirmed by the company.`,
      affects_held: [e.ticker],
      certainty: e.confirmed ? "confirmed" : "estimated",
      source: e.confirmed ? "tracker" : "yahoo_calendar",
    });
  }

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * The book's beta, the way `risk/components.ts` computes it: the weights over
 * invested value, signed by side, times each name's own beta. Drawn at random
 * it was always positive, and a book that is net borrowed moves against the
 * index, so every conclusion sized on it came out the wrong way round.
 */
function bookBeta(priced: Priced[], invested: number): number {
  if (!(invested > 0)) return 0;
  let sum = 0;
  for (const p of priced) sum += ((p.holding.shares * p.last) / invested) * p.beta;
  return sum;
}

function buildRisk(rand: () => number, priced: Priced[], book: BriefingBook, computedAt: string): BriefingRisk {
  const top = book.top_weights[0];
  if (!top) {
    // An empty book has nothing to score; the snapshot still "matches", since
    // it describes the same (empty) set of names.
    return {
      score: null,
      band: null,
      driver_component: null,
      driver_sentence: null,
      beta_eff: null,
      beta_port: null,
      port_vol_daily_pct: null,
      computed_at: computedAt,
      matches_book: true,
    };
  }

  // Built from the book's own concentration so the score, the band and the
  // sentence describe the weights shown beside them and not three random draws.
  const score = Math.max(5, Math.min(95, Math.round(22 + top.weight * 110 + (rand() - 0.5) * 12)));
  // The Risk engine's default band edges (30 / 55 / 75).
  const band = score >= 75 ? "high" : score >= 55 ? "elevated" : score >= 30 ? "moderate" : "low";
  const betaPort = bookBeta(priced, book.invested_usd);
  return {
    score,
    band,
    driver_component: "concentration",
    driver_sentence: `${Math.round(top.weight * 100)}% of the portfolio sits in ${top.ticker}.`,
    // The engine's own definition: the size of the book beta, times the share
    // of equity that is invested. It carries no sign; `beta_port` holds that.
    beta_eff: roundTo(Math.abs(betaPort) * (book.gross_exposure_pct / 100), 2),
    beta_port: roundTo(betaPort, 2),
    port_vol_daily_pct: roundTo(0.8 + rand() * 1.4, 2),
    computed_at: computedAt,
    matches_book: true,
  };
}

function buildCalendar(
  rand: () => number,
  window: BriefingWindow,
  clock: Clock,
  earnings: HeldEarnings[],
  events: CorporateEvent[],
): CalendarItem[] {
  const items: CalendarItem[] = [];
  const priorMonth = addDays(`${clock.targetYmd.slice(0, 7)}-01`, -1).slice(0, 7);

  // Session items are the exceptions only, worded as the engine words them. An
  // ordinary session gets no line in the real report, so it gets none here: a
  // "Regular session" row on stage would be a row no user ever sees.
  if (window.early_close) {
    items.push({
      id: "demo-session-early-close",
      kind: "session",
      time_et: null,
      at: null,
      title: "Early close at 13:00 ET",
      detail: "US equities close at 13:00 ET this session.",
      importance: 2,
      tickers: [],
      source: "rule",
    });
  }
  if (window.handover === "holiday") {
    items.push({
      id: "demo-session-after-holiday",
      kind: "session",
      time_et: null,
      at: null,
      title: "First session after a US market holiday",
      detail: "Markets abroad traded while the US was closed.",
      importance: 1,
      tickers: [],
      source: "rule",
    });
  }

  // A decision day carries little else: the agencies keep the 08:30 slot
  // clear of first-tier releases, so the demo shows one or the other.
  if (rand() < 1 / 3) {
    items.push({
      id: "demo-fomc",
      kind: "fomc",
      time_et: "14:00",
      at: etInstant(clock, "14:00"),
      title: "FOMC rate decision",
      detail: "Statement at 14:00 ET, press conference at 14:30 ET.",
      importance: 3,
      tickers: [],
      source: "fed",
    });
  } else {
    for (const release of pickSome(rand, DEMO_RELEASES, intBetween(rand, 2, 4))) {
      items.push({
        id: `demo-data-${release.code}`,
        kind: "data",
        time_et: release.time,
        at: etInstant(clock, release.time),
        title: release.title,
        // The period is numeric on purpose: one month's name is also a modal
        // verb the copy rules ban, and a "2026-05" never trips them.
        detail: release.weekly ? "Covers the prior week." : `Covers ${priorMonth}.`,
        importance: release.importance,
        tickers: [],
        source: release.source,
      });
    }
  }

  if (rand() < 0.25) {
    items.push({
      id: "demo-opex",
      kind: "opex",
      time_et: null,
      at: null,
      title: "Monthly options expiry",
      detail: "Standard monthly equity and index options expire at the close.",
      importance: 2,
      tickers: [],
      source: "rule",
    });
  }

  for (const e of earnings) {
    if (e.sessions_until !== 0) continue;
    const timing = earningsTimingWords(e);
    items.push({
      id: `demo-earnings-${e.ticker}`,
      kind: "earnings",
      time_et: null,
      at: null,
      title: `${e.ticker} earnings report`,
      detail: `${timing.charAt(0).toUpperCase()}${timing.slice(1)}.`,
      // A held name reporting is about this book, so the engine ranks it with
      // the first-tier releases.
      importance: 3,
      tickers: [e.ticker],
      source: e.source,
    });
  }

  for (const event of events) {
    if (event.kind !== "rebalance" || event.sessions_until !== 0) continue;
    // All-day, as in the engine: the change lands after the close, and a row
    // timed at 16:00 would sit under the "now" line as if it were a release.
    items.push({
      id: `demo-rebalance-${event.index ?? "index"}`,
      kind: "rebalance",
      time_et: null,
      at: null,
      title: event.title,
      detail: event.detail,
      importance: 2,
      tickers: [...event.affects_held],
      source: event.source,
    });
  }

  // All-day items lead, then the clock; within one slot the heavier item first.
  return items.sort((a, b) => {
    if (a.time_et === null || b.time_et === null) {
      if (a.time_et !== b.time_et) return a.time_et === null ? -1 : 1;
    } else if (a.time_et !== b.time_et) {
      return a.time_et < b.time_et ? -1 : 1;
    }
    return b.importance - a.importance || (a.id < b.id ? -1 : 1);
  });
}

function buildCalendarCoverage(rand: () => number, clock: Clock): CalendarCoverage {
  // Anchored to the target instead of to a fixed year, so the demo never
  // shows the "calendar is running out" state merely because it is December.
  const until = addDays(clock.targetYmd, intBetween(rand, 90, 210));
  return {
    from: addDays(clock.targetYmd, -intBetween(rand, 150, 240)),
    until,
    // A calendar date, as in the engine: the curated file records the day it
    // was compiled, not an instant.
    compiled_at: addDays(clock.targetYmd, -intBetween(rand, 5, 30)),
    covers_target: true,
    days_left: Math.round((ymdToMs(until) - ymdToMs(clock.targetYmd)) / DAY_MS),
  };
}

function buildHeadlines(rand: () => number, markets: MarketRow[], clock: Clock): MarketHeadline[] {
  const moveOf = (symbol: string): number | null => markets.find((r) => r.symbol === symbol)?.move ?? null;
  // A headline that claims a direction is offered only when the row it reads
  // moved at all; beside a flat or withheld row it would make a claim the
  // table does not.
  const candidates = DEMO_MARKET_HEADLINES.filter((h) => h.symbol === null || (moveOf(h.symbol) ?? 0) !== 0);
  const chosen = pickSome(rand, candidates, Math.min(candidates.length, intBetween(rand, MIN_MARKET_HEADLINES, MAX_MARKET_HEADLINES)));

  const items = chosen.map((h): MarketHeadline => {
    const move = h.symbol === null ? null : moveOf(h.symbol);
    return {
      id: `demo-headline-${h.slug}`,
      title: move !== null && move < 0 ? h.down : h.up,
      source: pickOne(rand, DEMO_NEWS_SOURCES),
      // example.com is reserved for documentation, so a click lands nowhere real.
      url: `https://example.com/falcon-demo/market/${h.slug}`,
      published_at: minuteIso(overnightMs(rand, clock)),
      related: [...h.related],
      via: h.via,
    };
  });
  // Newest first, as the report lists them; the id settles a shared minute.
  return items.sort((a, b) => (a.published_at > b.published_at ? -1 : a.published_at < b.published_at ? 1 : a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The lead: the engine's template, assembled the same way
//
// `templateNarrative` in the engine's narrative.ts is the lead a real report
// carries whenever the model cannot be used, and a demo book never calls the
// model. That module is Node-only, so the assembly is repeated here rule for
// rule: the first story (or the open indication, or the market list), then
// the calendar, at most two sentences and 55 words.
// ---------------------------------------------------------------------------

/** The lead's limits: the engine's validator holds a model lead to them and its template keeps under them. */
const MAX_LEAD_WORDS = 55;
/** A story sentence longer than this leaves no room for the calendar beside it. */
const MAX_LEAD_STORY_WORDS = 40;
const MAX_LEAD_CALENDAR_ITEMS = 3;
/** The engine's facts carry at most this many calendar items for the lead to choose from. */
const MAX_LEAD_CALENDAR_POOL = 4;

const HANDOVER_OPENER: Record<BriefingHandover, string> = {
  overnight: "Overnight markets show",
  weekend: "After the weekend, markets show",
  holiday: "After the holiday break, markets show",
};

const UNIT_SUFFIX: Record<MarketUnit, string> = { pct: "%", bp: " bp", pts: " pts" };

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "up 0.4%", "down 6 bp", "flat": one decimal, as the engine's prose prints a table row. */
function moveWords(move: number, unit: MarketUnit): string {
  const size = Number(Math.abs(move).toFixed(1));
  if (size === 0) return "flat";
  return `${move > 0 ? "up" : "down"} ${size}${UNIT_SUFFIX[unit]}`;
}

/**
 * The first story as one sentence: the event, then the reaction. A name story
 * whose reaction opens with the ticker is joined on it ("NVDA reported results
 * and is up 2.3% since the close"); anything else takes the reaction after a
 * colon. "Since the close" is said once, by whichever half says it first.
 */
function storyLead(first: Story | undefined): string | null {
  if (!first || first.what === "") return null;
  const what = first.what.replace(/[.!?]+$/, "").trim();
  let reaction = first.reaction.replace(/[.!?]+$/, "").trim();
  if (reaction === "") return `${what}.`;
  if (/since the close/i.test(what)) reaction = reaction.replace(" since the close", "");

  const ticker = first.tickers[0];
  const sentence =
    first.scope === "name" && ticker && reaction.startsWith(`${ticker} `)
      ? `${what} and ${reaction.slice(ticker.length + 1)}.`
      : `${what}: ${reaction}.`;
  return wordCount(sentence) > MAX_LEAD_STORY_WORDS ? null : sentence;
}

/** The table read aloud: the engine's lead rows that printed since the close. */
function marketsSentence(markets: MarketRow[], handover: BriefingHandover): string {
  const parts = leadMarketRows(markets).flatMap((row) => (row.move === null ? [] : [`${row.label} ${moveWords(row.move, row.unit)}`]));
  if (parts.length > 0) return `${HANDOVER_OPENER[handover]} ${listOf(parts)}.`;
  if (markets.every((row) => row.state === "unavailable")) return "The overnight market feed is unavailable, so index moves are not listed.";
  return "The lead indices have no fresh print since the last US close.";
}

/** What the engine's facts carry of the calendar: the items the lead may name, in the order of the day. */
function leadCalendar(calendar: CalendarItem[]): CalendarItem[] {
  const timeKey = (item: CalendarItem): string => item.time_et ?? "";
  return calendar
    .filter((item) => item.importance >= 2 && item.kind !== "earnings" && item.kind !== "session")
    .sort((a, b) => b.importance - a.importance || timeKey(a).localeCompare(timeKey(b)) || a.id.localeCompare(b.id))
    .slice(0, MAX_LEAD_CALENDAR_POOL)
    .sort((a, b) => timeKey(a).localeCompare(timeKey(b)) || a.id.localeCompare(b.id));
}

function calendarSentence(calendar: CalendarItem[], earnings: HeldEarnings[], earlyClose: boolean, maxItems: number): string {
  const items: Array<{ text: string; importance: number }> = [];
  const reporting = earnings
    .filter((e) => e.sessions_until === 0)
    .map((e) => e.ticker)
    .sort();
  if (reporting.length > 0) {
    const named = reporting.slice(0, 3);
    const rest = reporting.length - named.length;
    const names = listOf(rest > 0 ? [...named, `${rest} more held ${rest === 1 ? "name" : "names"}`] : named);
    // A held name reporting is about this book, so it ranks with the top releases.
    items.push({ text: `earnings from ${names}`, importance: 3 });
  }
  // The engine skips a title that breaks the copy rules. The titles here are
  // the demo's own, and its test holds every one of them to the rules.
  for (const item of leadCalendar(calendar)) {
    items.push({ text: item.time_et ? `${item.title} at ${item.time_et} ET` : item.title, importance: item.importance });
  }
  // Chosen by importance, then read out in the order they were given (the
  // order of the day).
  const chosen = new Set([...items].sort((a, b) => b.importance - a.importance).slice(0, maxItems));
  const listed = listOf(items.filter((item) => chosen.has(item)).map((item) => item.text));

  // The engine's "calendar file has run out" branch is not here: the demo's
  // coverage always reaches past its target (see buildCalendarCoverage).
  if (earlyClose) {
    return listed
      ? `This session closes early at 13:00 ET, and its calendar has ${listed}.`
      : "This session closes early at 13:00 ET, with nothing else scheduled in the calendar file.";
  }
  return listed ? `This session's calendar has ${listed}.` : "Nothing is scheduled in the calendar file for this session.";
}

type LeadInput = {
  stories: Story[];
  implications: Implication[];
  markets: MarketRow[];
  calendar: CalendarItem[];
  earnings: HeldEarnings[];
  window: BriefingWindow;
};

function buildLead(input: LeadInput, generatedAt: string, hash: string): BriefingNarrative {
  // The first story, or the open indication when there is no story to tell,
  // or the plain market list when there is neither. The market list is last
  // because it is the table read aloud, which is what the stories replace.
  const open = input.implications.find((i) => i.kind === "open_indication" && i.headline.length > 0);
  const first = storyLead(input.stories[0]) ?? open?.headline ?? marketsSentence(input.markets, input.window.handover);
  const calendar = (maxItems: number): string => calendarSentence(input.calendar, input.earnings, input.window.early_close, maxItems);

  // Held under the word limit by shortening the calendar to its top item and
  // then giving it up; the first sentence always stays.
  let sentences = [first, calendar(MAX_LEAD_CALENDAR_ITEMS)];
  if (wordCount(sentences.join(" ")) > MAX_LEAD_WORDS) sentences = [first, calendar(1)];
  if (wordCount(sentences.join(" ")) > MAX_LEAD_WORDS) sentences = [first];

  return {
    text: sentences.join(" "),
    source: "template",
    model: null,
    generated_at: generatedAt,
    facts_hash: hash,
    pending: false,
    reason: "Demo book: no model is called.",
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function buildDemoBriefing(
  rand: () => number,
  window: BriefingWindow,
  positions: BriefingHolding[],
  cash: number,
): BriefingReport {
  const clock = resolveClock(window);
  const generatedAt = iso(clock.generatedMs);
  const quotesAsOf = iso(clock.generatedMs - 2 * MINUTE_MS);
  const holdings = mergeHoldings(positions);
  const companies = holdings.map((h) => h.symbol).filter((s) => !isFund(s));

  // One shared lean for the whole morning, so futures, Europe and the held
  // names mostly point the same way, as they do on a real day.
  const tone = (rand() - 0.5) * 2;

  const markets = buildMarkets(rand, clock, tone);
  const coverage = buildCoverage(rand, holdings);
  const cast = castOf(rand, holdings, coverage, clock);
  const priced = priceHoldings(rand, holdings, markets, cast);
  const movers = buildMovers(priced, coverage, quotesAsOf);
  const book = buildBook(priced, cash, generatedAt);
  const news = buildNews(rand, holdings, coverage, cast, movers, clock);
  const filings = buildFilings(rand, companies, coverage, cast, clock);
  const measurements = buildMeasurements(rand, movers, news, quotesAsOf);
  // The reporter has just reported, so it is not also due to report soon.
  const earnings = buildEarnings(rand, companies.filter((s) => s !== cast.reporter), clock);
  const events = buildCorporateEvents(rand, holdings, earnings, clock);
  const risk = buildRisk(rand, priced, book, iso(clock.generatedMs - 5 * MINUTE_MS));
  const calendar = buildCalendar(rand, window, clock, earnings, events);
  const calendarCoverage = buildCalendarCoverage(rand, clock);
  const headlines = buildHeadlines(rand, markets, clock);

  // Forced to the pre-open phase because that is the state the panel is
  // designed around, and never auto-shown: a demo report that opened itself
  // would pop up the moment presentation mode is switched on.
  const reportWindow: BriefingWindow = { ...window, phase: "pre_open", auto_show: false };
  const overnight = { markets, held_movers: movers, held_news: news, filings, measurements };
  const heldCoverage = holdings.map((h) => ({ ticker: h.symbol, coverage: coverage.get(h.symbol) ?? "pending" }));

  // What the figures above mean for this book, drawn by the engine's own rule
  // over the finished demo body, exactly as `gather.ts` draws them over a real
  // one. The positions are valued the way `buildBook` values them, so the
  // weights behind a conclusion add up to the invested figure printed beside
  // it. A failure here costs the conclusions and nothing else: the report is
  // still a report, it just leads with the narrative instead.
  const positionValues: ImplicationPosition[] = priced.map((p) => ({
    ticker: p.holding.symbol,
    market_value: p.holding.shares * p.last,
  }));
  let implications: Implication[] = [];
  try {
    implications = deriveImplications(
      {
        generated_at: generatedAt,
        window: reportWindow,
        overnight,
        held_coverage: heldCoverage,
        book,
        risk,
        earnings_next: earnings,
        corporate_events: events,
        calendar_today: calendar,
      },
      positionValues,
    );
  } catch {
    implications = [];
  }

  // What happened, told by the engine's own rule over the same body, so the
  // demo's stories are exactly the ones a real report would tell of these
  // figures. Guarded the same way as the conclusions: a throw costs the
  // stories, and the lead then falls back to the open indication.
  let stories: Story[] = [];
  try {
    stories = deriveStories({
      generated_at: generatedAt,
      window: reportWindow,
      overnight,
      held_coverage: heldCoverage,
      book,
      headlines,
      implications,
      calendar_today: calendar,
      earnings_next: earnings,
    });
  } catch {
    stories = [];
  }

  const hash = factsHash({
    target: clock.targetYmd,
    markets: markets.map((r) => [r.symbol, r.move]),
    movers: movers.map((m) => [m.ticker, m.move_pct]),
    pnl: book.overnight_pnl_pct,
    events: events.map((e) => e.id),
    calendar: calendar.map((c) => c.id),
    // A new headline, or a story appearing or going, is a new morning, as the
    // engine's own hash has it.
    headlines: headlines.map((h) => h.id),
    stories: stories.map((s) => s.id),
  });

  return {
    schema_version: DEMO_SCHEMA_VERSION,
    generated_at: generatedAt,
    demo: true,
    synthetic_now: false,
    window: reportWindow,
    overnight,
    held_coverage: heldCoverage,
    book,
    risk,
    earnings_next: earnings,
    corporate_events: events,
    corporate_coverage: {
      dividends:
        "Ex-dividend dates cover companies, declared or projected. Upcoming fund distributions are not available from the provider.",
      splits:
        "Splits are picked up from price history once they take effect. Upcoming splits are not available from the provider.",
      unknown_symbols: holdings.map((h) => h.symbol).filter(isFund),
    },
    calendar_today: calendar,
    calendar_coverage: calendarCoverage,
    headlines,
    stories,
    implications,
    narrative: buildLead({ stories, implications, markets, calendar, earnings, window: reportWindow }, generatedAt, hash),
    facts_hash: hash,
    degraded: [],
  };
}
