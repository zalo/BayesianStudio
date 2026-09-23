import type { AnyNode, BayesDoc } from "./doc.js";
import { parseExpr, type RpnItem } from "./expr.js";
import type { ValidationIssue } from "./validate.js";
import { nodeDependencies, nodeLabels, topologicalOrder } from "./validate.js";
import {
  DIMENSIONLESS,
  dimsEqual,
  formatUnit,
  isDimensionless,
  mulDims,
  parseUnit,
  isPercentUnit,
  powDims,
  UnitError,
  type Dim,
} from "./unit.js";

/**
 * Dimensional evaluation of an expression: units multiply/divide/cancel
 * through the arithmetic, additive positions must agree, transcendental
 * functions demand dimensionless arguments, and exponents on dimensionful
 * bases must be literal numbers.
 */
interface DimVal {
  dim: Dim;
  /** Statically-known numeric value (literals and literal-only subtrees). */
  lit: number | null;
}

function evalDims(
  rpn: RpnItem[],
  lookup: (name: string) => Dim,
  nodeId: string,
  issues: ValidationIssue[],
): Dim {
  const err = (message: string) => issues.push({ severity: "error", nodeId, message });
  const stack: DimVal[] = [];
  const pop = (): DimVal => stack.pop() ?? { dim: DIMENSIONLESS, lit: null };

  const requireSame = (vals: DimVal[], what: string): Dim => {
    for (let i = 1; i < vals.length; i++) {
      if (!dimsEqual(vals[0].dim, vals[i].dim)) {
        err(
          `Unit mismatch in ${what}: '${formatUnit(vals[0].dim) || "1"}' vs '${formatUnit(vals[i].dim) || "1"}' — quantities must share units to be ${what === "comparison" ? "compared" : "combined"}`,
        );
        return vals[0].dim;
      }
    }
    return vals[0].dim;
  };

  for (const item of rpn) {
    switch (item.t) {
      case "num":
        stack.push({ dim: DIMENSIONLESS, lit: item.v });
        break;
      case "var":
        stack.push({ dim: lookup(item.name), lit: null });
        break;
      case "op": {
        if (item.op === "neg") {
          const a = pop();
          stack.push({ dim: a.dim, lit: a.lit === null ? null : -a.lit });
          break;
        }
        if (item.op === "not") {
          const a = pop();
          if (!isDimensionless(a.dim)) {
            err(`'not' needs a dimensionless (boolean) operand (got '${formatUnit(a.dim)}')`);
          }
          stack.push({ dim: DIMENSIONLESS, lit: null });
          break;
        }
        const b = pop();
        const a = pop();
        switch (item.op) {
          case "<":
          case "<=":
          case ">":
          case ">=":
          case "==":
          case "!=":
            requireSame([a, b], "comparison");
            stack.push({ dim: DIMENSIONLESS, lit: null });
            break;
          case "and":
          case "or":
            for (const side of [a, b]) {
              if (!isDimensionless(side.dim)) {
                err(`'${item.op}' needs dimensionless (boolean) operands (got '${formatUnit(side.dim)}')`);
              }
            }
            stack.push({ dim: DIMENSIONLESS, lit: null });
            break;
          case "+":
          case "-": {
            const dim = requireSame([a, b], `'${item.op}'`);
            stack.push({
              dim,
              lit:
                a.lit !== null && b.lit !== null
                  ? item.op === "+"
                    ? a.lit + b.lit
                    : a.lit - b.lit
                  : null,
            });
            break;
          }
          case "*":
            stack.push({
              dim: mulDims(a.dim, b.dim, 1),
              lit: a.lit !== null && b.lit !== null ? a.lit * b.lit : null,
            });
            break;
          case "/":
            stack.push({
              dim: mulDims(a.dim, b.dim, -1),
              lit: a.lit !== null && b.lit !== null ? a.lit / b.lit : null,
            });
            break;
          case "^": {
            if (!isDimensionless(b.dim)) {
              err(`Exponents must be dimensionless (got '${formatUnit(b.dim)}')`);
            }
            if (isDimensionless(a.dim)) {
              stack.push({
                dim: DIMENSIONLESS,
                lit: a.lit !== null && b.lit !== null ? Math.pow(a.lit, b.lit) : null,
              });
            } else if (b.lit === null) {
              err(
                `A dimensionful base ('${formatUnit(a.dim)}') needs a literal exponent so its units stay well-defined — use a plain number, not a node reference`,
              );
              stack.push({ dim: a.dim, lit: null });
            } else {
              stack.push({
                dim: powDims(a.dim, b.lit),
                lit: a.lit !== null ? Math.pow(a.lit, b.lit) : null,
              });
            }
            break;
          }
        }
        break;
      }
      case "fn": {
        const args: DimVal[] = new Array(item.arity);
        for (let k = item.arity - 1; k >= 0; k--) args[k] = pop();
        switch (item.name) {
          case "min":
          case "max":
            stack.push({ dim: requireSame(args, `${item.name}()`), lit: null });
            break;
          case "clamp":
            stack.push({ dim: requireSame(args, "clamp()"), lit: null });
            break;
          case "if": {
            if (!isDimensionless(args[0].dim)) {
              err(`if() condition must be dimensionless (got '${formatUnit(args[0].dim)}')`);
            }
            stack.push({ dim: requireSame([args[1], args[2]], "if() branches"), lit: null });
            break;
          }
          case "log":
          case "ln":
          case "log10":
          case "log2":
          case "exp": {
            if (!isDimensionless(args[0].dim)) {
              err(
                `${item.name}() needs a dimensionless argument (got '${formatUnit(args[0].dim)}') — divide by a reference quantity first, e.g. log(x / x_ref)`,
              );
            }
            stack.push({ dim: DIMENSIONLESS, lit: null });
            break;
          }
          case "logit":
          case "inv_logit":
          case "odds":
          case "prob": {
            if (!isDimensionless(args[0].dim)) {
              err(`${item.name}() takes a probability or odds, which are dimensionless (got '${formatUnit(args[0].dim)}')`);
            }
            stack.push({ dim: DIMENSIONLESS, lit: null });
            break;
          }
          case "cdf":
          case "prob_lt":
          case "prob_gt":
            // The threshold is measured in the queried node's units; the answer is a probability.
            requireSame([args[0], args[1]], `${item.name}()`);
            stack.push({ dim: DIMENSIONLESS, lit: null });
            break;
          case "quantile":
            if (!isDimensionless(args[1].dim)) {
              err(`quantile() probability must be dimensionless (got '${formatUnit(args[1].dim)}')`);
            }
            stack.push({ dim: args[0].dim, lit: null });
            break;
          case "sqrt":
            stack.push({ dim: powDims(args[0].dim, 0.5), lit: null });
            break;
          case "abs":
          case "floor":
          case "ceil":
          case "round":
            stack.push({ dim: args[0].dim, lit: args[0].lit });
            break;
          case "pow": {
            const [base, exp] = args;
            if (!isDimensionless(exp.dim)) err("pow() exponent must be dimensionless");
            if (isDimensionless(base.dim)) {
              stack.push({ dim: DIMENSIONLESS, lit: null });
            } else if (exp.lit === null) {
              err(
                `pow() on a dimensionful base ('${formatUnit(base.dim)}') needs a literal exponent`,
              );
              stack.push({ dim: base.dim, lit: null });
            } else {
              stack.push({ dim: powDims(base.dim, exp.lit), lit: null });
            }
            break;
          }
        }
        break;
      }
    }
  }
  return pop().dim;
}

export interface UnitDerivation {
  /** Node id → canonical formatted unit ("" = dimensionless). */
  units: Record<string, string>;
  issues: ValidationIssue[];
}

/**
 * Walk the graph in topological order deriving every node's unit. Declared
 * units on formulas act as assertions; mismatches are errors. Assumes the
 * document already passed structural validation (refs resolve, DAG).
 */
export function deriveUnits(doc: BayesDoc): UnitDerivation {
  const issues: ValidationIssue[] = [];
  const dims = new Map<string, Dim>();
  /** Nodes whose declared unit carries a `%`: their display unit keeps it. */
  const percent = new Set<string>();
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const { order } = topologicalOrder(doc);

  const declared = (node: AnyNode & { unit?: string }): Dim => {
    if (node.unit === undefined) return DIMENSIONLESS;
    if (isPercentUnit(node.unit)) percent.add(node.id);
    try {
      return parseUnit(node.unit);
    } catch (e) {
      if (e instanceof UnitError) {
        issues.push({ severity: "error", nodeId: node.id, message: e.message });
        return DIMENSIONLESS;
      }
      throw e;
    }
  };

  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    let dim: Dim = DIMENSIONLESS;

    switch (node.kind) {
      case "prior.dist":
      case "prior.sourced": {
        const isDiscrete = nodeLabels(node, byId) !== null;
        dim = declared(node);
        if (isDiscrete && !isDimensionless(dim)) {
          issues.push({
            severity: "warning",
            nodeId: id,
            message: "Discrete nodes (bernoulli/categorical) are dimensionless — the declared unit is ignored",
          });
          dim = DIMENSIONLESS;
        }
        break;
      }
      case "cond.mixture": {
        const isDiscrete = nodeLabels(node, byId) !== null;
        dim = isDiscrete ? DIMENSIONLESS : declared(node);
        break;
      }
      case "prior.pooled": {
        const inputDims = node.inputs.map((pid) => dims.get(pid) ?? DIMENSIONLESS);
        dim = inputDims[0] ?? DIMENSIONLESS;
        for (let i = 1; i < inputDims.length; i++) {
          if (!dimsEqual(dim, inputDims[i])) {
            issues.push({
              severity: "error",
              nodeId: id,
              message: `Pooled inputs must share units: '${node.inputs[0]}' is '${formatUnit(dim) || "1"}' but '${node.inputs[i]}' is '${formatUnit(inputDims[i]) || "1"}'`,
            });
          }
        }
        break;
      }
      case "formula": {
        try {
          const rpn = parseExpr(node.expr);
          dim = evalDims(rpn, (name) => dims.get(name) ?? DIMENSIONLESS, id, issues);
        } catch {
          dim = DIMENSIONLESS; // parse error already reported by validation
        }
        if (node.unit !== undefined) {
          const asserted = declared(node);
          if (!dimsEqual(asserted, dim)) {
            issues.push({
              severity: "error",
              nodeId: id,
              message: `Declared unit '${node.unit}' does not match derived unit '${formatUnit(dim) || "1"}'`,
            });
          }
        }
        break;
      }
      case "utility": {
        try {
          const rpn = parseExpr(node.expr);
          const exprDim = evalDims(rpn, (name) => dims.get(name) ?? DIMENSIONLESS, id, issues);
          // log/CRRA transforms normalize by one unit of the input (u = ln(w/1$)),
          // so transformed utility is dimensionless; linear passes units through.
          dim = !node.transform || node.transform.type === "linear" ? exprDim : DIMENSIONLESS;
        } catch {
          dim = DIMENSIONLESS;
        }
        break;
      }
      case "output":
        dim = dims.get(node.target) ?? DIMENSIONLESS;
        break;
      case "comparator": {
        // Booleans are dimensionless; the threshold is interpreted in the
        // input's units (surfaced as a hint on the node UI).
        dim = DIMENSIONLESS;
        break;
      }
      default:
        dim = DIMENSIONLESS; // logic, cpt, decision, evidence
    }

    dims.set(id, dim);
  }

  const units: Record<string, string> = {};
  for (const [id, d] of dims) {
    const base = formatUnit(d);
    units[id] = percent.has(id) ? (base ? `% ${base}` : "%") : base;
  }
  return { units, issues };
}
