import type { ScoredItem } from "@shared/types";

export const CALCULATOR_SOURCE_ID = "calculator";
// Calculator results should be the first thing the user sees for a maths query.
const CALC_SCORE = 1000;

type Tok =
  | { t: "num"; v: number }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "%" | "^" | "(" | ")" }
  | { t: "ident"; v: string }
  | { t: "pct" };

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function tokenize(src: string): Tok[] | undefined {
  const s = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/,/g, "").replace(/\s+/g, " ");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " ") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) return undefined;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if ("+-*/^()".includes(c)) {
      out.push({ t: "op", v: c as "+" | "-" | "*" | "/" | "^" | "(" | ")" });
      i++;
      continue;
    }
    if (c === "%") {
      // "15% of 80" / "80 + 15%" → percent postfix; "17 % 5" (spaces or digit after) → modulo.
      const next = s.slice(i + 1).trimStart();
      const prev = out[out.length - 1];
      const isModulo = prev?.t === "num" && /^[\d.(]/.test(next) && s[i + 1] === " ";
      out.push(isModulo ? { t: "op", v: "%" } : { t: "pct" });
      i++;
      continue;
    }
    if (/[a-z]/i.test(c)) {
      const m = /^[a-z]+/i.exec(s.slice(i))!;
      const word = m[0].toLowerCase();
      if (word === "x") out.push({ t: "op", v: "*" });
      else if (word === "mod") out.push({ t: "op", v: "%" });
      else if (word === "of") out.push({ t: "ident", v: "of" });
      else if (word in FUNCTIONS || word in CONSTANTS) out.push({ t: "ident", v: word });
      else return undefined;
      i += m[0].length;
      continue;
    }
    return undefined;
  }
  return out;
}

interface Value {
  n: number;
  /** true when the literal carried a "%" postfix and has not been consumed yet */
  pct: boolean;
}

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): number | undefined {
    const v = this.additive();
    if (v === undefined || this.pos !== this.toks.length) return undefined;
    return v.pct ? v.n / 100 : v.n;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }

  private additive(): Value | undefined {
    let left: Value | undefined = this.multiplicative();
    if (!left) return undefined;
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.toks[this.pos++] as { v: string }).v;
      const right = this.multiplicative();
      if (!right) return undefined;
      // "80 + 15%" means 80 plus 15 percent of 80.
      const l: number = left.pct ? left.n / 100 : left.n;
      const r: number = right.pct ? l * (right.n / 100) : right.n;
      left = { n: op === "+" ? l + r : l - r, pct: false };
    }
    return left;
  }

  private multiplicative(): Value | undefined {
    let left: Value | undefined = this.power();
    if (!left) return undefined;
    for (;;) {
      const t = this.peek();
      if (t?.t === "ident" && t.v === "of") {
        this.pos++;
        const right = this.power();
        if (!right) return undefined;
        left = { n: (left.pct ? left.n / 100 : left.n) * (right.pct ? right.n / 100 : right.n), pct: false };
        continue;
      }
      if (!(this.isOp("*") || this.isOp("/") || this.isOp("%"))) break;
      const op = (this.toks[this.pos++] as { v: string }).v;
      const right = this.power();
      if (!right) return undefined;
      const l: number = left.pct ? left.n / 100 : left.n;
      const r: number = right.pct ? right.n / 100 : right.n;
      left = { n: op === "*" ? l * r : op === "/" ? l / r : l % r, pct: false };
    }
    return left;
  }

  private power(): Value | undefined {
    const base = this.unary();
    if (!base) return undefined;
    if (this.isOp("^")) {
      this.pos++;
      const exp = this.power(); // right-associative
      if (!exp) return undefined;
      return { n: Math.pow(base.pct ? base.n / 100 : base.n, exp.pct ? exp.n / 100 : exp.n), pct: false };
    }
    return base;
  }

  private unary(): Value | undefined {
    if (this.isOp("-")) {
      this.pos++;
      const v = this.unary();
      return v && { n: -v.n, pct: v.pct };
    }
    if (this.isOp("+")) {
      this.pos++;
      return this.unary();
    }
    return this.postfix();
  }

  private postfix(): Value | undefined {
    const v = this.primary();
    if (!v) return undefined;
    if (this.peek()?.t === "pct") {
      this.pos++;
      return { n: v.n, pct: true };
    }
    return v;
  }

  private primary(): Value | undefined {
    const t = this.peek();
    if (!t) return undefined;
    if (t.t === "num") {
      this.pos++;
      return { n: t.v, pct: false };
    }
    if (t.t === "op" && t.v === "(") {
      this.pos++;
      const inner = this.additive();
      if (!inner || !this.isOp(")")) return undefined;
      this.pos++;
      return { n: inner.pct ? inner.n / 100 : inner.n, pct: false };
    }
    if (t.t === "ident" && t.v in CONSTANTS) {
      this.pos++;
      return { n: CONSTANTS[t.v]!, pct: false };
    }
    if (t.t === "ident" && t.v in FUNCTIONS) {
      this.pos++;
      if (!this.isOp("(")) return undefined;
      this.pos++;
      const arg = this.additive();
      if (!arg || !this.isOp(")")) return undefined;
      this.pos++;
      return { n: FUNCTIONS[t.v]!(arg.pct ? arg.n / 100 : arg.n), pct: false };
    }
    return undefined;
  }
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "∞" : n < 0 ? "-∞" : "NaN";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toString();
  const rounded = Number(n.toPrecision(12));
  return Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0) ? rounded.toExponential(6) : rounded.toString();
}

/**
 * Evaluate an arithmetic query. Returns undefined when the text is not maths.
 * A bare number ("42") is deliberately not a calculation.
 */
export function evaluate(query: string): number | undefined {
  const src = query.trim().replace(/^=\s*/, "");
  if (!src || !/\d/.test(src)) return undefined;
  const toks = tokenize(src);
  if (!toks) return undefined;
  const hasOperation = toks.some((t) => t.t !== "num");
  if (!hasOperation) return undefined;
  const result = new Parser(toks).parse();
  return result === undefined || Number.isNaN(result) ? undefined : result;
}

export function calculatorItems(query: string): ScoredItem[] {
  const value = evaluate(query);
  if (value === undefined) return [];
  const text = formatNumber(value);
  return [
    {
      item: {
        id: `calculator:${query.trim()}`,
        kind: "calculator",
        title: `= ${text}`,
        subtitle: "Press Enter to copy",
        icon: { kind: "emoji", value: "🧮" },
        text,
        source: CALCULATOR_SOURCE_ID,
      },
      score: CALC_SCORE,
      matchScore: CALC_SCORE,
      matchKind: "exact",
      frecency: 0,
      ranges: [],
    },
  ];
}
