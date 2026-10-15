import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOwnershipXml } from "../edgar/form4";
import { form4Xml, type FixtureForm } from "../edgar/form4-fixtures";
import { saleShare, type InsiderEvent } from "../../shared/insider-types";
import {
  findClusters,
  holdingsAfter,
  holdingsBefore,
  rankEvents,
  scheduleEvents,
  scheduleKind,
  significance,
  tradeEvents,
  tradesOf,
  type EventContext,
  type ScheduleRecord,
  type TradeRecord,
} from "./detect";

const TODAY = "2026-10-15";
const ctx: EventContext = { ticker: "EXMP", today: TODAY, scope: "held", via: null };

let seq = 0;
function trades(form: FixtureForm): TradeRecord[] {
  const doc = parseOwnershipXml(form4Xml(form));
  assert.ok(doc);
  seq++;
  return tradesOf(doc, { accession: `0000000000-26-${String(seq).padStart(6, "0")}`, filedAt: form.lines?.[0]?.date ?? TODAY, url: `https://www.sec.gov/x/${seq}` });
}

function purchase(owner: string, date: string, shares: number, opts: Partial<FixtureForm> & { price?: number; after?: number } = {}): TradeRecord[] {
  return trades({
    ownerCik: owner,
    ownerName: `Insider ${owner}`,
    director: true,
    ...opts,
    lines: [{ code: "P", date, shares, price: opts.price ?? 50, after: opts.after ?? shares * 10 }],
  });
}

function sale(owner: string, date: string, shares: number, opts: Partial<FixtureForm> & { price?: number } = {}): TradeRecord[] {
  return trades({
    ownerCik: owner,
    ownerName: `Insider ${owner}`,
    director: true,
    ...opts,
    lines: [{ code: "S", date, shares, price: opts.price ?? 50, after: 100_000 }],
  });
}

describe("trades from a Form 4", () => {
  it("totals P and S lines apart, and leaves derivative lines and other codes out", () => {
    const t = trades({
      title: "Chief Executive Officer",
      lines: [
        { code: "P", date: "2026-10-01", shares: 1_000, price: 20, after: 11_000 },
        { code: "P", date: "2026-10-02", shares: 500, price: 22, after: 11_500 },
        { code: "A", date: "2026-10-02", shares: 3_000, price: 0, after: 14_500 },
      ],
      derivative: [{ code: "P", date: "2026-10-02", shares: 9_999, price: 5, after: 9_999 }],
    });
    assert.equal(t.length, 1);
    assert.deepEqual([t[0]!.code, t[0]!.shares, t[0]!.value, t[0]!.firstDate, t[0]!.lastDate, t[0]!.role], ["P", 1500, 31000, "2026-10-01", "2026-10-02", "ceo"]);
    assert.equal(t[0]!.sharesBefore, 10_000);
    assert.equal(t[0]!.increase, 0.15);
  });

  it("counts every ownership line and holdings row in what was held before", () => {
    const doc = parseOwnershipXml(
      form4Xml({
        lines: [{ code: "P", date: "2026-10-01", shares: 100, after: 100, ownership: "I", nature: "By Trust" }],
        holdings: [{ shares: 900, ownership: "D" }],
      }),
    );
    assert.equal(holdingsBefore(doc!), 900);
    const first = trades({ lines: [{ code: "P", date: "2026-10-01", shares: 400, after: 400 }] });
    assert.equal(first[0]!.firstPosition, true);
    assert.equal(first[0]!.increase, null);
    const unknown = trades({ lines: [{ code: "P", date: "2026-10-01", shares: 400, after: null }] });
    assert.equal(unknown[0]!.sharesBefore, null);
  });

  it("reads what was left from the form, exercises included (Coca-Cola, August 2026)", () => {
    // Form 4 0000021344-26-000161: sells 19,772, exercises three option grants, sells 35,983.
    const xml = form4Xml({
      title: "Europe OU President",
      lines: [
        { code: "S", date: "2026-08-06", shares: 19_772, price: 86.6721, after: 26_209 },
        { code: "M", date: "2026-08-06", shares: 7_628, price: 48.075, after: 33_837 },
        { code: "M", date: "2026-08-06", shares: 10_684, price: 59.485, after: 44_521 },
        { code: "M", date: "2026-08-06", shares: 21_848, price: 50.4383, after: 66_369 },
        { code: "S", date: "2026-08-06", shares: 35_983, price: 86.5468, after: 30_386 },
      ],
    });
    const doc = parseOwnershipXml(xml)!;
    assert.equal(holdingsBefore(doc), 45_981);
    assert.equal(holdingsAfter(doc), 30_386);
    const t = tradesOf(doc, { accession: "0000021344-26-000161", filedAt: "2026-08-07", url: "https://www.sec.gov/x" });
    assert.deepEqual([t[0]!.code, t[0]!.shares, t[0]!.value, t[0]!.sharesBefore, t[0]!.sharesAfter], ["S", 55_755, 4_827_894, 45_981, 30_386]);
    // 55,755 of the 86,141 shares held at most: never "more than all of it".
    assert.equal(saleShare(t)!.toFixed(4), (55_755 / 86_141).toFixed(4));
    // No holding on record after the form: back to the holding before.
    assert.equal(holdingsAfter(parseOwnershipXml(form4Xml({ lines: [{ code: "S", date: "2026-08-06", shares: 10, after: null }] }))!), null);
  });

  it("keeps plan trades apart from the rest", () => {
    const t = trades({
      lines: [
        { code: "S", date: "2026-10-01", shares: 100, footnotes: ["F1"] },
        { code: "S", date: "2026-10-01", shares: 50 },
      ],
      footnotes: { F1: "Effected pursuant to a Rule 10b5-1 trading plan." },
    });
    assert.deepEqual(
      t.map((x) => [x.shares, x.plan]),
      [
        [50, false],
        [100, true],
      ],
    );
  });
});

describe("cluster windows", () => {
  it("needs the distinct insiders inside 30 days", () => {
    const inside = [...purchase("1", "2026-09-01", 100), ...purchase("2", "2026-09-30", 100)];
    assert.equal(findClusters(inside, 2).length, 1);
    const outside = [...purchase("1", "2026-09-01", 100), ...purchase("2", "2026-10-01", 100)];
    assert.equal(findClusters(outside, 2).length, 0);
    const sameInsider = [...purchase("1", "2026-09-01", 100), ...purchase("1", "2026-09-05", 100)];
    assert.equal(findClusters(sameInsider, 2).length, 0);
  });

  it("takes the widest window first and uses each trade once", () => {
    const t = [
      ...purchase("1", "2026-07-20", 100),
      ...purchase("2", "2026-07-25", 100),
      ...purchase("3", "2026-09-10", 100),
      ...purchase("4", "2026-09-12", 100),
      ...purchase("5", "2026-09-20", 100),
    ];
    const found = findClusters(t, 2);
    assert.deepEqual(
      found.map((c) => c.map((x) => x.insiderKey)),
      [
        ["3", "4", "5"],
        ["1", "2"],
      ],
    );
  });
});

describe("rules", () => {
  it("finds a purchase cluster and does not list its trades again", () => {
    const t = [...purchase("1", "2026-10-01", 2_000, { title: "Chief Executive Officer" }), ...purchase("2", "2026-10-06", 1_000)];
    const events = tradeEvents(t, ctx);
    assert.deepEqual(
      events.map((e) => [e.kind, e.insiders, e.value, e.firstDate, e.date, e.roles.join(",")]),
      [["purchase_cluster", 2, 150_000, "2026-10-01", "2026-10-06", "ceo,director"]],
    );
  });

  it("leaves out purchases under a plan", () => {
    const t = [...purchase("1", "2026-10-01", 2_000), ...purchase("2", "2026-10-06", 1_000, { aff10b5One: true })];
    assert.deepEqual(tradeEvents(t, ctx).map((e) => e.kind), []);
  });

  it("flags a single purchase by the CEO or CFO, or one that raises a holding by 20%", () => {
    const ceo = purchase("1", "2026-10-01", 100, { title: "CEO", price: 10, after: 100_100 });
    assert.deepEqual(tradeEvents(ceo, ctx).map((e) => e.kind), ["large_purchase"]);
    const big = purchase("2", "2026-10-01", 1_000, { price: 50, after: 5_000 });
    assert.deepEqual(tradeEvents(big, ctx).map((e) => e.kind), ["large_purchase"]);
    const small = purchase("3", "2026-10-01", 1_000, { price: 50, after: 100_000 });
    assert.deepEqual(tradeEvents(small, ctx).map((e) => e.kind), []);
    const tiny = purchase("4", "2026-10-01", 100, { price: 50, after: 200 });
    assert.deepEqual(tradeEvents(tiny, ctx).map((e) => e.kind), []);
  });

  it("flags a CEO or CFO sale outside a plan over $1M, and three insiders selling", () => {
    const cfo = sale("1", "2026-10-01", 30_000, { title: "Chief Financial Officer" });
    assert.deepEqual(tradeEvents(cfo, ctx).map((e) => e.kind), ["unplanned_sale"]);
    const planned = sale("1", "2026-10-01", 30_000, { title: "Chief Financial Officer", aff10b5One: true });
    assert.deepEqual(tradeEvents(planned, ctx).map((e) => e.kind), []);
    const director = sale("2", "2026-10-01", 30_000);
    assert.deepEqual(tradeEvents(director, ctx).map((e) => e.kind), []);
    const three = [...sale("2", "2026-10-01", 100), ...sale("3", "2026-10-02", 100), ...sale("4", "2026-10-10", 100)];
    assert.deepEqual(tradeEvents(three, ctx).map((e) => [e.kind, e.insiders]), [["sale_cluster", 3]]);
    const two = [...sale("2", "2026-10-01", 100), ...sale("3", "2026-10-02", 100)];
    assert.deepEqual(tradeEvents(two, ctx).map((e) => e.kind), []);
  });

  it("flags a large unplanned sale by a director, officer or 10% owner, scaled to the holding", () => {
    // NVIDIA, September 2026: one director's three Form 4s, no 10b5-1 plan, about $946M in 17 days.
    const nvdaCtx: EventContext = { ...ctx, ticker: "NVDA", today: "2026-10-15" };
    const stevens = (date: string, shares: number, price: number, after: number) =>
      trades({ ownerCik: "1199039", ownerName: "STEVENS MARK A", director: true, lines: [{ code: "S", date, shares, price, after }] });
    const run = [
      ...stevens("2026-09-02", 1_848_501, 222.25, 29_921_132),
      ...stevens("2026-09-04", 1_022_239, 230.51, 28_898_893),
      ...stevens("2026-09-18", 1_366_000, 219.73, 27_532_893),
    ];
    const events = tradeEvents(run, nvdaCtx);
    assert.deepEqual(events.map((e) => [e.kind, e.insiders, e.roles.join(","), e.firstDate, e.date]), [["large_unplanned_sale", 1, "director", "2026-09-02", "2026-09-18"]]);
    assert.ok(events[0]!.value! > 940_000_000);
    // Below every other kind's base, before the multipliers.
    assert.ok(events[0]!.score < significance({ ...events[0]!, kind: "unplanned_sale" }, nvdaCtx.today));

    const dir = (shares: number, after: number, extra: Partial<FixtureForm> = {}) =>
      trades({ ownerCik: "77", ownerName: "Director B", director: true, ...extra, lines: [{ code: "S", date: "2026-10-01", shares, price: 100, after }] });
    // $12M that is 15% of the holding: flagged.
    assert.deepEqual(tradeEvents(dir(120_000, 680_000), ctx).map((e) => e.kind), ["large_unplanned_sale"]);
    // $12M that is 2% of a large holding: not flagged.
    assert.deepEqual(tradeEvents(dir(120_000, 5_880_000), ctx).map((e) => e.kind), []);
    // $8M: under the floor.
    assert.deepEqual(tradeEvents(dir(80_000, 20_000), ctx).map((e) => e.kind), []);
    // $12M of exercised options sold out of 3.02M shares held at most: 4%, not flagged.
    const exercised = trades({
      ownerCik: "78",
      ownerName: "Officer C",
      title: "EVP",
      lines: [
        { code: "M", date: "2026-10-01", shares: 120_000, price: 40, after: 3_020_000 },
        { code: "S", date: "2026-10-01", shares: 120_000, price: 100, after: 2_900_000 },
      ],
    });
    assert.deepEqual(tradeEvents(exercised, ctx).map((e) => e.kind), []);
    // $12M sold after exercising 200,000 options on a 50,000 share holding: 80% of the 250,000 held at most
    // (against the 50,000 held before alone it read as 400%, shown as all of it).
    const small = trades({
      ownerCik: "79",
      ownerName: "Officer D",
      title: "EVP",
      lines: [
        { code: "M", date: "2026-10-01", shares: 200_000, price: 40, after: 250_000 },
        { code: "S", date: "2026-10-01", shares: 200_000, price: 60, after: 50_000 },
      ],
    });
    const flagged = tradeEvents(small, ctx);
    assert.deepEqual(flagged.map((e) => e.kind), ["large_unplanned_sale"]);
    assert.equal(saleShare(flagged[0]!.trades), 0.8);
    // Under a plan: not flagged.
    assert.deepEqual(tradeEvents(dir(600_000, 100_000, { aff10b5One: true }), ctx).map((e) => e.kind), []);
    // The CEO's large sale stays an unplanned_sale, once.
    assert.deepEqual(tradeEvents(dir(600_000, 100_000, { title: "Chief Executive Officer" }), ctx).map((e) => e.kind), ["unplanned_sale"]);
  });

  it("ignores trades older than the lookback", () => {
    const old = [...purchase("1", "2026-06-01", 2_000), ...purchase("2", "2026-06-06", 1_000)];
    assert.deepEqual(tradeEvents(old, ctx), []);
  });
});

describe("13D and 13G", () => {
  const rec = (form: string, extra: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
    form,
    filer: "Example Partners LP",
    filedAt: "2026-10-10",
    accession: `acc-${form}`,
    url: "https://www.sec.gov/Archives/x",
    percent: 7.5,
    purposeAmended: false,
    ...extra,
  });

  it("reads both form names", () => {
    assert.equal(scheduleKind("SC 13D"), "13d");
    assert.equal(scheduleKind("SCHEDULE 13D/A"), "13d_a");
    assert.equal(scheduleKind("SC 13G"), "13g");
    assert.equal(scheduleKind("SC 13G/A"), "13g_a");
    assert.equal(scheduleKind("SC TO-T"), null);
  });

  it("keeps new 13D, amendments that restate the purpose, and new 13G", () => {
    const events = scheduleEvents(
      [rec("SC 13D"), rec("SC 13D/A"), rec("SCHEDULE 13D/A", { accession: "a2", purposeAmended: true }), rec("SC 13G"), rec("SC 13G/A")],
      ctx,
    );
    assert.deepEqual(
      events.map((e) => e.kind),
      ["activist_13d", "activist_13d_amendment", "new_holder_13g"],
    );
    assert.equal(events[0]!.filing!.filer, "Example Partners LP");
  });
});

describe("significance", () => {
  const base = (over: Partial<InsiderEvent>): InsiderEvent => ({
    id: "x",
    ticker: "EXMP",
    kind: "purchase_cluster",
    date: TODAY,
    firstDate: TODAY,
    insiders: 2,
    value: 100_000,
    roles: ["director"],
    trades: [],
    filing: null,
    scope: "held",
    via: null,
    score: 0,
    ...over,
  });

  it("scores by kind, size, breadth, role, recency and scope", () => {
    assert.equal(significance(base({}), TODAY), 60);
    assert.equal(significance(base({ value: 1_000_000 }), TODAY), 66);
    assert.equal(significance(base({ insiders: 4 }), TODAY), 76);
    assert.equal(significance(base({ roles: ["ceo", "director"] }), TODAY), 70);
    assert.equal(significance(base({ date: "2026-07-17" }), TODAY), 30);
    assert.equal(significance(base({ scope: "watchlist" }), TODAY), 54);
    assert.equal(significance(base({ scope: "linked", via: { holding: "NVDA", relation: "supplier", tier: "critical", namedBy: "NVDA", sourceUrl: null } }), TODAY), 45);
    assert.equal(significance(base({ kind: "new_holder_13g", value: null, insiders: 0, filing: { form: "SC 13G", filer: "X", filedAt: TODAY, accession: "a", url: "u", percent: 9 } }), TODAY), 26);
    assert.equal(significance(base({ insiders: 9, value: 1e9, roles: ["ceo"] }), TODAY), 100);
  });

  it("ranks a cluster at a held name above a routine 13G, and a fresh event above a stale one", () => {
    const events: InsiderEvent[] = [
      { ...base({ id: "g", kind: "new_holder_13g", value: null }), score: 20 },
      { ...base({ id: "old", date: "2026-08-01" }), score: significance(base({ date: "2026-08-01" }), TODAY) },
      { ...base({ id: "new" }), score: significance(base({}), TODAY) },
    ];
    assert.deepEqual(
      rankEvents(events).map((e) => e.id),
      ["new", "old", "g"],
    );
  });
});
