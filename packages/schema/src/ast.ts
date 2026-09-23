import { parseExpr, type BinOp, type FnName, type RpnItem, type UnOp } from "./expr.js";

/**
 * Expression syntax tree, rebuilt from the parser's RPN. The engine evaluates
 * RPN directly; the tree exists for anything that has to *show* an expression
 * (typeset it, describe it in words, list its variables in source order).
 */
export type ExprAst =
  /** `src` locates a literal in the source text (absent for folded constants), so editors can rewrite it in place. */
  | { t: "num"; v: number; src?: { pos: number; len: number } }
  | { t: "var"; name: string }
  | { t: "bin"; op: BinOp; l: ExprAst; r: ExprAst }
  | { t: "un"; op: UnOp; x: ExprAst }
  | { t: "fn"; name: FnName; args: ExprAst[] };

/** Fold RPN back into a tree. Throws if the RPN is malformed (it never is when it came from parseExpr). */
export function rpnToAst(rpn: readonly RpnItem[]): ExprAst {
  const stack: ExprAst[] = [];
  const pop = (): ExprAst => {
    const x = stack.pop();
    if (!x) throw new Error("Malformed RPN: operand stack underflow");
    return x;
  };
  for (const item of rpn) {
    switch (item.t) {
      case "num":
        stack.push(
          item.pos !== undefined && item.len !== undefined
            ? { t: "num", v: item.v, src: { pos: item.pos, len: item.len } }
            : { t: "num", v: item.v },
        );
        break;
      case "var":
        stack.push({ t: "var", name: item.name });
        break;
      case "op":
        if (item.op === "neg" || item.op === "not") {
          stack.push({ t: "un", op: item.op, x: pop() });
        } else {
          const r = pop();
          const l = pop();
          stack.push({ t: "bin", op: item.op, l, r });
        }
        break;
      case "fn": {
        const args: ExprAst[] = new Array(item.arity);
        for (let i = item.arity - 1; i >= 0; i--) args[i] = pop();
        stack.push({ t: "fn", name: item.name, args });
        break;
      }
    }
  }
  if (stack.length !== 1) throw new Error("Malformed RPN: leftover operands");
  return stack[0];
}

/** Parse source text straight to a tree. Throws ExprError like parseExpr. */
export function parseExprAst(src: string): ExprAst {
  return rpnToAst(parseExpr(src));
}

/** Variables in order of first appearance in the source, which is what a reader scans. */
export function astVariables(ast: ExprAst, out: string[] = []): string[] {
  switch (ast.t) {
    case "num":
      break;
    case "var":
      if (!out.includes(ast.name)) out.push(ast.name);
      break;
    case "bin":
      astVariables(ast.l, out);
      astVariables(ast.r, out);
      break;
    case "un":
      astVariables(ast.x, out);
      break;
    case "fn":
      for (const a of ast.args) astVariables(a, out);
      break;
  }
  return out;
}
