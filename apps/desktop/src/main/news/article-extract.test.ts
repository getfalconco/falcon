import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capParagraphs, decodeEntities, extractArticle, largestTextBlock } from "./article-extract";
import { fetchPage, isFetchableUrl, readArticleBody, type FetchLike } from "./article-fetch";
import type { NewsArticleRequest } from "../../shared/news-article";

const P1 =
  "Nvidia said on Wednesday that revenue in its data-center segment rose to $30.8 billion in the quarter, up 112% from a year earlier, as cloud providers kept ordering its accelerators.";
const P2 =
  "The company guided third-quarter revenue to $32.5 billion, plus or minus 2%, above the $31.7 billion analysts had pencilled in, according to LSEG data.";
const P3 =
  "Chief Financial Officer Colette Kress told analysts on a call that supply of the newest systems remained tight and that lead times had lengthened for some customers.";
const P4 =
  "Shares of Taiwan Semiconductor Manufacturing, which makes the chips, rose 1.4% in Taipei trading on Thursday morning after the results were published.";

/** A typical article page: nav, a related-stories rail, the story in nested divs, a footer. */
const ARTICLE_PAGE = `<!doctype html>
<html><head>
<title>Nvidia results</title>
<script>window.__data = {"x": "<p>not this</p>"};</script>
<style>p { color: red }</style>
</head>
<body>
<header><nav><ul><li><a href="/">Home</a></li><li><a href="/markets">Markets &amp; Finance news section</a></li></ul></nav></header>
<div class="layout">
  <aside class="sidebar"><p>Sign up for our newsletter to get the morning briefing in your inbox every single day.</p></aside>
  <main>
    <article>
      <h1>Nvidia beats</h1>
      <div class="byline">By A Reporter</div>
      <div class="article-body">
        <div data-testid="paragraph-0"><p>${P1}</p></div>
        <figure><img src="x.png"><figcaption>A long caption that describes the photograph above in some detail for readers.</figcaption></figure>
        <div data-testid="paragraph-1"><p>${P2}</p></div>
        <div data-testid="paragraph-2"><p>${P3.replace("Kress", "Kress&nbsp;")}</p></div>
        <div data-testid="paragraph-3"><p>${P4}</p></div>
        <div class="related-stories"><p>Related: Chip stocks slide as investors weigh export curbs on advanced processors.</p></div>
      </div>
    </article>
  </main>
</div>
<footer><p>&copy; 2026 Example News. All rights reserved. Reproduction is prohibited without permission.</p></footer>
</body></html>`;

describe("article extraction", () => {
  it("finds the story's paragraphs and leaves the page furniture", () => {
    const result = extractArticle(ARTICLE_PAGE);
    assert.equal(result.kind, "text");
    assert.equal(result.via, "blocks");
    assert.equal(result.paragraphs.length, 4);
    assert.equal(result.paragraphs[0], P1);
    assert.equal(result.paragraphs[3], P4);
    const all = result.paragraphs.join(" ");
    assert.ok(!all.includes("newsletter"));
    assert.ok(!all.includes("Related:"));
    assert.ok(!all.includes("caption"));
    assert.ok(!all.includes("not this"));
    assert.ok(!all.includes("rights reserved"));
    // Entities decoded, whitespace folded.
    assert.ok(result.paragraphs[2]!.includes("Kress told"));
  });

  it("prefers a JSON-LD articleBody when it is the whole story", () => {
    const body = [P1, P2, P3].join("\n\n");
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "NewsArticle", headline: "x", articleBody: body }],
    })}</script></head><body><p>Teaser only.</p></body></html>`;
    const result = extractArticle(html);
    assert.equal(result.kind, "text");
    assert.equal(result.via, "jsonld");
    assert.deepEqual(result.paragraphs, [P1, P2, P3]);
  });

  it("reports a paywall and keeps none of the text, even when the markup has it", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      isAccessibleForFree: "False",
      articleBody: [P1, P2, P3, P4].join("\n\n"),
    })}</script></head><body><article><p>${P1}</p><p>${P2}</p></article></body></html>`;
    const result = extractArticle(html);
    assert.equal(result.kind, "paywall");
    assert.deepEqual(result.paragraphs, []);
  });

  it("reads a subscribe wall from the page's own words", () => {
    const html = `<html><body><article><p>${P1}</p>
      <div class="wall"><p>Subscribe to continue reading this story and get unlimited access.</p>
      <p>Already a subscriber? Sign in here to keep going with your account.</p></div></article></body></html>`;
    assert.equal(extractArticle(html).kind, "paywall");
  });

  it("calls a page with no article text empty", () => {
    const html = `<html><body><nav><p>${P1}</p></nav><div><p>Short.</p></div></body></html>`;
    assert.equal(extractArticle(html).kind, "empty");
  });

  it("closes an unclosed paragraph at the next one and at its container", () => {
    const html = `<body><div class="story"><p>${P1}<p>${P2}</div><div class="story2"><p>${P3}</p></div></body>`;
    const blocks = largestTextBlock(html);
    assert.ok(blocks.includes(P1));
    assert.ok(blocks.includes(P2));
  });

  it("decodes numeric and named entities", () => {
    assert.equal(decodeEntities("AT&amp;T &#8217;s &#x2019; &euro;5 &bogus;"), "AT&T ’s ’ €5 &bogus;");
  });

  it("caps text at whole paragraphs and says so", () => {
    const capped = capParagraphs([P1, P2, P3, P4], P1.length + P2.length + 10, 60);
    assert.deepEqual(capped.paragraphs, [P1, P2]);
    assert.equal(capped.truncated, true);
    const all = capParagraphs([P1, P2], 100_000, 60);
    assert.equal(all.truncated, false);
    const one = capParagraphs(["x ".repeat(500)], 100, 60);
    assert.equal(one.paragraphs.length, 1);
    assert.ok(one.paragraphs[0]!.length <= 104);
  });
});

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(status >= 300 && status < 400 ? null : body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

const REQUEST: NewsArticleRequest = {
  id: 42,
  headline: "Nvidia beats",
  summary: "Nvidia reported data-center revenue of $30.8 billion.",
  url: "https://news.example.com/a/42",
  source: "Example",
  datetime: 1_760_000_000,
  tickers: ["NVDA"],
};

describe("article fetch", () => {
  it("refuses addresses that are not public web pages", () => {
    assert.equal(isFetchableUrl("https://www.reuters.com/x"), true);
    assert.equal(isFetchableUrl("file:///etc/passwd"), false);
    assert.equal(isFetchableUrl("http://localhost:3000/"), false);
    assert.equal(isFetchableUrl("http://127.0.0.1/"), false);
    assert.equal(isFetchableUrl("http://192.168.1.10/"), false);
    assert.equal(isFetchableUrl("http://10.0.0.1/"), false);
    assert.equal(isFetchableUrl("http://[::1]/"), false);
    assert.equal(isFetchableUrl("https://user:pw@example.com/"), false);
  });

  it("follows redirects, sends a browser's headers, and reads the page", async () => {
    const seen: Array<{ url: string; ua: string | undefined }> = [];
    const fake: FetchLike = async (url, init) => {
      seen.push({ url, ua: (init.headers as Record<string, string>)["User-Agent"] });
      if (url.includes("finnhub")) return response(302, "", { location: "https://news.example.com/a/42" });
      return response(200, ARTICLE_PAGE);
    };
    const body = await readArticleBody({ ...REQUEST, url: "https://finnhub.io/api/news?id=42" }, { fetch: fake, now: () => 5 });
    assert.equal(body.status, "full");
    assert.equal(body.origin, "publisher");
    assert.equal(body.finalUrl, "https://news.example.com/a/42");
    assert.equal(body.paragraphs.length, 4);
    assert.equal(seen.length, 2);
    assert.match(seen[0]!.ua ?? "", /Mozilla\/5\.0/);
  });

  it("will not follow a redirect into a private address", async () => {
    const fake: FetchLike = async () => response(302, "", { location: "http://127.0.0.1/admin" });
    const page = await fetchPage("https://news.example.com/a", { fetch: fake });
    assert.equal(page.kind, "error");
  });

  it("refuses a page over the size cap", async () => {
    const fake: FetchLike = async () => response(200, "x".repeat(5000));
    const page = await fetchPage("https://news.example.com/a", { fetch: fake, maxBytes: 1000 });
    assert.deepEqual(page.kind, "error");
  });

  it("gives up at the timeout", async () => {
    const fake: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const page = await fetchPage("https://news.example.com/a", { fetch: fake, timeoutMs: 20 });
    assert.equal(page.kind, "error");
    if (page.kind === "error") assert.equal(page.reason, "timed out");
  });

  it("falls back to the provider's summary when the publisher refuses", async () => {
    const fake: FetchLike = async () => response(403, "denied");
    const body = await readArticleBody(REQUEST, { fetch: fake });
    assert.equal(body.status, "blocked");
    assert.equal(body.origin, "provider");
    assert.deepEqual(body.paragraphs, [REQUEST.summary]);
  });

  it("says empty when there is neither text nor a summary", async () => {
    const fake: FetchLike = async () => response(200, "<html><body><p>Hi.</p></body></html>");
    const body = await readArticleBody({ ...REQUEST, summary: "" }, { fetch: fake });
    assert.equal(body.status, "empty");
    assert.deepEqual(body.paragraphs, []);
  });

  it("uses a long provider body without fetching the page", async () => {
    let calls = 0;
    const fake: FetchLike = async () => {
      calls += 1;
      return response(200, ARTICLE_PAGE);
    };
    const long = [P1, P2, P3, P4, P1.replace("Wednesday", "Thursday"), P2.replace("third", "fourth")].join("\n\n");
    const body = await readArticleBody({ ...REQUEST, summary: long }, { fetch: fake });
    assert.equal(calls, 0);
    assert.equal(body.status, "full");
    assert.equal(body.origin, "provider");
  });
});
