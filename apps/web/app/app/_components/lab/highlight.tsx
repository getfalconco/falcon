import type { ReactNode } from "react";

/**
 * A small Python highlighter for the results panel's Code tab: comments,
 * strings (triple-quoted and f-strings included), numbers, keywords, builtins
 * and decorator / def / class names, in theme colors. Returns one node list
 * per line. Not a parser; good enough to read a backtest script.
 */

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" "),
);
const BUILTINS = new Set(
  "abs all any bool dict enumerate filter float format getattr hasattr int isinstance len list map max min open print range repr reversed round set sorted str sum tuple type zip self pd np json os glob math".split(" "),
);

const CLASS: Record<string, string> = {
  comment: "italic text-faint",
  string: "text-up",
  number: "text-warn",
  keyword: "text-iris",
  builtin: "text-chart-ew",
  name: "font-medium text-fore",
  decorator: "text-warn",
};

const TOKEN =
  /(#[^\n]*)|([rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|(@[A-Za-z_][\w.]*)|(\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?\b|\.\d+\b)|([A-Za-z_]\w*)/g;

export function highlightPython(code: string): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  let key = 0;
  const push = (text: string, cls?: string) => {
    const parts = text.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1]!.push(cls ? <span key={key++} className={cls}>{p}</span> : p);
    });
  };
  TOKEN.lastIndex = 0;
  let last = 0;
  let prevWord = "";
  for (let m = TOKEN.exec(code); m; m = TOKEN.exec(code)) {
    if (m.index > last) push(code.slice(last, m.index));
    const [tok, comment, string, decorator, number, word] = m;
    if (comment) push(tok, CLASS.comment);
    else if (string) push(tok, CLASS.string);
    else if (decorator) push(tok, CLASS.decorator);
    else if (number) push(tok, CLASS.number);
    else if (word) {
      push(tok, KEYWORDS.has(word) ? CLASS.keyword : prevWord === "def" || prevWord === "class" ? CLASS.name : BUILTINS.has(word) ? CLASS.builtin : undefined);
      prevWord = word;
    }
    last = m.index + tok.length;
    if (!tok.length) TOKEN.lastIndex++;
  }
  if (last < code.length) push(code.slice(last));
  return lines;
}
