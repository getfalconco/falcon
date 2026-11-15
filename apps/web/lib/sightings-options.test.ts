// Run: node --import tsx --test apps/web/lib/sightings-options.test.ts (tsx from packages/engine)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RippleCard, RippleOptions } from "@falcon/ripple";
import { canSeeOptions, optionsDisplayMode, optionsForViewer, stripOptions } from "./sightings-options";

const O: RippleOptions = {
  asOf: "2026-11-13T20:45:00.000Z",
  source: "OPRA via Databento",
  spot: 100,
  atmIv: 40,
  impliedMove5: { sessions: 5, expiration: "2026-11-20", rawPct: 4, marketAdjustedPct: 2.5 },
  impliedMove20: null,
};

const card = (id: string): RippleCard =>
  ({
    id,
    options: O,
    hits: [
      { ticker: "A", options: O },
      { ticker: "B" },
    ],
  }) as unknown as RippleCard;

const payload = () => ({ generatedAt: "x", cards: [card("1"), card("2")], portfolio: [card("1")], opportunities: [card("2")] });

const hasOptions = (cards: RippleCard[]) => cards.some((c) => c.options !== undefined || c.hits.some((h) => h.options !== undefined));

test("OPTIONS_DISPLAY defaults to all; admin and off are overrides; anything else is all", () => {
  assert.equal(optionsDisplayMode(undefined), "all");
  assert.equal(optionsDisplayMode(""), "all");
  assert.equal(optionsDisplayMode(" ADMIN "), "admin");
  assert.equal(optionsDisplayMode("off"), "off");
  assert.equal(optionsDisplayMode("all"), "all");
  assert.equal(optionsDisplayMode("public"), "all");
});

test("who sees the blocks", () => {
  assert.equal(canSeeOptions("admin", true), true);
  assert.equal(canSeeOptions("admin", false), false);
  assert.equal(canSeeOptions("all", false), true);
  assert.equal(canSeeOptions("off", true), false);
});

test("default mode: everyone, admin or not, gets the same payload with options", () => {
  const mode = optionsDisplayMode(undefined);
  assert.equal(hasOptions(optionsForViewer(payload(), mode, false).cards), true);
  assert.equal(hasOptions(optionsForViewer(payload(), mode, true).cards), true);
  assert.equal(hasOptions(optionsForViewer(payload(), mode, false).portfolio!), true);
});

test("admin override: payload stripped for a non-admin in every list, kept for the admin", () => {
  const anon = optionsForViewer(payload(), "admin", false);
  assert.equal(hasOptions(anon.cards), false);
  assert.equal(hasOptions(anon.portfolio!), false);
  assert.equal(hasOptions(anon.opportunities!), false);
  assert.equal(JSON.stringify(anon).includes("OPRA"), false);
  assert.equal(anon.cards[0]!.hits[0]!.ticker, "A");

  const admin = optionsForViewer(payload(), "admin", true);
  assert.equal(hasOptions(admin.cards), true);
  assert.equal(hasOptions(optionsForViewer(payload(), "off", true).cards), false);
  assert.equal(hasOptions(optionsForViewer(payload(), "all", false).cards), true);
});

test("a feed without portfolio lists stays without them", () => {
  const out = stripOptions({ generatedAt: "x", cards: [card("1")] });
  assert.equal("portfolio" in out, false);
  assert.equal(hasOptions(out.cards), false);
});
