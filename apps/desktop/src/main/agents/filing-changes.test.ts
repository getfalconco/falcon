import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { AgentTrigger } from "../../shared/agent-types";
import type { FilingChangeItem, FilingChanges } from "../../shared/filing-changes";
import { en } from "../../renderer/lib/i18n/messages/areas/agents";
import { copyIssues } from "./copy";
import { AgentEngine } from "./engine";
import { STANDING_EARNINGS_DAYS, endReached, proposeEnds } from "./ends";
import { changesFacts, changesLead, changesTitle, itemFires, kindsOf, watchesFiling, type ChangesHit } from "./filing-changes";
import { draftFromBriefWithModel, heuristicDraft, withChangesWatch, type AgentModelCaller } from "./llm";
import type { FilingRef } from "./sources";
import { EMPTY_STATE, type AgentEngineState } from "./store";
import { agentFixture, fakeSources, filing } from "./test-fakes";
import { checkTrigger, triggerSignature, type TriggerCheck } from "./triggers";
import { HOUR_MS, MINUTE_MS, addDaysYmd } from "./time";
import { defaultName, validateTrigger } from "./validate";

/**
 * The `filing_changes` trigger: which of SMCI's filings it reads, when one
 * fires (once, and never as a second report beside the plain filing
 * trigger), what the opening paragraph says, and how the reader's words
 * become the trigger. Fixed clock, fake data; 2026-11-05 is a Thursday and
 * New York is on EST from 2026-11-01 (UTC-5).
 */

const CIK = "0001375365";
const DIR = "https://www.sec.gov/Archives/edgar/data/1375365";
const Q_ACC = "0001375365-26-000050";
const K_ACC = "0001375365-26-000031";
const K_PREV = "0001375365-25-000040";

const TENQ: FilingRef = filing({
  cik: CIK,
  form: "10-Q",
  accession: Q_ACC,
  filedAt: "2026-11-05",
  acceptedAt: "2026-11-05T21:05:00.000Z",
  items: [],
  primaryDocument: "smci-20260930.htm",
  url: `${DIR}/000137536526000050/smci-20260930.htm`,
});
const RESTATEMENT: FilingRef = filing({
  cik: CIK,
  form: "8-K",
  accession: "0001375365-26-000052",
  filedAt: "2026-11-05",
  acceptedAt: "2026-11-05T21:40:00.000Z",
  items: ["4.02", "9.01"],
  primaryDocument: "smci-8k.htm",
  url: `${DIR}/000137536526000052/smci-8k.htm`,
});
const OLD_8K: FilingRef = filing({ cik: CIK, form: "8-K", accession: "0001375365-26-000010", filedAt: "2026-02-03", acceptedAt: "2026-02-03T21:05:00.000Z", items: ["2.02"] });

const NOW = new Date("2026-11-05T22:30:00.000Z");
const CREATED = "2026-10-16T14:00:00.000Z";

function item(over: Partial<FilingChangeItem> & Pick<FilingChangeItem, "id" | "kind">): FilingChangeItem {
  return {
    form: "10-Q",
    date: "2026-11-05",
    url: `${TENQ.url}#item_1a`,
    text: null,
    previous: null,
    name: null,
    pct: null,
    previousPct: null,
    detail: null,
    notable: true,
    repeat: false,
    ...over,
  };
}

const TARIFF = "Tariffs on server components imported from Taiwan may increase our costs and reduce our margins";
const WEAKNESS =
  "Management concluded that our internal control over financial reporting was not effective as of September 30, 2026, because of a material weakness in the controls over revenue recognition for multi-element arrangements.";

function answer(over: Partial<FilingChanges> = {}): FilingChanges {
  return {
    ticker: "SMCI",
    checkedAt: "2026-11-05T22:00:00.000Z",
    latest: { form: "10-K", accession: K_ACC, filedAt: "2026-08-28", url: `${DIR}/000137536526000031/smci-20260630.htm`, sectionUrl: `${DIR}/000137536526000031/smci-20260630.htm#risk` },
    previous: { form: "10-K", accession: K_PREV, filedAt: "2025-08-28", url: `${DIR}/000137536525000040/smci-20250630.htm`, sectionUrl: null },
    quarter: { form: "10-Q", accession: Q_ACC, filedAt: "2026-11-05", url: TENQ.url, sectionUrl: `${TENQ.url}#item_1a` },
    quarterRisk: "updated",
    riskCount: { latest: 58, previous: 55 },
    relationships: "compared",
    items: [
      item({ id: `material_weakness:${Q_ACC}`, kind: "material_weakness", text: WEAKNESS, url: TENQ.url }),
      item({ id: `quarter_risk_new:${Q_ACC}:0`, kind: "quarter_risk_new", text: TARIFF }),
      item({ id: `quarter_risk_new:${Q_ACC}:1`, kind: "quarter_risk_new", text: "We depend on a limited number of suppliers for GPUs", carried: true }),
      item({ id: `quarter_risk_reworded:${Q_ACC}:0`, kind: "quarter_risk_reworded", text: "Our stock price is volatile", previous: "Our stock price has been volatile", notable: false }),
      // The annual report's own items: not this filing's.
      item({ id: `risk_new:${K_ACC}:0`, kind: "risk_new", form: "10-K", date: "2026-08-28", text: "Export controls on advanced computing items" }),
      item({ id: `customer_share_new:${K_ACC}:revenue:globex`, kind: "customer_share_new", form: "10-K", date: "2026-08-28", name: "Globex", pct: 14, detail: "revenue" }),
    ],
    missing: [],
    ...over,
  };
}

function state(over: Partial<AgentEngineState> = {}): AgentEngineState {
  return { ...EMPTY_STATE, firedKeys: [], lastFiredByTrigger: {}, ...over };
}

const CHANGES: AgentTrigger = { kind: "filing_changes", ticker: "SMCI" };
const PLAIN: AgentTrigger = { kind: "filing", ticker: "SMCI", forms: ["10-Q", "8-K"] };

function ctxFor(triggers: AgentTrigger[], opts: { filings?: FilingRef[]; answer?: FilingChanges | ((covering?: string) => FilingChanges); st?: AgentEngineState; now?: Date } = {}) {
  const asked: Array<string | undefined> = [];
  const sources = fakeSources({
    filings: async () => opts.filings ?? [TENQ, OLD_8K],
    filingChanges: async (_t, covering) => {
      asked.push(covering);
      const a = opts.answer ?? answer();
      return typeof a === "function" ? a(covering) : a;
    },
  });
  const agent = agentFixture({ ticker: "SMCI", triggers, createdAt: CREATED, oneShot: false });
  return { ctx: { agent, state: opts.st ?? state(), sources, now: opts.now ?? NOW }, asked };
}

function fired(check: TriggerCheck) {
  assert.equal(check.status, "fired");
  return (check as Extract<TriggerCheck, { status: "fired" }>).event;
}

function waiting(check: TriggerCheck) {
  assert.equal(check.status, "waiting");
  return check as Extract<TriggerCheck, { status: "waiting" }>;
}

describe("what the filing changes watch reads", () => {
  it("reads every periodic report, and red flag filings only when red flags are watched", () => {
    const all = kindsOf({});
    assert.deepEqual(all, ["risk_factors", "red_flags", "customers", "suppliers"]);
    assert.ok(watchesFiling(TENQ, ["customers"]));
    assert.ok(watchesFiling({ form: "20-F", items: [] }, ["risk_factors"]));
    assert.ok(watchesFiling(RESTATEMENT, all));
    assert.ok(!watchesFiling(RESTATEMENT, ["risk_factors"]));
    assert.ok(watchesFiling({ form: "NT 10-K", items: [] }, ["red_flags"]));
    assert.ok(!watchesFiling(OLD_8K, all), "an 8-K without 4.01 or 4.02 is not a red flag");
    assert.ok(!watchesFiling({ form: "10-K/A", items: [] }, all), "amendments are not compared");
  });

  it("fires on new changes of the watched kinds, never on repeats, carried ones or small share moves", () => {
    const base = item({ id: `x:${Q_ACC}`, kind: "quarter_risk_new", text: "x" });
    assert.ok(itemFires(base, ["risk_factors"]));
    assert.ok(!itemFires(base, ["customers"]));
    assert.ok(!itemFires({ ...base, carried: true }, ["risk_factors"]));
    assert.ok(!itemFires({ ...base, kind: "material_weakness", repeat: true }, ["red_flags"]));
    assert.ok(!itemFires({ ...base, kind: "quarter_risk_reworded" }, kindsOf({})));
    assert.ok(!itemFires({ ...base, kind: "customer_share", notable: false }, ["customers"]));
    assert.ok(itemFires({ ...base, kind: "customer_share", notable: true }, ["customers"]));
    assert.ok(itemFires({ ...base, kind: "sole_source_new" }, ["suppliers"]));
  });
});

describe("the filing changes check", () => {
  it("fires on the new 10-Q with its own items, asking for an answer that covers it", async () => {
    const { ctx, asked } = ctxFor([CHANGES]);
    const event = fired(await checkTrigger(CHANGES, ctx));
    assert.deepEqual(event.keys, [`filing:${Q_ACC}`]);
    assert.equal(event.kind, "filing_changes");
    assert.deepEqual(asked, [Q_ACC]);
    const hit = event.changes!.hits[0]!;
    assert.deepEqual(
      hit.firing.map((i) => i.id),
      [`material_weakness:${Q_ACC}`, `quarter_risk_new:${Q_ACC}:0`],
      "the carried heading, the reworded one and the annual report's items stay out",
    );
    assert.equal(hit.items.length, 4);
    assert.equal(event.title, "SMCI 10-Q filed 2026-11-05: 1 new risk factor, material weakness.");
  });

  it("does not fire twice, and leaves a filing the plain trigger already reported", async () => {
    const once = ctxFor([CHANGES], { st: state({ firedKeys: [`filing:${Q_ACC}`] }) });
    const w = waiting(await checkTrigger(CHANGES, once.ctx));
    assert.deepEqual(once.asked, [], "the service is not asked about a filing already reported");
    assert.equal(w.noteLines[0]!.code, "changes.watching");
  });

  it("consumes a filing with none of the watched changes quietly, under its own key", async () => {
    const { ctx } = ctxFor([{ kind: "filing_changes", ticker: "SMCI", kinds: ["customers"] }]);
    const w = waiting(await checkTrigger({ kind: "filing_changes", ticker: "SMCI", kinds: ["customers"] }, ctx));
    assert.deepEqual(ctx.state.firedKeys, [`filing_changes:${Q_ACC}`]);
    assert.equal(w.noteLines[0]!.code, "changes.noneWatched");
    assert.deepEqual(w.noteLines[0]!.params, { ticker: "SMCI", form: "10-Q", date: "2026-11-05" });
    assert.match(w.note, /none of the watched changes/);
  });

  it("waits while the service has not read the new filing, and looks again in ten minutes", async () => {
    const stale = answer({ checkedAt: "2026-11-05T20:00:00.000Z", quarter: null, items: [] });
    const { ctx } = ctxFor([CHANGES], { answer: stale });
    const w = waiting(await checkTrigger(CHANGES, ctx));
    assert.equal(w.noteLines[0]!.code, "changes.reading");
    assert.equal(w.nextCheckMs, 10 * MINUTE_MS);
    assert.deepEqual(ctx.state.firedKeys, [], "nothing consumed while reading");
  });

  it("lets go of a filing the service read after it and did not compare (no document)", async () => {
    const noDoc = filing({ ...TENQ, accession: "0001375365-26-000051", primaryDocument: null });
    const { ctx } = ctxFor([CHANGES], { filings: [noDoc], answer: answer({ quarter: null, items: [] }) });
    waiting(await checkTrigger(CHANGES, ctx));
    assert.deepEqual(ctx.state.firedKeys, ["filing_changes:0001375365-26-000051"]);
  });

  it("waits up to a day for a document the service could not read before reporting", async () => {
    const partial = answer({ missing: ["documents"] });
    const early = ctxFor([CHANGES], { answer: partial });
    assert.equal(waiting(await checkTrigger(CHANGES, early.ctx)).noteLines[0]!.code, "changes.reading");
    const late = ctxFor([CHANGES], { answer: partial, now: new Date(NOW.getTime() + 26 * HOUR_MS) });
    fired(await checkTrigger(CHANGES, late.ctx));
  });

  it("reports a restatement 8-K beside the 10-Q in one event, oldest first", async () => {
    const withFlag = answer();
    withFlag.items.push(item({ id: `restatement:${RESTATEMENT.accession}`, kind: "restatement", form: "8-K", url: RESTATEMENT.url, detail: "4.02" }));
    const { ctx } = ctxFor([CHANGES], { filings: [RESTATEMENT, TENQ], answer: withFlag });
    const event = fired(await checkTrigger(CHANGES, ctx));
    assert.deepEqual(event.keys, [`filing:${Q_ACC}`, `filing:${RESTATEMENT.accession}`]);
    assert.match(event.title, /^SMCI filing changes in 2 filings: 10-Q 2026-11-05 \(.*\); 8-K 2026-11-05 \(non-reliance notice\)\.$/);
  });

  it("throws when the service cannot be read for any new filing, so the engine backs off", async () => {
    const sources = fakeSources({ filings: async () => [TENQ] });
    const agent = agentFixture({ ticker: "SMCI", triggers: [CHANGES], createdAt: CREATED });
    await assert.rejects(checkTrigger(CHANGES, { agent, state: state(), sources, now: NOW }), /could not be read/);
  });

  it("says nothing about risk factors the service could not read, and fires on nothing from them", async () => {
    const base = answer();
    const unreadable = answer({ quarterRisk: null, riskCount: null, missing: ["risk_unreadable"], items: base.items.filter((i) => !/risk/.test(i.kind)) });
    const { ctx } = ctxFor([CHANGES], { answer: unreadable });
    const event = fired(await checkTrigger(CHANGES, ctx));
    const hits = event.changes!.hits;
    assert.deepEqual(
      hits[0]!.firing.map((i) => i.kind),
      ["material_weakness"],
    );
    const facts = changesFacts(hits, unreadable);
    assert.ok(!facts.some((f) => /risk factor/i.test(f)), facts.join(" | "));
    // Watching risk factors alone: the filing is let go quietly.
    const onlyRisks: AgentTrigger = { kind: "filing_changes", ticker: "SMCI", kinds: ["risk_factors"] };
    const quiet = ctxFor([onlyRisks], { answer: unreadable });
    assert.equal(waiting(await checkTrigger(onlyRisks, quiet.ctx)).noteLines[0]!.code, "changes.noneWatched");
  });

  it("has a stable signature per company and kinds", () => {
    assert.equal(triggerSignature(CHANGES), "changes:SMCI:");
    assert.equal(triggerSignature({ kind: "filing_changes", ticker: "SMCI", kinds: ["red_flags", "risk_factors"] }), "changes:SMCI:red_flags,risk_factors");
  });
});

describe("one filing, one report: the plain filing trigger on the same agent", () => {
  it("waits for the changes watch to decide, then reports what it let go", async () => {
    const triggers = [PLAIN, CHANGES];
    const first = ctxFor(triggers, { now: new Date(Date.parse(TENQ.acceptedAt!) + HOUR_MS) });
    waiting(await checkTrigger(PLAIN, first.ctx));
    // The changes watch reads it and finds nothing watched: the plain trigger reports it.
    const after = ctxFor(triggers, { st: state({ firedKeys: [`filing_changes:${Q_ACC}`] }), now: first.ctx.now });
    assert.deepEqual(fired(await checkTrigger(PLAIN, after.ctx)).keys, [`filing:${Q_ACC}`]);
  });

  it("stops waiting after six hours", async () => {
    const late = ctxFor([PLAIN, CHANGES], { now: new Date(Date.parse(TENQ.acceptedAt!) + 7 * HOUR_MS) });
    fired(await checkTrigger(PLAIN, late.ctx));
  });

  it("does not wait for a filing the changes watch does not read", async () => {
    const eightK = filing({ cik: CIK, form: "8-K", accession: "0001375365-26-000053", filedAt: "2026-11-05", acceptedAt: "2026-11-05T21:50:00.000Z", items: ["7.01"] });
    const { ctx } = ctxFor([PLAIN, CHANGES], { filings: [eightK] });
    fired(await checkTrigger(PLAIN, ctx));
  });

  it("through the engine: the changes report wins, and the filing is not reported again", async () => {
    let clock = new Date(CREATED);
    const sources = fakeSources({
      filings: async () => [TENQ],
      filingChanges: async () => answer(),
      lookupTicker: async (t) => ({ symbol: t, companyName: "Super Micro Computer, Inc." }),
    });
    const caller: AgentModelCaller = async () =>
      JSON.stringify({
        headline: "10-Q: material weakness in revenue controls",
        summary: "The new risk factor is about tariffs on server components imported from Taiwan. The material weakness is in the controls over revenue recognition.",
        readings: [],
        sources: [1],
      });
    const engine = new AgentEngine({
      root: fs.mkdtempSync(path.join(os.tmpdir(), "falcon-agents-changes-")),
      userKey: () => "anon",
      userId: () => undefined,
      sources,
      caller: () => caller,
      channels: () => [],
      emit: () => {},
      now: () => clock,
      log: () => {},
    });
    const created = await engine.create({ name: "Filing changes at SMCI", brief: "Tell me when SMCI's next 10-Q has a new risk factor.", ticker: "SMCI", triggers: [PLAIN, CHANGES], metrics: [], channels: [] });
    assert.ok(created.ok);
    clock = new Date(NOW);
    const run = await engine.runNow(created.data.id);
    assert.ok(run.ok && run.data.fired);
    const report = run.data.report!;
    assert.equal(report.trigger, "filing_changes");
    assert.ok(report.summary.startsWith("SMCI filed a 10-Q on 2026-11-05. 1 new risk factor heading against the 10-K filed 2026-08-28:"), report.summary);
    assert.ok(report.summary.includes(`"${TARIFF}"`), "the heading is quoted as filed");
    assert.ok(report.summary.includes(`SEC EDGAR: ${TENQ.url}#item_1a`));
    assert.ok(report.summary.endsWith("The material weakness is in the controls over revenue recognition."));
    assert.ok(report.sources.some((s) => s.url === `${TENQ.url}#item_1a`));
    const again = await engine.runNow(created.data.id);
    assert.ok(again.ok && !again.data.fired, "the same 10-Q is not reported again, by either trigger");
  });
});

describe("the opening paragraph", () => {
  const hit = (a: FilingChanges, f: FilingRef = TENQ): ChangesHit => {
    const items = a.items.filter((i) => i.id.split(":")[1] === f.accession);
    return { filing: f, items, firing: items.filter((i) => itemFires(i, kindsOf({}))) };
  };

  it("says what was filed and quotes each change, with the filing's link", () => {
    const a = answer();
    const lead = changesLead([hit(a)], "SMCI", a);
    assert.equal(
      lead,
      `SMCI filed a 10-Q on 2026-11-05. 1 new risk factor heading against the 10-K filed 2026-08-28: "${TARIFF}". ` +
        "1 other heading new against that report was already in the 10-Q filed before this one. " +
        `The filing reports a material weakness in internal control: "${WEAKNESS.replace(/\.$/, "")}". ` +
        `SEC EDGAR: ${TENQ.url}#item_1a`,
    );
  });

  it("writes customer moves, auditor changes and red flag filings in plain sentences", () => {
    const tenK = filing({ ...TENQ, form: "10-K", accession: K_ACC, filedAt: "2026-08-28", url: `${DIR}/000137536526000031/smci-20260630.htm` });
    const a = answer({
      quarter: null,
      items: [
        item({ id: `auditor_name:${K_ACC}`, kind: "auditor_name", form: "10-K", name: "BDO USA, P.C.", previous: "Ernst & Young LLP" }),
        item({ id: `customer_share:${K_ACC}:revenue:globex`, kind: "customer_share", form: "10-K", name: "Globex", pct: 24, previousPct: 18, detail: "revenue", text: "Globex accounted for 24% of net sales." }),
        item({ id: `customer_named:${K_ACC}:initech`, kind: "customer_named", form: "10-K", name: "Initech", text: "Initech purchased our liquid cooling racks." }),
        item({ id: `customer_share_dropped:${K_ACC}:revenue:hooli`, kind: "customer_share_dropped", form: "10-K", name: "Hooli", previousPct: 11, detail: "revenue", notable: false }),
      ],
    });
    const lead = changesLead([hit(a, tenK)], "SMCI", a);
    assert.match(lead, /^SMCI filed a 10-K on 2026-08-28\. /);
    assert.match(lead, /The auditor named in this report is BDO USA, P\.C\.; the previous annual report named Ernst & Young LLP\./);
    assert.match(lead, /Globex: 24% of revenue, against 18% in the previous annual report: "Globex accounted for 24% of net sales"\./);
    assert.match(lead, /Initech is named as a customer; the previous annual report does not name it: "Initech purchased our liquid cooling racks"\./);
    assert.match(lead, /Hooli was 11% of revenue in the previous annual report; this one states no share for it\./);
    assert.equal(
      changesLead([{ filing: RESTATEMENT, items: [], firing: [item({ id: `restatement:${RESTATEMENT.accession}`, kind: "restatement", url: RESTATEMENT.url })] }], "SMCI", a),
      `SMCI filed an 8-K on 2026-11-05 under item 4.02, non-reliance on previously issued financial statements or a related audit report. SEC EDGAR: ${RESTATEMENT.url}`,
    );
    const nt = filing({ cik: CIK, form: "NT 10-Q", accession: "0001375365-26-000060", filedAt: "2026-11-12", items: [] });
    assert.match(changesLead([{ filing: nt, items: [], firing: [item({ id: `late_filing:${nt.accession}`, kind: "late_filing", url: nt.url })] }], "SMCI", a), /^SMCI filed an NT 10-Q on 2026-11-12, a notice that its 10-Q could not be filed on time\./);
  });

  it("keeps Falcon's own words to the copy rules; only the filing's quoted words are its own", () => {
    const a = answer();
    const tenK = filing({ ...TENQ, form: "10-K", accession: K_ACC, filedAt: "2026-08-28" });
    const leads = [changesLead([hit(a)], "SMCI", a), changesLead([hit(a, tenK)], "SMCI", a)];
    for (const lead of leads) {
      const ours = lead.replace(/"[^"]*"/g, "QUOTE").replace(/https:\/\/\S+/g, "LINK");
      assert.deepEqual(copyIssues(ours), [], ours);
      assert.ok(!/\bwill\b|\bexpect|\bforecast|\blikely\b/i.test(ours), "no forecasts");
    }
    assert.deepEqual(copyIssues(changesTitle([hit(a)], "SMCI")), []);
  });
});

describe("the reader's words", () => {
  const BRIEF = "Tell me when SMCI's next 10-K or 10-Q adds a risk factor, reports a material weakness, changes auditor, or names a new customer.";

  it("reads the request as one filing changes trigger, not a filing, results or linked watch", async () => {
    const d = await heuristicDraft(BRIEF, { sources: fakeSources({ lookupTicker: async (t) => (t === "SMCI" ? { symbol: "SMCI", companyName: "Super Micro Computer, Inc." } : null) }) });
    assert.deepEqual(d.triggers, [{ kind: "filing_changes", ticker: "SMCI", kinds: ["risk_factors", "red_flags", "customers"] }]);
    assert.equal(d.name, "Filing changes at SMCI");
  });

  it("maps each phrase to its kind", async () => {
    const sources = fakeSources({ lookupTicker: async (t) => (t === "SMCI" ? { symbol: "SMCI", companyName: "Super Micro" } : null) });
    const kinds = async (brief: string) => {
      const d = await heuristicDraft(brief, { sources });
      const t = d.triggers.find((x) => x.kind === "filing_changes");
      return t && t.kind === "filing_changes" ? (t.kinds ?? "all") : null;
    };
    assert.deepEqual(await kinds("Watch SMCI risk factors"), ["risk_factors"]);
    assert.deepEqual(await kinds("Tell me if SMCI reports a going concern"), ["red_flags"]);
    assert.deepEqual(await kinds("Alert me to any SMCI restatement"), ["red_flags"]);
    assert.deepEqual(await kinds("Tell me if SMCI changes its auditor"), ["red_flags"]);
    assert.deepEqual(await kinds("Tell me when SMCI names a new customer"), ["customers"]);
    assert.deepEqual(await kinds("SMCI material weakness or new supplier"), ["red_flags", "suppliers"]);
    assert.equal(await kinds("Tell me when SMCI files an 8-K"), null, "a plain filing request stays a filing trigger");
  });

  it("puts the watch in when the model wrote a plain 10-K/10-Q watch, and drops that one", () => {
    const fromModel: AgentTrigger[] = [
      { kind: "filing", ticker: "SMCI", forms: ["10-K", "10-Q"] },
      { kind: "linked", ticker: "SMCI", events: ["filing"], relations: ["customer"] },
      { kind: "filing", ticker: "SMCI", forms: ["4"], insiderBuysOnly: true },
    ];
    assert.deepEqual(withChangesWatch(fromModel, "SMCI", BRIEF), [
      { kind: "filing_changes", ticker: "SMCI", kinds: ["risk_factors", "red_flags", "customers"] },
      { kind: "filing", ticker: "SMCI", forms: ["4"], insiderBuysOnly: true },
    ]);
    const nvda: AgentTrigger[] = [{ kind: "earnings", ticker: "NVDA", moment: "release" }];
    assert.deepEqual(withChangesWatch(nvda, "NVDA", "Tell me when NVDA reports"), nvda, "other words are left alone");
  });

  it("takes the model's filing changes trigger, cleaned", async () => {
    const caller: AgentModelCaller = async () =>
      JSON.stringify({
        name: "SMCI filing changes",
        ticker: "SMCI",
        companyName: "Super Micro",
        triggers: [
          {
            kind: "filing_changes",
            ticker: null,
            moment: null,
            forms: null,
            insiderBuysOnly: null,
            thresholdPct: null,
            window: null,
            keywords: null,
            event: null,
            cadence: null,
            time: null,
            weekday: null,
            relations: [],
            minTier: "none",
            events: [],
            kinds: ["red_flags", "risk_factors", "bogus"],
          },
          { kind: "filing", ticker: "SMCI", forms: ["10-q"], relations: [], minTier: "none", events: [], kinds: [] },
        ],
        metrics: [],
        instructions: null,
        oneShot: false,
        ends: "",
        clarify: "none",
        notes: [],
      });
    const sources = fakeSources({ lookupTicker: async (t) => ({ symbol: t, companyName: "Super Micro Computer, Inc." }) });
    const d = await draftFromBriefWithModel(BRIEF, { caller, sources, today: "2026-10-16" });
    assert.deepEqual(d.triggers, [{ kind: "filing_changes", ticker: "SMCI", kinds: ["risk_factors", "red_flags"] }]);
  });

  it("validates the trigger: a ticker is needed, all four kinds read as none", () => {
    assert.deepEqual(validateTrigger({ kind: "filing_changes", ticker: "smci", kinds: ["suppliers", "customers", "red_flags", "risk_factors"] }), { kind: "filing_changes", ticker: "SMCI" });
    assert.deepEqual(validateTrigger({ kind: "filing_changes", kinds: ["customers"] }, "AMD"), { kind: "filing_changes", ticker: "AMD", kinds: ["customers"] });
    assert.throws(() => validateTrigger({ kind: "filing_changes" }), /needs a ticker/);
    assert.equal(defaultName("SMCI", [{ kind: "filing_changes", ticker: "SMCI" }]), "Filing changes at SMCI");
  });

  it("runs two reporting seasons when no end was named, and a filing end waits for the watch to read it", async () => {
    assert.deepEqual(proposeEnds({ triggers: [CHANGES], oneShot: false }, "2026-10-16"), { kind: "date", date: addDaysYmd("2026-10-16", STANDING_EARNINGS_DAYS) });
    const agent = { ends: { kind: "filing" as const, ticker: "SMCI", form: "10-Q" }, createdAt: CREATED, triggers: [CHANGES] };
    const sources = fakeSources({ filings: async () => [TENQ] });
    assert.equal(await endReached(agent, state(), sources, NOW), false, "not before the watch has read it");
    assert.equal(await endReached(agent, state({ firedKeys: [`filing_changes:${Q_ACC}`] }), sources, NOW), true);
  });

  it("has an English sentence for every line code the check writes", () => {
    for (const code of ["changes.watching", "changes.reading", "changes.noneWatched", "changes.unavailable"]) {
      assert.ok((en as Record<string, string>)[`agents.line.${code}`], code);
    }
  });
});
