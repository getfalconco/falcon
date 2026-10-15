import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HEARD_ABOUT_DELAY_DAYS, isHeardAboutSource, shouldAskHeardAbout } from "./onboarding-followup";
import { countryFromLocales } from "./onboarding-country";

const DAY = 86_400_000;
const SETUP = "2026-10-01T12:00:00.000Z";
const at = (days: number) => Date.parse(SETUP) + days * DAY;

describe("the one-week question about how the reader heard of Falcon", () => {
  it("waits a full week after setup", () => {
    assert.equal(HEARD_ABOUT_DELAY_DAYS, 7);
    assert.equal(shouldAskHeardAbout({ completedAt: SETUP, done: false, now: at(0) }), false);
    assert.equal(shouldAskHeardAbout({ completedAt: SETUP, done: false, now: at(7) - 1 }), false);
    assert.equal(shouldAskHeardAbout({ completedAt: SETUP, done: false, now: at(7) }), true);
    assert.equal(shouldAskHeardAbout({ completedAt: SETUP, done: false, now: at(40) }), true);
  });

  it("is asked once: answered or dismissed, it does not come back", () => {
    assert.equal(shouldAskHeardAbout({ completedAt: SETUP, done: true, now: at(30) }), false);
  });

  it("is not asked of accounts that answered it during the old setup", () => {
    assert.equal(shouldAskHeardAbout({ completedAt: null, done: false, now: at(30) }), false);
    assert.equal(shouldAskHeardAbout({ completedAt: undefined, done: false, now: at(30) }), false);
    assert.equal(shouldAskHeardAbout({ completedAt: "not a date", done: false, now: at(30) }), false);
  });

  it("stores one of its own answers", () => {
    assert.ok(isHeardAboutSource("friend"));
    assert.ok(!isHeardAboutSource("Twitter, a friend"));
  });
});

describe("countryFromLocales", () => {
  const known = ["US", "TR", "DE", "BR", "GB"];

  it("takes the first locale that names a known region", () => {
    assert.equal(countryFromLocales(["tr-TR", "en-US"], known), "TR");
    assert.equal(countryFromLocales(["de", "pt_BR"], known), "BR");
  });

  it("does not guess a country from a bare language or an unknown region", () => {
    assert.equal(countryFromLocales(["de", "ja"], known), null);
    assert.equal(countryFromLocales(["fr-FR"], known), null);
    assert.equal(countryFromLocales(["", "not a tag!"], known), null);
  });
});
