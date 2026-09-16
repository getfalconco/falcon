import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonFromModelText, withJsonInstruction } from "./model-json.js";

/**
 * The shapes actually observed coming back from a gateway that ignores
 * `output_config`, plus the clean case that must pass through untouched.
 */
describe("jsonFromModelText", () => {
  it("returns clean JSON byte-for-byte", () => {
    const clean = '{"summary":"a","points":["b"]}';
    assert.equal(jsonFromModelText(clean), clean);
  });

  it("keeps a top-level array intact", () => {
    const arr = '[{"a":1},{"b":2}]';
    assert.equal(jsonFromModelText(arr), arr);
  });

  it("strips a prose preamble", () => {
    const out = jsonFromModelText(
      'Brief, with the caveat that I have not verified this:\n\n{"summary":"a","points":[]}',
    );
    assert.deepEqual(JSON.parse(out), { summary: "a", points: [] });
  });

  it("strips a markdown fence", () => {
    const out = jsonFromModelText('Here you go:\n```json\n{"summary":"a"}\n```\nHope that helps.');
    assert.deepEqual(JSON.parse(out), { summary: "a" });
  });

  it("strips a leaked reasoning block", () => {
    const out = jsonFromModelText(
      '<antml thinking>\nThe user wants a summary...\n</antml thinking>\n{"summary":"a"}',
    );
    assert.deepEqual(JSON.parse(out), { summary: "a" });
  });

  it("drops trailing prose after the object", () => {
    const out = jsonFromModelText('{"summary":"a"}\n\nLet me know if you want more detail.');
    assert.deepEqual(JSON.parse(out), { summary: "a" });
  });

  it("handles braces inside strings without truncating", () => {
    const out = jsonFromModelText('Note:\n{"summary":"use {a} and {b}","points":["x"]}');
    assert.deepEqual(JSON.parse(out), { summary: "use {a} and {b}", points: ["x"] });
  });

  it("handles an escaped quote inside a string", () => {
    const out = jsonFromModelText('lead-in {"summary":"he said \\"hi\\"","points":[]}');
    assert.deepEqual(JSON.parse(out), { summary: 'he said "hi"', points: [] });
  });

  it("keeps nested objects whole", () => {
    const out = jsonFromModelText('x {"a":{"b":{"c":1}},"d":2} y');
    assert.deepEqual(JSON.parse(out), { a: { b: { c: 1 } }, d: 2 });
  });

  it("returns the text unchanged when there is no JSON, so the caller still fails", () => {
    const prose = "The claim as stated is that US export restrictions create a second-order hit.";
    assert.equal(jsonFromModelText(prose), prose);
    assert.throws(() => JSON.parse(jsonFromModelText(prose)));
  });

  it("does not invent a value from an unclosed object", () => {
    const broken = 'here: {"summary":"a", "points":[';
    assert.throws(() => JSON.parse(jsonFromModelText(broken)));
  });

  it("survives empty and non-string input", () => {
    assert.equal(jsonFromModelText(""), "");
    assert.equal(jsonFromModelText("   "), "");
    assert.equal(jsonFromModelText(undefined as unknown as string), "");
  });
});

describe("withJsonInstruction", () => {
  const schema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };

  it("keeps the caller's own instructions first", () => {
    const out = withJsonInstruction("You explain things.", schema);
    assert.ok(out.startsWith("You explain things."));
  });

  it("carries the schema so a model that never saw it still knows the shape", () => {
    const out = withJsonInstruction("sys", schema);
    assert.ok(out.includes('"required":["summary"]'));
    assert.ok(/JSON object and nothing else/i.test(out));
  });
});
