import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createFilingsService, pickFilings, type EdgeLike, type FilingLike } from "./service";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(HERE, "fixtures", name), "utf8");

function filing(form: string, accession: string, filedAt: string, extra: Partial<FilingLike> = {}): FilingLike {
  return {
    cik: "0000000001",
    form,
    accession,
    filedAt,
    items: [],
    primaryDocument: `${accession}.htm`,
    url: `https://www.sec.gov/Archives/edgar/data/1/${accession.replace(/-/g, "")}/${accession}.htm`,
    ...extra,
  };
}

const INDEX: FilingLike[] = [
  filing("10-Q", "q-2026", "2026-08-05"),
  filing("8-K", "8k-402", "2026-06-01", { items: ["4.02", "9.01"] }),
  filing("NT 10-Q", "nt-2026", "2026-05-15", { primaryDocument: null }),
  filing("8-K", "8k-401", "2026-03-10", { items: ["4.01"] }),
  filing("10-K", "k-2026", "2026-02-20"),
  filing("4", "f4", "2026-02-01"),
  filing("10-K", "k-2025", "2025-02-21"),
  // Before the previous annual report: outside the comparison.
  filing("8-K", "8k-old", "2024-11-01", { items: ["4.01"] }),
];

const DOCS: Record<string, string> = {
  "k-2026": "tenk-2026.html",
  "k-2025": "tenk-2025.html",
  "q-2026": "tenq-2026.html",
};

const EDGES: EdgeLike[] = [
  { root_ticker: "ACME", counterparty_name: "Umbrella Materials", category: "supplier", evidence_quote: "We entered into a supply agreement with Umbrella Materials for wafers.", accession_number: "k-2026" },
  { root_ticker: "ACME", counterparty_name: "Initech", category: "supplier", evidence_quote: "We also work with Initech for machined housings.", accession_number: "k-2026" },
  { root_ticker: "ACME", counterparty_name: "Hooli Inc.", category: "customer", disclosed_share_pct: 11, evidence_quote: "Sales to Globex Corporation and Hooli Inc. accounted for 24% and 11%", accession_number: "k-2026" },
  { root_ticker: "OTHER", counterparty_name: "Vandelay", category: "customer", accession_number: "x" },
];

function setup(opts: { index?: FilingLike[]; edges?: EdgeLike[]; failDocs?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-filings-"));
  let clock = Date.parse("2026-10-15T15:00:00Z");
  const calls = { index: 0, docs: [] as string[] };
  const service = createFilingsService({
    dir,
    now: () => clock,
    filings: async (ticker) => {
      calls.index++;
      return ticker === "ACME" ? (opts.index ?? INDEX) : [];
    },
    document: async (f) => {
      calls.docs.push(f.accession);
      if (opts.failDocs) throw new Error("503");
      const name = DOCS[f.accession];
      if (!name) throw new Error(`no fixture for ${f.accession}`);
      return fixture(name);
    },
    graphEdges: async () => opts.edges ?? EDGES,
  });
  return { service, calls, dir, advance: (ms: number) => (clock += ms) };
}

describe("pickFilings", () => {
  it("takes the newest annual report, the one before it and the 10-Q after it", () => {
    const p = pickFilings(INDEX);
    assert.deepEqual([p.latest?.accession, p.previous?.accession, p.quarter?.accession], ["k-2026", "k-2025", "q-2026"]);
  });
});

describe("filing changes", () => {
  it("compares the two annual reports, the 10-Q and the index", async () => {
    const { service } = setup();
    const c = await service.changes("ACME");
    assert.deepEqual(c.missing, []);
    assert.equal(c.latest?.sectionUrl, `${INDEX[4]!.url}#a1a`);
    const kinds = (k: string) => c.items.filter((i) => i.kind === k);

    assert.deepEqual(
      kinds("risk_new").map((i) => i.text),
      ["We depend on Umbrella Materials as the sole source of our wafers.", "We have identified a material weakness in our internal control over financial reporting."],
    );
    assert.deepEqual(
      kinds("risk_removed").map((i) => i.text),
      ["We have never paid dividends on our common stock."],
    );
    assert.deepEqual(
      kinds("risk_reworded").map((i) => [i.previous, i.text]),
      [["Climate change may have a long-term impact on our business.", "Climate change and extreme weather may have a long-term impact on our business and our suppliers."]],
    );
    // The year moved in the stock price heading; that is not a change.
    assert.ok(!c.items.some((i) => /market price/.test(i.text ?? "")));

    assert.equal(c.quarterRisk, "updated");
    assert.deepEqual(
      kinds("quarter_risk_new").map((i) => [i.form, i.text]),
      [["10-Q", "New tariffs on imported components have increased our costs and could reduce our margins."]],
    );

    assert.equal(kinds("going_concern")[0]?.notable, true);
    assert.equal(kinds("material_weakness")[0]?.form, "10-K");
    assert.deepEqual(
      kinds("auditor_name").map((i) => [i.previous, i.name]),
      [["Ernst & Young LLP", "KPMG LLP"]],
    );
    assert.deepEqual(
      kinds("auditor_change").map((i) => i.date),
      ["2026-03-10"],
    );
    assert.deepEqual(
      kinds("restatement").map((i) => i.detail),
      ["4.02"],
    );
    assert.deepEqual(
      kinds("late_filing").map((i) => i.detail),
      ["NT 10-Q"],
    );

    assert.equal(c.relationships, "compared");
    assert.deepEqual(
      [...kinds("supplier_named"), ...kinds("customer_named")].map((i) => i.name).sort(),
      ["Hooli Inc.", "Umbrella Materials"],
    );
    const share = kinds("customer_share")[0];
    assert.deepEqual([share?.name, share?.pct, share?.previousPct, share?.notable], ["Globex Corporation", 24, 18, true]);
    assert.deepEqual(
      kinds("customer_share_new").map((i) => i.name),
      ["Hooli Inc."],
    );
    assert.ok(kinds("sole_source_new").some((i) => /Umbrella Materials/.test(i.text ?? "")));

    // Newest filing first; on one day, red flags before risk factors.
    const dates = c.items.map((i) => i.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
    const k26 = c.items.filter((i) => i.date === "2026-02-20").map((i) => i.kind);
    assert.ok(k26.indexOf("going_concern") < k26.indexOf("risk_new"));
  });

  it("says when the graph's names come from an older report", async () => {
    const { service } = setup({ edges: [{ ...EDGES[0]!, accession_number: "k-2025", filing_date: "2025-02-21" }] });
    const c = await service.changes("ACME");
    assert.equal(c.relationships, "graph_older");
    assert.ok(!c.items.some((i) => i.kind === "supplier_named"));
  });

  it("reads a 10-Q that says nothing changed", async () => {
    const index = [filing("10-Q", "q-same", "2026-08-05"), filing("10-K", "k-2026", "2026-02-20"), filing("10-K", "k-2025", "2025-02-21")];
    DOCS["q-same"] = "tenq-unchanged.html";
    const { service } = setup({ index });
    const c = await service.changes("ACME");
    assert.equal(c.quarterRisk, "no_material_changes");
    assert.ok(!c.items.some((i) => i.form === "10-Q"));
  });

  it("answers for a ticker EDGAR does not know", async () => {
    const { service } = setup();
    const c = await service.changes("ZZZZ");
    assert.equal(c.latest, null);
    assert.deepEqual(c.missing, ["annual"]);
  });
});

describe("caching", () => {
  it("reads each filing once ever and the index once a day", async () => {
    const { service, calls, advance } = setup();
    await service.changes("ACME");
    assert.equal(calls.index, 1);
    assert.deepEqual([...calls.docs].sort(), ["k-2025", "k-2026", "q-2026"]);
    await service.changes("ACME");
    assert.equal(calls.index, 1);
    advance(24 * 60 * 60_000);
    await service.changes("ACME");
    assert.equal(calls.index, 2);
    assert.equal(calls.docs.length, 3);
  });

  it("keeps what it read across restarts", async () => {
    const first = setup();
    await first.service.changes("ACME");
    const again = createFilingsService({
      dir: first.dir,
      now: () => Date.parse("2026-10-15T18:00:00Z"),
      filings: async () => {
        throw new Error("should not be asked");
      },
      document: async () => {
        throw new Error("should not be asked");
      },
      graphEdges: async () => [],
    });
    assert.ok((await again.changes("ACME")).items.length > 0);
  });

  it("shows what it could read when a document fails, and waits before asking again", async () => {
    const { service, calls, advance } = setup({ failDocs: true });
    const c = await service.changes("ACME");
    assert.ok(c.missing.includes("documents"));
    assert.ok(c.items.some((i) => i.kind === "restatement"));
    await service.changes("ACME");
    assert.equal(calls.index, 1);
    advance(31 * 60_000);
    await service.changes("ACME");
    assert.equal(calls.index, 2);
  });
});

describe("what the report before the newest one already carried", () => {
  it("marks a 10-Q's new risk factor carried when the 10-Q before it had the heading", async () => {
    DOCS["q-new"] = "tenq-2026.html";
    DOCS["q-old"] = "tenq-2026.html";
    const index = [filing("10-Q", "q-new", "2026-08-05"), filing("10-Q", "q-old", "2026-05-06"), filing("10-K", "k-2026", "2026-02-20"), filing("10-K", "k-2025", "2025-02-21")];
    assert.equal(pickFilings(index).prior?.accession, "q-old");
    const { service, calls } = setup({ index });
    const c = await service.changes("ACME");
    assert.ok(calls.docs.includes("q-old"));
    const q = c.items.filter((i) => i.kind === "quarter_risk_new");
    assert.deepEqual(q.map((i) => [i.id.split(":")[1], i.carried]), [["q-new", true]]);
    // The annual report's items are not the newest filing's: not marked either way.
    assert.ok(c.items.filter((i) => i.form === "10-K").every((i) => i.carried === undefined));
  });

  it("does not mark it when the 10-Q before said nothing changed", async () => {
    DOCS["q-new"] = "tenq-2026.html";
    DOCS["q-old"] = "tenq-unchanged.html";
    const index = [filing("10-Q", "q-new", "2026-08-05"), filing("10-Q", "q-old", "2026-05-06"), filing("10-K", "k-2026", "2026-02-20"), filing("10-K", "k-2025", "2025-02-21")];
    const { service } = setup({ index });
    const c = await service.changes("ACME");
    assert.deepEqual(c.items.filter((i) => i.kind === "quarter_risk_new").map((i) => i.carried), [false]);
  });

  it("for a new annual report, reads the last 10-Q before it: its headings and red flags count as carried", async () => {
    DOCS["q-before"] = "tenq-2026.html";
    const index = [filing("10-K", "k-2026", "2026-02-20"), filing("10-Q", "q-before", "2025-11-05"), filing("10-K", "k-2025", "2025-02-21")];
    assert.equal(pickFilings(index).prior?.accession, "q-before");
    const { service } = setup({ index });
    const c = await service.changes("ACME");
    const risk = c.items.filter((i) => i.kind === "risk_new");
    assert.ok(risk.length > 0 && risk.every((i) => i.carried === false), "none of the new headings were in that 10-Q");
    assert.equal(c.items.find((i) => i.kind === "material_weakness")?.carried, false);
  });
});

describe("an answer that covers a filing just seen", () => {
  it("reads EDGAR again for a filing the kept answer predates, at most every ten minutes", async () => {
    const index = [...INDEX];
    const { service, calls, advance } = setup({ index });
    await service.changes("ACME");
    assert.equal(calls.index, 1);
    DOCS["q-next"] = "tenq-2026.html";
    index.unshift(filing("10-Q", "q-next", "2026-10-15"));
    // Kept from this morning, but read less than ten minutes ago: kept.
    advance(5 * 60_000);
    const kept = await service.changes("ACME", { covering: "q-next" });
    assert.equal(calls.index, 1);
    assert.equal(kept.quarter?.accession, "q-2026");
    advance(6 * 60_000);
    const fresh = await service.changes("ACME", { covering: "q-next" });
    assert.equal(calls.index, 2);
    assert.equal(fresh.quarter?.accession, "q-next");
    // Covered now: the day's answer stands.
    await service.changes("ACME", { covering: "q-next" });
    await service.changes("ACME", { covering: "8k-402" });
    assert.equal(calls.index, 2);
  });
});

describe("overview", () => {
  it("queues names it has not read today and lists notable changes once read", async () => {
    const { service } = setup();
    const first = service.overview({ held: ["ACME"], watchlist: ["ZZZZ"] });
    assert.ok(first.ok);
    assert.deepEqual(first.ok && first.pending, ["ACME", "ZZZZ"]);
    await service.idle();
    const second = service.overview({ held: ["ACME"], watchlist: ["ZZZZ"] });
    assert.ok(second.ok);
    if (!second.ok) return;
    assert.deepEqual(second.pending, []);
    assert.equal(second.checked, 2);
    const kinds = second.rows.map((r) => r.item.kind);
    assert.ok(kinds.includes("risk_new"));
    assert.ok(!kinds.includes("risk_reworded"));
    assert.ok(!kinds.includes("risk_removed"));
    const riskRow = second.rows.find((r) => r.item.kind === "risk_new");
    assert.equal(riskRow?.count, 2);
    assert.equal(riskRow?.held, true);
    // Newest first.
    assert.equal(second.rows[0]!.item.form, "10-Q");
  });
});
