/**
 * Dev only: runs every Desk tool live once per ticker and prints a compact
 * view of each result with its time. Hits Yahoo and SEC for real; not part of
 * the test suite and never imported by the app. Output is not saved.
 *
 *   cd packages/engine && node --import tsx ../../apps/web/lib/desk/tools/live.ts [AAPL NVDA ...]
 */

import { runDeskTool } from "./index";

const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ["AAPL", "NVDA"];
const full = process.env.DESK_LIVE_FULL === "1";

function preview(content: string): string {
  if (full) return content;
  return content.length > 1_400 ? `${content.slice(0, 1_400)} ... (${content.length} chars)` : content;
}

async function main() {
  for (const t of tickers) {
    const calls: [string, Record<string, unknown>][] = [
      ["quote", { ticker: t }],
      ["history", { ticker: t, range: "1y" }],
      ["fundamentals", { ticker: t }],
      ["earnings", { ticker: t }],
      ["filings", { ticker: t, form: "8-K", limit: 5 }],
      ["filings", { ticker: t, query: "export controls", limit: 3 }],
      ["insiders", { ticker: t }],
    ];
    let firstUrl: string | null = null;
    for (const [name, input] of calls) {
      const r = await runDeskTool(name, input);
      console.log(`\n=== ${r.label} [${name}] ${r.ok ? "ok" : "ERROR"} ${r.ms} ms, ${r.content.length} chars`);
      console.log(preview(r.content));
      if (name === "filings" && r.ok && !firstUrl) firstUrl = (JSON.parse(r.content) as { filings?: { url?: string }[] }).filings?.[0]?.url ?? null;
    }
    if (firstUrl) {
      const r = await runDeskTool("filing_text", { url: firstUrl, query: "revenue guidance" });
      console.log(`\n=== ${r.label} [filing_text] ${r.ok ? "ok" : "ERROR"} ${r.ms} ms, ${r.content.length} chars`);
      console.log(preview(r.content));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
