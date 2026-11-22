/**
 * Which tickers a Finnhub article is really about, and which headlines are
 * listicles or clickbait. Finnhub's /company-news returns any article that
 * merely mentions a ticker (SpaceX or Sam's Club stories under AMZN), so the
 * news sweeper (lib/news/store.ts) keeps a symbol only when the headline, or
 * the summary's first sentence, names the company or its ticker, and drops
 * listicle and teaser headlines outright. scripts/news-clean.ts applies the
 * same rules to rows already stored.
 *
 * Company names come from SEC company_tickers_exchange.json (kept by the
 * filings sweeper in public.filing_sweep_state.ciks). A symbol with no known
 * name is kept, so a missing map never empties the store.
 *
 * Pure; run by Node directly through store.ts, so type-only TypeScript.
 */

/** Words too generic to stand alone as a company's short name: the alias takes the next word too. */
const GENERIC = new Set(
  (
    "american america first general united international global national new bank banc bancorp energy capital health healthcare royal great " +
    "western eastern southern northern pacific atlantic central community citizens home life real digital advanced applied smart green blue " +
    "alpha beta golden gold silver star sun solar world power data net tech bio medical pharma total park union peoples federal mid north south " +
    "east west enterprise liberty heritage pioneer summit vision focus premier prime select security standard strategic universal value " +
    "victory trust financial investors investment income realty properties property resources industries partners group holdings company " +
    "corporation the a an us usa china hong first-citizens commerce credit insurance mutual savings city county state metro texas florida " +
    "california ohio new-york carolina virginia old modern integrated innovative precision quantum next one two three four five can open " +
    "live core key bright clear true sound safe main best big high grand"
  ).split(" "),
);

/** Legal suffixes and share-class tails removed from a company name. */
const SUFFIX =
  /\b(incorporated|inc|corp|corporation|co|company|ltd|limited|plc|llc|lp|l\.p|n\.v|nv|s\.a|sa|se|ag|asa|ab|oyj|spa|s\.p\.a|holdings?|group|trust|reit|the|class [a-z]|com|de|cos|cl [a-z]|adr|ads)\b\.?/gi;

/** Lowercase name words, suffixes removed ("AMAZON COM INC" -> ["amazon"]). */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[,.()/'’]/g, " ")
    .replace(SUFFIX, " ")
    .split(/[\s-]+/)
    .filter((w) => w && w.length > 1 && w !== "and");
}

/** Short names to look for: the first word, or the first two when the first is generic, plus the full cleaned name. */
export function nameAliases(name: string): string[] {
  const words = nameWords(name);
  if (!words.length) return [];
  const out = new Set<string>();
  const first = words[0]!;
  // "AT&T", "S&P Global": the first token as written.
  const raw = name.trim().split(/\s+/)[0]!.toLowerCase().replace(/[,.]+$/, "");
  if (raw.includes("&") && raw.length >= 3) out.add(raw);
  if (!GENERIC.has(first) && first.length >= 3) out.add(first);
  else if (words.length >= 2) out.add(/^(of|for|de|la|du)$/.test(words[1]!) && words[2] ? `${first} ${words[1]} ${words[2]}` : `${first} ${words[1]}`);
  if (words.length >= 2) out.add(words.slice(0, Math.min(words.length, 3)).join(" "));
  return [...out];
}

/** Tickers that are ordinary uppercase words or acronyms: they count only as $T, (T), "NYSE: T" and the like. */
const AMBIGUOUS_TICKERS = new Set(
  "AI IT ON ALL ARE NOW CEO EV EVS USA US OPEN BIG CAN GO SO BE DO AN AT FOR ONE TWO NEW OLD CAR FUN LOVE HOME BUY SELL HOLD UP RUN WELL REAL KEY NICE FAST TRUE BEST SAFE GOOD PLAY LIFE MAIN CASH GDP IPO ETF SEC FDA FED AM PM OR AND THE TV PC VR AR ESG OK IQ HR PR ID USD EU UK".split(" "),
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first sentence of a summary (at most 400 characters). */
export function firstSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^(.{20,400}?[.!?])(\s+["“A-Z0-9]|$)/.exec(t);
  return (m ? m[1]! : t.slice(0, 400)).trim();
}

/** True when `text` names the company (one of its aliases) or its ticker. */
export function mentions(text: string, symbol: string, aliases: string[]): boolean {
  if (!text) return false;
  const base = symbol.toUpperCase();
  const forms = [...new Set([base, base.replace(".", "-"), base.replace(".", "")])].map(escape).join("|");
  // $TICKER, (TICKER), "Nasdaq: TICKER", "NYSE:TICKER" always count.
  if (new RegExp(`(\\$(${forms})\\b|\\((${forms})\\)|\\b(nasdaq|nyse|amex|nyse american|otc)\\s*:\\s*(${forms})\\b)`, "i").test(text)) return true;
  // A bare ticker counts when it is 3+ letters, written in capitals and not an ordinary word.
  if (base.replace(/\W/g, "").length >= 3 && !AMBIGUOUS_TICKERS.has(base) && new RegExp(`(^|[^A-Za-z0-9$])(${forms})(?![A-Za-z0-9])`).test(text)) return true;
  const lower = text.toLowerCase().replace(/[’']s\b/g, "");
  for (const a of aliases) {
    if (new RegExp(`(^|[^a-z0-9])${escape(a).replace(/ /g, "[\\s.,-]+")}(?![a-z0-9])`).test(lower)) return true;
  }
  return false;
}

/**
 * The symbols an article is mainly about: those named in the headline or the
 * summary's first sentence. Symbols with no known company name are kept.
 */
export function relevantSymbols(symbols: string[], headline: string, summary: string, names: Map<string, string>): string[] {
  const lead = firstSentence(summary);
  return symbols.filter((s) => {
    const name = names.get(s);
    if (!name) return true;
    const aliases = nameAliases(name);
    return mentions(headline, s, aliases) || mentions(lead, s, aliases);
  });
}

const NUM = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)";
const CLICKBAIT: RegExp[] = [
  // "5 Stocks to Buy in 2027", "3 Reasons to ...", "2 Top Growth Stocks ...", "10 Dividend Stocks ..."
  new RegExp(`^\\s*${NUM}\\s+(?:[\\w'’-]+\\s+){0,4}(stocks?|reasons?|things|etfs?|picks|ways|shares|companies|names|charts?|lessons|mistakes|signs|moves|questions|millionaire)\\b`, "i"),
  new RegExp(`^\\s*${NUM}\\s+(magnificent|unstoppable|brilliant|incredible|spectacular|no-brainer|monster|surefire|top|best|cheap|ultra|high-yield|dirt-cheap|beaten-down|phenomenal|genius|smart|stellar|explosive|elite|wonderful|safe)\\b`, "i"),
  /^\s*top\s+\d+\b/i,
  /\btop\s+\d+\s+(?:[\w'-]+\s+){0,2}(stocks?|picks|etfs?)\b/i,
  /^\s*should you (buy|sell|hold|invest|worry|be worried)\b/i,
  /^\s*(is|are)\b[^?]{0,80}\b(a|still a|now a)\s+(buy|sell|bargain|steal)\b/i,
  /^\s*(is|are)\b[^?]{0,80}\b(too late to buy|a smart buy|worth buying|a good buy)\b/i,
  /\b(buy|sell) (it )?(now|right now|today)\?\s*$/i,
  /^\s*(the )?best\b.{0,40}\bstocks?\b/i,
  /\bbest\s+(?:[\w-]+\s+){0,2}stocks?\s+to\b/i,
  /\bstocks?\s+to\s+(buy|sell|own|hold|avoid|watch)\b/i,
  /millionaire[- ]?maker|make you (a )?millionaire|could make you rich|turn \$[\d,]+ into/i,
  /^\s*prediction\s*:/i,
  /\b(no[- ]brainer|screaming buy|hand over fist|too late to buy|set to soar|could soar|could double|surefire|life-changing|generational (buy|opportunity)|buy and hold forever|forever stocks?)\b/i,
  /^\s*(here'?s|here is) why\b/i,
  /^\s*why\s+(?:[\w.'’&-]+\s+){1,4}(stock|shares)\s+(could|is|are|might)\s+(a|the|soar|double|be)\b/i,
  /\bwall street (thinks|says)\b.*\bcould\b/i,
  /^\s*(want|looking) (to|for)\b.*\?\s/i,
];

/** True for listicle, "should you buy" and teaser headlines. */
export function isClickbait(headline: string): boolean {
  const h = headline.replace(/\s+/g, " ").trim();
  return CLICKBAIT.some((r) => r.test(h));
}
