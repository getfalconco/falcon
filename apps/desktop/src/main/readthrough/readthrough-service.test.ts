import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createReadthroughService, timingOf } from "./readthrough-service";
import type { LinkEdge } from "../../shared/earnings-links";
import type { EarningsRow } from "../../shared/earnings-types";
import type { PricePoint } from "../../shared/stock-types";
import { parseReadthroughRequest } from "../../shared/readthrough-types";

const NOW = Date.parse("2026-10-15T16:00:00Z"); // noon in New York, a Thursday
const TODAY = "2026-10-15";

function weekdays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  while (d.toISOString().slice(0, 10) <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const DAYS = weekdays("2024-08-01", TODAY);
const wiggle = (i: number) => Math.sin(i * 1.7) * 0.004 + Math.cos(i * 0.9) * 0.003;
const TSM_REPORTS = ["2025-10-16", "2026-01-15", "2026-04-16", "2026-07-16"];
const AMD_REPORTS = ["2025-02-04", "2025-05-06", "2025-08-05", "2025-11-04", "2026-02-03", "2026-05-05", "2026-08-04", "2026-10-13"];

function points(ret: (day: string, i: number) => number): PricePoint[] {
  let c = 100;
  // Yahoo stamps a daily bar at the open.
  return DAYS.map((d, i) => {
    if (i > 0) c *= 1 + ret(d, i);
    return { t: Date.parse(`${d}T13:30:00Z`), v: c };
  });
}

const SERIES: Record<string, PricePoint[]> = {
  SPY: points((_d, i) => wiggle(i)),
  TSM: points((d, i) => wiggle(i) + (TSM_REPORTS.includes(d) ? 0.04 : 0)),
  AMD: points((d, i) => wiggle(i) + (AMD_REPORTS.includes(d) ? -0.03 : 0)),
  NVDA: points((d, i) => wiggle(i) + (TSM_REPORTS.includes(d) ? 0.02 : 0) + (AMD_REPORTS.includes(d) ? 0.005 : 0)),
  INTC: points((_d, i) => wiggle(i)),
};

function edge(root: string, other: string, category: string): LinkEdge {
  return {
    root_ticker: root,
    counterparty_ticker: other,
    category,
    strength_tier: "critical",
    confidence: 0.9,
    evidence_quote: "quote",
    source_url: `https://www.sec.gov/Archives/edgar/data/1/${root}.htm`,
    accession_number: "0000000001-26-000001",
    filing_date: "2026-02-26",
    form: "10-K",
  };
}

function upRow(ticker: string, date: string, extra: Partial<EarningsRow> = {}): EarningsRow {
  return {
    ticker,
    company: `${ticker} Corp`,
    date,
    windowEnd: null,
    time: "bmo",
    status: "confirmed",
    phase: "upcoming",
    releasedAt: null,
    fiscalPeriod: null,
    epsEstimate: 1,
    epsActual: null,
    epsCurrency: "USD",
    consensus: null,
    revenueEstimate: null,
    revenueActual: null,
    revenueCurrency: null,
    revenueEstimateUsd: null,
    revenueActualUsd: null,
    fx: null,
    source: "yahoo",
    lastSurprise: null,
    sector: null,
    held: true,
    watchlist: false,
    tracked: false,
    readsThrough: [],
    reason: null,
    marketCap: null,
    ...extra,
  };
}

function setup(overrides: { failDaily?: string; now?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readthrough-"));
  const calls: Record<string, number> = {};
  const service = createReadthroughService({
    dir,
    now: overrides.now ?? (() => NOW),
    graphEdges: async () => [edge("NVDA", "TSM", "supplier"), edge("AMD", "NVDA", "competitor"), edge("NVDA", "INTC", "competitor")],
    upcoming: async (tickers) => tickers.flatMap((t) => (t === "TSM" ? [upRow("TSM", "2026-10-16")] : [])),
    quarters: async (symbol) => {
      if (symbol === "TSM") return TSM_REPORTS.map((d) => ({ reportedAt: null, reportedYmd: d, epsActual: 1, epsEstimate: 0.9 }));
      if (symbol === "AMD") return AMD_REPORTS.slice(-4).map((d) => ({ reportedAt: null, reportedYmd: d, epsActual: 1.1, epsEstimate: 1 }));
      return [];
    },
    releases: async (symbol) => {
      calls[`releases:${symbol}`] = (calls[`releases:${symbol}`] ?? 0) + 1;
      return symbol === "AMD" ? AMD_REPORTS.slice(0, 4).map((d) => ({ filedAt: d, acceptedAt: null })) : [];
    },
    fetchDaily: async (symbol) => {
      calls[symbol] = (calls[symbol] ?? 0) + 1;
      if (symbol === overrides.failDaily) throw new Error("no closes");
      return SERIES[symbol] ?? [];
    },
  });
  return { service, calls, dir };
}

describe("readthrough service", () => {
  it("lists the upcoming and the recent pairs, measured, and leaves the rest out", async () => {
    const { service } = setup();
    const res = await service.radar(parseReadthroughRequest({ held: [{ ticker: "NVDA", shares: 10 }], watchlist: [] })!);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.today, TODAY);
    assert.deepEqual(res.degraded, []);
    const ids = res.rows.map((r) => r.id);
    assert.deepEqual(new Set(ids), new Set(["TSM>NVDA", "AMD>NVDA"]));

    const tsm = res.rows.find((r) => r.id === "TSM>NVDA")!;
    assert.equal(tsm.kind, "upcoming");
    assert.equal(tsm.date, "2026-10-16");
    assert.equal(tsm.relation, "supplier");
    assert.equal(tsm.sample, 4);
    assert.equal(tsm.stats!.withIt, 4);
    assert.ok(Math.abs(tsm.stats!.avgAbsAbnormal - 0.02) < 1e-3);
    assert.equal(tsm.counterpartyName, "TSM Corp");
    assert.ok(tsm.score > 0);

    const amd = res.rows.find((r) => r.id === "AMD>NVDA")!;
    assert.equal(amd.kind, "recent");
    assert.equal(amd.relation, "competitor");
    // The last report (Oct 13) is measured too; eight in all, from Yahoo's four and EDGAR's four.
    assert.equal(amd.sample, 8);
    // AMD fell on its reports while NVDA rose: never with it.
    assert.equal(amd.stats!.withIt, 0);
    assert.equal(amd.report!.epsActual, 1.1);
    assert.equal(amd.report!.reactionDay, "2026-10-13");
    assert.ok(amd.report!.counterpartyMove! < -0.02);
    assert.ok(amd.report!.holdingSince !== null);
    // TSM's 2% on its days against NVDA's small move on AMD's days: TSM first.
    assert.equal(res.rows[0]!.id, "TSM>NVDA");
  });

  it("reads each name's closes once a day, and keeps the answer", async () => {
    const { service, calls } = setup();
    await service.radar(parseReadthroughRequest({ held: ["NVDA"] })!);
    await service.radar(parseReadthroughRequest({ held: ["NVDA"], watchlist: ["AAPL"] })!);
    assert.equal(calls.SPY, 1);
    assert.equal(calls.TSM, 1);
    assert.equal(calls.NVDA, 1);
    // INTC has no report in view: its closes are never asked for.
    assert.equal(calls.INTC, undefined);
  });

  it("lists every link of a focused name, whatever the dates", async () => {
    const { service } = setup();
    const res = await service.radar(parseReadthroughRequest({ focus: "NVDA" })!);
    assert.ok(res.ok);
    if (!res.ok) return;
    const intc = res.rows.find((r) => r.id === "INTC>NVDA");
    assert.ok(intc);
    assert.equal(intc!.kind, "later");
    assert.equal(intc!.sample, 0);
    assert.equal(intc!.stats, null);
  });

  it("stands without a name's closes and says so", async () => {
    const { service } = setup({ failDaily: "TSM" });
    const res = await service.radar(parseReadthroughRequest({ held: ["NVDA"] })!);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.deepEqual(res.degraded, ["prices"]);
    const tsm = res.rows.find((r) => r.id === "TSM>NVDA")!;
    assert.equal(tsm.stats, null);
    assert.equal(tsm.sample, 0);
  });

  it("keeps a releases read made before SEC's nightly rebuild for minutes, not the day", async () => {
    let nowMs = Date.parse("2026-10-15T04:10:00Z"); // 00:10 New York
    const { service, calls } = setup({ now: () => nowMs });
    const ask = () => service.radar(parseReadthroughRequest({ held: ["NVDA"] })!);
    await ask();
    const first = calls["releases:AMD"];
    assert.ok(first && first >= 1, "AMD's filings are read");
    nowMs += 11 * 60_000; // 00:21: the answer and the releases read have both run out
    await ask();
    assert.equal(calls["releases:AMD"], first + 1);
    nowMs = Date.parse("2026-10-15T05:00:00Z"); // 01:00: read again, now kept for the day
    await ask();
    assert.equal(calls["releases:AMD"], first + 2);
    nowMs = Date.parse("2026-10-15T09:00:00Z"); // 05:00
    await ask();
    assert.equal(calls["releases:AMD"], first + 2);
  });

  it("reads again a day's releases kept by an earlier reading of EDGAR's stamps", async () => {
    const { service, calls, dir } = setup();
    // Version 1 of releases.json, today, with AMD's answer already in it.
    const day = new Date(NOW - 4 * 3_600_000).toISOString().slice(0, 10);
    const stale = { schema_version: 1, day, symbols: { AMD: [{ filedAt: AMD_REPORTS[0], acceptedAt: "2026-01-01T00:00:00.000Z" }] } };
    fs.writeFileSync(path.join(dir, "releases.json"), JSON.stringify(stale));
    await service.radar(parseReadthroughRequest({ held: ["NVDA"] })!);
    assert.ok((calls["releases:AMD"] ?? 0) >= 1, "AMD's filings are read again");
  });

  it("answers an empty list without reading anything for a reader with no names", async () => {
    const { service, calls } = setup();
    const res = await service.radar(parseReadthroughRequest({})!);
    assert.ok(res.ok && res.rows.length === 0);
    assert.deepEqual(calls, {});
  });
});

describe("timingOf", () => {
  it("takes a report out in the last week from the quarters when the calendar has none", () => {
    const t = timingOf(undefined, [{ reportedAt: null, reportedYmd: "2026-10-09", epsActual: 2, epsEstimate: 1.6 }], TODAY);
    assert.equal(t.kind, "recent");
    assert.equal(t.surprisePct, 25);
    const old = timingOf(undefined, [{ reportedAt: null, reportedYmd: "2026-10-01", epsActual: 2, epsEstimate: 1.6 }], TODAY);
    assert.equal(old.kind, "later");
  });

  it("lists a report up to four weeks out, not further", () => {
    assert.equal(timingOf(upRow("X", "2026-11-11"), [], TODAY).kind, "upcoming");
    assert.equal(timingOf(upRow("X", "2026-11-12"), [], TODAY).kind, "later");
  });
});

describe("parseReadthroughRequest", () => {
  it("cleans tickers and share counts, and turns down what is not a request", () => {
    assert.deepEqual(parseReadthroughRequest({ held: [" nvda ", { ticker: "aapl", shares: -5 }, 7], watchlist: ["tsm", "tsm"] }), {
      held: [
        { ticker: "NVDA", shares: null },
        { ticker: "AAPL", shares: 5 },
      ],
      watchlist: ["TSM"],
      focus: null,
    });
    assert.equal(parseReadthroughRequest([]), null);
    assert.equal(parseReadthroughRequest({ focus: "not a ticker!" }), null);
    assert.equal(parseReadthroughRequest({ held: "NVDA" }), null);
  });
});
