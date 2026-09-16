import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SCREEN_CONFIG } from "./config.js";
import { bannedWordHits } from "./templates.js";

describe("screen/banned-words (§6)", () => {
  it("the matcher catches whole words and inflections, not substrings", () => {
    const words = DEFAULT_SCREEN_CONFIG.bannedWords;
    assert.deepEqual(bannedWordHits("insiders buying into a decline", words), ["buy"]);
    assert.deepEqual(bannedWordHits("a clear sell signal", words), ["sell", "signal"]);
    assert.deepEqual(bannedWordHits("Take Profit here", words), ["take profit"]);
    assert.deepEqual(bannedWordHits("stopped out at the target", words), ["target", "stop"]);
    assert.deepEqual(bannedWordHits("a longer address; shortly; additional", words), []);
  });

  it("no default label or template contains a banned word", () => {
    const words = DEFAULT_SCREEN_CONFIG.bannedWords;
    const offenders: string[] = [];
    for (const [key, label] of Object.entries(DEFAULT_SCREEN_CONFIG.labels)) {
      const hits = bannedWordHits(label, words);
      if (hits.length) offenders.push(`label ${key}: ${hits.join(", ")}`);
    }
    for (const [key, template] of Object.entries(DEFAULT_SCREEN_CONFIG.templates)) {
      const hits = bannedWordHits(template, words);
      if (hits.length) offenders.push(`template ${key}: ${hits.join(", ")}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("compression copy stays direction-symmetric", () => {
    const t = DEFAULT_SCREEN_CONFIG.templates.compression;
    assert.doesNotMatch(t, /\b(up|down|upward|downward|higher|lower|bull|bear|rally|decline|advance|breakout|breakdown)\b/i);
    assert.match(t, /no direction claimed/);
  });

  it("the banned list matches Gauge's (§6: same list)", () => {
    assert.deepEqual(DEFAULT_SCREEN_CONFIG.bannedWords, ["buy", "sell", "enter", "exit", "long", "short", "add", "trim", "target", "stop", "take profit", "signal", "prediction", "recommend"]);
  });



});
