import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../shared/copy-rules";
import * as auth from "../../lib/i18n/messages/areas/auth";

/**
 * Setup's words follow the house rules: no dash, no advice vocabulary, no
 * claim about what comes next, no exclamation mark, no emoji. The screens the
 * redesign removed (intro line, country, role, focus, the sector preview, the
 * free-text "how did you hear") are gone from every language and from the
 * flow's source.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLOW = fs.readFileSync(path.join(HERE, "OnboardingFlow.tsx"), "utf8");
const UI = fs.readFileSync(path.join(HERE, "onboarding-ui.tsx"), "utf8");
const TICKERS = fs.readFileSync(path.join(HERE, "TickerField.tsx"), "utf8");
const PROMPT = fs.readFileSync(path.join(HERE, "HeardAboutPrompt.tsx"), "utf8");

const SETUP = /^auth\.(onboarding|heard)\./;
const setupKeys = Object.keys(auth.en).filter((k) => SETUP.test(k)) as (keyof typeof auth.en)[];
const TABLES = { en: auth.en, tr: auth.tr, de: auth.de, fr: auth.fr, es: auth.es, it: auth.it, ptBR: auth.ptBR, ja: auth.ja, zhCN: auth.zhCN, ko: auth.ko };

/**
 * Words the rules ban for what they say about a market, used here for
 * something else. "should" is a question put to the reader ("What should we
 * call you?", and the spec's own "How much should Falcon explain?"); "long"
 * is a length of time ("How long do you usually hold?"), not a side of a
 * trade. Every other rule still applies to these keys.
 */
const ALLOWED: Record<string, string> = {
  "auth.onboarding.name.title": 'banned word "should"',
  "auth.onboarding.depth.title": 'banned word "should"',
  "auth.onboarding.holding.title": 'banned word "long"',
};

const EMOJI = /\p{Extended_Pictographic}/u;

describe("setup copy", () => {
  it("English follows the advice, outlook and dash rules", () => {
    for (const key of setupKeys) {
      const text = auth.en[key].replace(/\{br\}/g, " ");
      const problems = textProblems(text, { riskWords: true }).filter((p) => !ALLOWED[key] || !p.startsWith(ALLOWED[key]));
      assert.deepEqual(problems, [], key);
    }
  });

  it("no language shouts or uses an emoji", () => {
    for (const [lang, table] of Object.entries(TABLES)) {
      for (const key of setupKeys) {
        const text = (table as Record<string, string | undefined>)[key] ?? "";
        assert.ok(!/[!！]/.test(text), `${lang} ${key} has an exclamation mark`);
        assert.ok(!EMOJI.test(text), `${lang} ${key} has an emoji`);
      }
    }
  });

  it("the removed screens are gone from every language", () => {
    const removed = /^auth\.onboarding\.(intro|country|role|focus|heard|preview)\.|^auth\.onboarding\.(finish|tenure\.title|tenure\.subtitle)$/;
    for (const [lang, table] of Object.entries(TABLES)) {
      assert.deepEqual(Object.keys(table).filter((k) => removed.test(k)), [], lang);
    }
    for (const src of [FLOW, UI]) assert.ok(!/auth\.onboarding\.(intro|country|role|focus|heard|preview)\./.test(src));
  });

  it("the components follow the rules too", () => {
    for (const [name, src] of Object.entries({ FLOW, UI, TICKERS, PROMPT })) {
      assert.deepEqual(copyProblems(src, { jsxText: true }), [], name);
    }
  });

  it("points at Add Module by the button's own name, in every language", () => {
    for (const [lang, table] of Object.entries(TABLES)) {
      assert.ok(table["auth.onboarding.desk.later"]?.includes("{addModule}"), lang);
    }
    assert.ok(FLOW.includes('t("auth.onboarding.desk.later", { addModule: t("modules.addButton") })'));
  });
});
