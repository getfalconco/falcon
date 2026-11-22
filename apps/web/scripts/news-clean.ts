/**
 * One-off pass over public.news_items with the ingest rules of
 * lib/news/relevance.ts: deletes listicle and clickbait headlines, removes
 * tickers an article only mentions in passing, and deletes articles left with
 * no ticker. Prints before and after counts and examples of what it drops.
 *
 *   pnpm --filter web news:clean            # dry run: counts and examples only
 *   pnpm --filter web news:clean --apply    # also writes the changes
 *
 * Needs DATABASE_URL in apps/web/.env.local, and the SEC company names the
 * filings sweeper keeps in public.filing_sweep_state (run filings:sweep once).
 */
import { isClickbait, relevantSymbols } from "../lib/news/relevance.ts";
import { createNewsPool, readTickerNames } from "../lib/news/store.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL in apps/web/.env.local");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const pool = createNewsPool(url, 2);

try {
  const names = await readTickerNames(pool);
  if (names.size < 1000) throw new Error(`Only ${names.size} company names known; run the filings sweeper first.`);
  const { rows } = await pool.query<{ id: string; symbols: string[]; headline: string; summary: string; source: string }>(
    `select id, symbols, headline, summary, source from public.news_items`,
  );
  const clickbait: typeof rows = [];
  const untagged: (typeof rows[number] & { dropped: string[] })[] = [];
  const retag: { id: string; headline: string; keep: string[]; dropped: string[] }[] = [];
  let tagsBefore = 0;
  let tagsAfter = 0;
  for (const r of rows) {
    tagsBefore += r.symbols.length;
    if (isClickbait(r.headline)) {
      clickbait.push(r);
      continue;
    }
    const keep = relevantSymbols(r.symbols, r.headline, r.summary, names);
    const dropped = r.symbols.filter((s) => !keep.includes(s));
    if (!keep.length) untagged.push({ ...r, dropped });
    else {
      tagsAfter += keep.length;
      if (dropped.length) retag.push({ id: r.id, headline: r.headline, keep, dropped });
    }
  }
  const after = rows.length - clickbait.length - untagged.length;
  console.log(`Rows: ${rows.length} before, ${after} after (${clickbait.length} clickbait, ${untagged.length} with no ticker left). Ticker tags: ${tagsBefore} before, ${tagsAfter} after; ${retag.length} rows keep some tickers and lose others.`);
  const sample = <T,>(list: T[], n: number) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
  console.log("\nClickbait examples:");
  for (const r of sample(clickbait, 15)) console.log(`  [${r.symbols.join(",")}] ${r.source}: ${r.headline}`);
  console.log("\nDropped for not being about any of its tickers:");
  for (const r of sample(untagged, 15)) console.log(`  [${r.dropped.join(",")}] ${r.source}: ${r.headline}`);
  console.log("\nKept with fewer tickers:");
  for (const r of sample(retag, 10)) console.log(`  keep [${r.keep.join(",")}] drop [${r.dropped.join(",")}]: ${r.headline}`);

  if (apply) {
    const del = [...clickbait, ...untagged].map((r) => r.id);
    if (del.length) await pool.query(`delete from public.news_items where id = any($1::bigint[])`, [del]);
    if (retag.length) {
      await pool.query(
        `update public.news_items as n set symbols = string_to_array(t.symbols, ',') from unnest($1::bigint[], $2::text[]) as t(id, symbols) where n.id = t.id`,
        [retag.map((r) => r.id), retag.map((r) => r.keep.join(","))],
      );
    }
    console.log(`\nApplied: ${del.length} rows deleted, ${retag.length} rows retagged.`);
  } else console.log("\nDry run: nothing written. Pass --apply to write.");
} finally {
  await pool.end().catch(() => undefined);
}
