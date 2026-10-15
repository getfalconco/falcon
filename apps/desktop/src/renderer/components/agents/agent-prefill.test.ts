import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LANGUAGES, type LanguageCode } from "../../lib/i18n/languages";
import { draftIssues } from "./agent-draft";
import { say, understanding } from "./agent-format";
import { STANDING_DAYS, STANDING_REPORTS_DAYS, createFocus, earningsWatchDraft, filingChangesWatchDraft, starterDraft } from "./agent-prefill";
import { buildStarterTemplates, starterBrief, type StarterId, type StarterTemplate } from "./agent-templates";
import { CONFIRM, DESCRIBE, initialWizard, nextMove, wizardReducer, type WizardAction, type WizardState } from "./agent-wizard";

const TODAY = "2026-10-16";
const TR_BRIEF = "NVDA 19 Kas tarihinde rapor açıklıyor. Bilanço yayımlandığında HBK ve gelirin konsensüsle nasıl karşılaştırıldığını söyle.";

const run = (actions: WizardAction[], from: WizardState = initialWizard()) => actions.reduce(wizardReducer, from);

describe("prefilled drafts: the trigger set by the screen, not read from words", () => {
  it("Create agent in an earnings drawer: one results release, with the metrics in the reader's language", () => {
    const d = earningsWatchDraft({ ticker: " nvda ", brief: TR_BRIEF, date: "2026-11-19", today: TODAY }, "tr-TR");
    assert.deepEqual(d.triggers, [{ kind: "earnings", ticker: "NVDA", moment: "release" }]);
    assert.equal(d.ticker, "NVDA");
    assert.equal(d.brief, TR_BRIEF);
    assert.equal(d.name, say("tr-TR", "agents.noun.earnings", { ticker: "NVDA" }));
    assert.deepEqual(
      d.metrics.map((m) => m.label),
      ["HBK", "Gelir", "Öngörü"],
    );
    assert.equal(d.oneShot, true);
    assert.deepEqual(d.ends, { kind: "earnings", ticker: "NVDA" });
    assert.equal(d.endsProposed, true);
    assert.deepEqual(d.channels, ["digest"]);
    assert.equal(d.nextExpectedAt, "2026-11-19T12:00:00.000Z");
    assert.equal(d.clarify, undefined);
    assert.deepEqual(draftIssues(d, "tr-TR"), []);
  });

  it("leaves the date off a report that is already out", () => {
    const d = earningsWatchDraft({ ticker: "NVDA", brief: TR_BRIEF, date: "2026-08-27", today: TODAY }, "en-US");
    assert.equal(d.nextExpectedAt, undefined);
    assert.equal(d.name, "NVDA earnings");
  });

  it("Watch filings: every kind of change, standing for two reporting seasons, worded in the reader's language", () => {
    const d = filingChangesWatchDraft({ ticker: "smci", today: TODAY }, "tr-TR");
    assert.deepEqual(d.triggers, [{ kind: "filing_changes", ticker: "SMCI" }], "no kinds: all four");
    assert.equal(d.brief, say("tr-TR", "agents.starter.changes.brief", { ticker: "SMCI" }));
    assert.equal(d.name, say("tr-TR", "agents.starter.changes.title", { ticker: "SMCI" }));
    assert.equal(d.oneShot, false);
    assert.equal(STANDING_REPORTS_DAYS, 184);
    assert.deepEqual(d.ends, { kind: "date", date: "2027-04-18" });
    assert.equal(d.endsProposed, true);
    assert.deepEqual(d.metrics, []);
    assert.deepEqual(draftIssues(d, "tr-TR"), []);
  });

  it("has the metric labels in every language", () => {
    for (const { code } of LANGUAGES) {
      const d = earningsWatchDraft({ ticker: "NVDA", brief: "x", today: TODAY }, code);
      for (const m of d.metrics) assert.ok(m.label.trim() && !m.label.startsWith("agents."), `${code}: ${m.label}`);
    }
  });

  it("reads back on the confirm step in the reader's language", () => {
    const lines = understanding(filingChangesWatchDraft({ ticker: "SMCI", today: TODAY }, "tr-TR"), "tr-TR").lines;
    assert.ok(lines.length >= 3);
    assert.ok(!lines.some((l) => /\bIt watches\b|\bEach report\b/.test(l)), lines.join(" | "));
  });
});

describe("openCreateAgent's request", () => {
  it("carries a prebuilt draft, its brief and its name", () => {
    const draft = filingChangesWatchDraft({ ticker: "SMCI", today: TODAY }, "tr-TR");
    const f = createFocus(draft, undefined, 7);
    assert.equal(f.kind, "create");
    assert.equal(f.seq, 7);
    assert.equal(f.brief, draft.brief);
    assert.equal(f.name, draft.name);
    assert.deepEqual(f.draft?.triggers, draft.triggers);
  });

  it("lets a name passed beside the draft win", () => {
    const f = createFocus(filingChangesWatchDraft({ ticker: "SMCI", today: TODAY }, "en-US"), "  My SMCI watch ", 1);
    assert.equal(f.name, "My SMCI watch");
    assert.equal(f.draft?.name, "My SMCI watch");
  });

  it("keeps the words-only path as it was", () => {
    assert.deepEqual(createFocus("  Tell me when NVDA reports ", "NVDA", 2), { kind: "create", seq: 2, brief: "Tell me when NVDA reports", name: "NVDA" });
    assert.deepEqual(createFocus(undefined, undefined, 3), { kind: "create", seq: 3 });
    assert.equal("draft" in createFocus("words", undefined, 4), false);
  });
});

describe("the create flow started on a prefilled draft", () => {
  const draft = earningsWatchDraft({ ticker: "NVDA", brief: TR_BRIEF, date: "2026-11-19", today: TODAY }, "tr-TR");

  it("opens on the confirm step with nothing to read, and Start agent is next", () => {
    const s = run([{ type: "prefill", draft }]);
    assert.equal(s.step, CONFIRM);
    assert.equal(s.draftingFor, null);
    assert.deepEqual(s.draft?.triggers, draft.triggers);
    assert.equal(s.name, draft.name);
    assert.equal(s.brief, TR_BRIEF);
    assert.equal(nextMove(s), "create");
  });

  it("starts over from whatever the wizard held", () => {
    const busy = run([
      { type: "name", text: "Old" },
      { type: "brief", text: "Something typed before" },
      { type: "draft-start", text: "Something typed before" },
    ]);
    const s = wizardReducer(busy, { type: "prefill", draft, name: "Mine" });
    assert.equal(s.step, CONFIRM);
    assert.equal(s.draftingFor, null);
    assert.equal(s.name, "Mine");
    assert.equal(s.draft?.name, "Mine");
  });

  it("Change and Next come back to the same draft without a reading; edited words are read", () => {
    let s = run([{ type: "prefill", draft }, { type: "back" }]);
    assert.equal(s.step, DESCRIBE);
    assert.equal(nextMove(s), "advance", "the words are unchanged: no reading");
    s = wizardReducer(s, { type: "forward" });
    assert.equal(s.step, CONFIRM);
    s = run([{ type: "back" }, { type: "brief", text: `${TR_BRIEF} Ayrıca brüt marj.` }], s);
    assert.equal(nextMove(s), "draft");
  });

  it("falls back to the words alone for a draft that cannot run as it is", () => {
    const s = wizardReducer(initialWizard(), { type: "prefill", draft: { ...draft, triggers: [] } });
    assert.equal(s.step, DESCRIBE);
    assert.equal(s.draft, null);
    assert.equal(s.brief, TR_BRIEF);
    assert.equal(nextMove(s), "draft");
  });
});

describe("the create flow's starters, as drafts", () => {
  const starters = buildStarterTemplates({
    held: ["NVDA", "AAPL", "MSFT", "SMCI"],
    watchlist: [],
    reporting: [{ ticker: "NVDA", date: "2026-11-19", held: true }],
    tracked: [],
  });
  const byId = (id: StarterId) => starters.find((t) => t.id === id)!;

  // What the engine reads from each starter's English words (main/agents/llm.ts
  // heuristic, main/agents/ends.ts proposed ends; main/agents/create-v2.test.ts
  // and linked.test.ts hold the same shapes).
  it("results: one release, the three named numbers, ending with it", () => {
    const d = starterDraft(byId("earnings"), "en-US", TODAY);
    assert.deepEqual(d.triggers, [{ kind: "earnings", ticker: "NVDA", moment: "release" }]);
    assert.deepEqual(d.metrics.map((m) => m.label), ["Revenue", "Gross margin", "Next-quarter guidance"]);
    assert.equal(d.oneShot, true);
    assert.deepEqual(d.ends, { kind: "earnings", ticker: "NVDA" });
    assert.equal(d.nextExpectedAt, "2026-11-19T12:00:00.000Z");
    assert.equal(d.name, "Earnings of NVDA");
    assert.equal(d.brief, starterBrief(byId("earnings"), "en-US").text);
  });

  it("filings: every 8-K, 10-Q and 10-K, standing 90 days", () => {
    const d = starterDraft(byId("filings"), "en-US", TODAY);
    assert.deepEqual(d.triggers, [{ kind: "filing", ticker: d.ticker, forms: ["8-K", "10-Q", "10-K"] }]);
    assert.equal(d.oneShot, false);
    assert.equal(STANDING_DAYS, 90);
    assert.deepEqual(d.ends, { kind: "date", date: "2027-01-14" });
  });

  it("insider purchases: Form 4, open-market purchases only, standing 90 days", () => {
    const d = starterDraft(byId("insider"), "en-US", TODAY);
    assert.deepEqual(d.triggers, [{ kind: "filing", ticker: d.ticker, forms: ["4"], insiderBuysOnly: true }]);
    assert.deepEqual(d.ends, { kind: "date", date: "2027-01-14" });
  });

  it("suppliers and customers: 8-Ks and results of the critical ones, standing two reporting seasons", () => {
    const d = starterDraft(byId("linked"), "en-US", TODAY);
    assert.deepEqual(d.triggers, [
      { kind: "linked", ticker: "NVDA", relations: ["supplier", "customer"], minTier: "critical", events: ["earnings", "filing"], forms: ["8-K"] },
    ]);
    assert.equal(d.name, "Suppliers and customers of NVDA");
    assert.deepEqual(d.ends, { kind: "date", date: "2027-04-18" });
  });

  it("filing changes: the three kinds its words name, standing two reporting seasons", () => {
    const d = starterDraft(byId("changes"), "en-US", TODAY);
    assert.deepEqual(d.triggers, [{ kind: "filing_changes", ticker: "SMCI", kinds: ["risk_factors", "red_flags", "customers"] }]);
    assert.deepEqual(d.ends, { kind: "date", date: "2027-04-18" });
    assert.equal(d.name, "Filing changes at SMCI");
  });

  it("an example chip's draft is named as the reader's own would be", () => {
    const [example] = buildStarterTemplates({ held: [], watchlist: [], reporting: [], tracked: [] });
    assert.equal(starterDraft(example!, "en-US", TODAY).name, "Earnings of NVDA");
  });

  it("is complete in every language: the brief in the reader's words, nothing left to ask, nothing to fix", () => {
    for (const { code } of LANGUAGES) {
      for (const t of starters) {
        const d = starterDraft(t, code, TODAY);
        assert.equal(d.brief, starterBrief(t, code).text, `${code} ${t.id}`);
        assert.equal(d.clarify, undefined);
        assert.deepEqual(draftIssues(d, code), [], `${code} ${t.id}`);
        assert.ok(d.endsProposed);
        for (const m of d.metrics) assert.ok(m.label.trim() && !m.label.startsWith("agents."), `${code}: ${m.label}`);
        assert.ok(!d.name.startsWith("agents."), `${code}: ${d.name}`);
      }
    }
    assert.deepEqual(
      starterDraft(byId("earnings"), "tr-TR", TODAY).metrics.map((m) => m.label),
      ["Gelir", "Brüt marj", "Gelecek çeyrek öngörüsü"],
    );
  });
});

describe("a starter picked in the create flow", () => {
  const [earnings, filings] = buildStarterTemplates({ held: ["NVDA", "AAPL"], watchlist: [], reporting: [], tracked: [] });
  const pick = (t: StarterTemplate, lang: LanguageCode = "tr-TR"): Extract<WizardAction, { type: "template" }> => ({
    type: "template",
    id: `${t.id}:${t.ticker}`,
    text: starterBrief(t, lang).text,
    draft: starterDraft(t, lang, TODAY),
  });

  it("unedited, Next goes to the confirm step with the starter's draft and reads nothing", () => {
    let s = run([{ type: "name", text: "Benim NVDA" }, pick(earnings!)]);
    assert.equal(s.step, DESCRIBE, "the words show first, the ticker ready to replace");
    assert.equal(nextMove(s), "advance");
    s = wizardReducer(s, { type: "forward" });
    assert.equal(s.step, CONFIRM);
    assert.equal(s.draftingFor, null);
    assert.deepEqual(s.draft?.triggers, [{ kind: "earnings", ticker: "NVDA", moment: "release" }]);
    assert.equal(s.draft?.name, "Benim NVDA", "the reader's name, not the starter's");
    assert.equal(nextMove(s), "create");
  });

  it("waits for a name as before, and the name typed after reaches the draft", () => {
    let s = run([pick(filings!)]);
    assert.equal(nextMove(s), "blocked");
    s = wizardReducer(s, { type: "name", text: "AAPL bildirimleri" });
    assert.equal(nextMove(s), "advance");
    assert.equal(wizardReducer(s, { type: "forward" }).draft?.name, "AAPL bildirimleri");
  });

  it("reads the words once the reader edits them, as before", () => {
    let s = run([{ type: "name", text: "N" }, pick(earnings!)]);
    s = wizardReducer(s, { type: "brief", text: s.brief.replace("NVDA", "AMD") });
    assert.equal(nextMove(s), "draft");
    assert.equal(wizardReducer(s, { type: "forward" }).step, DESCRIBE, "an edited brief does not skip its reading");
    assert.equal(s.templateId, `earnings:NVDA`);
  });

  it("a second starter replaces the first one's draft; Change and Next keep it", () => {
    let s = run([{ type: "name", text: "N" }, pick(earnings!), pick(filings!), { type: "forward" }]);
    assert.equal(s.draft?.triggers[0]?.kind, "filing");
    s = run([{ type: "back" }, { type: "forward" }], s);
    assert.equal(s.step, CONFIRM);
  });

  it("without a usable draft, the words alone are read", () => {
    const bare = { ...pick(earnings!), draft: undefined };
    const s = run([{ type: "name", text: "N" }, bare]);
    assert.equal(s.draft, null);
    assert.equal(nextMove(s), "draft");
    const empty = run([{ type: "name", text: "N" }, { ...pick(earnings!), draft: { ...starterDraft(earnings!, "tr-TR", TODAY), triggers: [] } }]);
    assert.equal(nextMove(empty), "draft");
  });
});
