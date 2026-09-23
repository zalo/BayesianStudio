/**
 * The document expression language, used by `formula` and `utility` nodes.
 * Deliberately tiny and side-effect free: numbers, node references,
 * arithmetic, comparisons, boolean logic, and a fixed set of functions.
 *
 * Parsing lives in the schema package because the language is part of the
 * document format; evaluation lives in the engine.
 */

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "and"
  | "or";
export type UnOp = "neg" | "not";
export type Op = BinOp | UnOp;

export type RpnItem =
  /** `pos`/`len` locate a literal in the source; folded constants (`pi`, `true`, …) carry neither. */
  | { t: "num"; v: number; pos?: number; len?: number }
  | { t: "var"; name: string }
  | { t: "op"; op: Op }
  | { t: "fn"; name: FnName; arity: number };

export const FUNCTIONS = {
  min: { minArity: 2, maxArity: Infinity },
  max: { minArity: 2, maxArity: Infinity },
  log: { minArity: 1, maxArity: 1 }, // natural log
  ln: { minArity: 1, maxArity: 1 },
  log10: { minArity: 1, maxArity: 1 },
  log2: { minArity: 1, maxArity: 1 },
  exp: { minArity: 1, maxArity: 1 },
  sqrt: { minArity: 1, maxArity: 1 },
  abs: { minArity: 1, maxArity: 1 },
  pow: { minArity: 2, maxArity: 2 },
  floor: { minArity: 1, maxArity: 1 },
  ceil: { minArity: 1, maxArity: 1 },
  round: { minArity: 1, maxArity: 1 },
  clamp: { minArity: 3, maxArity: 3 }, // clamp(x, lo, hi)
  /**
   * Piecewise selection: if(cond, then, else) — per-sample ternary. `cond` is
   * truthy when > 0.5, so comparator/logic node outputs and inline
   * comparisons (`if(x > 0, …)`) plug in directly. For switching whole
   * DISTRIBUTIONS by a discrete parent, prefer a cond.mixture node; if() is
   * for piecewise arithmetic inside one formula.
   */
  if: { minArity: 3, maxArity: 3 },
  /** Probability ↔ log-odds ↔ odds. Out-of-range inputs yield NaN samples. */
  logit: { minArity: 1, maxArity: 1 },
  inv_logit: { minArity: 1, maxArity: 1 },
  odds: { minArity: 1, maxArity: 1 },
  prob: { minArity: 1, maxArity: 1 },
  /**
   * Distribution queries: these read the WHOLE sample vector of their first
   * argument rather than one sample at a time, so they turn a distribution
   * into a statistic. `cdf(node, x)` is the share of node's outcomes ≤ x,
   * `prob_lt`/`prob_gt` are strict below/above, `quantile(node, p)` is the
   * value at cumulative probability p. The second argument may itself vary
   * per sample.
   */
  cdf: { minArity: 2, maxArity: 2 },
  prob_lt: { minArity: 2, maxArity: 2 },
  prob_gt: { minArity: 2, maxArity: 2 },
  quantile: { minArity: 2, maxArity: 2 },
} as const;

export type FnName = keyof typeof FUNCTIONS;

/** Functions whose first argument is consumed as a whole distribution. */
export const DISTRIBUTION_QUERY_FUNCTIONS: ReadonlySet<FnName> = new Set<FnName>([
  "cdf",
  "prob_lt",
  "prob_gt",
  "quantile",
]);

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  true: 1,
  false: 0,
};

const KEYWORDS = new Set(["and", "or", "not"]);

/** Names that documents may not use as node ids. */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  ...Object.keys(FUNCTIONS),
  ...Object.keys(CONSTANTS),
  ...KEYWORDS,
]);

export class ExprError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} (at position ${position})`);
    this.name = "ExprError";
  }
}

type Token =
  | { t: "num"; v: number; pos: number; len: number }
  | { t: "ident"; name: string; pos: number }
  | { t: "op"; op: BinOp; pos: number }
  | { t: "kw"; name: "and" | "or" | "not"; pos: number }
  | { t: "lparen"; pos: number }
  | { t: "rparen"; pos: number }
  | { t: "comma"; pos: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i))!;
      tokens.push({ t: "num", v: Number(m[0]), pos: i, len: m[0].length });
      i += m[0].length;
      continue;
    }
    if (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9") {
      const m = /^\.\d+([eE][+-]?\d+)?/.exec(src.slice(i))!;
      tokens.push({ t: "num", v: Number(m[0]), pos: i, len: m[0].length });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))!;
      const name = m[0];
      if (KEYWORDS.has(name)) {
        tokens.push({ t: "kw", name: name as "and" | "or" | "not", pos: i });
      } else {
        tokens.push({ t: "ident", name, pos: i });
      }
      i += name.length;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^") {
      tokens.push({ t: "op", op: c, pos: i });
      i++;
      continue;
    }
    if (c === "<" || c === ">") {
      if (src[i + 1] === "=") {
        tokens.push({ t: "op", op: c === "<" ? "<=" : ">=", pos: i });
        i += 2;
      } else {
        tokens.push({ t: "op", op: c, pos: i });
        i++;
      }
      continue;
    }
    if (c === "=" || c === "!") {
      if (src[i + 1] !== "=") {
        throw new ExprError(
          c === "=" ? "Use '==' to compare for equality" : "Use '!=' for not-equal (or 'not' to negate)",
          i,
        );
      }
      tokens.push({ t: "op", op: c === "=" ? "==" : "!=", pos: i });
      i += 2;
      continue;
    }
    if (c === "?" || c === ":") {
      throw new ExprError("There is no ternary operator — use if(condition, then, else)", i);
    }
    if (c === "&" || c === "|") {
      throw new ExprError(`Use the word '${c === "&" ? "and" : "or"}' instead of '${c}'`, i);
    }
    if (c === "(") {
      tokens.push({ t: "lparen", pos: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen", pos: i });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ t: "comma", pos: i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}'`, i);
  }
  return tokens;
}

/**
 * Binding strength, low to high: or < and < not < comparisons < additive <
 * multiplicative < power < unary minus. `not a > b` therefore reads as
 * `not (a > b)`, matching Python.
 */
const PRECEDENCE: Record<Op, number> = {
  or: 1,
  and: 2,
  not: 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "==": 4,
  "!=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "^": 7,
  neg: 8,
};
const RIGHT_ASSOC = new Set<Op>(["^"]);

/**
 * Parse an expression to RPN (shunting-yard with unary operators and
 * function calls). Throws ExprError with a position on any malformed input.
 */
export function parseExpr(src: string): RpnItem[] {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new ExprError("Empty expression", 0);

  const output: RpnItem[] = [];
  type StackItem =
    | { t: "op"; op: Op; pos: number }
    | { t: "fn"; name: FnName; argCount: number; pos: number }
    | { t: "lparen"; pos: number };
  const stack: StackItem[] = [];
  // Track whether the previous token completes a value (drives unary detection).
  let prevWasValue = false;

  const popOps = (minPrec: number, rightAssoc: boolean) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.t !== "op") break;
      const topPrec = PRECEDENCE[top.op];
      if (topPrec > minPrec || (topPrec === minPrec && !rightAssoc)) {
        output.push({ t: "op", op: top.op });
        stack.pop();
      } else break;
    }
  };

  const pushBinary = (op: BinOp, pos: number) => {
    if (!prevWasValue) throw new ExprError(`Unexpected operator '${op}'`, pos);
    popOps(PRECEDENCE[op], RIGHT_ASSOC.has(op));
    stack.push({ t: "op", op, pos });
    prevWasValue = false;
  };

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    switch (tok.t) {
      case "num":
        if (prevWasValue) throw new ExprError("Unexpected number", tok.pos);
        output.push({ t: "num", v: tok.v, pos: tok.pos, len: tok.len });
        prevWasValue = true;
        break;
      case "ident": {
        if (prevWasValue) throw new ExprError(`Unexpected identifier '${tok.name}'`, tok.pos);
        const next = tokens[idx + 1];
        if (next && next.t === "lparen") {
          if (!(tok.name in FUNCTIONS)) {
            throw new ExprError(`Unknown function '${tok.name}'`, tok.pos);
          }
          stack.push({ t: "fn", name: tok.name as FnName, argCount: 1, pos: tok.pos });
          stack.push({ t: "lparen", pos: next.pos });
          idx++; // consume the lparen
          prevWasValue = false;
        } else if (tok.name in CONSTANTS) {
          output.push({ t: "num", v: CONSTANTS[tok.name] });
          prevWasValue = true;
        } else {
          output.push({ t: "var", name: tok.name });
          prevWasValue = true;
        }
        break;
      }
      case "kw": {
        if (tok.name === "not") {
          if (prevWasValue) throw new ExprError("Unexpected 'not' — write 'a and not b'", tok.pos);
          stack.push({ t: "op", op: "not", pos: tok.pos });
          break;
        }
        pushBinary(tok.name, tok.pos);
        break;
      }
      case "op": {
        if (tok.op === "-" && !prevWasValue) {
          stack.push({ t: "op", op: "neg", pos: tok.pos });
          break;
        }
        if (tok.op === "+" && !prevWasValue) break; // unary plus: no-op
        pushBinary(tok.op, tok.pos);
        break;
      }
      case "lparen":
        if (prevWasValue) throw new ExprError("Unexpected '('", tok.pos);
        stack.push({ t: "lparen", pos: tok.pos });
        prevWasValue = false;
        break;
      case "rparen": {
        if (!prevWasValue) throw new ExprError("Unexpected ')'", tok.pos);
        while (stack.length > 0 && stack[stack.length - 1].t === "op") {
          const op = stack.pop() as Extract<StackItem, { t: "op" }>;
          output.push({ t: "op", op: op.op });
        }
        if (stack.length === 0 || stack[stack.length - 1].t !== "lparen") {
          throw new ExprError("Mismatched ')'", tok.pos);
        }
        stack.pop(); // lparen
        const maybeFn = stack[stack.length - 1];
        if (maybeFn && maybeFn.t === "fn") {
          stack.pop();
          const spec = FUNCTIONS[maybeFn.name];
          if (maybeFn.argCount < spec.minArity || maybeFn.argCount > spec.maxArity) {
            throw new ExprError(
              `Function '${maybeFn.name}' expects ${
                spec.maxArity === Infinity
                  ? `at least ${spec.minArity}`
                  : spec.minArity === spec.maxArity
                    ? `${spec.minArity}`
                    : `${spec.minArity}-${spec.maxArity}`
              } argument(s), got ${maybeFn.argCount}`,
              maybeFn.pos,
            );
          }
          output.push({ t: "fn", name: maybeFn.name, arity: maybeFn.argCount });
        }
        prevWasValue = true;
        break;
      }
      case "comma": {
        if (!prevWasValue) throw new ExprError("Unexpected ','", tok.pos);
        while (stack.length > 0 && stack[stack.length - 1].t === "op") {
          const op = stack.pop() as Extract<StackItem, { t: "op" }>;
          output.push({ t: "op", op: op.op });
        }
        const paren = stack[stack.length - 1];
        const fn = stack[stack.length - 2];
        if (!paren || paren.t !== "lparen" || !fn || fn.t !== "fn") {
          throw new ExprError("',' outside of function call", tok.pos);
        }
        fn.argCount++;
        prevWasValue = false;
        break;
      }
    }
  }

  if (!prevWasValue) throw new ExprError("Unexpected end of expression", src.length);
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.t === "lparen" || top.t === "fn") throw new ExprError("Mismatched '('", top.pos);
    output.push({ t: "op", op: top.op });
  }
  return output;
}

/** The set of node ids an expression references. */
export function exprIdentifiers(src: string): Set<string> {
  const ids = new Set<string>();
  for (const item of parseExpr(src)) {
    if (item.t === "var") ids.add(item.name);
  }
  return ids;
}
