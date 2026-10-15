import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GlossModelCaller, GlossModelInput } from "@meridian/research/gloss";
import type { ChangeItem } from "../../shared/stock-tab-data";
import { buildTagsUser, itemsHash, parseTags, tagChanges, tagsKey, THESIS_TAGS_SYSTEM } from "./thesis-tags";

const ITEMS: ChangeItem[] = [
  {
    kind: "estimate_revision",
    id: "rev:0y:2027-01-31:7",
    date: "2026-10-15",
    source: { kind: "yahoo", url: null },
    period: "0y",
    periodEnd: "2027-01-31",
    days: 7,
    up: 2,
    down: 0,
    epsNow: 9.31,
    epsBefore: 9.3,
    currency: "USD",
    fact: "Mean EPS estimate for the current fiscal year (period ending 2027-01-31): 2 analysts revised up and 0 revised down in the last 7 days; the mean was 9.30 7 days ago and is 9.31 now.",
  },
  {
    kind: "insider",
    id: "ins:0001",
    date: "2026-10-10",
    source: { kind: "form4", url: "https://www.sec.gov/x" },
    name: "Jane Doe",
    role: "CFO",
    code: "S",
    shares: 1500,
    value: 271000,
    plan: true,
    fact: "Jane Doe (CFO) reported an open market sale of 1,500 shares worth $271,000 on 2026-10-10, under a Rule 10b5-1 plan set up in advance (Form 4 filed 2026-10-12).",
  },
];

const THESIS = "Data center demand keeps earnings estimates rising through fiscal 2027.";

function caller(reply: unknown, seen: GlossModelInput[] = []): GlossModelCaller {
  return async (input) => {
    seen.push(input);
    return { text: typeof reply === "string" ? reply : JSON.stringify(reply), input_tokens: 10, output_tokens: 10 };
  };
}

describe("thesis tags", () => {
  it("labels each item with the model's tag and a checked reason", async () => {
    const seen: GlossModelInput[] = [];
    const tags = await tagChanges(
      "NVDA",
      THESIS,
      ITEMS,
      "en-US",
      {
        caller: caller(
          {
            tags: [
              { id: "ins:0001", tag: "neutral", en: "A planned sale set up in advance, unrelated to demand.", translation: "" },
              { id: "rev:0y:2027-01-31:7", tag: "supports", en: "Fiscal 2027 estimates rose, as the thesis argues.", translation: "" },
            ],
          },
          seen,
        ),
        model: "test-model",
      },
    );
    assert.deepEqual(tags, [
      { id: "rev:0y:2027-01-31:7", tag: "supports", reason: "Fiscal 2027 estimates rose, as the thesis argues." },
      { id: "ins:0001", tag: "neutral", reason: "A planned sale set up in advance, unrelated to demand." },
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.model, "test-model");
    assert.equal(seen[0]!.system, THESIS_TAGS_SYSTEM);
    assert.match(seen[0]!.user, /id ins:0001: Jane Doe/);
    assert.match(seen[0]!.user, /<<<\nData center demand/);
  });

  it("drops unknown ids, repeated ids and tags outside the three", () => {
    const tags = parseTags(
      JSON.stringify({
        tags: [
          { id: "made-up", tag: "supports", en: "x", translation: "" },
          { id: "ins:0001", tag: "bullish", en: "x", translation: "" },
          { id: "rev:0y:2027-01-31:7", tag: "weakens", en: "Estimates moved.", translation: "" },
          { id: "rev:0y:2027-01-31:7", tag: "supports", en: "Estimates moved.", translation: "" },
        ],
      }),
      { items: ITEMS, thesis: THESIS, language: "en-US" },
    );
    assert.deepEqual(tags, [{ id: "rev:0y:2027-01-31:7", tag: "weakens", reason: "Estimates moved." }]);
  });

  it("keeps the tag but drops a reason that is too long, advises, or brings a new figure", () => {
    const tags = parseTags(
      JSON.stringify({
        tags: [
          { id: "rev:0y:2027-01-31:7", tag: "supports", en: "Estimates rose to 12.5 for the year.", translation: "" },
          { id: "ins:0001", tag: "weakens", en: "Insiders sell, so you should sell too.", translation: "" },
        ],
      }),
      { items: ITEMS, thesis: THESIS, language: "en-US" },
    );
    assert.deepEqual(tags, [
      { id: "rev:0y:2027-01-31:7", tag: "supports", reason: null },
      { id: "ins:0001", tag: "weakens", reason: null },
    ]);
    const long = parseTags(
      JSON.stringify({ tags: [{ id: "ins:0001", tag: "neutral", en: "one two three four five six seven eight nine ten eleven twelve thirteen.", translation: "" }] }),
      { items: ITEMS, thesis: THESIS, language: "en-US" },
    );
    assert.equal(long[0]!.reason, null);
  });

  it("shows the translation when it passed, and the English when it did not", () => {
    const tags = parseTags(
      JSON.stringify({
        tags: [
          { id: "rev:0y:2027-01-31:7", tag: "supports", en: "Fiscal 2027 estimates rose.", translation: "2027 mali yılı tahminleri yükseldi." },
          { id: "ins:0001", tag: "neutral", en: "A planned sale.", translation: "Planlı bir satış, 99 bin dolar." },
        ],
      }),
      { items: ITEMS, thesis: THESIS, language: "tr-TR" },
    );
    assert.equal(tags[0]!.reason, "2027 mali yılı tahminleri yükseldi.");
    assert.equal(tags[1]!.reason, "A planned sale.");
  });

  it("throws on a reply that is not the shape", () => {
    assert.throws(() => parseTags("not json", { items: ITEMS, thesis: THESIS, language: "en-US" }));
    assert.throws(() => parseTags("{}", { items: ITEMS, thesis: THESIS, language: "en-US" }));
  });

  it("asks for an empty translation in English and a named language otherwise", () => {
    assert.match(buildTagsUser("NVDA", THESIS, ITEMS, "en-US"), /empty string/);
    assert.match(buildTagsUser("NVDA", THESIS, ITEMS, "de-DE"), /German/);
  });

  it("keys the cache by ticker, thesis, items and language", () => {
    const h = itemsHash(ITEMS);
    assert.equal(h, itemsHash([...ITEMS]));
    assert.notEqual(h, itemsHash(ITEMS.slice(0, 1)));
    const k = tagsKey("NVDA", THESIS, h, "en-US");
    assert.equal(k, tagsKey("NVDA", ` ${THESIS} `, h, "en-US"));
    assert.notEqual(k, tagsKey("NVDA", "Another thesis.", h, "en-US"));
    assert.notEqual(k, tagsKey("NVDA", THESIS, h, "tr-TR"));
    assert.notEqual(k, tagsKey("AMD", THESIS, h, "en-US"));
  });
});
