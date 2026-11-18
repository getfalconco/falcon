// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/load-events.test.ts
// A fake page fetcher stands in for Supabase and a fake Files API for Anthropic; nothing leaves the machine.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { withSourceId } from "../citations";
import { parseLoadPrices } from "../strategy-run";
import { deskToolCommand } from "./command";
import {
  CSV_COLUMNS,
  DEFAULT_COLUMNS,
  LOAD_EVENTS_LIMITS,
  csvField,
  decimal,
  estimateCsvBytes,
  eventsCsv,
  fetchAllEvents,
  fetchSide,
  filedSession,
  gzip,
  loadEventsCommand,
  loadEventsLabel,
  parseLoadEvents,
  parseLoadEventsCommand,
  resetLoadEvents,
  runLoadEvents,
  eventTickersInTurns,
  withEventTickers,
  type EventTableRow,
  type PageFetcher,
  type Side,
} from "./load-events";

beforeEach(() => resetLoadEvents());

const TICKERS = ["AAPL", "MSFT", "NVDA", "BRK.B", "JPM", "TSLA", "KTB", "PWP", "AMD", "XOM"];

/** A realistic row; i spreads dates over 2016-2026 and gives a deterministic return. */
function row(i: number, extra: Partial<EventTableRow> = {}): EventTableRow {
  const day = new Date(Date.UTC(2016, 0, 4) + Math.floor(i * 1.3) * 86_400_000 * 0.07).toISOString().slice(0, 10);
  const abn = (((i * 7919) % 400) - 200) / 1000; // -0.2 .. 0.2
  const t = TICKERS[i % TICKERS.length]!;
  return {
    id: i + 1,
    ticker: t,
    event_date: day,
    filed_at: `${day}T${i % 3 === 0 ? "11:05:00" : i % 3 === 1 ? "17:30:00" : "21:05:00"}+00:00`,
    accession: `0001760965-${String(16 + (i % 10)).padStart(2, "0")}-${String(i).padStart(6, "0")}`,
    filing_url: `https://www.sec.gov/Archives/edgar/data/1760965/0001760965${i}/0001760965-22-${String(i).padStart(6, "0")}-index.htm`,
    form: "8-K",
    sector_etf: "XLK",
    abnormal_return_d0_d1: abn,
    stock_return_d0_d1: abn + 0.0123456789,
    etf_return_d0_d1: 0.0123456789,
    abnormal_return_d0: abn / 2,
    stock_return_d0: abn / 2 + 0.004,
    etf_return_d0: 0.004,
    abnormal_return_d1: -0.0014922940410432,
    stock_return_d1: -0.0185420304121289,
    etf_return_d1: -0.0170497363710856,
    price_source: i % 4 ? "yahoo" : "mixed",
    flags: i % 50 === 0 ? ["suspicious_move"] : [],
    event_kind: "earnings",
    kind_reason: "only Item 2.02 8-K between the 2022-07-02 quarter end and its 10-Q filed 2022-08-08 (4 days before the 10-Q filed 2022-08-08)",
    ...extra,
  };
}

/** A fake table: filters by side on abnormal_return_d0_d1 at `min`, orders by (event_date, id), pages like PostgREST (optionally capped). */
function fakeTable(rows: EventTableRow[], opts: { min?: number; cap?: number; noCount?: boolean } = {}) {
  const calls: { side: Side; from: number; to: number; withCount: boolean }[] = [];
  const min = opts.min ?? 0;
  const fetch: PageFetcher = async (side, from, to, withCount) => {
    calls.push({ side, from, to, withCount });
    const v = (r: EventTableRow) => r.abnormal_return_d0_d1 ?? NaN;
    const match = rows
      .filter((r) => (side === "any" ? true : side === "up" ? (min > 0 ? v(r) >= min : v(r) > 0) : min > 0 ? v(r) <= -min : v(r) < 0))
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id);
    const end = Math.min(to, from + (opts.cap ?? Infinity) - 1);
    return { rows: match.slice(from, end + 1), count: withCount && !opts.noCount ? match.length : null };
  };
  return { fetch, calls };
}

const never = new AbortController().signal;

/* ------------------------------------------------------------------ parsing */

test("parseLoadEvents: defaults and the events.ts parsers", () => {
  const d = parseLoadEvents({});
  assert.deepEqual(d.kinds, ["earnings"]);
  assert.equal(d.min, 0);
  assert.equal(d.direction, "both");
  assert.equal(d.measure, "abnormal_return_d0_d1");
  assert.equal(d.includeFlagged, false);
  assert.deepEqual(d.columns, DEFAULT_COLUMNS);
  assert.ok(!d.columns.includes("filing_url") && !d.columns.includes("kind_reason"));

  const q = parseLoadEvents({ min_abs_return: "+10%", since: "2016", until: "2024-06", kinds: "all", sector: "Information Technology", tickers: "aapl, brk.b", measure: "d0", include_flagged: true, columns: ["filing_url"] });
  assert.equal(q.min, 0.1);
  assert.equal(q.direction, "up");
  assert.equal(q.since, "2016-01-01");
  assert.equal(q.until, "2024-06-30");
  assert.equal(q.kinds.length, 4);
  assert.equal(q.etf, "XLK");
  assert.deepEqual(q.tickers, ["AAPL", "BRK-B"]);
  assert.equal(q.measure, "abnormal_return_d0");
  assert.equal(q.includeFlagged, true);
  assert.deepEqual(q.columns, ["ticker", "event_date", "filing_url"]);
  assert.equal(parseLoadEvents({ min_abs_return: 0.1, direction: "down" }).direction, "down");
  assert.equal(parseLoadEvents({ min_abs_return: 10 }).min, 0.1);
  assert.equal(parseLoadEvents({ columns: "all" }).columns.length, CSV_COLUMNS.length);
  // Lists sent as JSON strings (as the model sometimes does).
  assert.deepEqual(parseLoadEvents({ columns: '["ticker", "event_date", "abnormal_return_d0"]' }).columns, ["ticker", "event_date", "abnormal_return_d0"]);
  assert.deepEqual(parseLoadEvents({ tickers: '["AAPL","MSFT"]', kinds: '["earnings","preliminary"]' }).tickers, ["AAPL", "MSFT"]);
  assert.deepEqual(parseLoadEvents({ kinds: '["earnings","preliminary"]' }).kinds, ["earnings", "preliminary"]);
  assert.equal(parseLoadEvents({ measure: "stock_d0" }).measure, "stock_return_d0");

  assert.throws(() => parseLoadEvents({ tickers: ["not a ticker"] }), /Not US tickers/);
  assert.throws(() => parseLoadEvents({ since: "2024", until: "2020" }), /since must be on or before until/);
  assert.throws(() => parseLoadEvents({ measure: "vwap" }), /measure "vwap" is unknown/);
  assert.throws(() => parseLoadEvents({ include_flagged: "yes" }), /include_flagged/);
  assert.throws(() => parseLoadEvents({ min_abs_return: "+10%", direction: "down" }), /says up/);
  assert.throws(() => parseLoadEvents({ columns: ["price"] }), /column "price" is unknown/);
  assert.throws(() => parseLoadEvents({ kinds: "dividends" }), /kinds "dividends" is unknown/);
  const many = Array.from({ length: LOAD_EVENTS_LIMITS.tickers + 1 }, (_, i) => `T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + Math.floor(i / 676))}`);
  assert.throws(() => parseLoadEvents({ tickers: many }), /At most 600 tickers/);
});

test("slash form: /load_events --min-return 10% --since 2016 and the tool row's command", () => {
  const a = parseLoadEventsCommand("/load_events --min-return 10% --since 2016");
  assert.deepEqual(a, { min_abs_return: "10%", since: "2016" });
  const q = parseLoadEvents(a);
  assert.equal(q.min, 0.1);
  assert.equal(q.since, "2016-01-01");

  const b = parseLoadEventsCommand("/load_events --min-return 10% --up --measure d0 --since 2016 --until 2020 --kinds all --sector XLK --tickers AAPL,MSFT --include-flagged --columns default,filing_url")!;
  const qb = parseLoadEvents(b);
  assert.equal(qb.direction, "up");
  assert.equal(qb.measure, "abnormal_return_d0");
  assert.equal(qb.kinds.length, 4);
  assert.equal(qb.etf, "XLK");
  assert.deepEqual(qb.tickers, ["AAPL", "MSFT"]);
  assert.equal(qb.includeFlagged, true);
  assert.ok(qb.columns.includes("filing_url") && qb.columns.includes("abnormal_return_d0"));
  assert.equal(parseLoadEventsCommand("/events NVDA"), null);

  assert.equal(loadEventsCommand(a), "/load_events --min-return 10% --since 2016-01-01");
  assert.equal(loadEventsCommand(b), "/load_events --tickers AAPL,MSFT --min-return +10% --measure d0 --since 2016-01-01 --until 2020-12-31 --kinds all --sector XLK --include-flagged");
  assert.equal(loadEventsCommand({}), "/load_events");
  assert.equal(loadEventsCommand({ measure: "nope" }), "/load_events");
  assert.equal(deskToolCommand("load_events", a).cmd, "/load_events --min-return 10% --since 2016-01-01");
  // The command parses back to the same query.
  assert.deepEqual(parseLoadEvents(parseLoadEventsCommand(loadEventsCommand(b).replace("--include-flagged", "--include-flagged --columns default,filing_url"))), qb);

  assert.equal(loadEventsLabel(a, "running"), "Loading earnings events (±10% or more, 2016-01-01 to today)");
  assert.equal(loadEventsLabel(b, "done", 4478), "Loaded 4,478 events (+10% or more on d0, AAPL, MSFT, XLK, 2016-01-01 to 2020-12-31)");
});

/* ------------------------------------------------------------------ CSV */

test("CSV: escaping, decimals, flags, tickers, sessions", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField(" edge"), '" edge"');
  assert.equal(csvField(null), "");
  assert.equal(decimal(0.0339063901768323), "0.033906");
  assert.equal(decimal(-0.0000001), "0");
  assert.equal(decimal(0.1), "0.1");
  assert.equal(decimal(null), "");
  assert.equal(decimal(Number.NaN), "");

  // 11:05 UTC in August = 07:05 ET (pre-market); 17:30 UTC = 13:30 ET (intraday); a Friday 21:05 UTC filing with a Monday event date = after close.
  assert.deepEqual(filedSession("2022-08-04T11:05:00+00:00", "2022-08-04"), { session: "pre_market", et: "2022-08-04 07:05", utc: "2022-08-04T11:05:00Z" });
  assert.equal(filedSession("2022-08-04T17:30:00+00:00", "2022-08-04").session, "intraday");
  assert.equal(filedSession("2022-08-05T21:05:00+00:00", "2022-08-08").session, "after_close");
  assert.equal(filedSession("2022-08-06T15:00:00+00:00", "2022-08-08").session, "after_close");
  assert.equal(filedSession(null, "2022-08-08").session, null);

  const rows = [
    row(0, { ticker: "BRK.B", kind_reason: 'text, with "quotes"\nand a line', flags: ["suspicious_move", "amended"], abnormal_return_d1: null }),
    row(1, { event_kind: null }),
  ];
  const csv = eventsCsv(rows, ["ticker", "event_date", "filed_at", "filed_session", "event_kind", "abnormal_return_d1", "flags", "kind_reason"]);
  const [header, first] = csv.split("\n");
  assert.equal(header, "ticker,event_date,filed_at,filed_session,event_kind,abnormal_return_d1,flags,kind_reason");
  assert.ok(first!.startsWith(`BRK-B,${rows[0]!.event_date},${rows[0]!.event_date}T11:05:00Z,`));
  assert.ok(first!.includes(",earnings,,suspicious_move|amended,"));
  assert.ok(csv.includes('"text, with ""quotes""\nand a line"'));
  // A row without a kind reads as earnings (as /events does).
  assert.ok(csv.split("\n").slice(-1)[0]!.includes(",earnings,"));
});

test("size: the estimate tracks real rows, and the whole table fits gzipped", async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => row(i));
  for (const cols of [DEFAULT_COLUMNS, [...CSV_COLUMNS]]) {
    const csv = eventsCsv(rows, cols);
    const actual = Buffer.byteLength(csv);
    const est = estimateCsvBytes(rows.length, cols);
    assert.ok(Math.abs(est - actual) / actual < 0.25, `estimate ${est} vs actual ${actual} (${cols.length} columns)`);
  }
  // The whole table (54,300 rows in Nov 2026) with every column stays far under the guard.
  assert.ok(estimateCsvBytes(54_300, [...CSV_COLUMNS]) < LOAD_EVENTS_LIMITS.maxCsvBytes / 2);
  const csv = eventsCsv(rows, DEFAULT_COLUMNS);
  const gz = await gzip(csv);
  assert.equal(gunzipSync(gz).toString("utf8"), csv);
  assert.ok(gz.length < Buffer.byteLength(csv) / 2.5, `gzip ${gz.length} of ${Buffer.byteLength(csv)}`);
});

/* ------------------------------------------------------------------ paging */

test("paging: more than 1,000 rows, in order, every row once", async () => {
  const rows = Array.from({ length: 2537 }, (_, i) => row(i)).reverse();
  const t = fakeTable(rows);
  const got = await fetchAllEvents(t.fetch, { min: 0, direction: "both" }, never);
  assert.equal(got.rows.length, 2537);
  assert.equal(new Set(got.rows.map((r) => r.id)).size, 2537);
  assert.equal(got.pages, 3);
  for (let k = 1; k < got.rows.length; k++) assert.ok(got.rows[k - 1]!.event_date <= got.rows[k]!.event_date);
  assert.deepEqual(
    t.calls.map((c) => [c.from, c.to, c.withCount]),
    [
      [0, 999, true],
      [1000, 1999, false],
      [2000, 2999, false],
    ],
  );
});

test("paging: a server capping pages below 1,000, no count, rows added while reading, the row limit", async () => {
  const rows = Array.from({ length: 2300 }, (_, i) => row(i));
  const capped = fakeTable(rows, { cap: 400 });
  const a = await fetchSide(capped.fetch, "any", never);
  assert.equal(a.rows.length, 2300);
  assert.equal(new Set(a.rows.map((r) => r.id)).size, 2300);

  const noCount = fakeTable(rows, { noCount: true });
  const b = await fetchSide(noCount.fetch, "any", never);
  assert.equal(b.rows.length, 2300);
  assert.equal(b.total, null);

  // Rows added after the count (the count says 2,000, the table has 2,300 by the last page): read on to the end.
  const stale: PageFetcher = async (side, from, to, withCount) => ({ ...(await fakeTable(rows).fetch(side, from, to, false, never)), count: withCount ? 2000 : null });
  assert.equal((await fetchSide(stale, "any", never)).rows.length, 2300);

  // Exactly a multiple of the page: one extra (empty) read, nothing lost.
  const even = fakeTable(Array.from({ length: 2000 }, (_, i) => row(i)));
  assert.equal((await fetchSide(even.fetch, "any", never)).rows.length, 2000);

  await assert.rejects(fetchSide(fakeTable(rows).fetch, "any", never, { maxRows: 1000 }), /2,300 events match; at most 1,000/);
});

test("paging: both directions with a threshold read two sides and merge them", async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => row(i));
  const t = fakeTable(rows, { min: 0.1 });
  const got = await fetchAllEvents(t.fetch, { min: 0.1, direction: "both" }, never);
  const want = rows.filter((r) => Math.abs(r.abnormal_return_d0_d1!) >= 0.1).length;
  assert.equal(got.rows.length, want);
  assert.deepEqual([...new Set(t.calls.map((c) => c.side))].sort(), ["down", "up"]);
  assert.ok(got.rows.every((r) => Math.abs(r.abnormal_return_d0_d1!) >= 0.1));
});

/* ------------------------------------------------------------------ run */

function fakeClient() {
  const uploads: { name: string; type: string; bytes: Uint8Array }[] = [];
  const client = {
    files: {
      upload: async ({ file }: { file: File }) => {
        uploads.push({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
        return { id: `file_${uploads.length}` };
      },
    },
  };
  return { client: client as unknown as Parameters<typeof runLoadEvents>[0], uploads };
}

test("runLoadEvents: uploads the whole match as gzipped CSV and tells the model what it holds", async () => {
  const rows = Array.from({ length: 2537 }, (_, i) => row(i));
  const t = fakeTable(rows);
  const { client, uploads } = fakeClient();
  const pages = { fetch: t.fetch, countFlagged: async () => 12 };
  const r = await runLoadEvents(client, { since: "2016" }, never, { pages });
  assert.equal(r.ok, true, r.content);
  assert.equal(r.fileId, "file_1");
  assert.match(uploads[0]!.name, /^events_[0-9a-f]{6}\.csv\.gz$/);
  assert.equal(uploads[0]!.type, "application/gzip");
  const csv = gunzipSync(uploads[0]!.bytes).toString("utf8");
  assert.equal(csv.split("\n").length, 2538);
  const c = JSON.parse(r.content);
  assert.equal(c.rows, 2537);
  assert.ok(c.path.includes(c.file));
  assert.deepEqual(Object.keys(c.columns), DEFAULT_COLUMNS);
  assert.match(c.columns.event_date, /4:00 pm ET/);
  assert.match(c.columns.abnormal_return_d0, /sector|etf_return_d0/);
  assert.equal(c.counts.tickers, TICKERS.length);
  assert.ok(c.ticker_list.includes("BRK-B"));
  assert.equal(c.left_out_flagged, 12);
  assert.equal(c.preview.split("\n").length, 6);
  assert.equal(c.size.gzip_bytes, uploads[0]!.bytes.length);
  assert.match(c.source, /SEC 8-K Item 2\.02/);
  assert.ok(c.notes.some((n: string) => /Point in time/.test(n)));
  assert.match(r.label, /^Loaded 2,537 earnings events/);
  assert.match(r.log!, /2,537 events/);

  // Same query again (a resumed reply): no reads, a new upload.
  const before = t.calls.length;
  const again = await runLoadEvents(client, { since: "2016" }, never, { pages });
  assert.equal(again.ok, true);
  assert.equal(t.calls.length, before);
  assert.equal(uploads.length, 2);
});

test("runLoadEvents: bad input, no match, too many rows, a failing store", async () => {
  const { client, uploads } = fakeClient();
  const bad = await runLoadEvents(client, { measure: "vwap" }, never);
  assert.equal(bad.ok, false);
  assert.match(JSON.parse(bad.content).error, /measure/);

  const none = await runLoadEvents(client, { min_abs_return: "90%" }, never, { pages: { fetch: fakeTable([], { min: 0.9 }).fetch, countFlagged: async () => 0 } });
  assert.equal(none.ok, true);
  assert.equal(JSON.parse(none.content).rows, 0);
  assert.equal(uploads.length, 0);

  const huge: PageFetcher = async () => ({ rows: [row(0)], count: 200_000 });
  const big = await runLoadEvents(client, {}, never, { pages: { fetch: huge, countFlagged: async () => 0 } });
  assert.equal(big.ok, false);
  assert.match(JSON.parse(big.content).error, /200,000 events match/);

  const broken: PageFetcher = async () => {
    throw new Error("boom");
  };
  const orig = console.error;
  console.error = () => undefined;
  try {
    const down = await runLoadEvents(client, { kinds: "all" }, never, { pages: { fetch: broken, countFlagged: async () => 0 } });
    assert.equal(down.ok, false);
    assert.match(JSON.parse(down.content).error, /could not be prepared/);
  } finally {
    console.error = orig;
  }
});

test("load_prices tickers_from_events: the tickers of an earlier load_events file, past the 600 cap", () => {
  const many = Array.from({ length: 1074 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + Math.floor(i / 676))}`);
  const result = (file: string, tickers: string[]) => withSourceId("t1", JSON.stringify({ file, rows: 10, ticker_list: tickers.join(",") }));
  const turns = [
    { role: "user", content: "test it" },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "load_events", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: result("events_aaaaaa.csv.gz", ["AAPL", "MSFT"]) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "b", name: "load_events", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: result("events_bbbbbb.csv.gz", many) }] },
  ];
  assert.deepEqual(eventTickersInTurns(turns, "events_aaaaaa.csv.gz")?.tickers, ["AAPL", "MSFT"]);
  assert.equal(eventTickersInTurns(turns, "unknown")?.file, "events_bbbbbb.csv.gz");
  assert.equal(eventTickersInTurns(turns.slice(0, 2), "x"), null);

  const plain = { tickers: ["AAPL"], start: "2020-01-01" };
  assert.equal(withEventTickers(plain, turns).input, plain);
  const missing = withEventTickers({ tickers_from_events: "events_x.csv.gz", start: "2020-01-01" }, turns.slice(0, 1));
  assert.match(missing.error!, /Call load_events first/);
  const got = withEventTickers({ tickers_from_events: "events_bbbbbb.csv.gz", tickers: ["QQQ"], start: "2016-11-17" }, turns);
  const p = parseLoadPrices(got.input, "2026-11-17");
  assert.equal(p.tickers.length, 1074 + 2); // + QQQ + SPY
  // Without the marker the 600 cap holds. With it, "since 2016" is one call (any span from 2015-01-01 to today);
  // a start before 2015 still allows at most 10 years.
  assert.throws(() => parseLoadPrices({ tickers: many, start: "2016-11-17" }, "2026-11-17"), /At most 600 tickers/);
  const since2016 = parseLoadPrices({ ...(got.input as object), start: "2016-01-01" }, "2026-11-17");
  assert.equal(since2016.start, "2016-01-01");
  assert.equal(since2016.end, "2026-11-17");
  assert.equal(since2016.from, "2014-11-27");
  assert.equal(parseLoadPrices({ ...(got.input as object), start: "2015-01-01" }, "2026-11-17").start, "2015-01-01");
  assert.throws(() => parseLoadPrices({ ...(got.input as object), start: "2014-06-01" }, "2026-11-17"), /at most 10 years/);
  assert.equal(parseLoadPrices({ ...(got.input as object), start: "2010-01-01", end: "2019-12-31" }, "2026-11-17").start, "2010-01-01");
});
