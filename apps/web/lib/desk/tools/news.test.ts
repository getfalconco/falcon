import assert from "node:assert/strict";
import test from "node:test";
import { fieldSource } from "../citations";
import { deskToolCommand } from "./command";
import { capText, checkPublicUrl, clipSummary, extractArticleText, isBlockedAddress, newsLabel, newsSymbol, resetNewsCache, runNewsTool, type NewsArticleRow, type NewsStore } from "./news";

const row = (id: number, over: Partial<NewsArticleRow> = {}): NewsArticleRow => ({
  id,
  symbols: ["AAPL"],
  headline: `Headline ${id}`,
  summary: `Summary of article ${id}.`,
  source: "Yahoo",
  url: `https://finnhub.io/api/news?id=${id}`,
  publishedAt: "2026-11-20T15:00:00.000Z",
  ...over,
});

function memoryStore(rows: NewsArticleRow[]): NewsStore & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async list(opts) {
      calls.push(opts);
      return rows.filter((r) => !opts.symbol || r.symbols.includes(opts.symbol)).slice(0, opts.limit);
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
  };
}

const publicLookup = async () => ["93.184.216.34"];
const longText = "Apple reported record services revenue in the quarter, the company said on Thursday. ".repeat(20);

test("symbols and labels", () => {
  assert.equal(newsSymbol("$brk-b"), "BRK.B");
  assert.equal(newsSymbol(" aapl "), "AAPL");
  assert.equal(newsSymbol(""), undefined);
  assert.throws(() => newsSymbol("Apple Inc"));
  assert.equal(newsLabel("list_news", {}, "running"), "Reading latest news");
  assert.equal(newsLabel("list_news", { symbol: "nvda" }), "Read NVDA news");
  assert.equal(newsLabel("get_news_article", { id: 1 }), "Read news article");
  assert.equal(deskToolCommand("list_news", {}).cmd, "/news");
  assert.equal(deskToolCommand("list_news", { symbol: "aapl" }).cmd, "/news AAPL");
  assert.equal(deskToolCommand("get_news_article", { id: 144023649 }).cmd, "/article 144023649");
});

test("list_news with and without a symbol", async () => {
  resetNewsCache();
  const store = memoryStore([row(1), row(2, { symbols: ["NVDA"] }), row(3)]);
  const all = await runNewsTool("list_news", {}, { store });
  assert.equal(all.ok, true);
  assert.equal(JSON.parse(all.content).count, 3);
  const aapl = await runNewsTool("list_news", { symbol: "aapl", limit: 1 }, { store });
  const body = JSON.parse(aapl.content);
  assert.equal(body.symbol, "AAPL");
  assert.equal(body.articles.length, 1);
  assert.equal(body.articles[0].published, "2026-11-20 10:00 ET");
  assert.ok(body.next_before);
  const bad = await runNewsTool("list_news", { symbol: "not a ticker" }, { store });
  assert.equal(bad.ok, false);
});

test("blocked addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2002:c0a8:0101::1", "not-an-ip"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
});

test("url checks", async () => {
  await assert.rejects(checkPublicUrl(new URL("http://localhost/x"), publicLookup));
  await assert.rejects(checkPublicUrl(new URL("http://127.0.0.1/x"), publicLookup));
  await assert.rejects(checkPublicUrl(new URL("http://[::1]/x"), publicLookup));
  await assert.rejects(checkPublicUrl(new URL("file:///etc/passwd"), publicLookup));
  await assert.rejects(checkPublicUrl(new URL("https://example.com:8080/x"), publicLookup));
  await assert.rejects(checkPublicUrl(new URL("https://evil.example/x"), async () => ["10.0.0.5"]));
  await assert.rejects(checkPublicUrl(new URL("https://mixed.example/x"), async () => ["93.184.216.34", "127.0.0.1"]));
  await checkPublicUrl(new URL("https://www.example.com/a"), publicLookup);
});

test("text extraction: JSON-LD body, then paragraphs without page chrome", () => {
  const ld = `<html><head><title>T</title><script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","articleBody":${JSON.stringify(longText)}}]}</script></head><body><p>ignored</p></body></html>`;
  assert.equal(extractArticleText(ld).text, longText.trim());
  const html = `<html><head><meta property="og:title" content="Big &amp; news"><style>p{}</style></head><body><nav><p>Home Markets Videos and more links here</p></nav><article><h1>Big news today for the company and its peers</h1><p>First paragraph says the company&#8217;s sales rose 12% in the quarter.</p><script>var x = "<p>not text</p>";</script><p>Second paragraph with more detail about guidance &mdash; the outlook.</p></article><footer><p>Copyright notice that should not appear</p></footer></body></html>`;
  const out = extractArticleText(html);
  assert.equal(out.title, "Big & news");
  assert.match(out.text, /company’s sales rose 12%/);
  assert.match(out.text, /Second paragraph/);
  assert.doesNotMatch(out.text, /not text|Copyright|Home Markets/);
});

test("get_news_article: follows checked redirects and returns capped text", async () => {
  resetNewsCache();
  const store = memoryStore([row(7)]);
  const seen: string[] = [];
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("https://finnhub.io/")) return new Response(null, { status: 302, headers: { location: "https://news.example.com/story" } });
    return new Response(`<html><body><article>${`<p>${longText}</p>`.repeat(10)}</article></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  const r = await runNewsTool("get_news_article", { id: 7 }, { store, deps: { fetch: fetchImpl, lookup: publicLookup } });
  assert.equal(r.ok, true);
  const body = JSON.parse(r.content);
  assert.equal(body.content, "full_text");
  assert.equal(body.url, "https://news.example.com/story");
  assert.equal(body.truncated, true);
  assert.ok(body.text.length <= 8_100);
  assert.deepEqual(seen, ["https://finnhub.io/api/news?id=7", "https://news.example.com/story"]);
});

test("get_news_article: a redirect to a private address, a paywall and an unknown id", async () => {
  resetNewsCache();
  const store = memoryStore([row(8), row(9), row(10)]);
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.endsWith("id=8")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    if (url.endsWith("id=9")) return new Response("Subscribe", { status: 403 });
    return new Response("<html><body><p>Sign in to keep reading this premium article.</p></body></html>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const deps = { fetch: fetchImpl, lookup: publicLookup };
  const priv = JSON.parse((await runNewsTool("get_news_article", { id: 8 }, { store, deps })).content);
  assert.equal(priv.content, "unavailable");
  assert.equal(priv.reason, "private address");
  assert.equal(priv.summary, "Summary of article 8.");
  const paywall = JSON.parse((await runNewsTool("get_news_article", { id: 9 }, { store, deps })).content);
  assert.equal(paywall.content, "unavailable");
  assert.match(paywall.reason, /HTTP 403/);
  const thin = JSON.parse((await runNewsTool("get_news_article", { id: 10 }, { store, deps })).content);
  assert.equal(thin.content, "unavailable");
  const missing = await runNewsTool("get_news_article", { id: 999 }, { store, deps });
  assert.equal(missing.ok, false);
  assert.match(JSON.parse(missing.content).error, /No article or filing with id 999/);
});

test("summaries end at a sentence with a clipped marker; long texts end at a paragraph", () => {
  const s = "Neither Phase 3 study met its prespecified primary endpoint. The company will review the data with regulators before deciding next steps. ".repeat(4);
  const out = clipSummary(s, 200);
  assert.match(out, /endpoint\. \[summary clipped; read the article or filing for the full text\]$|steps\. \[summary clipped; read the article or filing for the full text\]$/);
  assert.equal(clipSummary("Short and whole."), "Short and whole.");
  const text = ["First paragraph is here. It has two sentences.", "Second paragraph, a bit longer than the first one, ends here.", "Third paragraph."].join("\n\n");
  const capped = capText(text, 120);
  assert.equal(capped.truncated, true);
  assert.match(capped.text, /^First paragraph is here\. It has two sentences\.\n\n/);
  assert.doesNotMatch(capped.text, /Third/);
  assert.match(capped.text, /\[text cut here at a paragraph end; the rest is not shown\]$/);
});

test("list_news mixes filings with articles and labels each by its source", async () => {
  resetNewsCache();
  const filing = row(1_149_315_226_050_606, {
    kind: "filing",
    symbols: ["ABEO"],
    source: "SEC EDGAR",
    form: "8-K",
    items: ["1.01", "3.02"],
    headline: "ABEO 8-K: Entry into a Material Agreement; Unregistered Sale of Equity Securities",
    url: "https://www.sec.gov/Archives/edgar/data/318306/000149315226050606/0001493152-26-050606-index.htm",
    publishedAt: "2026-11-09T11:30:34.000Z",
  });
  const store = memoryStore([row(5), filing]);
  const body = JSON.parse((await runNewsTool("list_news", {}, { store })).content);
  assert.equal(body.articles[0].source, "Yahoo, Nov 20, 2026");
  assert.equal(body.articles[1].kind, "filing");
  assert.equal(body.articles[1].source, "SEC EDGAR, 8-K, Nov 9, 2026");
  assert.deepEqual(body.articles[1].items, ["1.01", "3.02"]);
  assert.doesNotMatch(body.source, /^Finnhub/);
  // Each cited figure resolves to its own row's source (citations.ts fieldSource).
  const base = { label: body.source };
  assert.equal(fieldSource(body, "articles.1.headline", base).label, "SEC EDGAR, 8-K, Nov 9, 2026");
  assert.equal(fieldSource(body, "articles.0.summary", base).label, "Yahoo, Nov 20, 2026");
});

test("get_news_article reads a filing's main document and press release from SEC EDGAR only", async () => {
  resetNewsCache();
  const folder = "https://www.sec.gov/Archives/edgar/data/318306/000149315226050606/";
  const filing = row(1_149_315_226_050_606, {
    kind: "filing",
    symbols: ["ABEO"],
    source: "SEC EDGAR",
    form: "8-K",
    url: `${folder}0001493152-26-050606-index.htm`,
    documents: [
      { type: "8-K", description: "8-K", url: `${folder}form8-k.htm` },
      { type: "EX-99.1", description: "PRESS RELEASE", url: `${folder}ex99-1.htm` },
      { type: "EX-99.2", description: "elsewhere", url: "https://evil.example/x.htm" },
    ],
  });
  const seen: { url: string; ua: string | null }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    seen.push({ url: String(input), ua: new Headers(init?.headers).get("user-agent") });
    if (String(input).endsWith("form8-k.htm")) return new Response(`<html><body><p>FORM 8-K</p><p>Item 3.02. Unregistered Sales of Equity Securities.</p><p>The Company agreed to sell 10,000,000 shares in a private placement at $3.00 per share.</p></body></html>`);
    return new Response(`<html><body><p>Abeona Announces $30 Million Private Placement</p><p>CLEVELAND, November 9, 2026 - Abeona Therapeutics Inc. today announced a private placement.</p></body></html>`);
  }) as typeof fetch;
  const r = await runNewsTool("get_news_article", { id: 1_149_315_226_050_606 }, { store: memoryStore([filing]), deps: { fetch: fetchImpl } });
  const body = JSON.parse(r.content);
  assert.equal(body.content, "full_text");
  assert.equal(body.source, "SEC EDGAR, 8-K, Nov 20, 2026");
  assert.match(body.text, /^\[8-K main document\]\n\nItem 3\.02\. Unregistered Sales of Equity Securities\./);
  assert.match(body.text, /\[EX-99\.1 \(PRESS RELEASE\)\]\n\nAbeona Announces \$30 Million Private Placement/);
  assert.deepEqual(
    seen.map((s) => s.url),
    [`${folder}form8-k.htm`, `${folder}ex99-1.htm`],
  );
  assert.ok(seen.every((s) => s.ua && /getfalcon\.co/.test(s.ua)));
});
