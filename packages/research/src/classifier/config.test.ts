import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mergeClassifierConfig } from "./config.js";

describe("FALCON_CLASSIFIER_MODEL override", () => {
  const prev = process.env.FALCON_CLASSIFIER_MODEL;
  afterEach(() => {
    if (prev === undefined) delete process.env.FALCON_CLASSIFIER_MODEL;
    else process.env.FALCON_CLASSIFIER_MODEL = prev;
  });

  it("beats the stored config, not just the default", () => {
    // The whole point: a volume that has already been written carries its own
    // model, and an override that loses to it changes nothing while looking
    // like it should.
    process.env.FALCON_CLASSIFIER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
    const merged = mergeClassifierConfig({ model: "claude-haiku-4-5" });
    assert.equal(merged.model, "nvidia/nemotron-3-super-120b-a12b:free");
  });

  it("leaves the stored model alone when unset", () => {
    delete process.env.FALCON_CLASSIFIER_MODEL;
    assert.equal(mergeClassifierConfig({ model: "claude-haiku-4-5" }).model, "claude-haiku-4-5");
  });
});
