// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/code-cards.test.ts
// Code cards: reading a script out of a streaming tool input, and the file name a card shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeDraft, lineCount, partialJsonString, scriptFileName } from "./code-cards";

test("a string field is decoded as far as it has streamed", () => {
  assert.equal(partialJsonString('{"command": "create", "path": "/tmp/x.py", "file_text": "import pa', "file_text"), "import pa");
  assert.equal(partialJsonString('{"file_text": "a\\nb\\"c\\', "file_text"), 'a\nb"c');
  assert.equal(partialJsonString('{"file_text": "\\u00e7\\u00', "file_text"), "ç");
  assert.equal(partialJsonString('{"file_text": "done", "x": 1}', "file_text"), "done");
  assert.equal(partialJsonString('{"command": "cre', "file_text"), null);
});

test("an editor create streams its file; other editor commands show nothing", () => {
  assert.deepEqual(codeDraft("editor", '{"command":"create","path":"/tmp/iv_chart.py","file_text":"import numpy as np\\nx = 1'), {
    path: "/tmp/iv_chart.py",
    code: "import numpy as np\nx = 1",
    lang: "python",
  });
  assert.equal(codeDraft("editor", '{"command":"view","path":"/tmp/x.py"}'), null);
});

test("a bash heredoc streams as the python inside it", () => {
  const d = codeDraft("bash", JSON.stringify({ command: "cat > /tmp/pnl_by_regime.py <<'EOF'\nimport pandas as pd\nprint(1)\nEOF\npython3 /tmp/pnl_by_regime.py" }));
  assert.deepEqual(d, { path: "/tmp/pnl_by_regime.py", code: "import pandas as pd\nprint(1)", lang: "python" });
  assert.deepEqual(codeDraft("bash", '{"command":"python3 - <<\'PY\'\\nimport os\\npr'), { path: undefined, code: "import os\npr", lang: "python" });
  assert.deepEqual(codeDraft("bash", '{"command":"ls -la /tmp'), { code: "ls -la /tmp", lang: "bash" });
});

test("a meaningful path is kept", () => {
  assert.equal(scriptFileName("/tmp/work/earnings_drift.py", "print(1)"), "earnings_drift.py");
});

test("a generic or missing name comes from what the script does", () => {
  assert.equal(scriptFileName("/tmp/script.py", "import matplotlib.pyplot as plt\nplt.savefig('/tmp/aapl_msft_returns.png')"), "aapl_msft_returns.py");
  assert.equal(scriptFileName("(inline script)", '"""Compare AAPL and MSFT one-year returns."""\nimport pandas'), "compare_aapl_msft_one.py");
  assert.equal(scriptFileName(undefined, "# Earnings gap backtest since 2016\nimport pandas as pd"), "earnings_gap_backtest_since.py");
  assert.equal(scriptFileName("/tmp/main.py", "import pandas as pd\ndef run(costs_bps=5.0):\n  pass\n# writes falcon_result.json after earnings"), "earnings_backtest.py");
  assert.equal(scriptFileName(undefined, "import pandas as pd\nimport matplotlib.pyplot as plt\nplt.plot([1])"), "chart.py");
  assert.equal(scriptFileName(undefined, "# imports\nimport pandas as pd\nx = df.pct_change()"), "returns_analysis.py");
});

test("lines are counted without a trailing newline", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a"), 1);
});
