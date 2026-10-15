import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { GlossModelCaller } from "@meridian/research/gloss";
import type { FilingRef } from "../agents/sources";
import type { PricePoint } from "../../shared/stock-types";
import type { YahooEarningsRead } from "../earnings/earnings-sources";
import { createStockTabService, type StockTabDeps } from "./service";

const DAY = 86_400_000;
const START = Date.parse("2026-10-15T16:00:00Z");

const n = (raw: number) => ({ raw });

const YAHOO = {
  earningsTrend: {
    trend: [
      {
        period: "0q",
        endDate: "2026-10-31",
        epsTrend: { current: n(2.5), "7daysAgo": n(2.4), "30daysAgo": n(2.3) },
        epsRevisions: { upLast7days: n(2), upLast30days: n(4), downLast30days: n(0), downLast7Days: n(0) },
      },
    ],
  },
  defaultKeyStatistics: {},
  financialData: { targetMeanPrice: n(300), numberOfAnalystOpinions: n(40) },
};

/** Weekday closes for the last `days`, with a sine wiggle so returns vary. */
function daily(days: number, nowMs: number, phase = 0): PricePoint[] {
  const out: PricePoint[] = [];
  let c = 100;
  for (let i = days; i >= 1; i--) {
    const t = nowMs - i * DAY;
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    c *= 1 + Math.sin(i / 3 + phase) * 0.01;
    out.push({ t, v: c });
  }
  return out;
}

function harness(over: Partial<StockTabDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stock-tab-"));
  let clock = START;
  const calls = { yahoo: 0, model: 0, daily: 0, form4: 0 };
  const caller: GlossModelCaller = async (input) => {
    calls.model++;
    const ids = [...input.user.matchAll(/- id (\S+):/g)].map((m) => m[1]);
    return { text: JSON.stringify({ tags: ids.map((id) => ({ id, tag: "supports", en: "Estimates rose.", translation: "" })) }), input_tokens: 1, output_tokens: 1 };
  };
  const filing = (form: string, filedAt: string, accession: string, items: string[] = []): FilingRef => ({
    cik: "1",
    form,
    accession,
    filedAt,
    acceptedAt: null,
    items,
    primaryDocument: "doc.xml",
    url: `https://www.sec.gov/${accession}`,
  });
  const read: YahooEarningsRead = {
    dates: ["2026-11-18"],
    estimated: false,
    time: "amc",
    epsEstimate: 2.5,
    revenueEstimate: 50e9,
    lastSurprise: null,
    epsCurrency: "USD",
    revenueCurrency: "USD",
    consensus: { analysts: 40, low: 2.2, high: 2.8, thin: false },
    consensusPeriodEnd: "2026-10-31",
    consensusFiscal: "Q3 2027",
    quarters: [],
  };
  const deps: StockTabDeps = {
    dir,
    now: () => clock,
    fetchYahoo: async () => {
      calls.yahoo++;
      return YAHOO;
    },
    fetchDaily: async (symbol, startSec) => {
      calls.daily++;
      return daily(Math.round((clock / 1000 - startSec) / 86_400), clock, symbol.length);
    },
    filings: async () => [filing("4", "2026-10-12", "a-1"), filing("4", "2026-09-01", "a-old")],
    form4Xml: async () => {
      calls.form4++;
      return `<ownershipDocument><rptOwnerName>Jane Doe</rptOwnerName><officerTitle>CFO</officerTitle><nonDerivativeTransaction><transactionDate><value>2026-10-10</value></transactionDate><transactionCode>S</transactionCode><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>50</value></transactionPricePerShare></nonDerivativeTransaction></ownershipDocument>`;
    },
    graphEdges: async () => [],
    graphBuiltAt: async () => null,
    linksExtractedAt: () => null,
    earnings: {
      read: async (s) => (s === "NVDA" ? read : null),
      upcoming: async () => null,
      reaction: async () => null,
      fxRate: async () => null,
    },
    sectors: {
      get: async () => "Technology",
      known: () => [
        { symbol: "AAPL", sector: "Technology" },
        { symbol: "MSFT", sector: "Technology" },
        { symbol: "TINY", sector: "Technology" },
        { symbol: "XOM", sector: "Energy" },
      ],
    },
    marketCaps: async () => ({ AAPL: 3e12, MSFT: 3.5e12, TINY: 1e9 }),
    companyName: async (s) => `${s} Corp`,
    caller,
    configured: () => true,
    language: () => "en-US",
    ...over,
  };
  const svc = createStockTabService(deps);
  return { svc, dir, calls, advance: (ms: number) => (clock += ms), fresh: () => createStockTabService(deps) };
}

describe("stock tab service: changes", () => {
  it("lists revisions and the window's insider forms, reading Yahoo once a day", async () => {
    const h = harness();
    const a = await h.svc.changes("NVDA");
    assert.ok(a.ok);
    assert.deepEqual(a.changes.items.map((i) => i.kind), ["estimate_revision", "insider"]);
    assert.equal(a.changes.since, "2026-10-08");
    assert.equal(h.calls.form4, 1, "only the form filed in the window is read");
    await h.svc.changes("NVDA");
    h.svc.flush();
    const again = h.fresh();
    await again.changes("NVDA");
    assert.equal(h.calls.yahoo, 1);
    assert.equal(h.calls.form4, 1, "a filed form is read once");
  });

  it("opens the window at the last visit when it is older than a week", async () => {
    const h = harness();
    await h.svc.changes("NVDA");
    h.svc.flush();
    h.advance(20 * DAY);
    const later = h.fresh();
    const r = await later.changes("NVDA");
    assert.ok(r.ok);
    assert.equal(r.changes.sinceVisit, true);
    assert.equal(r.changes.since, "2026-10-15");
  });
});

describe("stock tab service: thesis tags", () => {
  it("makes one model call per thesis and items, and serves the copy after", async () => {
    const h = harness();
    const first = await h.svc.tags("NVDA", "Estimates keep rising.");
    assert.ok(first.ok);
    assert.equal(first.tags.length, 2);
    const second = await h.svc.tags("NVDA", "Estimates keep rising.");
    assert.deepEqual(second, first);
    assert.equal(h.calls.model, 1);
    await h.svc.tags("NVDA", "A different thesis.");
    assert.equal(h.calls.model, 2);
  });

  it("stops at the day's limit and says when no model is configured", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) await h.svc.tags("NVDA", `Thesis ${i}`);
    assert.equal(h.calls.model, 4);
    const off = harness({ configured: () => false });
    assert.deepEqual(await off.svc.tags("NVDA", "Thesis"), { ok: false, error: "not_configured" });
  });
});

describe("stock tab service: earnings", () => {
  it("takes the next report from Yahoo when the calendar row is out of range", async () => {
    const h = harness();
    const r = await h.svc.earnings("NVDA");
    assert.ok(r.ok);
    assert.equal(r.earnings.next?.date, "2026-11-18");
    assert.equal(r.earnings.next?.status, "confirmed");
    assert.equal(r.earnings.next?.consensus?.analysts, 40);
    assert.deepEqual(r.earnings.reports, []);
  });
});

describe("stock tab service: peers", () => {
  it("falls back to large companies in the sector when the graph has no competitor", async () => {
    const h = harness();
    const r = await h.svc.peers("NVDA");
    assert.ok(r.ok);
    assert.deepEqual(r.peers.peers.map((p) => [p.ticker, p.basis]), [
      ["MSFT", "sector"],
      ["AAPL", "sector"],
    ]);
    assert.ok(r.peers.peers.every((p) => p.corr1y !== null && p.corr3m !== null));
    const calls = h.calls.daily;
    await h.svc.peers("NVDA");
    assert.equal(h.calls.daily, calls, "closes are read once a day");
  });

  it("uses the filing's competitors when there are some", async () => {
    const h = harness({
      graphEdges: async () => [
        {
          root_ticker: "NVDA",
          counterparty_ticker: "AMD",
          counterparty_name: "Advanced Micro Devices",
          category: "competitor",
          strength_tier: "important",
          confidence: 0.95,
          evidence_quote: "q",
          source_url: "https://www.sec.gov/nvda-10k",
          accession_number: "1",
        },
      ],
    });
    const r = await h.svc.peers("NVDA");
    assert.ok(r.ok);
    assert.deepEqual(r.peers.peers.map((p) => [p.ticker, p.basis, p.name, p.filingUrl]), [["AMD", "filing", "Advanced Micro Devices", "https://www.sec.gov/nvda-10k"]]);
  });
});

describe("stock tab service: report history", () => {
  it("reaches back twelve reports through the 8-K releases, and keeps the read for the day", async () => {
    // Fourteen quarterly releases, every thirteen weeks back from a Wednesday.
    const releases: FilingRef[] = Array.from({ length: 14 }, (_, i) => {
      const filedAt = new Date(Date.parse("2026-08-05T12:00:00Z") - i * 91 * DAY).toISOString().slice(0, 10);
      return { cik: "1", form: "8-K", accession: `r-${i}`, filedAt, acceptedAt: null, items: ["2.02"], primaryDocument: "x.htm", url: `https://www.sec.gov/r-${i}` };
    });
    const h = harness({ filings: async () => releases });
    const rows = await h.svc.reportHistory("NVDA");
    assert.equal(rows.length, 12);
    assert.equal(rows[0]!.date, "2026-08-05");
    assert.ok(rows.every((r) => r.move !== null && r.source.kind === "filing"));
    const reads = h.calls.daily;
    await h.svc.reportHistory("NVDA");
    assert.equal(h.calls.daily, reads);
    // The section itself still shows eight.
    const e = await h.svc.earnings("NVDA");
    assert.ok(e.ok);
    assert.equal(e.earnings.reports.length, 8);
  });
});
