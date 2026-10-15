import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptsEffort, acceptsSamplingParams, CLAUDE_FAST_MODEL, CLAUDE_WRITING_MODEL } from "./anthropicModels.js";

describe("acceptsSamplingParams", () => {
  it("drops temperature for 4.7+ and Fable models, which reject it", () => {
    for (const m of [CLAUDE_FAST_MODEL, CLAUDE_WRITING_MODEL, "claude-opus-5", "claude-sonnet-5", "claude-opus-4-7", "claude-fable-5"]) {
      assert.equal(acceptsSamplingParams(m), false, m);
    }
  });

  it("keeps it for older Claude ids and other providers' models", () => {
    for (const m of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-3-5-sonnet-20241022", "z-ai/glm-5.2:free"]) {
      assert.equal(acceptsSamplingParams(m), true, m);
    }
  });
});

describe("acceptsEffort", () => {
  it("sends effort to models that take it", () => {
    for (const m of [CLAUDE_FAST_MODEL, CLAUDE_WRITING_MODEL, "claude-sonnet-4-6", "claude-opus-4-5-20251101", "claude-fable-5-1"]) {
      assert.equal(acceptsEffort(m), true, m);
    }
  });

  it("leaves it out where it is a 400 or unknown", () => {
    for (const m of ["claude-haiku-4-5", "claude-sonnet-4-5-20250929", "claude-3-5-sonnet-20241022", "nvidia/nemotron-3-super-120b-a12b:free"]) {
      assert.equal(acceptsEffort(m), false, m);
    }
  });
});
