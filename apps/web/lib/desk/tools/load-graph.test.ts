// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/load-graph.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { knownAsOf, parseAsOf } from "../../workspace/graph-pit";
import { deskToolCommand } from "./command";
import { graphCsv, loadGraphCommand, parseLoadGraph, parseLoadGraphCommand, runLoadGraph, selectRows, type PitRow, type PitRowsFile } from "./load-graph";

const row = (from: string, to: string, rel: string, first: string, ended = "", current = 1, basis = "history"): PitRow => [from, to, rel, "marginal", first, "0000000000-00-000000", "10-K", first, ended, 1, 1, basis, current, "https://www.sec.gov/x.htm", `${from} names ${to}, "quoted"`];

const rows: PitRow[] = [
  row("NVDA", "TSM", "supplier", "2014-03-13"),
  row("NVDA", "MU", "supplier", "2018-02-28"),
  row("NVDA", "MSFT", "customer", "2021-02-26"),
  row("NVDA", "ARM", "competitor", "2014-03-13", "2019-02-21", 0),
  row("NVDA", "TXN", "competitor", "2014-03-13", "2018-02-28", 0),
  row("BRK.B", "KO", "supplier", "2026-02-25", "", 1, "source"),
];

test("parseAsOf: days, months, years; impossible dates refused", () => {
  assert.equal(parseAsOf("2018-06-30"), "2018-06-30");
  assert.equal(parseAsOf("2018-06"), "2018-06-30");
  assert.equal(parseAsOf("2016-02"), "2016-02-29");
  assert.equal(parseAsOf("2018"), "2018-12-31");
  assert.equal(parseAsOf(2018), "2018-12-31");
  assert.equal(parseAsOf("2018-02-30"), null);
  assert.equal(parseAsOf("30/06/2018"), null);
  assert.equal(parseAsOf(""), null);
});

test("knownAsOf: first seen on or before, and not ended by then unless asked", () => {
  assert.ok(knownAsOf({ firstSeen: "2018-06-30", endedAt: null }, "2018-06-30"));
  assert.ok(!knownAsOf({ firstSeen: "2018-07-01", endedAt: null }, "2018-06-30"));
  assert.ok(!knownAsOf({ firstSeen: "2014-03-13", endedAt: "2018-02-28" }, "2018-06-30"));
  assert.ok(knownAsOf({ firstSeen: "2014-03-13", endedAt: "2018-02-28" }, "2018-06-30", true));
  assert.ok(knownAsOf({ firstSeen: "2014-03-13", endedAt: "2019-02-21" }, "2018-06-30"));
});

test("selectRows: as of a date, by ticker either end, by relation", () => {
  const q = parseLoadGraph({ as_of: "2018-06-30" });
  assert.deepEqual(selectRows(rows, q).map((r) => r[1]), ["TSM", "MU", "ARM"]);
  assert.deepEqual(selectRows(rows, parseLoadGraph({ as_of: "2018-06-30", include_ended: true })).map((r) => r[1]), ["TSM", "MU", "ARM", "TXN"]);
  assert.equal(selectRows(rows, parseLoadGraph({})).length, rows.length);
  assert.deepEqual(selectRows(rows, parseLoadGraph({ tickers: "ko" })).map((r) => r[0]), ["BRK.B"]);
  assert.deepEqual(selectRows(rows, parseLoadGraph({ relations: ["customer"] })).map((r) => r[1]), ["MSFT"]);
});

test("parseLoadGraph refuses bad input", () => {
  assert.throws(() => parseLoadGraph({ as_of: "June 2018" }), /as_of/);
  assert.throws(() => parseLoadGraph({ relations: "friend" }), /relation/);
  assert.equal(parseLoadGraph({ include_ended: true }).includeEnded, false, "include_ended needs as_of");
  assert.deepEqual(parseLoadGraph({ tickers: "brk-b" }).tickers, ["BRK.B"]);
});

test("the slash form and the tool row's command", () => {
  const i = parseLoadGraphCommand("/load_graph --as-of 2018-06-30 --tickers NVDA,AMD --include-ended");
  assert.deepEqual(i, { as_of: "2018-06-30", tickers: "NVDA,AMD", include_ended: true });
  assert.deepEqual(parseLoadGraphCommand("/load-graph 2018"), { as_of: "2018" });
  assert.equal(parseLoadGraphCommand("/load_events"), null);
  assert.equal(loadGraphCommand(i), "/load_graph --as-of 2018-06-30 --include-ended --tickers NVDA,AMD");
  assert.equal(deskToolCommand("load_graph", { as_of: "2018-06-30" }).cmd, "/load_graph --as-of 2018-06-30");
  assert.equal(deskToolCommand("falcon_graph", { ticker: "NVDA", as_of: "2018-06-30" }).cmd, "/graph NVDA --as-of 2018-06-30");
});

test("graphCsv: dashes in tickers, quotes only when asked, fields escaped", () => {
  const csv = graphCsv([rows[5]!], true).split("\n");
  assert.equal(csv[0], "from,to,relation,strength,first_seen,first_accession,first_form,last_seen,ended_at,seen_in,checked_in,basis,current,first_url,first_quote");
  assert.ok(csv[1]!.startsWith("BRK-B,KO,supplier,marginal,2026-02-25,"));
  assert.ok(csv[1]!.endsWith(`"BRK.B names KO, ""quoted"""`));
  assert.equal(graphCsv([rows[0]!], false).split("\n")[0], "from,to,relation,strength,first_seen,first_accession,first_form,last_seen,ended_at,seen_in,checked_in,basis,current");
});

test("runLoadGraph uploads the rows known on the date as gzipped CSV", async () => {
  const file: PitRowsFile = { generatedAt: "2026-11-17T00:00:00Z", since: "2014-01-01", columns: [] as unknown as PitRowsFile["columns"], rows };
  let uploaded: File | null = null;
  const client = { files: { upload: async ({ file: f }: { file: File }) => ((uploaded = f), { id: "file_1" }) } } as never;
  const r = await runLoadGraph(client, { as_of: "2018-06-30" }, new AbortController().signal, { rows: file });
  assert.ok(r.ok);
  assert.equal(r.fileId, "file_1");
  const body = JSON.parse(r.content);
  assert.equal(body.rows, 3);
  assert.deepEqual(body.counts.by_first_seen_year, { 2014: 2, 2018: 1 });
  const text = await new Response((uploaded as unknown as File).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  assert.equal(text.split("\n").length, 4);
  const none = await runLoadGraph(client, { as_of: "2010" }, new AbortController().signal, { rows: file });
  assert.equal(JSON.parse(none.content).rows, 0);
  const bad = await runLoadGraph(client, { as_of: "x" }, new AbortController().signal, { rows: file });
  assert.ok(!bad.ok);
});
