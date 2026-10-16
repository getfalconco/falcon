import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { AgentTrigger } from "../../shared/agent-types";
import { en } from "../../renderer/lib/i18n/messages/areas/agents";
import { AgentEngine } from "./engine";
import { STANDING_EARNINGS_DAYS, proposeEnds } from "./ends";
import { gatherMaterial } from "./gather";
import { DRAFT_SCHEMA, draftFromBriefWithModel, draftUser, finalizeReport, heuristicDraft, linkedFromWords, type AgentModelCall, type AgentModelCaller } from "./llm";
import { linkedCapFor, linkedLead, reactionSentence, resolveLinkedSet, tierRelation, type LinkedCompany } from "./linked";
import { materialFromFeed, type AgentDataSources, type FilingRef, type LinkGraphEdge, type MaterialNewsItem } from "./sources";
import { EMPTY_STATE, type AgentEngineState } from "./store";
import { agentFixture, fakeSources, filing } from "./test-fakes";
import { checkTrigger, hashKey, triggerSignature, type TriggerCheck, type TriggerContext, type TriggerEvent } from "./triggers";
import { MINUTE_MS, addDaysYmd, nyInstant } from "./time";
import { validateTrigger } from "./validate";

/**
 * The `linked` trigger: who is in NVDA's linked set, when a linked
 * company's filing or story fires (once), what the write-up says about the
 * link, and how the reader's words become the trigger. Fixed clock, fake
 * data; 2026-10-27 is a Tuesday and New York is on EDT (UTC-4).
 */

function edge(root: string, counterparty: string | null, category: string, tier: string, over: Partial<LinkGraphEdge> = {}): LinkGraphEdge {
  return {
    root_ticker: root,
    counterparty_ticker: counterparty,
    counterparty_id: counterparty ?? "name:private co",
    category,
    strength_tier: tier,
    confidence: 0.95,
    evidence_quote: `${root}'s filing names ${counterparty ?? "a private company"} as a ${category}`,
    source_url: `https://www.sec.gov/Archives/edgar/data/1/${root.toLowerCase()}-10k.htm`,
    accession_number: `0000000001-26-${root}`,
    filing_date: "2026-02-25",
    form: "10-K",
    ...over,
  };
}

const EDGES: LinkGraphEdge[] = [
  // NVDA's own 10-K names TSM a supplier; TSM's 20-F names NVDA a critical customer.
  edge("NVDA", "TSM", "supplier", "important", { confidence: 0.98 }),
  edge("TSM", "NVDA", "customer", "critical", { confidence: 0.9, form: "20-F" }),
  // AMKR's 10-K names NVDA a customer with a share: AMKR is NVDA's supplier.
  edge("AMKR", "NVDA", "customer", "critical", {
    disclosed_share_pct: 12.5,
    disclosed_share_quote: "Direct sales to NVIDIA accounted for 12.5% of our net sales.",
    evidence_quote: "NVIDIA is one of our largest customers by net sales.",
  }),
  // HPE's 10-K names NVDA a supplier: HPE is NVDA's customer.
  edge("HPE", "NVDA", "supplier", "critical"),
  edge("NVDA", "MU", "supplier", "marginal"),
  edge("NVDA", "AMD", "competitor", "marginal"),
  edge("NVDA", "INTC", "partner", "important"),
  edge("NVDA", "ABC", "supplier", "important", { confidence: 0.6 }),
  edge("NVDA", "XYZ", "supplier", "important", { accession_number: null }),
  edge("NVDA", "USGOV", "customer", "critical", { counterparty_id: "name:us government", counterparty_type: "government" }),
  edge("NVDA", null, "supplier", "critical"),
  edge("NVDA", "NVDA", "supplier", "critical"),
];

const LINKED: AgentTrigger = { kind: "linked", ticker: "NVDA", events: ["earnings", "filing"] };
const CREATED = "2026-10-15T12:00:00.000Z";
const NOW = "2026-10-27T21:00:00Z";

function ctx(trigger: AgentTrigger, sources: Partial<AgentDataSources> = {}, state: Partial<AgentEngineState> = {}, now = NOW): TriggerContext {
  return {
    agent: agentFixture({ triggers: [trigger], createdAt: CREATED, oneShot: false }),
    state: { ...EMPTY_STATE, firedKeys: [], lastFiredByTrigger: {}, ...state },
    sources: fakeSources({ linkEdges: async () => EDGES, ...sources }),
    now: new Date(now),
  };
}

function waiting(c: TriggerCheck): Extract<TriggerCheck, { status: "waiting" }> {
  assert.equal(c.status, "waiting", JSON.stringify(c));
  return c as Extract<TriggerCheck, { status: "waiting" }>;
}

function fired(c: TriggerCheck): TriggerEvent {
  assert.equal(c.status, "fired", JSON.stringify(c));
  return (c as Extract<TriggerCheck, { status: "fired" }>).event;
}

const AMKR_RESULTS = filing({
  cik: "0001047127",
  accession: "0001047127-26-000050",
  form: "8-K",
  items: ["2.02", "9.01"],
  filedAt: "2026-10-27",
  acceptedAt: "2026-10-27T20:05:00.000Z",
  url: "https://www.sec.gov/Archives/edgar/data/1047127/000104712726000050/amkr-8k.htm",
});
const AMKR_OLD = filing({ accession: "0001047127-26-000010", filedAt: "2026-10-01", acceptedAt: "2026-10-01T20:00:00.000Z" });
const byTicker = (map: Record<string, FilingRef[]>) => async (t: string) => map[t] ?? [];

describe("the linked set, from the filing graph", () => {
  it("reads links from the watched name's side, keeps filing-backed confident ones, and orders by tier, share, confidence", () => {
    const { companies, total } = resolveLinkedSet(EDGES, { ticker: "NVDA" });
    assert.deepEqual(
      companies.map((c) => [c.ticker, c.relation, c.tier, c.namedBy]),
      [
        ["AMKR", "supplier", "critical", "AMKR"],
        ["HPE", "customer", "critical", "HPE"],
        ["TSM", "supplier", "critical", "TSM"],
      ],
    );
    assert.equal(total, 3);
    assert.equal(companies[0]!.sharePct, 12.5);
    assert.match(companies[0]!.shareQuote!, /12\.5% of our net sales/);
    assert.equal(companies[2]!.form, "20-F", "the strongest link for TSM is its own 20-F's");
  });

  it("leaves out the U.S. government node, nameless and self links, partners, weak and unsourced links", () => {
    const all = resolveLinkedSet(EDGES, { ticker: "NVDA", minTier: "marginal" }).companies.map((c) => c.ticker);
    assert.deepEqual(all, ["AMKR", "HPE", "TSM", "AMD", "MU"]);
    for (const t of ["USGOV", "INTC", "ABC", "XYZ", "NVDA"]) assert.ok(!all.includes(t), t);
  });

  it("narrows to the relations and tier asked for", () => {
    assert.deepEqual(resolveLinkedSet(EDGES, { ticker: "NVDA", relations: ["supplier"] }).companies.map((c) => c.ticker), ["AMKR", "TSM"]);
    assert.deepEqual(resolveLinkedSet(EDGES, { ticker: "NVDA", relations: ["competitor"], minTier: "marginal" }).companies.map((c) => c.ticker), ["AMD"]);
    assert.deepEqual(resolveLinkedSet(EDGES, { ticker: "nvda", minTier: "critical", relations: ["customer"] }).companies.map((c) => c.ticker), ["HPE"]);
  });

  it("caps the set, closest first, and splits the cap across an agent's linked triggers", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      edge("NVDA", `S${String(i).padStart(2, "0")}`, "supplier", i % 2 === 0 ? "critical" : "important", { disclosed_share_pct: i }),
    );
    const { companies, total } = resolveLinkedSet(many, { ticker: "NVDA" }, () => null, 25);
    assert.equal(total, 40);
    assert.equal(companies.length, 25);
    assert.ok(companies.slice(0, 20).every((c) => c.tier === "critical"));
    assert.equal(companies[0]!.ticker, "S38", "the largest stated share among the critical ones first");
    assert.equal(linkedCapFor({ triggers: [LINKED] }), 25);
    assert.equal(linkedCapFor({ triggers: [LINKED, { ...LINKED, ticker: "AAPL" }] }), 12);
    assert.equal(linkedCapFor({ triggers: Array.from({ length: 6 }, () => LINKED) }), 5);
  });

  it("takes the filing form from the filer's meta file when the edge lacks it", () => {
    const { companies } = resolveLinkedSet([edge("TSM", "NVDA", "customer", "critical", { form: null })], { ticker: "NVDA" }, (f) => (f === "TSM" ? "20-F" : null));
    assert.equal(companies[0]!.form, "20-F");
  });
});

describe("the linked check: polling and dedupe", () => {
  it("fires on a linked company's results 8-K, once, with the link that put it in the set", async () => {
    const sources = { filings: byTicker({ AMKR: [AMKR_RESULTS, AMKR_OLD] }) };
    const c = ctx(LINKED, sources);
    const e = fired(await checkTrigger(LINKED, c));
    assert.equal(e.kind, "linked");
    assert.deepEqual(e.keys, ["filing:0001047127-26-000050"]);
    assert.equal(e.linked?.length, 1);
    assert.equal(e.linked![0]!.kind, "earnings");
    assert.equal(e.linked![0]!.company.ticker, "AMKR");
    assert.equal(e.title, "AMKR, a critical supplier to NVDA, filed an 8-K (item 2.02) with its results.");
    // The engine records the keys it consumed; the next look finds nothing new.
    const again = waiting(await checkTrigger(LINKED, { ...c, state: { ...c.state, firedKeys: e.keys } }));
    assert.match(again.detail, /Watching 3 companies linked to NVDA\. Nothing new from them yet\./);
    assert.deepEqual(again.noteLines, [{ code: "linked.watching", params: { count: 3, ticker: "NVDA" } }]);
  });

  it("skips filings from before the agent started and ones too old to be news", async () => {
    const stale = filing({ accession: "0001047127-26-000040", filedAt: "2026-10-20", acceptedAt: "2026-10-20T20:00:00.000Z" });
    waiting(await checkTrigger(LINKED, ctx(LINKED, { filings: byTicker({ AMKR: [AMKR_OLD, stale] }) })));
  });

  it("does not share one filing between the plain filing trigger and the linked one", async () => {
    waiting(await checkTrigger(LINKED, ctx(LINKED, { filings: byTicker({ AMKR: [AMKR_RESULTS] }) }, { firedKeys: ["filing:0001047127-26-000050"] })));
  });

  it("counts a company that joins the set with a rebuilt graph from when it joined", async () => {
    const tsm8k = filing({ accession: "0001046179-26-000077", form: "8-K", items: ["8.01"], filedAt: "2026-10-27", acceptedAt: "2026-10-27T20:30:00.000Z" });
    const sig = triggerSignature(LINKED);
    const c = ctx(LINKED, { filings: byTicker({ TSM: [tsm8k] }) }, { linked: { [sig]: { AMKR: CREATED, HPE: CREATED } } });
    waiting(await checkTrigger(LINKED, c));
    assert.equal(c.state.linked?.[sig]?.TSM, new Date(NOW).toISOString());
    assert.equal(c.state.linked?.[sig]?.AMKR, CREATED);
  });

  it("reads a foreign filer's 6-K on its results date as its results", async () => {
    const t: AgentTrigger = { kind: "linked", ticker: "NVDA", events: ["earnings"] };
    const sixK = filing({ accession: "0001046179-26-000070", form: "6-K", items: [], filedAt: "2026-10-16", acceptedAt: "2026-10-16T10:00:00.000Z" });
    const sources = {
      filings: byTicker({ TSM: [sixK] }),
      earningsDates: async (tk: string) => (tk === "TSM" ? { dates: ["2026-10-16"], estimated: false } : { dates: [], estimated: null }),
    };
    const e = fired(await checkTrigger(t, ctx(t, sources, {}, "2026-10-16T12:00:00Z")));
    assert.equal(e.linked![0]!.kind, "earnings");
    assert.equal(e.linked![0]!.company.ticker, "TSM");
    // A 6-K a week from the date is not results.
    const far = filing({ ...sixK, filedAt: "2026-10-16" });
    waiting(await checkTrigger(t, ctx(t, { ...sources, earningsDates: async () => ({ dates: ["2026-10-23"], estimated: false }), filings: byTicker({ TSM: [far] }) }, {}, "2026-10-16T12:00:00Z")));
  });

  it("with filing events, matches the forms asked for and reads a results 8-K as a filing", async () => {
    const t: AgentTrigger = { kind: "linked", ticker: "NVDA", events: ["filing"], forms: ["8-K"] };
    const hpe10q = filing({ accession: "0001645590-26-000090", form: "10-Q", items: [], filedAt: "2026-10-27", acceptedAt: "2026-10-27T20:10:00.000Z" });
    const e = fired(await checkTrigger(t, ctx(t, { filings: byTicker({ AMKR: [AMKR_RESULTS], HPE: [hpe10q] }) })));
    assert.deepEqual(e.linked!.map((h) => [h.company.ticker, h.kind]), [["AMKR", "filing"]]);
  });

  it("polls EDGAR one linked company at a time, every 15 minutes while EDGAR is open", async () => {
    let inFlight = 0;
    let most = 0;
    const asked: string[] = [];
    const filings = async (t: string) => {
      asked.push(t);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return [];
    };
    const w = waiting(await checkTrigger(LINKED, ctx(LINKED, { filings })));
    assert.equal(most, 1);
    assert.deepEqual(asked, ["AMKR", "HPE", "TSM"]);
    assert.equal(w.nextCheckMs, 15 * MINUTE_MS);
  });

  it("says the next report among them and checks every 10 minutes around a results date", async () => {
    const sources = {
      earningsDates: async (t: string) => (t === "HPE" ? { dates: ["2026-11-24"], estimated: false } : { dates: [], estimated: null }),
    };
    const w = waiting(await checkTrigger(LINKED, ctx(LINKED, sources)));
    assert.equal(w.nextExpectedAt, nyInstant("2026-11-24", "08:00").toISOString());
    assert.ok(w.detailLines.some((l) => l.code === "linked.nextReport" && l.params?.ticker === "HPE" && l.params?.date === "2026-11-24"));
    const soon = waiting(await checkTrigger(LINKED, ctx(LINKED, { earningsDates: async () => ({ dates: ["2026-10-28"], estimated: false }) })));
    assert.equal(soon.nextCheckMs, 10 * MINUTE_MS);
  });

  it("keeps a results date twelve hours instead of asking the calendar on every check", async () => {
    let reads = 0;
    const earningsDates = async () => {
      reads++;
      return { dates: ["2026-11-24"], estimated: false };
    };
    const c = ctx(LINKED, { earningsDates });
    await checkTrigger(LINKED, c);
    assert.equal(reads, 3);
    await checkTrigger(LINKED, { ...c, now: new Date(Date.parse(NOW) + 15 * MINUTE_MS) });
    assert.equal(reads, 3);
  });

  it("says how many could not be read, and fails only when none could", async () => {
    const filings = async (t: string) => {
      if (t === "HPE") throw new Error("SEC filings request failed (503)");
      return [];
    };
    const w = waiting(await checkTrigger(LINKED, ctx(LINKED, { filings })));
    assert.ok(w.detailLines.some((l) => l.code === "linked.unread" && l.params?.count === 1));
    await assert.rejects(
      checkTrigger(LINKED, ctx(LINKED, { filings: async () => Promise.reject(new Error("down")) })),
      /EDGAR could not be read for the 3 linked companies/,
    );
  });

  it("waits, reading the graph hourly, when the name has no links yet", async () => {
    const w = waiting(await checkTrigger({ ...LINKED, ticker: "ZZZ" } as AgentTrigger, ctx({ ...LINKED, ticker: "ZZZ" } as AgentTrigger)));
    assert.deepEqual(w.detailLines.map((l) => l.code), ["linked.noneInGraph", "linked.readsGraphHourly"]);
  });

  it("fires on a material story about a linked company, never on one about another name", async () => {
    const t: AgentTrigger = { kind: "linked", ticker: "NVDA", events: ["news"] };
    const story = (id: string, tickers: string[], at: string): MaterialNewsItem => ({
      id,
      title: `Story ${id}`,
      url: `https://news.example.com/${id}`,
      source: "Reuters",
      publishedAt: at,
      tickers,
    });
    const materialNews = async () => [story("a", ["TSM"], "2026-10-27T20:00:00.000Z"), story("b", ["AAPL"], "2026-10-27T20:10:00.000Z")];
    const e = fired(await checkTrigger(t, ctx(t, { materialNews })));
    assert.deepEqual(e.keys, [`news:${hashKey("https://news.example.com/a")}`]);
    assert.equal(e.linked![0]!.company.ticker, "TSM");
    assert.equal(e.title, "Material news on TSM, a critical supplier to NVDA.");
    waiting(await checkTrigger(t, ctx(t, { materialNews }, { firedKeys: e.keys })));
  });
});

describe("the linked write-up: the link and the evidence", () => {
  const amkr = (): LinkedCompany => resolveLinkedSet(EDGES, { ticker: "NVDA" }).companies[0]!;
  const event = (): TriggerEvent => ({
    keys: ["filing:0001047127-26-000050"],
    kind: "linked",
    trigger: LINKED,
    title: "AMKR, a critical supplier to NVDA, filed an 8-K (item 2.02) with its results.",
    at: NOW,
    ticker: "NVDA",
    filings: [AMKR_RESULTS],
    linked: [{ company: amkr(), kind: "earnings", filing: AMKR_RESULTS }],
  });
  const rt = (sample: number, events: number) => [
    {
      counterparty: "AMKR",
      holding: "NVDA",
      sample,
      stats:
        events >= 3
          ? { events, withIt: 4, avgAbsMove: 0.0312, avgAbsAbnormal: 0.0221, sensitivity: 1.8, from: "2024-10-29", to: "2026-07-28" }
          : null,
    },
  ];

  it("names what was filed, the relation and tier, the stated share and the filing's words, and the measured reaction", async () => {
    const agent = agentFixture({ triggers: [LINKED], createdAt: CREATED, metrics: [] });
    const material = await gatherMaterial(event(), agent, { ...EMPTY_STATE }, fakeSources({ readthrough: async () => rt(6, 6) }), new Date(NOW));
    assert.equal(
      material.lead,
      "AMKR filed an 8-K (item 2.02) on 2026-10-27, its results release. " +
        "AMKR is a critical supplier to NVDA, per AMKR's 10-K filed 2026-02-25. " +
        'The filing states a share of 12.5%: "Direct sales to NVIDIA accounted for 12.5% of our net sales". ' +
        'The filing says: "NVIDIA is one of our largest customers by net sales". ' +
        "On AMKR's last 6 report days (2024-10-29 to 2026-07-28), NVDA moved 3.1% on average, 2.2% beyond the market, and in the same direction as AMKR on 4 of 6.",
    );
    assert.ok(material.sources.some((s) => s.url === "https://www.sec.gov/Archives/edgar/data/1/amkr-10k.htm"), "the 10-K that states the link is a source");
    assert.ok(material.sources.some((s) => s.url === AMKR_RESULTS.url), "the 8-K itself is a source");
    assert.ok(material.corpus.includes("12.5%"));
  });

  it("gives no reaction figure under three measured reports, only the count", () => {
    assert.equal(reactionSentence(amkr(), "NVDA", rt(2, 2)[0]), "Only 2 of AMKR's past reports could be measured against NVDA, too few for a figure.");
    assert.equal(reactionSentence(amkr(), "NVDA", rt(0, 0)[0]), null);
    assert.ok(!/%/.test(linkedLead([{ company: amkr(), kind: "earnings", filing: AMKR_RESULTS }], "NVDA", rt(2, 2)).split("Only")[1]!));
  });

  it("leaves a filing quote out rather than soften it, and adds no reaction line to a plain filing", () => {
    const c = { ...amkr(), quote: "We will rely on NVIDIA for most of our growth.", sharePct: null, shareQuote: null };
    const lead = linkedLead([{ company: c, kind: "filing", filing: { ...AMKR_RESULTS, items: ["8.01"] } }], "NVDA", rt(6, 6));
    assert.equal(lead, "AMKR filed an 8-K (item 8.01) on 2026-10-27. AMKR is a critical supplier to NVDA, per AMKR's 10-K filed 2026-02-25.");
  });

  it("prints the link above the model's summary, and keeps it when the model's text does not survive", () => {
    const agent = agentFixture({ triggers: [LINKED], metrics: [] });
    const material = { lead: "AMKR filed an 8-K (item 2.02) on 2026-10-27, its results release.", facts: [], documents: [], sources: [], corpus: "revenue 1,234" };
    const ids = { newId: () => "report-000001", now: new Date(NOW) };
    const report = finalizeReport({ headline: "AMKR revenue 1,234", summary: "Revenue came in at 1,234.", readings: [], sources: [] }, agent, event(), material, ids);
    assert.equal(report.summary, "AMKR filed an 8-K (item 2.02) on 2026-10-27, its results release.\n\nRevenue came in at 1,234.");
    const bare = finalizeReport({ headline: "x", summary: "Revenue was 9,999.", readings: [], sources: [] }, agent, event(), material, ids);
    assert.equal(bare.summary, material.lead);
  });
});

describe("the reader's words, into a linked trigger", () => {
  it("reads the example sentence: critical suppliers or customers, 8-Ks and results", async () => {
    const d = await heuristicDraft("Tell me when any of NVDA's critical suppliers or customers files an 8-K or reports", { sources: fakeSources() });
    assert.deepEqual(d.triggers, [
      { kind: "linked", ticker: "NVDA", relations: ["supplier", "customer"], minTier: "critical", events: ["earnings", "filing"], forms: ["8-K"] },
    ]);
    assert.equal(d.ticker, "NVDA");
    assert.equal(d.clarify, undefined);
  });

  it("reads suppliers of, customers' news and supply chain", () => {
    assert.deepEqual(linkedFromWords("suppliers of NVDA"), { events: ["earnings", "filing"], relations: ["supplier"] });
    assert.deepEqual(linkedFromWords("NVDA's customers, any news"), { events: ["news"], relations: ["customer"] });
    assert.deepEqual(linkedFromWords("AMD supply chain results"), { events: ["earnings"], relations: ["supplier", "customer"] });
    assert.deepEqual(linkedFromWords("all of NVDA's competitors when they file"), { events: ["filing"], relations: ["competitor"], minTier: "marginal" });
  });

  it("reads 'companies linked to my holdings' as one trigger per holding, and asks when there are none", async () => {
    const d = await heuristicDraft("Tell me when companies linked to my holdings report", { sources: fakeSources(), held: ["NVDA", "AAPL"] });
    assert.deepEqual(d.triggers, [
      { kind: "linked", ticker: "NVDA", events: ["earnings"] },
      { kind: "linked", ticker: "AAPL", events: ["earnings"] },
    ]);
    const none = await heuristicDraft("Tell me when companies linked to my holdings report", { sources: fakeSources(), held: [] });
    assert.deepEqual(none.triggers, []);
    assert.equal(none.clarify?.field, "subject");
    assert.ok(none.notes?.some((n) => /No holdings were found/.test(n)));
  });

  it("takes the model's linked trigger, cleaned, and the holdings go into the model's message", async () => {
    const calls: AgentModelCall[] = [];
    const caller: AgentModelCaller = async (call) => {
      calls.push(call);
      return JSON.stringify({
        name: "NVDA supplier filings",
        ticker: "NVDA",
        companyName: "Nvidia",
        triggers: [
          {
            kind: "linked",
            ticker: null,
            moment: null,
            forms: ["8k"],
            insiderBuysOnly: null,
            thresholdPct: null,
            window: null,
            keywords: null,
            event: null,
            cadence: null,
            time: null,
            weekday: null,
            relations: ["supplier", "customer"],
            minTier: "critical",
            events: ["filing", "earnings"],
          },
        ],
        metrics: [],
        instructions: null,
        oneShot: false,
        ends: "",
        clarify: "none",
        notes: [],
      });
    };
    const d = await draftFromBriefWithModel("Tell me when any of NVDA's critical suppliers or customers files an 8-K or reports", {
      caller,
      sources: fakeSources(),
      today: "2026-10-16",
      held: ["AAPL"],
    });
    assert.deepEqual(d.triggers, [
      { kind: "linked", ticker: "NVDA", events: ["earnings", "filing"], relations: ["supplier", "customer"], minTier: "critical", forms: ["8-K"] },
    ]);
    assert.match(calls[0]!.user, /THE READER'S HOLDINGS \(tickers they hold now\): AAPL/);
    assert.match(calls[0]!.system, /linked \{ticker, relations, minTier, events, forms\}/);
  });

  it("adds a linked trigger per holding when the model wrote none for 'my holdings'", async () => {
    const caller: AgentModelCaller = async () =>
      JSON.stringify({
        name: "Holdings links",
        ticker: null,
        companyName: null,
        triggers: [],
        metrics: [],
        instructions: null,
        oneShot: false,
        ends: "",
        clarify: "none",
        notes: [],
      });
    const d = await draftFromBriefWithModel("Watch the suppliers of my holdings for news", { caller, sources: fakeSources(), today: "2026-10-16", held: ["MSFT"] });
    assert.deepEqual(d.triggers, [{ kind: "linked", ticker: "MSFT", events: ["news"], relations: ["supplier"] }]);
    assert.equal(draftUser("x", []), "THE READER'S REQUEST, VERBATIM:\nx");
  });

  it("keeps the draft schema within structured outputs' cap of 16 union-typed parameters", () => {
    let unions = 0;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (Array.isArray(o.type) || Array.isArray(o.anyOf)) unions++;
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    };
    walk(DRAFT_SCHEMA);
    assert.ok(unions <= 16, `found ${unions}`);
  });

  it("validates a linked trigger: events required, all relations read as none, unknown tier dropped", () => {
    assert.deepEqual(validateTrigger({ kind: "linked", ticker: "nvda", events: ["news", "earnings", "news"], relations: ["supplier", "customer", "competitor"], minTier: "none" }), {
      kind: "linked",
      ticker: "NVDA",
      events: ["earnings", "news"],
    });
    assert.throws(() => validateTrigger({ kind: "linked", ticker: "NVDA", events: [] }), /needs an event/);
    assert.throws(() => validateTrigger({ kind: "linked", events: ["filing"] }), /needs a ticker/);
    assert.deepEqual(validateTrigger({ kind: "linked", events: ["filing"], forms: ["6k", "8-K"] }, "AMD"), { kind: "linked", ticker: "AMD", events: ["filing"], forms: ["6-K", "8-K"] });
  });

  it("through the engine: the create flow's holdings reach the draft, and a results watch runs two seasons", async () => {
    const engine = new AgentEngine({
      root: fs.mkdtempSync(path.join(os.tmpdir(), "falcon-agents-linked-")),
      userKey: () => "anon",
      userId: () => undefined,
      sources: fakeSources(),
      caller: () => null,
      channels: () => [],
      emit: () => {},
      now: () => new Date("2026-10-16T14:00:00.000Z"),
      log: () => {},
    });
    const res = await engine.draftFromBrief("Tell me when the customers of my positions report or file", { held: ["nvda", "$aapl", "not a ticker"] });
    assert.ok(res.ok);
    assert.deepEqual(res.data.triggers.map((t) => (t.kind === "linked" ? t.ticker : t.kind)), ["NVDA", "AAPL"]);
    assert.deepEqual(res.data.ends, { kind: "date", date: addDaysYmd("2026-10-16", STANDING_EARNINGS_DAYS) });
    assert.deepEqual(proposeEnds({ triggers: [{ kind: "linked", ticker: "NVDA", events: ["news"] }], oneShot: false }, "2026-10-16"), { kind: "date", date: "2027-01-14" });
  });

  it("has an English sentence for every line code the check writes", () => {
    for (const code of ["linked.watching.one", "linked.watching.other", "linked.noneInGraph", "linked.readsGraphHourly", "linked.nothingNew", "linked.nextReport", "linked.unread.other", "linked.newsUnavailable"]) {
      assert.ok((en as Record<string, string>)[`agents.line.${code}`], code);
    }
  });
});

describe("the material news the linked watch reads", () => {
  it("keeps the stories the feed shows, under Falcon's own title, since the given time", () => {
    const article = (id: number, decision: "show" | "hide", headline: string | null, at: number) => ({
      id,
      headline: `Publisher ${id}`,
      summary: "",
      url: `https://x.example/${id}`,
      source: "Reuters",
      datetime: at,
      tickers: ["TSM"],
      event: null,
      first_seen: "",
      sectors: [],
      falcon: {
        decision,
        reason: "material" as const,
        headline,
        headline_source: "falcon" as const,
        article_key: String(id),
        event_type: null,
        materiality: null,
        direction: null,
        tickers: ["tsm"],
        primary: null,
        duplicate_of: null,
      },
    });
    const since = Date.parse("2026-10-27T00:00:00Z");
    const out = materialFromFeed(
      {
        ok: true,
        articles: [article(1, "show", "TSMC lifts capex plan", since / 1000 + 60), article(2, "hide", null, since / 1000 + 60), article(3, "show", "Old", since / 1000 - 60)],
        status: {} as never,
      },
      since,
    );
    assert.deepEqual(out.map((n) => [n.title, n.tickers]), [["TSMC lifts capex plan", ["TSM"]]]);
    assert.throws(() => materialFromFeed({ ok: false, error: "x" }, since), /unavailable/);
  });
});

describe("the linked set: unclassified strength (the classifier gave no tier)", () => {
  const edges = [
    edge("NVDA", "TSM", "supplier", "important", { strength_basis: "unclassified", confidence: 0.99 }),
    edge("NVDA", "UMC", "supplier", "important", { strength_basis: "classified", confidence: 0.9 }),
    // An unclassified edge ranks as important whatever tier it carries.
    edge("NVDA", "GFS", "supplier", "marginal", { strength_basis: "unclassified" }),
  ];

  it("passes the important filter, never the critical one, and sorts after a measured important link", () => {
    const important = resolveLinkedSet(edges, { ticker: "NVDA", minTier: "important" }).companies;
    assert.deepEqual(
      important.map((c) => [c.ticker, c.tier, c.tierMeasured ?? true]),
      [
        ["UMC", "important", true],
        ["TSM", "important", false],
        ["GFS", "important", false],
      ],
    );
    assert.deepEqual(resolveLinkedSet(edges, { ticker: "NVDA", minTier: "critical" }).companies, []);
  });

  it("never states the unmeasured tier in the write-up", () => {
    const tsm = resolveLinkedSet(edges, { ticker: "NVDA", minTier: "important" }).companies.find((c) => c.ticker === "TSM")!;
    assert.equal(tierRelation(tsm, "NVDA"), "a supplier to NVDA");
    const umc = resolveLinkedSet(edges, { ticker: "NVDA", minTier: "important" }).companies.find((c) => c.ticker === "UMC")!;
    assert.equal(tierRelation(umc, "NVDA"), "an important supplier to NVDA");
  });
});
