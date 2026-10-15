export const HERO = {
  eyebrow: "INSTITUTIONAL RESEARCH · FOR INDIVIDUAL TRADERS",
  headline: "See the market",
  mission:
    "Institutional-grade market research—built for individual traders, not billion-dollar desks.",
  description:
    "Understand a company the way a research team would, in a fraction of the time.",
} as const;

export const INSTITUTIONAL_GAP = {
  title: "The infrastructure gap",
  deskTitle: "What billion-dollar desks run",
  deskItems: [
    "Dedicated research analysts running multi-pass briefings",
    "Quant developers building signal pipelines and market context",
    "Data engineers ingesting filings, news, and live market feeds",
    "Knowledge graph teams mapping second-order relationships",
    "24/7 monitoring—not reactive reading when you have time",
  ],
  retailTitle: "What most traders rely on today",
  retailItems: [
    "Generic AI chat with no sources or evidence discipline",
    "Fragmented terminals, Twitter, and headline chasing",
    "Single-prompt stock picks with no relationship context",
    "No daily curated signal—only what you remember to ask",
    "Browser tabs instead of a native research workflow",
  ],
  closing: "Falcon closes that gap.",
} as const;

export const FALCON_STACK = {
  title: "Your personal quant research desk",
  subtitle:
    "The roles a fund staffs with million-dollar salaries—rebuilt as one service for you.",
  roles: [
    {
      role: "Senior research analyst",
      equivalent: "Multi-pass briefings with verified sources and follow-up Q&A",
    },
    {
      role: "Quant developer",
      equivalent: "Daily signal pipeline, ticker context, and trajectory analysis",
    },
    {
      role: "Data engineer",
      equivalent: "Live web search, SEC filings, and market data ingestion",
    },
    {
      role: "Knowledge graph team",
      equivalent: "Relationship mapping and second-order effect chains",
    },
  ],
} as const;

export const COMPARISON = {
  title: "Not a basic AI plan",
  subtitle: "You're not paying for chat tokens. You're buying an institutional research stack.",
  genericTitle: "Generic AI subscription",
  falconTitle: "Falcon",
  rows: [
    { label: "Research model", generic: "Single prompt, instant answer", falcon: "Multi-pass institutional pipeline" },
    { label: "Sources", generic: "Often none, or unverifiable", falcon: "VERIFIED · REPORTED · INFERRED discipline" },
    { label: "Daily workflow", generic: "Ask when you remember", falcon: "Curated top signal every session" },
    { label: "Market context", generic: "No live data or charts", falcon: "Ticker trajectories and quant context" },
    { label: "Relationships", generic: "No graph, no ripple effects", falcon: "Supply chain and second-order mapping" },
    { label: "Environment", generic: "Browser tab", falcon: "Native desktop research desk" },
  ],
} as const;

export type MarketingTestimonial = {
  text: string;
  highlight: string;
  name: string;
  country: string;
};

export const MARKETING_TESTIMONIALS: MarketingTestimonial[] = [
  {
    text: "Without Falcon I wouldn't have a morning briefing that rivals what fund analysts produce overnight.",
    highlight: "morning briefing",
    name: "James Chen",
    country: "Singapore",
  },
  {
    text: "Without Falcon I wouldn't be able to trace second-order effects across a supply chain in minutes.",
    highlight: "second-order effects",
    name: "Elena Rossi",
    country: "Italy",
  },
  {
    text: "Without Falcon I wouldn't be able to run institutional-grade diligence as a solo trader.",
    highlight: "institutional-grade diligence",
    name: "Marcus Webb",
    country: "United Kingdom",
  },
  {
    text: "Without Falcon I wouldn't be able to challenge my thesis with sourced evidence under pressure.",
    highlight: "sourced evidence",
    name: "Sarah Mitchell",
    country: "United States",
  },
];

export const AUTH_PANEL_LINES: MarketingTestimonial[] = [
  {
    text: "Falcon exists to bring billion-dollar desk infrastructure to individual traders.",
    highlight: "billion-dollar desk infrastructure",
    name: "Falcon",
    country: "Our mission",
  },
  {
    text: "Falcon isn't a chatbot wrapper. It's a research service with sources, signals, and a graph.",
    highlight: "research service",
    name: "Falcon",
    country: "Our mission",
  },
  {
    text: "Falcon gives one person at a desk the technology quant firms build in-house.",
    highlight: "technology quant firms build",
    name: "Falcon",
    country: "Our mission",
  },
];

export const HOME_CTA = {
  title: "Deploy your research desk",
  body: "Download Falcon for Mac or Windows—or join the waitlist for early access.",
} as const;

export const STORY = {
  hero: {
    title: "The infrastructure gap",
    subtitle:
      "Billion-dollar trading firms don't win with better instincts. They win with a research stack you were never meant to access.",
  },
  desk: {
    title: "What a serious desk actually runs",
    paragraphs: [
      "A large quant or multi-strategy fund doesn't run on a single AI prompt. It runs an organization: research analysts writing sourced briefings, quant developers maintaining signal pipelines, data engineers normalizing filings and market feeds, and teams mapping relationship graphs across sectors.",
      "That stack costs millions a year in salaries, data contracts, and internal tooling. It runs around the clock, not just when a trader remembers to open a chat window.",
    ],
    bullets: [
      "Multi-pass research with evidence tags",
      "Live market data and quant context",
      "Relationship graphs and ripple analysis",
      "Curated daily signals, not reactive queries",
    ],
  },
  rebuild: {
    title: "What Falcon rebuilds",
    paragraphs: [
      "Falcon is that same infrastructure, compressed into one native desktop app for individual traders and serious investors.",
      "You get a daily top signal with deep analysis, verified sources, ticker context, a relationship graph for second-order effects, and follow-up Q&A. Not a consumer AI plan. A research desk.",
    ],
  },
  different: {
    title: "How we're different from AI subscriptions",
    paragraphs: [
      "A $20/month AI plan gives you tokens and a text box. Falcon gives you a workflow: open the app, read today's signal, drill into sourced briefings, and follow up on real analysis—not a blank prompt.",
      "We built Falcon because advanced research technology shouldn't require a seven-figure salary or a seat at a fund.",
    ],
  },
  mission: {
    title: "Our responsibility",
    body: "Falcon's job is to make institutional-grade research accessible to individual investors, without dumbing it down and without pretending to be a trading bot. We provide intelligence for your judgment, not a replacement for it.",
  },
  cta: {
    title: "Start with your desk",
    body: "Download the app or join the waitlist. Research intelligence—not buy/sell advice.",
  },
} as const;

export const DOWNLOAD = {
  hero: {
    subtitle:
      "Run an institutional research stack locally—not a browser tab with ChatGPT.",
  },
  features: [
    {
      title: "Desk-speed execution",
      body: "Falcon runs as a native desktop app: fast and responsive, built for serious research sessions instead of another browser tab.",
    },
    {
      title: "Command your research",
      body: "search signals, tickers, briefings, and analysis from anywhere on your machine—like a quant desk command palette.",
    },
    {
      title: "Second-order intelligence",
      body: "Multi-pass analysis, relationship mapping, and follow-up Q&A show you how events ripple across companies, sectors, and supply chains.",
    },
  ],
  capabilityGrid: {
    title: "The stack, one app",
    subtitle: "What funds spread across teams and tools—unified in Falcon.",
    capabilities: [
      { label: "Daily signals", caption: "The morning meeting, automated" },
      { label: "Deep analysis", caption: "Multi-pass institutional briefings" },
      { label: "Ticker charts", caption: "Live context on every name" },
      { label: "Follow-up chat", caption: "Analyst Q&A on your briefing" },
      { label: "Relationship graph", caption: "Second-order ripple mapping" },
      { label: "SEC research", caption: "Filings and verified sources" },
      { label: "Workspace", caption: "Your persistent research desk" },
      { label: "Auto-updates", caption: "Always-current intelligence" },
    ],
  },
  install: {
    title: "Installation",
    subtitle: "Install your research desk in a few steps.",
  },
  testimonials: {
    title: "Built alongside our users",
    subtitle: "Serious traders who wanted desk-level research—not another AI toy.",
  },
} as const;

export const AUTH = {
  loginSubtitle: "Sign in or create an account",
  waitlist: {
    title: "You're on the waitlist",
    body: "We're not open to everyone yet. Access is going out slowly, to traders who want depth over noise.",
    approved:
      "Once you're approved, we'll let you know by email and phone, and walk you through setting up your desk.",
  },
} as const;

export const SEO = {
  title: "Falcon — Institutional market research for individual traders",
  description:
    "Institutional-grade market research for individual traders. Multi-pass analysis, daily signals, verified sources, and relationship mapping—not a basic AI subscription.",
  openGraphDescription:
    "Your personal quant research desk. Advanced technology, individual access.",
} as const;

export const NAV_RESOURCES = [
  { label: "The infrastructure gap", href: "/#gap", description: "Desk vs retail research stack" },
  { label: "Falcon vs generic AI", href: "/#comparison", description: "Service model comparison" },
  { label: "Our story", href: "/story", description: "Why we built Falcon" },
  { label: "Early access", href: "/login", description: "Join the waitlist" },
] as const;

export const FOOTER_PRODUCT_LINKS = [
  { label: "Features", href: "/#stack" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Story", href: "/story" },
  { label: "Early access", href: "/early-access" },
] as const;

export const FOOTER_LEGAL_LINKS = [
  { label: "Terms of Service", href: "/terms" },
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Usage Policy", href: "/terms#acceptable-use" },
] as const;

export const FOOTER = {
  tagline: "Institutional-grade market research for individual traders.",
  disclaimer: "Falcon provides research intelligence, not investment advice.",
  copyright: "© 2026 Falcon",
} as const;

export const HOW_IT_WORKS = {
  title: "How it works",
  subtitle: "What the product does—not who it replaces on a desk.",
  cards: [
    {
      title: "Relationship mapping",
      caption:
        "Map suppliers, customers, competitors, and dependencies across any company—like a knowledge graph team on call.",
    },
    {
      title: "Second-order effects",
      caption:
        "Trace how events ripple through supply chains and sectors, with evidence tagged VERIFIED, REPORTED, or INFERRED.",
    },
    {
      title: "Always on",
      caption:
        "A research pipeline running continuously—daily signals, refreshed briefings, and a desktop workflow that doesn't wait for you to ask.",
    },
  ],
} as const;

// The Privacy Policy and Terms of Service live in app/privacy/content.tsx and
// app/terms/content.tsx; the facts they depend on in lib/legal-config.ts.
