import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { textProblems } from "../../../shared/copy-rules";
import * as panels from "../../lib/i18n/messages/areas/panels";

/**
 * The house copy rules over the words the graph, Propagation, Gauge and Risk
 * panels show. The words left the components for lib/i18n/messages/areas/
 * panels.ts, so the rules read the English table, the source every language
 * is translated from. Dashes are checked in every language by i18n.test.ts.
 */
describe("panels copy", () => {
  it("English has no advice vocabulary and no dashes", () => {
    const problems = Object.entries(panels.en).flatMap(([key, text]) =>
      textProblems(text).map((p) => `${key}: ${p}`),
    );
    assert.deepEqual(problems, []);
  });

  it("no language uses an exclamation mark", () => {
    for (const table of [panels.en, panels.tr, panels.de, panels.fr, panels.es, panels.it, panels.ptBR, panels.ja, panels.zhCN, panels.ko]) {
      const loud = Object.entries(table).filter(([, text]) => /[!！]/.test(text ?? ""));
      assert.deepEqual(loud, []);
    }
  });
});
