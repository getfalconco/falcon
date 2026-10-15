import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentDraft } from "../../../shared/agent-types";
import { cleanDraft, draftIssues, draftProblems } from "./agent-draft";
import {
  CONFIRM,
  DESCRIBE,
  WIZARD_STEPS,
  blockReason,
  composeBrief,
  initialWizard,
  nextMove,
  pendingQuestion,
  textToRead,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from "./agent-wizard";

const BRIEF = "Tell me when NVDA reports. Data center revenue and gross margin.";

const DRAFT: AgentDraft = {
  name: "NVDA earnings",
  brief: BRIEF,
  ticker: "NVDA",
  triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
  metrics: [{ id: "m1", label: "Gross margin", expectation: "over 75%" }],
  channels: ["digest"],
  oneShot: true,
  ends: { kind: "earnings", ticker: "NVDA" },
  endsProposed: true,
};

const VAGUE: AgentDraft = {
  name: "Market news",
  brief: "watch tech",
  triggers: [],
  metrics: [],
  channels: ["digest"],
  oneShot: false,
  ends: { kind: "date", date: "2027-01-13" },
  clarify: { field: "subject", question: "What to watch, and when?" },
};

const run = (actions: WizardAction[], from: WizardState = initialWizard()) => actions.reduce(wizardReducer, from);

/** A wizard that has read the brief and sits on the confirm step. */
const drafted = () =>
  run([
    { type: "name", text: "My NVDA watch" },
    { type: "brief", text: BRIEF },
    { type: "draft-start", text: BRIEF },
    { type: "draft-done", text: BRIEF, draft: DRAFT },
  ]);

describe("Create Agent in two steps", () => {
  it("runs describe, then confirm", () => {
    assert.deepEqual([...WIZARD_STEPS], ["describe", "confirm"]);
    assert.equal(initialWizard().step, DESCRIBE);
  });

  it("holds Next until there is a name and an instruction, and says which is missing", () => {
    let s = initialWizard();
    assert.equal(nextMove(s), "blocked");
    assert.equal(blockReason(s), "both");
    s = wizardReducer(s, { type: "brief", text: BRIEF });
    assert.equal(blockReason(s), "name");
    s = run([{ type: "name", text: "Chip suppliers" }, { type: "brief", text: "NVDA" }], s);
    assert.equal(blockReason(s), "describe");
    s = wizardReducer(s, { type: "brief", text: BRIEF });
    assert.equal(nextMove(s), "draft");
    assert.equal(blockReason(s), null);
  });

  it("keeps the reader's name: the model's suggestion never replaces it, and an edit to it reaches the draft", () => {
    let s = drafted();
    assert.equal(s.draft?.name, "My NVDA watch", `not ${DRAFT.name}`);
    s = wizardReducer(s, { type: "edit", draft: { ...s.draft!, name: "Something else", oneShot: false } });
    assert.equal(s.draft?.name, "My NVDA watch");
    assert.equal(s.draft?.oneShot, false);
    s = run([{ type: "back" }, { type: "name", text: "Renamed" }], s);
    assert.equal(s.draft?.name, "Renamed");
    assert.equal(nextMove(s), "advance", "a new name needs no second reading");
  });

  it("stays on the first step while the brief is read, then shows the reading", () => {
    let s = run([{ type: "name", text: "Watch" }, { type: "brief", text: BRIEF }, { type: "draft-start", text: BRIEF }]);
    assert.equal(s.step, DESCRIBE);
    assert.equal(nextMove(s), "busy");
    s = wizardReducer(s, { type: "draft-done", text: BRIEF, draft: DRAFT });
    assert.equal(s.step, CONFIRM);
    assert.equal(nextMove(s), "create");
  });

  it("asks one question when the words give nothing to act on, and reads the answer with them", () => {
    let s = run([{ type: "name", text: "Helper" }, { type: "brief", text: "watch tech please" }, { type: "draft-start", text: "watch tech please" }]);
    s = wizardReducer(s, { type: "draft-done", text: "watch tech please", draft: VAGUE });
    assert.equal(s.step, DESCRIBE, "the question is asked on the first step");
    assert.deepEqual(pendingQuestion(s), VAGUE.clarify);
    assert.equal(nextMove(s), "answer");
    assert.equal(blockReason(s), "answer");

    s = wizardReducer(s, { type: "answer", text: "chip supplier news every morning" });
    assert.equal(nextMove(s), "draft");
    assert.equal(textToRead(s), "watch tech please (chip supplier news every morning)");

    s = run(
      [
        { type: "draft-start", text: textToRead(s) },
        { type: "draft-done", text: "watch tech please (chip supplier news every morning)", draft: DRAFT },
      ],
      s,
    );
    assert.equal(s.step, CONFIRM);
    assert.equal(pendingQuestion(s), null);
    assert.equal(s.draft?.name, "Helper");
    assert.equal(s.brief, "watch tech please (chip supplier news every morning)", "the answer becomes part of the brief");
    // Back and Next again: the same draft, no second reading.
    s = wizardReducer(s, { type: "back" });
    assert.equal(nextMove(s), "advance");
    s = wizardReducer(s, { type: "forward" });
    assert.equal(s.step, CONFIRM);
  });

  it("drops the question once the brief itself changes", () => {
    let s = run([{ type: "name", text: "Helper" }, { type: "brief", text: "watch tech please" }, { type: "draft-start", text: "watch tech please" }]);
    s = wizardReducer(s, { type: "draft-done", text: "watch tech please", draft: VAGUE });
    s = wizardReducer(s, { type: "brief", text: "Tell me when AMD reports its results" });
    assert.equal(pendingQuestion(s), null);
    assert.equal(nextMove(s), "draft");
    assert.equal(textToRead(s), "Tell me when AMD reports its results");
  });

  it("composes a brief and an answer, and leaves a brief alone without one", () => {
    assert.equal(composeBrief("  watch tech ", " NVDA "), "watch tech (NVDA)");
    assert.equal(composeBrief("watch tech", ""), "watch tech");
  });

  it("keeps the reader's edits when going back with the same brief, and reads a changed one again", () => {
    let s = wizardReducer(drafted(), { type: "edit", draft: { ...DRAFT, oneShot: false } });
    s = wizardReducer(s, { type: "back" });
    assert.equal(s.step, DESCRIBE);
    assert.equal(nextMove(s), "advance");
    s = wizardReducer(s, { type: "forward" });
    assert.equal(s.draft?.oneShot, false);
    s = run([{ type: "back" }, { type: "brief", text: `${BRIEF} And the guide.` }], s);
    assert.equal(nextMove(s), "draft");
    assert.equal(wizardReducer(s, { type: "forward" }).step, DESCRIBE, "a changed brief does not skip its reading");
  });

  it("drops an answer for a brief that has since changed", () => {
    let s = run([{ type: "name", text: "W" }, { type: "brief", text: BRIEF }, { type: "draft-start", text: BRIEF }, { type: "brief", text: `${BRIEF} Also.` }]);
    s = wizardReducer(s, { type: "draft-done", text: BRIEF, draft: DRAFT });
    assert.equal(s.draft, null);
    assert.equal(s.step, DESCRIBE);
  });

  it("shows a failed reading on the first step, and Next tries again", () => {
    let s = run([{ type: "name", text: "W" }, { type: "brief", text: BRIEF }, { type: "draft-start", text: BRIEF }]);
    s = wizardReducer(s, { type: "draft-failed", text: BRIEF, error: "The model did not answer in time." });
    assert.equal(s.step, DESCRIBE);
    assert.equal(s.draftError, "The model did not answer in time.");
    assert.equal(nextMove(s), "draft");
  });

  it("asks for fixes before Start when the draft cannot be saved", () => {
    let s = wizardReducer(drafted(), { type: "edit", draft: { ...DRAFT, triggers: [] } });
    assert.equal(nextMove(s), "fix");
    s = wizardReducer(s, { type: "tried" });
    assert.equal(s.tried, true);
  });

  it("ends on Create agent, once, and starts clean after", () => {
    let s = wizardReducer(drafted(), { type: "create-start" });
    assert.equal(nextMove(s), "busy");
    assert.equal(wizardReducer(s, { type: "back" }).step, CONFIRM, "Back holds still while creating");
    s = wizardReducer(s, { type: "create-failed", error: "That agent could not be saved." });
    assert.equal(s.createError, "That agent could not be saved.");
    assert.equal(nextMove(s), "create");
    assert.deepEqual(wizardReducer(s, { type: "reset" }), initialWizard());
  });

  it("remembers the starter while the reader keeps its brief", () => {
    let s = run([{ type: "template", id: "earnings:NVDA", text: BRIEF }]);
    assert.equal(s.templateId, "earnings:NVDA");
    s = wizardReducer(s, { type: "brief", text: `${BRIEF} More.` });
    assert.equal(s.templateId, "earnings:NVDA");
    s = wizardReducer(s, { type: "brief", text: "" });
    assert.equal(s.templateId, null);
  });
});

describe("draft rules shared by every create flow", () => {
  it("reports the same problems as one list and by part; no channel is in-app only, not a problem", () => {
    const bad: AgentDraft = { ...DRAFT, name: "", triggers: [], channels: [] };
    assert.deepEqual(
      draftIssues(bad).map((i) => i.part),
      ["name", "triggers"],
    );
    assert.equal(draftProblems(bad).length, 2);
    assert.deepEqual(draftProblems(DRAFT), []);
    assert.deepEqual(draftProblems({ ...DRAFT, channels: [] }), []);
  });

  it("cleans a draft for create: trimmed name, no blank metrics, no blank bars", () => {
    const clean = cleanDraft({
      ...DRAFT,
      name: "  NVDA earnings ",
      metrics: [
        { id: "a", label: " Gross margin ", expectation: "  " },
        { id: "b", label: "   " },
      ],
    });
    assert.equal(clean.name, "NVDA earnings");
    assert.deepEqual(clean.metrics, [{ id: "a", label: "Gross margin", expectation: undefined }]);
  });
});
