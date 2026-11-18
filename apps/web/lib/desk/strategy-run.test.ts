// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/strategy-run.test.ts
// Pure checks of the strategy-test contract; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactRunResult, fmtPct, validateRunResult } from "./run-result";
import { parseLoadPrices, signResume, verifyResume } from "./strategy-run";

const TODAY = "2026-11-16";

test("parseLoadPrices: universe, explicit tickers, SPY added, warm-up", () => {
  const p = parseLoadPrices({ universe: "sector_etfs", tickers: ["brk.b"], start: "2021-11-16" }, TODAY);
  assert.ok(p.tickers.includes("XLK") && p.tickers.includes("BRK-B") && p.tickers.includes("SPY"));
  assert.equal(p.end, TODAY);
  assert.equal(p.from, "2020-10-12");
  assert.deepEqual(p.fields, ["open", "close"]);
  assert.equal(p.todaysPick, false);
});

test("parseLoadPrices: limits", () => {
  assert.throws(() => parseLoadPrices({ start: "2021-01-01" }, TODAY), /universe or a list/);
  assert.throws(() => parseLoadPrices({ tickers: ["SPY"], start: "2021-13-01" }, TODAY), /start must be a date/);
  assert.throws(() => parseLoadPrices({ tickers: ["SPY"], start: "2021-01-01", end: "2027-01-01" }, TODAY), /after today/);
  assert.throws(() => parseLoadPrices({ universe: "sp500_today", start: "2014-01-01" }, TODAY), /at most 10 years/);
  // A few tickers may go back further.
  assert.equal(parseLoadPrices({ tickers: ["SPY"], start: "2000-01-03" }, TODAY).start, "2000-01-03");
  assert.throws(() => parseLoadPrices({ tickers: ["not a ticker"], start: "2021-01-01" }, TODAY), /Not US tickers/);
  assert.throws(() => parseLoadPrices({ tickers: ["SPY"], start: "2021-01-01", fields: ["vwap"] }, TODAY), /fields must be/);
});

test("validateRunResult: lenient types, strict structure", () => {
  const v = validateRunResult({
    name: "Test",
    period: { start: "2021-01-04", end: "2021-01-07" },
    metrics: { cagr: "0.1", max_dd: 0.2, sharpe: 1.2, benchmark: { cagr: 0.08 } },
    series: { dates: ["2021-01-04", "2021-01-05", "bad", "2021-01-07"], equity: [1, 1.1, 1.2, 0.99], benchmark_equity: [1, 1.01, 1.02] },
    trades: [
      { date: "2021-01-05", ticker: "aapl", side: "BUY", price: 130, pnl: null },
      { date: "2021-01-06", ticker: "AAPL", side: "hold" },
    ],
    warnings: ["Survivorship"],
  });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.result.metrics.cagr, 0.1);
  assert.equal(v.result.metrics.max_dd, -0.2);
  assert.deepEqual(v.result.series.dates, ["2021-01-04", "2021-01-05", "2021-01-07"]);
  assert.equal(v.result.series.benchmark_equity[2], null);
  assert.ok(Math.abs(v.result.series.drawdown[2]! - (0.99 / 1.1 - 1)) < 1e-9);
  assert.equal(v.result.trades.length, 1);
  assert.equal(v.result.trades[0]!.ticker, "AAPL");
  assert.ok(v.problems.length > 0);
  assert.equal(validateRunResult({ name: "x" }).ok, false);
  assert.equal(validateRunResult([1, 2]).ok, false);
});

test("compactRunResult keeps the deepest drawdown and the first trades", () => {
  const n = 2000;
  const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2015, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
  const equity = dates.map((_, i) => (i === 1234 ? 0.5 : 1 + i / n));
  const v = validateRunResult({ name: "x", metrics: { cagr: 0.1 }, series: { dates, equity, benchmark_equity: equity }, trades: Array.from({ length: 900 }, () => ({ date: "2016-01-04", ticker: "SPY", side: "buy" })) });
  assert.ok(v.ok);
  if (!v.ok) return;
  const c = compactRunResult(v.result, 400, 500);
  assert.ok(c.result.series.dates.length <= 402);
  assert.ok(c.result.series.dates.includes(dates[1234]!));
  assert.equal(c.result.trades.length, 500);
  assert.deepEqual(c.cut, { points: n, trades: 900 });
});

test("fmtPct", () => {
  assert.equal(fmtPct(0.1234), "+12.3%");
  assert.equal(fmtPct(-0.0001), "0.0%");
  assert.equal(fmtPct(21.47, 0), "+2,147%");
  assert.equal(fmtPct(null), "n/a");
});

test("resume token: signed, bound to the member, tamper-proof", () => {
  const state = { tail: [{ role: "user" as const, content: "hi" }], container: "container_1", runId: "run_1", dataFiles: ["file_1"], files: { "/tmp/a.py": "print(1)" }, n: 1 };
  const t = signResume(state, "secret", "user-1");
  assert.deepEqual(verifyResume(t, "secret", "user-1"), state);
  assert.equal(verifyResume(t, "secret", "user-2"), null);
  assert.equal(verifyResume(t, "other", "user-1"), null);
  const [body, mac] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), container: "container_x" })).toString("base64url");
  assert.equal(verifyResume(`${forged}.${mac}`, "secret", "user-1"), null);
  assert.equal(verifyResume("garbage", "secret", "user-1"), null);
});

test("bug 1: load_prices takes the benchmark the member asked for (SPY still loaded)", () => {
  const p = parseLoadPrices({ tickers: ["XLK", "XLF"], benchmark: "agg", start: "2021-11-16" }, TODAY);
  assert.equal(p.benchmark, "AGG");
  assert.ok(p.tickers.includes("AGG") && p.tickers.includes("SPY"));
  assert.equal(parseLoadPrices({ tickers: ["XLK"], start: "2021-11-16" }, TODAY).benchmark, "SPY");
  assert.throws(() => parseLoadPrices({ tickers: ["XLK"], benchmark: "equal weight", start: "2021-11-16" }, TODAY), /benchmark must be a ticker/);
  // A benchmark alone is not a universe.
  assert.throws(() => parseLoadPrices({ benchmark: "AGG", start: "2021-11-16" }, TODAY), /universe or a list/);
});
