// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/events.test.ts
// A fake in-memory store stands in for Supabase; nothing is read from or written to the real table.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeChart } from "../chart-spec";
import { deskToolCommand } from "./command";
import {
  EventsMissingError,
  eventsLabel,
  eventsTool,
  filedText,
  isCaveated,
  isMissingTable,
  parseDateBound,
  parseEventsCommand,
  parseEventsInput,
  parseKinds,
  parseReturn,
  parseSector,
  resetEvents,
  runEventsTool,
  summarizeEvents,
  tickerVariants,
  type EventRow,
  type EventsStore,
  type RowQuery,
} from "./events";

const row = (ticker: string, date: string, abn: number | null, extra: Partial<EventRow> = {}): EventRow => ({
  ticker,
  event_date: date,
  filed_at: `${date}T21:05:00Z`,
  accession: `${ticker}-${date}`,
  filing_url: `https://www.sec.gov/Archives/edgar/data/1/${ticker}-${date}.htm`,
  form: "8-K",
  sector_etf: ticker === "JPM" ? "XLF" : "XLK",
  abnormal_return_d0_d1: abn,
  stock_return_d0_d1: abn === null ? null : abn + 0.01,
  etf_return_d0_d1: abn === null ? null : 0.01,
  price_source: "databento",
  flags: null,
  ...extra,
});

/** Applies a RowQuery the way the Supabase store does. */
function fakeStore(rows: EventRow[] | "missing", calls: RowQuery[] = []): EventsStore {
  return {
    async rows(q) {
      calls.push(q);
      if (rows === "missing") throw new EventsMissingError("relation does not exist");
      let r = rows.filter(
        (x) =>
          (!q.tickers || q.tickers.includes(x.ticker)) &&
          (!q.since || x.event_date >= q.since) &&
          (!q.until || x.event_date <= q.until) &&
          (!q.etf || x.sector_etf === q.etf) &&
          (!q.kinds || q.kinds.includes((x.event_kind ?? "earnings") as never)) &&
          (q.caveat === "any" || (q.caveat === "only") === isCaveated(x)),
      );
      const a = (x: EventRow) => x.abnormal_return_d0_d1;
      if (q.side === "up") r = r.filter((x) => a(x) !== null && a(x)! >= q.min);
      if (q.side === "down") r = r.filter((x) => a(x) !== null && (q.min > 0 ? a(x)! <= -q.min : a(x)! < 0));
      r.sort((x, y) => (q.order === "date_desc" ? y.event_date.localeCompare(x.event_date) : q.order === "abn_desc" ? a(y)! - a(x)! : a(x)! - a(y)!));
      return { rows: r.slice(0, q.limit), count: r.length };
    },
    async hasAny() {
      if (rows === "missing") throw new EventsMissingError("relation does not exist");
      return rows.length > 0;
    },
  };
}

const signal = new AbortController().signal;

const NVDA = [
  row("NVDA", "2024-02-22", 0.12),
  row("NVDA", "2024-05-23", 0.08),
  row("NVDA", "2024-08-29", -0.07),
  row("NVDA", "2024-11-21", -0.01),
  row("NVDA", "2025-02-27", -0.09, { flags: ["gap_fill"] }),
  row("NVDA", "2025-05-29", 0.03),
  row("NVDA", "2025-08-28", null),
];
const ALL = [...NVDA, row("AMD", "2024-01-31", -0.11), row("AMD", "2023-05-03", 0.2), row("JPM", "2024-04-12", -0.16), row("JPM", "2024-07-12", 0.04)];
// In doubt (left out of summaries and screens, listed apart) and an extreme move to check.
const FLAGGED = [
  ...ALL,
  row("NVDA", "2023-08-23", 0.3, { flags: ["price_source_disagree"] }),
  row("AMD", "2024-10-29", -0.4, { flags: ["cik_mismatch"] }),
  row("SMCI", "2024-08-06", -0.6, { flags: ["suspicious_move"] }),
];

beforeEach(() => resetEvents());

/* ------------------------------------------------------------------ parsing */

test("parseReturn: percent, decimal and signed forms", () => {
  assert.deepEqual(parseReturn("10%"), { value: 0.1, sign: null });
  assert.deepEqual(parseReturn(10), { value: 0.1, sign: null });
  assert.deepEqual(parseReturn(0.1), { value: 0.1, sign: null });
  assert.deepEqual(parseReturn("0.1"), { value: 0.1, sign: null });
  assert.deepEqual(parseReturn("7.5%"), { value: 0.075, sign: null });
  assert.deepEqual(parseReturn("+15%"), { value: 0.15, sign: "up" });
  assert.deepEqual(parseReturn("-15"), { value: 0.15, sign: "down" });
  assert.deepEqual(parseReturn(-0.05), { value: 0.05, sign: "down" });
  assert.deepEqual(parseReturn("1"), { value: 0.01, sign: null });
  assert.deepEqual(parseReturn("0.5%"), { value: 0.005, sign: null });
  assert.throws(() => parseReturn("ten"), /not a return/);
  assert.throws(() => parseReturn("900%"), /at most 500%/);
  assert.throws(() => parseReturn(true), /must be a number/);
});

test("parseDateBound: whole dates, years and months as period bounds", () => {
  assert.equal(parseDateBound("2024-01-01", "since"), "2024-01-01");
  assert.equal(parseDateBound("2024", "since"), "2024-01-01");
  assert.equal(parseDateBound("2024", "until"), "2024-12-31");
  assert.equal(parseDateBound("2024-02", "until"), "2024-02-29");
  assert.equal(parseDateBound("2024-3-5", "since"), "2024-03-05");
  assert.equal(parseDateBound(undefined, "since"), null);
  assert.throws(() => parseDateBound("2024-02-30", "since"), /not a calendar date/);
  assert.throws(() => parseDateBound("last year", "until"), /like 2024-01-01/);
});

test("parseSector: GICS names, ETF symbols, unknown names", () => {
  assert.equal(parseSector("Information Technology"), "XLK");
  assert.equal(parseSector("health care"), "XLV");
  assert.equal(parseSector("tech"), "XLK");
  assert.equal(parseSector("smh"), "SMH");
  assert.equal(parseSector(""), null);
  assert.throws(() => parseSector("semiconductor equipment"), /unknown/);
});

test("parseEventsInput: one ticker is its history; a threshold, direction, sector or list is a screen", () => {
  assert.deepEqual(parseEventsInput({ ticker: "nvda" }), { mode: "ticker", ticker: "NVDA", since: null, until: null, limit: 12, kinds: ["earnings"] });
  assert.deepEqual(parseEventsInput({ ticker: "BRK.B", limit: 200 }), { mode: "ticker", ticker: "BRK-B", since: null, until: null, limit: 60, kinds: ["earnings"] });
  assert.deepEqual(parseEventsInput({ min_abs_return: "10%", since: "2024-01-01" }), {
    mode: "screen",
    tickers: null,
    min: 0.1,
    direction: "both",
    since: "2024-01-01",
    until: null,
    etf: null,
    limit: 25,
    kinds: ["earnings"],
  });
  const signed = parseEventsInput({ min_abs_return: "-15%", sector: "Financials", ticker: "jpm, bac" });
  assert.equal(signed.mode, "screen");
  assert.deepEqual(signed.mode === "screen" && [signed.tickers, signed.min, signed.direction, signed.etf], [["JPM", "BAC"], 0.15, "down", "XLF"]);
  assert.equal(parseEventsInput({ ticker: "NVDA", direction: "up" }).mode, "screen");
  assert.equal(parseEventsInput({ ticker: "NVDA", min_abs_return: 0.05 }).mode, "screen");
  assert.equal(parseEventsInput({}).mode, "screen");
  assert.throws(() => parseEventsInput({ ticker: "Nvidia Corp" }), /not a US stock ticker/);
  assert.throws(() => parseEventsInput({ min_abs_return: "+10%", direction: "down" }), /says up but direction says down/);
  assert.throws(() => parseEventsInput({ direction: "sideways" }), /direction must be/);
  assert.throws(() => parseEventsInput({ since: "2025-01-01", until: "2024-01-01" }), /since must be on or before until/);
  assert.throws(() => parseEventsInput({ ticker: "NVDA", limit: 0 }), /limit must be/);
  assert.throws(() => parseEventsInput({ ticker: Array.from({ length: 26 }, (_, k) => `T${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))}`).join(",") }), /At most 25/);
});

test("parseKinds: earnings by default, lists, all, unknown names", () => {
  assert.deepEqual(parseKinds(undefined), ["earnings"]);
  assert.deepEqual(parseKinds(""), ["earnings"]);
  assert.deepEqual(parseKinds("all"), ["earnings", "preliminary", "operational_update", "other"]);
  assert.deepEqual(parseKinds(["other", "Earnings"]), ["earnings", "other"]);
  assert.deepEqual(parseKinds("operational, preliminary"), ["preliminary", "operational_update"]);
  assert.throws(() => parseKinds("deliveries"), /kinds "deliveries" is unknown/);
  assert.throws(() => parseKinds(5), /kinds must be/);
  assert.deepEqual(parseEventsInput({ ticker: "TSLA", kinds: "all" }), { mode: "ticker", ticker: "TSLA", since: null, until: null, limit: 12, kinds: ["earnings", "preliminary", "operational_update", "other"] });
});

test("parseEventsCommand: the slash forms a member types", () => {
  assert.deepEqual(parseEventsCommand("/events NVDA"), { ticker: "NVDA" });
  assert.deepEqual(parseEventsCommand("/events --min-return 10% --since 2024-01-01"), { min_abs_return: "10%", since: "2024-01-01" });
  assert.deepEqual(parseEventsCommand("/events --min-return=-15% --until 2025 --sector XLK --limit 40"), { min_abs_return: "-15%", until: "2025", sector: "XLK", limit: 40 });
  assert.deepEqual(parseEventsCommand("/events NVDA,AMD --up --min 5"), { ticker: "NVDA,AMD", direction: "up", min_abs_return: "5" });
  assert.deepEqual(parseEventsCommand("/events --sector Health_Care --down"), { sector: "Health Care", direction: "down" });
  assert.deepEqual(parseEventsCommand("/events TSLA --kinds all"), { ticker: "TSLA", kinds: "all" });
  assert.deepEqual(parseEventsCommand("/events TSLA --all"), { ticker: "TSLA", kinds: "all" });
  assert.equal(parseEventsCommand("/eventsx NVDA"), null);
  assert.equal(parseEventsCommand("events NVDA"), null);
  // Every slash form parses into valid tool input.
  assert.equal(parseEventsInput(parseEventsCommand("/events NVDA")).mode, "ticker");
  assert.equal(parseEventsInput(parseEventsCommand("/events --min-return 10% --since 2024-01-01")).mode, "screen");
});

test("tool row command and labels", () => {
  assert.equal(deskToolCommand("earnings_events", { ticker: "NVDA" }).cmd, "/events NVDA");
  assert.equal(deskToolCommand("earnings_events", { ticker: "brk-b", since: "2020" }).cmd, "/events BRK.B --since 2020-01-01");
  assert.equal(deskToolCommand("earnings_events", { min_abs_return: 0.1, since: "2024-01-01" }).cmd, "/events --min-return 10% --since 2024-01-01");
  assert.equal(deskToolCommand("earnings_events", { min_abs_return: 15, direction: "down", sector: "Information Technology" }).cmd, "/events --min-return -15% --sector XLK");
  assert.equal(deskToolCommand("earnings_events", { ticker: "NVDA,AMD", direction: "up" }).cmd, "/events NVDA,AMD --up");
  assert.equal(deskToolCommand("earnings_events", { ticker: "Nvidia Corp" }).cmd, "/events NVIDIA CORP");
  // The command parses back into the same query.
  assert.equal(deskToolCommand("earnings_events", { ticker: "TSLA", kinds: "all" }).cmd, "/events TSLA --kinds all");
  assert.equal(deskToolCommand("earnings_events", { min_abs_return: 0.1, kinds: ["operational_update"] }).cmd, "/events --min-return 10% --kinds operational_update");
  for (const input of [
    { ticker: "NVDA" },
    { min_abs_return: "7.5%", direction: "up", since: "2023-06-01", until: "2024-06-30", sector: "XLF" },
    { ticker: "NVDA,AMD", min_abs_return: 0.1 },
    { ticker: "TSLA", kinds: "all" },
    { min_abs_return: 0.1, kinds: "earnings,preliminary" },
  ]) {
    const back = parseEventsInput(parseEventsCommand(deskToolCommand("earnings_events", input).cmd));
    assert.deepEqual(back, parseEventsInput(input));
  }
  assert.equal(eventsLabel({ ticker: "nvda" }, "running"), "Reading NVDA earnings reactions");
  assert.equal(eventsLabel({ min_abs_return: "10%" }), "Screened earnings reactions of ±10% or more");
  assert.equal(eventsLabel({ min_abs_return: "-10%" }, "running"), "Screening earnings reactions of -10% or more");
});

/* ------------------------------------------------------------------ math */

test("summarizeEvents: mean, median, typical move, hit rate, extremes, latest", () => {
  const s = summarizeEvents([...NVDA].reverse());
  assert.equal(s.events, 7);
  assert.equal(s.with_returns, 6);
  // abn: .12 .08 -.07 -.01 -.09 .03 -> mean 0.01, median (-.01 + .03)/2 = .01
  assert.equal(s.mean_abn, 1);
  assert.equal(s.median_abn, 1);
  // |abn| mean = .40/6
  assert.equal(s.avg_abs_abn, 6.67);
  assert.equal(s.median_abs_abn, 7.5);
  assert.equal(s.up_share, 50);
  assert.deepEqual(s.biggest_up, { date: "2024-02-22", abn: 12 });
  assert.deepEqual(s.biggest_down, { date: "2025-02-27", abn: -9 });
  // Newest with a return is 2025-05-29 (+3%): 5 of 6 by size, below the typical move.
  assert.deepEqual(s.latest, { date: "2025-05-29", abn: 3, vs_avg_abs: 0.45, abs_rank: "5 of 6", abs_percentile: 20 });
  const empty = summarizeEvents([]);
  assert.deepEqual([empty.events, empty.mean_abn, empty.up_share, empty.latest, empty.biggest_up], [0, null, null, null, null]);
});

test("filedText: New York time and session", () => {
  assert.equal(filedText("2024-02-21T21:20:00Z"), "2024-02-21 16:20 ET (after close)");
  assert.equal(filedText("2024-07-12T10:45:00Z"), "2024-07-12 06:45 ET (pre-market)");
  assert.equal(filedText("2024-07-12T15:00:00Z"), "2024-07-12 11:00 ET (market hours)");
  assert.equal(filedText(null), null);
});

test("isMissingTable and tickerVariants", () => {
  assert.equal(isMissingTable({ code: "42P01", message: 'relation "public.historical_events" does not exist' }), true);
  assert.equal(isMissingTable({ code: "PGRST205", message: "Could not find the table 'public.historical_events' in the schema cache" }), true);
  assert.equal(isMissingTable({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.deepEqual(tickerVariants(["BRK-B", "NVDA"]), ["BRK-B", "BRK.B", "NVDA"]);
});

/* ------------------------------------------------------------------ tool */

test("one ticker: newest first, limit, summary and a chart show_chart accepts", async () => {
  const out = (await eventsTool({ ticker: "NVDA", limit: 3 }, fakeStore(ALL), signal)) as any;
  assert.equal(out.ticker, "NVDA");
  assert.equal(out.sector_etf, "XLK");
  assert.equal(out.of, 7);
  assert.equal(out.shown, 3);
  assert.deepEqual(out.events.map((e: any) => e.date), ["2025-08-28", "2025-05-29", "2025-02-27"]);
  assert.deepEqual(out.events[2], {
    date: "2025-02-27",
    filed: "2025-02-27 16:05 ET (after close)",
    abn_d0: null,
    abn_d1: null,
    abn: -9,
    stock_d0: null,
    stock: -8,
    etf: 1,
    flags: ["gap_fill"],
    url: "https://www.sec.gov/Archives/edgar/data/1/NVDA-2025-02-27.htm",
    prices: "databento",
  });
  assert.equal(out.summary.avg_abs_abn, 6.67);
  assert.equal(out.eps_surprise, "not available yet");
  assert.match(out.source, /SEC EDGAR 8-K Item 2\.02 filings; returns computed by Falcon from daily closes \(Databento EQUS\.SUMMARY\)/);
  // The chart: oldest first, events without a return left out, valid for show_chart.
  assert.equal(out.chart.series[0].points.length, 6);
  assert.deepEqual(out.chart.series[0].points[0], ["2024-02-22", 12]);
  const chart = normalizeChart(out.chart);
  assert.ok(chart.ok, JSON.stringify(chart));
  // since / until narrow the history and the summary.
  const y2024 = (await eventsTool({ ticker: "NVDA", since: "2024", until: "2024" }, fakeStore(ALL), signal)) as any;
  assert.equal(y2024.of, 4);
  assert.equal(y2024.summary.up_share, 50);
});

test("screen: |abnormal| >= x since a date, both sides, largest first, with totals", async () => {
  const calls: RowQuery[] = [];
  const out = (await eventsTool({ min_abs_return: "10%", since: "2024-01-01" }, fakeStore(ALL, calls), signal)) as any;
  assert.deepEqual(calls.map((c) => [c.side, c.order, c.min, c.caveat]), [["up", "abn_desc", 0.1, "exclude"], ["down", "abn_asc", 0.1, "exclude"], ["up", "abn_desc", 0.1, "only"], ["down", "abn_asc", 0.1, "only"]]);
  assert.deepEqual(out.events.map((e: any) => [e.ticker, e.abn]), [["JPM", -16], ["NVDA", 12], ["AMD", -11]]);
  assert.deepEqual(out.totals, { matched: 3, up: 1, down: 2, companies: 3, mean_abs_abn: 13, median_abs_abn: 12 });
  assert.equal(out.events[0].etf_symbol, "XLF");
  assert.equal(out.filters.min_abs_return, "10%");
  // Signed: down only; sector; ticker list; limit.
  const down = (await eventsTool({ min_abs_return: "-5%" }, fakeStore(ALL), signal)) as any;
  assert.deepEqual(down.events.map((e: any) => e.abn), [-16, -11, -9, -7]);
  assert.equal(down.totals.up, undefined);
  assert.deepEqual(down.totals.flagged, { gap_fill: 1 });
  assert.equal(out.totals.flagged, undefined);
  const tech = (await eventsTool({ min_abs_return: 0.05, sector: "Information Technology", limit: 2 }, fakeStore(ALL), signal)) as any;
  assert.deepEqual(tech.events.map((e: any) => e.abn), [20, 12]);
  assert.equal(tech.totals.matched, 6);
  const list = (await eventsTool({ ticker: "AMD,JPM", direction: "up" }, fakeStore(ALL), signal)) as any;
  assert.deepEqual(list.events.map((e: any) => e.ticker), ["AMD", "JPM"]);
  const none = (await eventsTool({ min_abs_return: "50%" }, fakeStore(ALL), signal)) as any;
  assert.deepEqual([none.totals.matched, none.events.length], [0, 0]);
});

test("missing table and empty table: still loading, never an error", async () => {
  for (const store of [fakeStore("missing"), fakeStore([])]) {
    for (const input of [{ ticker: "NVDA" }, { min_abs_return: "10%", since: "2024-01-01" }]) {
      resetEvents();
      const out = (await eventsTool(input, store, signal)) as any;
      assert.equal(out.status, "loading");
      assert.match(out.note, /still loading/);
    }
  }
  const r = await runEventsTool({ ticker: "NVDA" }, { store: fakeStore("missing") });
  assert.equal(r.ok, true);
  assert.match(r.content, /still loading/);
  assert.equal(r.label, "Read NVDA earnings reactions");
  // A ticker the table does not cover, once it has data.
  const other = (await eventsTool({ ticker: "ZZZZ" }, fakeStore(ALL), signal)) as any;
  assert.deepEqual(other.events, []);
  assert.match(other.note, /no earnings events for ZZZZ/);
});

test("runEventsTool: bad input and store failures come back as errors", async () => {
  const bad = await runEventsTool({ ticker: "NVDA", since: "yesterday" }, { store: fakeStore(ALL) });
  assert.equal(bad.ok, false);
  assert.match(bad.content, /since must be a date/);
  const broken: EventsStore = { rows: async () => Promise.reject(new Error("boom")), hasAny: async () => true };
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await runEventsTool({ ticker: "NVDA" }, { store: broken });
    assert.equal(r.ok, false);
    assert.match(r.content, /unavailable right now/);
  } finally {
    console.error = orig;
  }
  // The result stays compact.
  const many = Array.from({ length: 60 }, (_, k) => row("NVDA", `20${16 + Math.floor(k / 4)}-0${1 + (k % 4) * 2}-15`, ((k % 7) - 3) / 50));
  const big = await runEventsTool({ ticker: "NVDA", limit: 60 }, { store: fakeStore(many) });
  assert.equal(big.ok, true);
  assert.ok(big.content.length <= 12_000);
});

test("caveated rows are left out of stats and listed apart; suspicious moves are marked", async () => {
  assert.equal(isCaveated(row("X", "2024-01-01", 0, { flags: ["amended", "cik_mismatch"] })), true);
  assert.equal(isCaveated(row("X", "2024-01-01", 0, { flags: ["suspicious_move"] })), false);
  const nvda = (await eventsTool({ ticker: "NVDA" }, fakeStore(FLAGGED), signal)) as any;
  // Same summary as without the +30% price_source_disagree row; that row only under caveated.
  assert.equal(nvda.of, 7);
  assert.equal(nvda.summary.avg_abs_abn, 6.67);
  assert.equal(nvda.summary.biggest_up.abn, 12);
  assert.deepEqual(nvda.caveated.map((e: any) => [e.date, e.abn]), [["2023-08-23", 30]]);
  assert.equal(nvda.chart.series[0].points.length, 6);
  assert.match(nvda.notes[0], /price_source_disagree/);
  const screen = (await eventsTool({ min_abs_return: "10%", since: "2024-01-01" }, fakeStore(FLAGGED), signal)) as any;
  assert.deepEqual(screen.events.map((e: any) => [e.ticker, e.abn, e.suspicious ?? false]), [["SMCI", -60, true], ["JPM", -16, false], ["NVDA", 12, false], ["AMD", -11, false]]);
  assert.equal(screen.totals.matched, 4);
  assert.deepEqual(screen.totals.flagged, { suspicious_move: 1 });
  assert.deepEqual([screen.caveated.count, screen.caveated.events.map((e: any) => e.abn)], [1, [-40]]);
  assert.equal(screen.notes.length, 2);
  // A ticker with only caveated rows, and one with none (foreign filers have no 8-K).
  const only = (await eventsTool({ ticker: "SMCI", since: "2025" }, fakeStore([...FLAGGED, row("SMCI", "2025-02-25", 0.1, { flags: ["cik_mismatch"] })]), signal)) as any;
  assert.deepEqual([only.events.length, only.caveated.length], [0, 1]);
  assert.match(only.note, /no clean earnings events for SMCI/);
  const tsm = (await eventsTool({ ticker: "TSM" }, fakeStore(FLAGGED), signal)) as any;
  assert.match(tsm.note, /Foreign private issuers .* file no 8-K/);
});

/* ------------------------------------------------------------------ kinds and single days */

/** TSLA-like: earnings releases and production/deliveries reports, with single-day moves. */
const day = (ticker: string, date: string, d0: number, d1: number, kind: string, extra: Partial<EventRow> = {}): EventRow => {
  const s0 = d0 + 0.005;
  const s1 = d1 + 0.002;
  const e0 = 0.005;
  const e1 = 0.002;
  const stock = (1 + s0) * (1 + s1) - 1;
  const etf = (1 + e0) * (1 + e1) - 1;
  return row(ticker, date, stock - etf, {
    stock_return_d0_d1: stock,
    etf_return_d0_d1: etf,
    abnormal_return_d0: s0 - e0,
    stock_return_d0: s0,
    etf_return_d0: e0,
    abnormal_return_d1: s1 - e1,
    stock_return_d1: s1,
    etf_return_d1: e1,
    event_kind: kind,
    kind_reason: kind === "earnings" ? "only Item 2.02 8-K in the window" : "text: production and deliveries; one of 2 Item 2.02 8-Ks before the 10-Q",
    sector_etf: "XLY",
    ...extra,
  });
};
const TSLA = [
  day("TSLA", "2026-10-22", -0.02, 0.01, "earnings"),
  day("TSLA", "2026-10-02", 0.05, 0.0, "operational_update"),
  day("TSLA", "2026-07-23", -0.08, -0.04, "earnings"),
  day("TSLA", "2026-07-02", -0.01, 0.0, "operational_update"),
  day("TSLA", "2026-04-23", 0.03, 0.01, "earnings"),
  day("TSLA", "2026-04-02", -0.06, -0.01, "operational_update"),
  day("TSLA", "2026-01-29", 0.01, 0.0, "earnings"),
  day("TSLA", "2026-01-02", -0.002, 0.0, "preliminary"),
];

test("one ticker: earnings only by default, the rest counted under excluded; d0, d1 and d0+d1 per event", async () => {
  const calls: RowQuery[] = [];
  const out = (await eventsTool({ ticker: "TSLA" }, fakeStore(TSLA, calls), signal)) as any;
  assert.equal(calls[0]!.kinds, null); // every kind read, filtered here so the excluded can be counted
  assert.equal(out.of, 4);
  assert.deepEqual(out.events.map((e: any) => e.date), ["2026-10-22", "2026-07-23", "2026-04-23", "2026-01-29"]);
  assert.deepEqual(out.excluded, { operational_update: 3, preliminary: 1 });
  assert.deepEqual(out.kinds, ["earnings"]);
  assert.match(out.notes[0], /not quarterly earnings releases/);
  const e = out.events[1];
  assert.deepEqual([e.abn_d0, e.abn_d1, e.stock_d0, e.kind], [-8, -4, -7.5, undefined]);
  // abn compounds each leg: close to, but not exactly, abn_d0 + abn_d1.
  assert.ok(Math.abs(e.abn - (e.abn_d0 + e.abn_d1)) < 0.5);
  // The event-day summary beside the two-day one.
  assert.equal(out.summary.d0.with_returns, 4);
  assert.equal(out.summary.d0.avg_abs_abn, 3.5); // |-2|, |-8|, |3|, |1| -> 3.5
  assert.deepEqual(out.summary.d0.biggest_down, { date: "2026-07-23", abn: -8 });
  assert.equal(out.summary.d0.avg_abs_stock, 3.5); // |-1.5|, |-7.5|, |3.5|, |1.5|
  assert.equal(out.summary.with_returns, 4);
  assert.ok(out.summary.avg_abs_abn > out.summary.d0.avg_abs_abn);
  // Chart: the event day and the two days, both valid for show_chart.
  assert.deepEqual(out.chart.series.map((s: any) => [s.name, s.points.length]), [["Event day", 4], ["Event day + next", 4]]);
  assert.ok(normalizeChart(out.chart).ok);

  const all = (await eventsTool({ ticker: "TSLA", kinds: "all" }, fakeStore(TSLA), signal)) as any;
  assert.equal(all.of, 8);
  assert.equal(all.excluded, undefined);
  assert.equal(all.events[1].kind, "operational_update");
  assert.match(all.events[1].kind_reason, /production and deliveries/);
  const ops = (await eventsTool({ ticker: "TSLA", kinds: ["operational_update"] }, fakeStore(TSLA), signal)) as any;
  assert.deepEqual(ops.events.map((x: any) => x.date), ["2026-10-02", "2026-07-02", "2026-04-02"]);
  assert.deepEqual(ops.excluded, { earnings: 4, preliminary: 1 });
});

test("screen: kinds go to the store; totals carry the event-day median", async () => {
  const calls: RowQuery[] = [];
  const out = (await eventsTool({ ticker: "TSLA,NVDA", min_abs_return: "5%" }, fakeStore([...TSLA, ...NVDA], calls), signal)) as any;
  assert.ok(calls.every((c) => JSON.stringify(c.kinds) === JSON.stringify(["earnings"])));
  // TSLA's +5% delivery day is not an earnings release, so it is not in the screen.
  assert.ok(!out.events.some((e: any) => e.date === "2026-10-02"));
  assert.ok(out.events.some((e: any) => e.ticker === "TSLA" && e.date === "2026-07-23"));
  assert.equal(typeof out.totals.median_abs_abn_d0, "number");
  assert.deepEqual(out.filters.kinds, ["earnings"]);
  const all = (await eventsTool({ ticker: "TSLA", min_abs_return: "4%", kinds: "all" }, fakeStore(TSLA), signal)) as any;
  assert.ok(all.events.some((e: any) => e.date === "2026-10-02" && e.kind === "operational_update"));
});

test("a row without a kind counts as earnings", async () => {
  const out = (await eventsTool({ ticker: "NVDA" }, fakeStore(NVDA), signal)) as any;
  assert.equal(out.of, 7);
  assert.equal(out.excluded, undefined);
});
