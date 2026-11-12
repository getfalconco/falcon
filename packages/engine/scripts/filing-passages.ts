/**
 * Research helper for growing the graph: prints the passages of a company's
 * latest annual report (10-K or 20-F) that name customers, suppliers,
 * foundries, distributors or competitors, so a link can be written down with
 * its exact quote. `build-graph` then checks every quote against the filing.
 *
 *   pnpm --filter @falcon/engine run filing-passages -- MCHP
 *   pnpm --filter @falcon/engine run filing-passages -- MCHP --grep "Microchip|Arrow"
 */

import { cikForTicker, recentFilings, documentText, type Filing } from "../src/sec.ts";
import { sentences } from "../src/text.ts";

const DEFAULT =
  /(\d+(\.\d+)?\s?%|percent) of (our )?(total |net |consolidated )?(net )?(revenue|sales)|accounted for|largest customer|significant customer|ten percent|10%|competitor|compete (with|against)|competition (from|with)|foundr|wafer|sole source|single source|sole supplier|single supplier|subcontract|assembly and test|distributor|contract manufactur|depend(s|ent)? (up)?on|rel(y|ies|iance) (up)?on/i;

export async function latestAnnual(ticker: string): Promise<Filing> {
  const cik = await cikForTicker(ticker);
  if (!cik) throw new Error(`no CIK for ${ticker}`);
  const filings = await recentFilings(cik);
  const annual = filings.find((f) => f.form === "10-K" || f.form === "20-F" || f.form === "40-F");
  if (!annual) throw new Error(`no 10-K or 20-F for ${ticker}`);
  return annual;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const ticker = args[0];
  if (!ticker) throw new Error("usage: filing-passages TICKER [--grep REGEX] [--max N]");
  const grepAt = args.indexOf("--grep");
  const maxAt = args.indexOf("--max");
  const re = grepAt >= 0 ? new RegExp(args[grepAt + 1]!, "i") : DEFAULT;
  const max = maxAt >= 0 ? Number(args[maxAt + 1]) : 400;
  const filing = await latestAnnual(ticker);
  const text = await documentText(filing.url);
  console.log(`# ${ticker} ${filing.form} filed ${filing.filedAt} ${filing.url} (${text.length} chars)`);
  let n = 0;
  const seen = new Set<string>();
  for (const s of sentences(text)) {
    if (s.length < 40 || s.length > 1200 || !re.test(s)) continue;
    if (/forward-looking statements|Private Securities Litigation/i.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    console.log(`- ${s}`);
    if (++n >= max) break;
  }
}

if (process.argv[1] && /filing-passages\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
