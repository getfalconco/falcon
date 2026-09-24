import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADVICE_WORDS,
  EM_DASH,
  EN_DASH,
  NON_COPY_LITERALS,
  RISK_SENTENCE_WORDS,
  bannedWordHits,
  copyProblems,
  jsxText,
  literals,
  looksLikeClassList,
  looksLikeCopy,
  textProblems,
  withoutComments,
} from "./copy-rules.js";

const BACKTICK = "`";

describe("bannedWordHits", () => {
  it("finds whole words, whatever their case", () => {
    assert.deepEqual(bannedWordHits("Time to BUY the dip", ADVICE_WORDS), ["buy"]);
    assert.deepEqual(bannedWordHits("a clear signal", ADVICE_WORDS), ["signal"]);
    assert.deepEqual(bannedWordHits("Take  profit here", ADVICE_WORDS), ["take profit"]);
  });

  it("catches the plain inflections", () => {
    const cases: Array<[string, string]> = [
      ["buys", "buy"],
      ["buying", "buy"],
      ["exited", "exit"],
      ["stopped", "stop"],
      ["trimming", "trim"],
      ["adding", "add"],
      ["targets", "target"],
      ["shorted", "short"],
      ["signalling", "signal"],
      ["predictions", "prediction"],
      ["recommends", "recommend"],
    ];
    for (const [form, word] of cases) {
      assert.deepEqual(bannedWordHits(`it is ${form} now`, ADVICE_WORDS), [word], form);
    }
    assert.deepEqual(bannedWordHits("reducing the position", RISK_SENTENCE_WORDS), ["reduce"]);
    assert.deepEqual(bannedWordHits("expected by noon", RISK_SENTENCE_WORDS), ["expect"]);
    assert.deepEqual(bannedWordHits("forecasts a move", RISK_SENTENCE_WORDS), ["forecast"]);
  });

  it("catches the irregular forms a writer reaches for next", () => {
    assert.deepEqual(bannedWordHits("Insiders sold shares", ADVICE_WORDS), ["sell"]);
    assert.deepEqual(bannedWordHits("Funds bought the dip", ADVICE_WORDS), ["buy"]);
    assert.deepEqual(bannedWordHits("Taking profit into strength", ADVICE_WORDS), ["take profit"]);
    assert.deepEqual(bannedWordHits("Our recommendation is unchanged", ADVICE_WORDS), ["recommend"]);
    assert.deepEqual(bannedWordHits("A cut is unlikely", RISK_SENTENCE_WORDS), ["likely"]);
    assert.deepEqual(bannedWordHits("Rates won't move", RISK_SENTENCE_WORDS), ["will"]);
  });

  it("leaves longer words that merely contain a banned one alone", () => {
    const innocent = [
      "address",
      "additional",
      "longer",
      "shortfall",
      "enterprise",
      "existing",
      "buyer",
      "stopover",
      "maybe",
      "mayor",
      "willing",
      "considerable",
    ];
    for (const word of innocent) {
      assert.deepEqual(bannedWordHits(`the ${word} one`, [...ADVICE_WORDS, ...RISK_SENTENCE_WORDS]), [], word);
    }
  });

  it("treats an underscore as part of an identifier and a hyphen as a boundary", () => {
    assert.deepEqual(bannedWordHits("target_open_at", ADVICE_WORDS), []);
    assert.deepEqual(bannedWordHits("stop-0", ADVICE_WORDS), ["stop"]);
  });

  it("reports each word once and ignores blank entries", () => {
    assert.deepEqual(bannedWordHits("buy, buy, buying", ["buy", " ", ""]), ["buy"]);
  });
});

describe("withoutComments", () => {
  it("drops block and line comments and keeps URLs", () => {
    const src = ["/* you should buy */", 'const a = "https://example.com/x"; // sell now', "// stop", "const b = 1;"].join("\n");
    const out = withoutComments(src);
    assert.ok(!out.includes("buy"));
    assert.ok(!out.includes("sell"));
    assert.ok(!out.includes("stop"));
    assert.ok(out.includes("https://example.com/x"));
    assert.ok(out.includes("const b = 1;"));
  });
});

describe("literals", () => {
  it("returns double-quoted, single-quoted and template bodies in source order", () => {
    const src = `const a = "one"; const b = 'two'; const c = ${BACKTICK}three \${n} four${BACKTICK};`;
    assert.deepEqual(literals(src), ["one", "two", "three ${n} four"]);
  });

  it("returns the literals inside a template interpolation after the template", () => {
    const src = `const c = ${BACKTICK}px-2 \${on ? "bg-a" : "bg-b"} end${BACKTICK};`;
    assert.deepEqual(literals(src), ['px-2 ${on ? "bg-a" : "bg-b"} end', "bg-a", "bg-b"]);
  });

  it("keeps escaped quotes inside the literal they belong to", () => {
    assert.deepEqual(literals('const a = "say \\"hi\\" now";'), ['say \\"hi\\" now']);
  });

  it("does not pair apostrophes across two double-quoted sentences", () => {
    const src = 'const a = "the book\'s day" + target + "today\'s list";';
    assert.deepEqual(literals(src), ["the book's day", "today's list"]);
  });

  it("steps over a lone apostrophe in JSX text", () => {
    const src = ["<p>Don't look</p>", 'const a = "kept";'].join("\n");
    assert.deepEqual(literals(src), ["kept"]);
  });
});

describe("looksLikeCopy", () => {
  it("accepts sentences, punctuated fragments and one-word labels", () => {
    for (const text of ["Overnight markets", "Flat.", "Risk:", "Overnight", "SELL"]) {
      assert.equal(looksLikeCopy(text), true, text);
    }
  });

  it("rejects single lower-case tokens, keys and empties", () => {
    for (const text of ["long", "pre_open", "briefing:get", "held_movers", "", "  ", "2-digit", "camelCase"]) {
      assert.equal(looksLikeCopy(text), false, text);
    }
  });
});

describe("looksLikeClassList", () => {
  it("recognises utility class strings, arbitrary values included", () => {
    assert.equal(looksLikeClassList("flex items-center gap-2 stop-0"), true);
    assert.equal(looksLikeClassList("bg-[#E5E7EB] hover:bg-white/10 w-1.5"), true);
    assert.equal(looksLikeClassList("briefing:get"), true);
  });

  it("does not mistake prose for classes", () => {
    assert.equal(looksLikeClassList("Overnight markets"), false);
    assert.equal(looksLikeClassList("no long-term data."), false);
    assert.equal(looksLikeClassList("flat for now"), false);
    assert.equal(looksLikeClassList(""), false);
  });
});

describe("copyProblems", () => {
  it("reports an em dash and an en dash in any literal", () => {
    const src = `const a = "Flat ${EM_DASH} for now"; const b = "09:30${EN_DASH}16:00";`;
    const problems = copyProblems(src);
    assert.equal(problems.length, 2);
    assert.ok(problems[0].startsWith("em dash: "));
    assert.ok(problems[1].startsWith("en dash: "));
  });

  it("reports a dash typed as a unicode escape", () => {
    const escaped = "\\" + "u2014";
    assert.equal(copyProblems(`const a = "Flat ${escaped} for now";`).length, 1);
    assert.equal(copyProblems(`const alone = "${escaped}";`).length, 1);
  });

  it("reports a dash standing alone, which is still a dash on screen", () => {
    assert.equal(copyProblems(`const none = "${EM_DASH}"; const alsoNone = " ${EN_DASH} ";`).length, 2);
  });

  it("reports advice words in prose and in one-word labels", () => {
    assert.deepEqual(copyProblems('const a = "Time to buy more.";'), ['banned word "buy": Time to buy more.']);
    assert.deepEqual(copyProblems('const label = "Sell";'), ['banned word "sell": Sell']);
  });

  it("applies the risk-sentence words only when asked", () => {
    const src = 'const a = "Volatility will ease.";';
    assert.deepEqual(copyProblems(src), []);
    assert.deepEqual(copyProblems(src, { riskWords: true }), ['banned word "will": Volatility will ease.']);
  });

  it("flags the month name that collides with a modal, so views never spell it out", () => {
    assert.deepEqual(copyProblems('const d = "May 12";', { riskWords: true }), ['banned word "may": May 12']);
    assert.deepEqual(copyProblems('const m = ["Apr", "May", "Jun"];', { riskWords: true }), ['banned word "may": May']);
    assert.deepEqual(copyProblems('const d = "2026-05-12";', { riskWords: true }), []);
  });

  it("stays quiet on code values that spell a banned word", () => {
    const src = [
      'const f = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", hour: "2-digit" });',
      'if (e.key === "Enter" || e.key === "Escape") submit();',
      'const side = w.side === "short" ? -1 : 1;',
      'dispatch({ type: "add" });',
      'const el = document.createElementNS(ns, "stop");',
    ].join("\n");
    assert.deepEqual(copyProblems(src, { riskWords: true }), []);
    for (const literal of ["Enter", "long", "short", "add", "stop"]) assert.ok(NON_COPY_LITERALS.has(literal), literal);
  });

  it("stays quiet on Tailwind class strings", () => {
    const src = [
      'const cls = "absolute stop-0 from-10% long-press:opacity-50 short:hidden";',
      `const dyn = ${BACKTICK}px-2 stop-0 \${active ? "bg-white/10" : "exit-none"}${BACKTICK};`,
    ].join("\n");
    assert.deepEqual(copyProblems(src), []);
  });

  it("does not read the code inside an interpolation as prose", () => {
    const src = `const a = ${BACKTICK}Value is \${event.target.value} today${BACKTICK};`;
    assert.deepEqual(copyProblems(src), []);
  });

  it("ignores comments", () => {
    const src = ["// you should buy this", "/* sell " + EM_DASH + " stop */", 'const a = "Flat for now.";'].join("\n");
    assert.deepEqual(copyProblems(src, { riskWords: true }), []);
  });

  it("checks JSX text only when asked", () => {
    const src = ["<div>", `  <p>Time to sell ${EM_DASH} now</p>`, '  <span className="x">Overnight</span>', "</div>"].join("\n");
    assert.deepEqual(copyProblems(src), []);
    const problems = copyProblems(src, { jsxText: true });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.startsWith("em dash: ")));
    assert.ok(problems.some((p) => p.startsWith('banned word "sell": ')));
  });
});

describe("jsxText", () => {
  it("keeps text between tags and drops runs that look like code", () => {
    const src = [
      "const ok = a > target && stop < b;",
      "const m = new Map<string, number>(); const n = list.length > 0 ? exit(list) : <Empty />;",
      "return <p>Nothing moved {count} times.</p>;",
    ].join("\n");
    assert.deepEqual(jsxText(src), ["Nothing moved times."]);
  });
});

describe("textProblems", () => {
  it("applies the same rules to a built string", () => {
    assert.deepEqual(textProblems("NVDA is up 2.10% since the last close."), []);
    assert.deepEqual(textProblems("long"), []);
    assert.deepEqual(textProblems("demo-dividend-2026-09-25"), []);
    assert.deepEqual(textProblems("Rates may ease.", { riskWords: true }), ['banned word "may": Rates may ease.']);
    assert.equal(textProblems(`Up ${EM_DASH} a lot`).length, 1);
  });
});
