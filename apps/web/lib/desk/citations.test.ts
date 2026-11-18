// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/citations.test.ts
// Numeric source citations: markup, number matching (Turkish and English formats), uncited numbers, stable ids.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignSourceIds,
  buildRegistry,
  checkReply,
  cleanCiteReport,
  dataNumbers,
  parseCitations,
  parseShown,
  readDigits,
  replyText,
  sameNumber,
  sourceOf,
  stripSourceId,
  verifyCitation,
  withSourceId,
  type SourceEntry,
  type Turn,
} from "./citations";

const shown = (s: string) => {
  const x = parseShown(s);
  assert.ok(x, `parses ${s}`);
  return x;
};

test("readDigits: decimal comma, decimal point, grouped thousands, ambiguous groups", () => {
  assert.deepEqual(readDigits("58,9"), [{ v: 58.9, decimals: 1 }]);
  assert.deepEqual(readDigits("58.9"), [{ v: 58.9, decimals: 1 }]);
  assert.deepEqual(readDigits("1.234,56"), [{ v: 1234.56, decimals: 2 }]);
  assert.deepEqual(readDigits("1,234.56"), [{ v: 1234.56, decimals: 2 }]);
  assert.deepEqual(readDigits("1,234,567"), [{ v: 1234567, decimals: 0 }]);
  assert.deepEqual(readDigits("1,234"), [
    { v: 1234, decimals: 0 },
    { v: 1.234, decimals: 3 },
  ]);
  assert.deepEqual(readDigits("0,123"), [{ v: 0.123, decimals: 3 }]);
});

test("Turkish and English figures match their raw values at the shown precision", () => {
  // Percent written before the number (Turkish) or after; raw as a percent or a fraction.
  assert.ok(sameNumber(58.94, shown("%58,9")));
  assert.ok(sameNumber(0.5894, shown("%58,9")));
  assert.ok(sameNumber(58.94, shown("58.9%")));
  assert.ok(!sameNumber(59.2, shown("%58,9")));
  // Scale words: mlr / milyar / B / bn.
  assert.ok(sameNumber(1_234_000_000, shown("$1,2 mlr")));
  assert.ok(sameNumber(94_930_000_000, shown("94,9 milyar $")));
  assert.ok(sameNumber(1_234_000_000, shown("$1.2B")));
  assert.ok(!sameNumber(1_334_000_000, shown("$1,2 mlr")));
  // Raw already in the scaled unit.
  assert.ok(sameNumber(1.2, shown("$1,2 mlr")));
  // Percentage points, a fraction difference or points.
  assert.ok(sameNumber(-0.008, shown("-0,8 puan")));
  assert.ok(sameNumber(-0.8, shown("-0,8 puan")));
  assert.ok(!sameNumber(0.8, shown("-0,8 puan")), "an explicit sign must agree");
  // No sign written (direction in words): the size matches.
  assert.ok(sameNumber(-3.4, shown("%3,4")));
  // Unicode minus, multiples, plain decimals, grouped thousands.
  assert.ok(sameNumber(-12.31, shown("−12,3%")));
  assert.ok(sameNumber(2.48, shown("2,5x")));
  assert.ok(sameNumber(0.82, shown("0,82")));
  assert.ok(sameNumber(1_234_567, shown("1.234.567")));
  assert.ok(sameNumber(1234.4, shown("1,234")), "ambiguous: thousands");
  assert.ok(sameNumber(1.234, shown("1,234")), "ambiguous: decimals");
  assert.ok(sameNumber(271.49, shown("$271,49")));
  assert.ok(sameNumber(0.0005, shown("5 bps")));
});

test("parseCitations reads label, ref and field", () => {
  const text = 'IV [%58,9](src:t2 "atmIv30Pct") ve fiyat [$271,49](src:t1).';
  assert.deepEqual(
    parseCitations(text).map(({ label, ref, field }) => ({ label, ref, field })),
    [
      { label: "%58,9", ref: "t2", field: "atmIv30Pct" },
      { label: "$271,49", ref: "t1", field: undefined },
    ],
  );
});

const entry = (data: unknown, over: Partial<SourceEntry> = {}): SourceEntry => ({ id: "t2", name: "falcon_options", input: { ticker: "NVDA" }, ok: true, data, source: { label: "OPRA via Databento" }, cmd: "/options NVDA", ...over });

test("verifyCitation: field match, value elsewhere, mismatch, unresolved, failed tool", () => {
  const e = entry({ ticker: "NVDA", atmIv30Pct: 58.94, ivStanding: { percentile: 72, rank: 64.2 }, impliedMove20: 0.081 });
  const ok = verifyCitation({ label: "%58,9", ref: "t2", field: "atmIv30Pct" }, e);
  assert.equal(ok.status, "verified");
  assert.equal(ok.path, "atmIv30Pct");
  assert.equal(ok.value, 58.94);
  assert.equal(ok.cmd, "/options NVDA");
  assert.ok(ok.excerpt?.includes("58.94"));
  // A nested field by its leaf name.
  assert.equal(verifyCitation({ label: "64,2", ref: "t2", field: "rank" }, e).path, "ivStanding.rank");
  // Wrong field name but the figure is in the result: verified with a note.
  // Case and separators do not matter in a field name.
  assert.equal(verifyCitation({ label: "%8,1", ref: "t2", field: "implied_move_20" }, e).note, undefined);
  const moved = verifyCitation({ label: "%8,1", ref: "t2", field: "month_move" }, e);
  assert.equal(moved.status, "verified");
  assert.equal(moved.path, "impliedMove20");
  assert.ok(moved.note);
  // A made-up figure.
  const bad = verifyCitation({ label: "%61,3", ref: "t2", field: "atmIv30Pct" }, e);
  assert.equal(bad.status, "mismatch");
  assert.equal(bad.value, 58.94);
  assert.match(bad.note ?? "", /58\.94/);
  assert.equal(verifyCitation({ label: "%58,9", ref: "t9" }, undefined).status, "unresolved");
  assert.equal(verifyCitation({ label: "%58,9", ref: "t2" }, entry({ error: "x" }, { ok: false })).status, "mismatch");
  // Too few digits to match anywhere by chance: unchecked without a field.
  assert.equal(verifyCitation({ label: "%2", ref: "t2" }, e).status, "unchecked");
});

test("verifyCitation: numbers inside strings and the audit's prose", () => {
  const audit = entry(
    [
      'Falcon\'s independent audit of this test. Evidence label shown to the member: "Thin evidence".',
      "Numbers shown in the results panel (benchmark: SPY).",
      "- HEADLINE, out-of-sample, 2023-06-01 to 2025-06-30: CAGR +12.3% vs SPY +10.1% (difference +2.2 pts a year); Sharpe 0.84 vs SPY 0.71; max drawdown -18.4% vs SPY -24.5%; closed trades 37; exposure 64%",
      "- In-sample, 2018-01-02 to 2023-05-31: CAGR +15.0% vs SPY +11.9% (difference +3.1 pts a year); Sharpe 1.02 vs SPY 0.66; max drawdown -21.0% vs SPY -33.7%; closed trades 88; exposure 70%",
    ].join("\n"),
    { id: "audit", name: "audit_run", cmd: "/audit_run" },
  );
  const oos = verifyCitation({ label: "%12,3", ref: "audit", field: "oos.cagr" }, audit);
  assert.equal(oos.status, "verified");
  assert.match(oos.excerpt ?? "", /out-of-sample/);
  assert.equal(verifyCitation({ label: "0,84", ref: "audit", field: "oos.sharpe" }, audit).status, "verified");
  assert.equal(verifyCitation({ label: "-%18,4", ref: "audit", field: "max_dd" }, audit).status, "verified");
  assert.equal(verifyCitation({ label: "+2,2 puan", ref: "audit", field: "oos.excess" }, audit).status, "verified");
  assert.equal(verifyCitation({ label: "%13,5", ref: "audit", field: "oos.cagr" }, audit).status, "mismatch");
  // A string value with a unit.
  assert.equal(verifyCitation({ label: "$1,2 mlr", ref: "t2" }, entry({ revenue: "$1.2B (TTM)" })).status, "verified");
});

test("dataNumbers: data-like figures only (not dates, years, counts, item numbers or code)", () => {
  const text = [
    "AAPL 2026-11-14 kapanışı $271,49; IV %58,9, 3 gün önce 14.11.2026 tarihli 10-K ve Item 2.02.",
    "Gelir 94,9 milyar $ oldu, 2,5x çarpan ve 1.234.567 adet; 2025 yılında 8 çeyrek.",
    "Kod: `x = 1.5` ve [%12,3](src:audit \"oos.cagr\") atlanır; saat 15:45.",
  ].join("\n");
  assert.deepEqual(
    dataNumbers(text).map((n) => n.text),
    ["$271,49", "%58,9", "94,9 milyar", "2,5x", "1.234.567"],
  );
});

test("checkReply: citations checked, uncited numbers flagged, derived ones marked", () => {
  const reg = new Map<string, SourceEntry>([["t1", entry({ price: 271.49, changePct: -0.82 }, { id: "t1", name: "quote", cmd: "/quote AAPL" })]]);
  const text = 'Kapanış [$271,49](src:t1 "price"), günlük [-%0,8](src:t1 "changePct"). Hacim %12 arttı. Fark %3,5 (hesaplandı).';
  const r = checkReply(text, reg);
  assert.equal(r.stats.cited, 2);
  assert.equal(r.stats.verified, 2);
  assert.deepEqual(
    r.uncited.map((u) => [u.text, u.status]),
    [
      ["%12", "unverified"],
      ["%3,5", "derived"],
    ],
  );
  // Survives storage.
  assert.deepEqual(cleanCiteReport(JSON.parse(JSON.stringify(r))), r);
  assert.equal(cleanCiteReport({ v: 2 }), undefined);
});

const use = (id: string, name = "quote", input: unknown = { ticker: "AAPL" }) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });

test("source ids: call order from the conversation's base, stable when the reply resumes", () => {
  const round1: Turn = { role: "assistant", content: [{ type: "text", text: "Bakıyorum." }, use("a"), use("b", "fundamentals")] };
  const round2: Turn = { role: "assistant", content: [use("c", "falcon_options", { ticker: "AAPL" })] };
  const first = assignSourceIds([], [round1], 4);
  assert.deepEqual([...first.entries()], [
    ["a", "t5"],
    ["b", "t6"],
  ]);
  // The next request carries the earlier turns in its tail: the same ids, then on.
  const later = assignSourceIds([], [round1, { role: "user", content: [result("a", "{}"), result("b", "{}")] }, round2], 4);
  assert.equal(later.get("a"), "t5");
  assert.equal(later.get("b"), "t6");
  assert.equal(later.get("c"), "t7");
  // After a question card the asking reply's calls come back in the history: just below the base.
  const ask = assignSourceIds([{ role: "user", content: "q" }, round1], [round2], 6);
  assert.equal(ask.get("a"), "t5");
  assert.equal(ask.get("b"), "t6");
  assert.equal(ask.get("c"), "t7");
});

test("buildRegistry: prefixed results, sources, the audit alias, and the reply's text", () => {
  const at = "2026-11-16T14:03:22.000Z";
  const quote = JSON.stringify({ ticker: "AAPL", price: 271.49, date: "2026-11-13", source: "Databento EQUS.SUMMARY, end of day, as of 2026-11-13. Split-adjusted." });
  const filing = JSON.stringify({ excerpt: "..." });
  const tail: Turn[] = [
    { role: "assistant", content: [{ type: "text", text: "Bakıyorum." }, use("a"), use("f", "filing_text", { url: "https://www.sec.gov/Archives/edgar/data/320193/x.htm" }), use("u", "audit_run", { script_path: "t.py" })] },
    { role: "user", content: [result("a", withSourceId("t1", quote, at)), result("f", withSourceId("t2", filing, at)), result("u", withSourceId("t3", "CAGR +12.3% vs SPY +10.1%", at))] },
    { role: "assistant", content: [{ type: "text", text: 'Kapanış [$271,49](src:t1 "price").' }] },
  ];
  const reg = buildRegistry([], tail, 0, (name) => `/${name}`);
  assert.deepEqual(reg.get("t1")?.source, { label: "Databento EQUS.SUMMARY, end of day, as of 2026-11-13. Split-adjusted.", dataset: "Databento EQUS.SUMMARY", as_of: "2026-11-13", fetched_at: at });
  assert.equal(reg.get("t2")?.source.url, "https://www.sec.gov/Archives/edgar/data/320193/x.htm");
  assert.equal(reg.get("audit")?.name, "audit_run");
  assert.equal(reg.get("t1")?.cmd, "/quote");
  const text = replyText(tail);
  assert.equal(text, 'Bakıyorum.\nKapanış [$271,49](src:t1 "price").');
  assert.equal(checkReply(text, reg).stats.verified, 1);
  assert.deepEqual(stripSourceId(withSourceId("t9", "{}", at)), { id: "t9", fetchedAt: at, content: "{}" });
  assert.equal(sourceOf("fundamentals", {}, { revenue: { ttm: { value: 1, end: "2026-09-27" }, quarters: [{ end: "2026-06-28" }] } }).as_of, "2026-09-27");
});

test("the reply's sources list and copy text", async () => {
  const at = "2026-11-16T14:03:22.000Z";
  const tail: Turn[] = [
    { role: "assistant", content: [use("a"), use("o", "falcon_options", { ticker: "AAPL" }), use("c", "show_chart", {})] },
    { role: "user", content: [result("a", withSourceId("t1", JSON.stringify({ price: 271.49, source: "Databento EQUS.SUMMARY, end of day, as of 2026-11-13." }), at)), result("o", withSourceId("t2", JSON.stringify({ atmIv30Pct: 24.1, source: "OPRA via Databento: Falcon's daily snapshot (end of day)" }), at)), result("c", withSourceId("t3", "{}", at))] },
  ];
  const r = checkReply('Kapanış [$271,49](src:t1 "price").', buildRegistry([], tail, 0, (n) => `/${n}`));
  assert.deepEqual(
    (r.sources ?? []).map((s) => [s.id, s.kind, s.domain, s.cited]),
    [
      ["t1", "databento", "databento.com", true],
      ["t2", "opra", "databento.com", false],
    ],
  );
  const { stripCitations } = await import("./citations");
  assert.equal(stripCitations('Kapanış [$271,49](src:t1 "price") ve [%24,1](src:t2).'), "Kapanış $271,49 ve %24,1.");
});

test("panel figures: the chat's audit citation and the panel name the same field", async () => {
  const { panelFigures, matchFigure, measureOf, partOf } = await import("./citation-panel");
  const part = (id: "oos" | "is" | "whole", cagr: number) => ({ id, label: id, start: "2020-01-01", end: "2025-01-01", cagr, bench_cagr: 0.101, excess: cagr - 0.101, sharpe: 0.84, bench_sharpe: 0.71, max_dd: -0.184, bench_max_dd: -0.245, trades: 37, exposure: 0.64 });
  const figs = panelFigures({ headline: { scope: "oos", benchmark: "SPY", main: part("oos", 0.123), secondary: [part("is", 0.15), part("whole", 0.13)] } });
  const chat = matchFigure(figs, "%12,3", { measure: measureOf("oos.cagr"), part: partOf("oos.cagr") });
  assert.equal(chat?.path, "audit.headline.oos.cagr");
  // The panel prints "+12.3%" in the out-of-sample column of the CAGR row.
  assert.equal(matchFigure(figs, "+12.3%", { measure: measureOf("CAGR"), part: partOf("Out of sample") })?.path, chat?.path);
  assert.equal(matchFigure(figs, "+10.1%", { measure: measureOf("SPY CAGR"), part: "oos" })?.path, "audit.headline.oos.bench_cagr");
  assert.equal(matchFigure(figs, "0.84", { measure: "sharpe", part: partOf("full.sharpe") })?.path, "audit.headline.whole.sharpe");
});

test("an indexed field names its own row", () => {
  const e = entry({ revenue: { lastQuarters: [{ value: 114_477_000_000 }, { value: 143_756_000_000 }] } });
  const ok = verifyCitation({ label: "$143,8 mlr", ref: "t2", field: "revenue.lastQuarters.1.value" }, e);
  assert.equal(ok.status, "verified");
  assert.equal(ok.note, undefined);
  // The right figure under the wrong row: found elsewhere, with a note.
  const other = verifyCitation({ label: "$143,8 mlr", ref: "t2", field: "revenue.lastQuarters[0].value" }, e);
  assert.equal(other.path, "revenue.lastQuarters[1].value");
  assert.ok(other.note);
});
