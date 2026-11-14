/**
 * FSL (Falcon Strategy Language): lexer and a hand-written Pratt parser.
 *
 *   close > ts_mean(close, $ma) and at("SPY", close > ts_mean(close, 200))
 *
 * Grammar (precedence low to high): or, and, not (prefix), comparisons
 * (< <= > >= == !=), + -, * /, unary minus, calls / atoms. Atoms: numbers,
 * strings ("..." or '...'), $params, identifiers (dotted: earnings.event),
 * calls f(a, b), parentheses, true / false.
 *
 * Pure, no eval or Function: the result is an AST the checker and evaluator
 * walk. Errors carry the character offset so the formula view can point at it.
 */

export type Pos = { start: number; end: number };

export type Node =
  | { k: "num"; v: number; pos: Pos }
  | { k: "str"; v: string; pos: Pos }
  | { k: "bool"; v: boolean; pos: Pos }
  | { k: "param"; name: string; pos: Pos }
  | { k: "ident"; name: string; pos: Pos }
  | { k: "call"; fn: string; args: Node[]; pos: Pos }
  | { k: "bin"; op: BinOp; a: Node; b: Node; pos: Pos }
  | { k: "un"; op: "-" | "not"; a: Node; pos: Pos };

export type BinOp = "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "and" | "or";

export class FslError extends Error {
  constructor(
    message: string,
    public pos: Pos | null = null,
    public hint: string | null = null,
  ) {
    super(message);
    this.name = "FslError";
  }
}

type Tok =
  | { t: "num"; v: number; pos: Pos }
  | { t: "str"; v: string; pos: Pos }
  | { t: "param"; v: string; pos: Pos }
  | { t: "ident"; v: string; pos: Pos }
  | { t: "op"; v: string; pos: Pos }
  | { t: "eof"; pos: Pos };

export const MAX_FORMULA_CHARS = 2_000;
export const MAX_NODES = 300;

const OPS = ["<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/", "(", ")", ","];

export function lex(src: string): Tok[] {
  if (src.length > MAX_FORMULA_CHARS) throw new FslError(`A formula can be at most ${MAX_FORMULA_CHARS} characters.`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
      if (src[i] === "." && /[0-9]/.test(src[i + 1] ?? "")) {
        i++;
        while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
      }
      if (/[eE]/.test(src[i] ?? "") && /[-+0-9]/.test(src[i + 1] ?? "")) {
        i += 2;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      if (src[i] === "%") {
        throw new FslError("Write percentages as fractions or as a $param of type pct (5% is 0.05).", { start, end: i + 1 });
      }
      const text = src.slice(start, i).replace(/_/g, "");
      out.push({ t: "num", v: Number(text), pos: { start, end: i } });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i++;
      if (i >= src.length) throw new FslError("A string is not closed.", { start, end: src.length });
      out.push({ t: "str", v: src.slice(start + 1, i), pos: { start, end: i + 1 } });
      i++;
      continue;
    }
    if (c === "$") {
      i++;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      if (i === start + 1) throw new FslError("A $ must be followed by a parameter name, e.g. $lookback.", { start, end: i });
      out.push({ t: "param", v: src.slice(start + 1, i), pos: { start, end: i } });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i]!)) i++;
      out.push({ t: "ident", v: src.slice(start, i), pos: { start, end: i } });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op, pos: { start, end: i + op.length } });
      i += op.length;
      continue;
    }
    if (c === "&" || c === "|" || c === "!" || c === "=") {
      const word = c === "&" ? "and" : c === "|" ? "or" : c === "!" ? "not" : "==";
      throw new FslError(`Unexpected "${c}". Write "${word}".`, { start, end: i + 1 });
    }
    throw new FslError(`Unexpected character "${c}".`, { start, end: i + 1 });
  }
  out.push({ t: "eof", pos: { start: src.length, end: src.length } });
  return out;
}

const BP: Record<string, number> = {
  or: 10,
  and: 20,
  "<": 40,
  "<=": 40,
  ">": 40,
  ">=": 40,
  "==": 40,
  "!=": 40,
  "+": 50,
  "-": 50,
  "*": 60,
  "/": 60,
};

class Parser {
  private i = 0;
  nodes = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private count() {
    this.nodes++;
    if (this.nodes > MAX_NODES) throw new FslError(`A formula can have at most ${MAX_NODES} parts.`);
  }
  private expectOp(v: string): Tok {
    const t = this.next();
    if (t.t !== "op" || t.v !== v) throw new FslError(`Expected "${v}".`, t.pos);
    return t;
  }

  private infixOp(t: Tok): string | null {
    if (t.t === "op" && t.v in BP) return t.v;
    if (t.t === "ident" && (t.v === "and" || t.v === "or")) return t.v;
    return null;
  }

  parse(minBp = 0): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const op = this.infixOp(t);
      if (!op) break;
      const bp = BP[op]!;
      if (bp <= minBp) break;
      this.next();
      // Comparisons do not chain: a < b < c is an error.
      const right = this.parse(bp);
      if (bp === 40 && left.k === "bin" && BP[left.op] === 40 && !("paren" in left)) {
        throw new FslError("Comparisons cannot be chained; join them with and.", t.pos);
      }
      this.count();
      left = { k: "bin", op: op as BinOp, a: left, b: right, pos: { start: left.pos.start, end: right.pos.end } };
    }
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    this.count();
    switch (t.t) {
      case "num":
        return { k: "num", v: t.v, pos: t.pos };
      case "str":
        return { k: "str", v: t.v, pos: t.pos };
      case "param":
        return { k: "param", name: t.v, pos: t.pos };
      case "ident": {
        if (t.v === "not") {
          const a = this.parse(30);
          return { k: "un", op: "not", a, pos: { start: t.pos.start, end: a.pos.end } };
        }
        if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true", pos: t.pos };
        if (t.v === "and" || t.v === "or") throw new FslError(`"${t.v}" needs something before it.`, t.pos);
        const nxt = this.peek();
        if (nxt.t === "op" && nxt.v === "(") {
          this.next();
          const args: Node[] = [];
          if (!(this.peek().t === "op" && (this.peek() as { v: string }).v === ")")) {
            for (;;) {
              args.push(this.parse(0));
              const sep = this.peek();
              if (sep.t === "op" && sep.v === ",") {
                this.next();
                continue;
              }
              break;
            }
          }
          const close = this.expectOp(")");
          return { k: "call", fn: t.v, args, pos: { start: t.pos.start, end: close.pos.end } };
        }
        return { k: "ident", name: t.v, pos: t.pos };
      }
      case "op": {
        if (t.v === "(") {
          const inner = this.parse(0);
          this.expectOp(")");
          // Mark parenthesized comparisons so a < (b < c) style chains are allowed explicitly.
          return inner.k === "bin" ? Object.assign(inner, { paren: true }) : inner;
        }
        if (t.v === "-") {
          const a = this.parse(70);
          if (a.k === "num") return { k: "num", v: -a.v, pos: { start: t.pos.start, end: a.pos.end } };
          return { k: "un", op: "-", a, pos: { start: t.pos.start, end: a.pos.end } };
        }
        throw new FslError(`Unexpected "${t.v}".`, t.pos);
      }
      case "eof":
        throw new FslError("The formula ends too early.", t.pos);
    }
  }
}

/** Parses one FSL expression. Throws FslError with a position. */
export function parse(src: string): Node {
  const text = (src ?? "").trim();
  if (!text) throw new FslError("The formula is empty.");
  const p = new Parser(lex(src));
  const node = p.parse(0);
  const rest = (p as unknown as { peek(): Tok }).peek();
  if (rest.t !== "eof") throw new FslError("Unexpected text after the end of the formula.", rest.pos);
  return node;
}

/** Number of AST nodes. */
export function size(n: Node): number {
  switch (n.k) {
    case "call":
      return 1 + n.args.reduce((a, x) => a + size(x), 0);
    case "bin":
      return 1 + size(n.a) + size(n.b);
    case "un":
      return 1 + size(n.a);
    default:
      return 1;
  }
}

/** Visits every node, parents first. */
export function walk(n: Node, f: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  f(n, parent);
  if (n.k === "call") n.args.forEach((a) => walk(a, f, n));
  else if (n.k === "bin") {
    walk(n.a, f, n);
    walk(n.b, f, n);
  } else if (n.k === "un") walk(n.a, f, n);
}

const PREC: Record<string, number> = { or: 1, and: 2, "<": 4, "<=": 4, ">": 4, ">=": 4, "==": 4, "!=": 4, "+": 5, "-": 5, "*": 6, "/": 6 };

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(12)));
}

/** Canonical text: aliases normalized (sma -> ts_mean), single spacing, minimal parentheses. */
export function format(n: Node, aliases: Record<string, string> = {}): string {
  const go = (x: Node, parentPrec: number, right = false): string => {
    switch (x.k) {
      case "num":
        return fmtNum(x.v);
      case "str":
        return JSON.stringify(x.v);
      case "bool":
        return x.v ? "true" : "false";
      case "param":
        return `$${x.name}`;
      case "ident":
        return aliases[x.name] ?? x.name;
      case "call":
        return `${aliases[x.fn] ?? x.fn}(${x.args.map((a) => go(a, 0)).join(", ")})`;
      case "un": {
        const inner = x.op === "not" ? `not ${go(x.a, 3)}` : `-${go(x.a, 7)}`;
        return parentPrec > (x.op === "not" ? 3 : 7) ? `(${inner})` : inner;
      }
      case "bin": {
        const p = PREC[x.op]!;
        const s = `${go(x.a, p)} ${x.op} ${go(x.b, p, true)}`;
        return parentPrec > p || (right && parentPrec === p) ? `(${s})` : s;
      }
    }
  };
  return go(n, 0);
}
