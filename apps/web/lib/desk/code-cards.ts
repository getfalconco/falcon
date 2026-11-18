/**
 * The code Falcon AI writes, shown in the reply as "Created <name>.py +N" cards
 * (lab/ScriptCard.tsx). Pure helpers shared by the chat route and the client:
 *
 * - `codeDraft` reads the script out of a code-execution call's input while it
 *   is still streaming (partial JSON), so the card can show it as it is written.
 * - `scriptFileName` gives the card a meaningful file name when the call has
 *   none (an inline `python3 - <<EOF` script) or a generic one (script.py).
 */

/** Matches a heredoc'd python script in a bash command (route scriptsInCommand, without needing its end). */
const HEREDOC = /(?:cat\s*>\s*(\S+\.py)|python3?\s+-)\s*<<\s*-?\s*['"]?(\w+)['"]?[^\n]*\n/;

/**
 * The value of a string field in JSON that may stop anywhere (a streaming tool input), decoded as far as it goes.
 * null when the field has not started yet.
 */
export function partialJsonString(json: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = re.exec(json);
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i]!;
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = json[i + 1];
    if (e === undefined) return out;
    if (e === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "b" ? "\b" : e === "f" ? "\f" : e;
    i += 1;
  }
  return out;
}

export type CodeDraft = { path?: string; code: string; lang: "python" | "bash" };

/**
 * What a code-execution call is writing so far: the file of a text editor `create`, the python heredoc of a bash
 * command (`cat > x.py <<'EOF'`, `python3 - <<'EOF'`), else the bash command itself. null when there is nothing to show yet.
 */
export function codeDraft(tool: "editor" | "bash", partial: string): CodeDraft | null {
  if (tool === "editor") {
    const command = partialJsonString(partial, "command");
    if (command !== null && command !== "create") return null;
    const code = partialJsonString(partial, "file_text");
    if (code === null) return null;
    const path = partialJsonString(partial, "path") ?? undefined;
    return { path, code, lang: path && !/\.py$/i.test(path) ? "bash" : "python" };
  }
  const command = partialJsonString(partial, "command");
  if (!command) return null;
  const m = HEREDOC.exec(command);
  if (!m) return { code: command, lang: "bash" };
  let code = command.slice(m.index + m[0].length);
  const end = code.search(new RegExp(`(^|\\n)${m[2]}\\b`));
  if (end >= 0) code = code.slice(0, end);
  return { path: m[1], code, lang: "python" };
}

/** Names that say nothing about the script; the card derives a better one from the code. */
const GENERIC = /^(script|main|run|test|tmp|temp|code|a|x|foo|untitled|analysis|inline_script)(_?\d+)?\.py$/i;

const STOP = new Set(
  "the a an of for and to with in on from this that script python code step steps compute calculate using use by is are be it its we our".split(" "),
);

/** "Compare AAPL vs MSFT 1y returns" -> "compare_aapl_vs_msft_1y_returns", at most `words` words. */
export function snakeWords(text: string, words = 4): string {
  const parts = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w));
  return parts.slice(0, words).join("_");
}

const base = (p: string) => p.split("/").pop() ?? p;

/**
 * The file name a code card shows. The call's own path when it is meaningful; else a name from what the script
 * saves (a chart image, a CSV), its opening docstring or comment, or what it does (a backtest, a chart).
 */
export function scriptFileName(path: string | undefined, code: string, lang: "python" | "bash" = "python"): string {
  const own = path && !path.startsWith("(") ? base(path) : "";
  if (own && !GENERIC.test(own)) return own;
  const ext = lang === "python" ? ".py" : ".sh";
  // A file the script saves (not the standard result file).
  const saved = /(?:savefig|to_csv|write_image|to_parquet)\(\s*(?:f?["'])([^"'{}]+?)\.(?:png|jpe?g|svg|pdf|csv|parquet)["']/.exec(code)?.[1];
  if (saved) {
    const n = snakeWords(base(saved), 5);
    if (n && !/^(output|out|result|results|chart|plot|fig|figure|image|data)$/.test(n)) return `${n}${ext}`;
  }
  // The opening docstring, or a comment in the first lines.
  const doc = /^\s*(?:#![^\n]*\n\s*)?(?:"""|''')\s*([^\n]+)/.exec(code)?.[1];
  // The script's leading comment block (before its first line of code).
  let comment: string | undefined;
  for (const l of code.split("\n").slice(0, 8)) {
    if (!l.trim() || l.startsWith("#!")) continue;
    const c = /^\s*#\s*(.+)$/.exec(l)?.[1];
    if (!c) break;
    if (!/coding[:=]|^-\*-|^type:/.test(c) && /[a-z]{3}/i.test(c)) {
      comment = c;
      break;
    }
  }
  for (const head of [doc, comment]) {
    const n = head ? snakeWords(head) : "";
    if (n && n.length >= 6 && !/^(imports?|load(_prices|_data)?|setup|helpers?)$/.test(n)) return `${n}${ext}`;
  }
  if (lang === "bash") return own || "command.sh";
  const backtest = /falcon_result\.json|def run\(/.test(code);
  if (backtest) return /event|earnings/i.test(code) ? "earnings_backtest.py" : "backtest.py";
  if (/implied_vol|\biv\b|options?_chain/i.test(code)) return /plt\.|matplotlib|plotly/.test(code) ? "iv_chart.py" : "iv_analysis.py";
  if (/plt\.|matplotlib|plotly/.test(code)) return "chart.py";
  if (/returns?|pct_change/.test(code)) return "returns_analysis.py";
  return own || "analysis.py";
}

/** Lines in a piece of code ("" is none; a final newline does not start a line). */
export function lineCount(code: string): number {
  if (!code) return 0;
  return code.replace(/\n$/, "").split("\n").length;
}
