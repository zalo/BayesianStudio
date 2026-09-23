import {
  astVariables,
  nodeDependencies,
  parseExprAst,
  type AnyNode,
  type BinOp,
  type Dist,
  type ExprAst,
  type FnName,
} from "@bayes-studio/schema";
import { fmt, fmtPct } from "./format.js";

/**
 * Every node has a defining equation. This module typesets it (KaTeX
 * source) and reads it aloud (a list of words and coloured variables), in the
 * spirit of Better Explained's colorized equations: each input gets a colour
 * that is used in the equation, in the sentence beneath it, on the port the
 * edge arrives at, and at the arriving end of the edge itself.
 *
 * Colours are assigned per node, in reading order, so the first variable a
 * reader meets is `v0`, the next `v1`, and so on. The CSS tokens --var-0…7
 * define the palette; `varClass` maps an index to its class.
 *
 * Numbers in the equation are *slots*: each one knows how to produce a copy
 * of the node with that number changed, so the UI can offer in-place editing
 * without knowing anything about node kinds. Variables are never editable
 * here — they are the connected inputs.
 */

export const VAR_COLOURS = 8;

export function varClass(index: number): string {
  return `v${index % VAR_COLOURS}`;
}

export function varColour(index: number): string {
  return `var(--var-${index % VAR_COLOURS})`;
}

/** A piece of the plain-English reading: literal words or a coloured variable. */
export type Segment = string | { var: string; index: number };

export interface InputRef {
  id: string;
  index: number;
  title?: string;
}

export interface EditableSlot {
  /** Value currently shown. */
  value: number;
  /** What the number is, for the edit field's tooltip: "threshold", "p", "coefficient", … */
  label: string;
  /**
   * The node with this one number replaced by what the user typed. Callers
   * check the text is a finite number first; for expression literals the text
   * is spliced into the source verbatim so `0.10` stays `0.10`.
   */
  apply: (text: string) => AnyNode;
}

export interface NodeDescription {
  /** KaTeX source for the defining equation; null when the node has none to show. */
  latex: string | null;
  /** The equation read aloud. Empty when there is nothing to say. */
  english: Segment[];
  /** Inputs in reading order, with their colour index. Drives ports, legend, and edge colours. */
  inputs: InputRef[];
  /** Editable numbers, indexed by the `data-slot` attribute KaTeX emits. */
  slots: EditableSlot[];
  /** Set when the expression could not be parsed; `latex` is then null. */
  error?: string;
}

/** `capex_growth` → `capex growth`. Ids are identifier-shaped, so this is the whole job. */
export function humanize(id: string): string {
  return id.replace(/_/g, " ");
}

/**
 * Inputs in the order a reader meets them: source order for expressions,
 * declaration order (parents, cases, …) for everything else. This is the
 * order colours are handed out in, so `graph.ts` uses it too.
 */
export function inputOrder(node: AnyNode): string[] {
  if (node.kind === "formula" || node.kind === "utility") {
    try {
      return astVariables(parseExprAst(node.expr));
    } catch {
      return [];
    }
  }
  return nodeDependencies(node);
}

// ---------------------------------------------------------------------------
// LaTeX
// ---------------------------------------------------------------------------

function texText(s: string): string {
  return s.replace(/[\\{}$&#%_^~]/g, (c) => (c === "\\" ? "\\textbackslash{}" : `\\${c}`));
}

/** Identifier as math: short ids stay italic symbols, `x_rest` becomes x with a subscript, words stay words. */
function identBody(id: string): string {
  const sub = /^([A-Za-z])_(.+)$/.exec(id);
  if (sub) return `${sub[1]}_{\\text{${texText(humanize(sub[2]))}}}`;
  if (id.length <= 2) return id;
  return `\\text{${texText(humanize(id))}}`;
}

function varTex(id: string, index: number): string {
  return `\\htmlClass{eqv ${varClass(index)}}{${identBody(id)}}`;
}

function selfTex(id: string): string {
  return `\\htmlClass{eq-self}{${identBody(id)}}`;
}

function numTex(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "\\infty" : v < 0 ? "-\\infty" : "\\text{NaN}";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) {
    const [m, e] = v.toExponential(2).split("e");
    return `${String(Number(m))} \\times 10^{${Number(e)}}`;
  }
  return String(Number(v.toPrecision(4)));
}

/** Split "% civilizations/planets" into its percent sign and the rest ("" when not percent-valued). */
function splitPercent(unit: string): { pct: boolean; rest: string } {
  const m = /^%\s*(.*)$/.exec(unit);
  return m ? { pct: true, rest: m[1] } : { pct: false, rest: unit };
}

function unitTex(unit: string | undefined): string {
  if (!unit) return "";
  const { pct, rest } = splitPercent(unit);
  const restTex = rest ? `\\ \\text{${texText(rest)}}` : "";
  return pct ? `\\%${restTex}` : restTex;
}

/** A number with its unit: "35%" or "4.4% civilizations/planets" for percent, "12 yr" otherwise. */
function withUnit(x: number, unit?: string): string {
  if (!unit) return fmt(x);
  const { pct, rest } = splitPercent(unit);
  if (!pct) return `${fmt(x)} ${unit}`;
  return rest ? `${fmt(x)}% ${rest}` : `${fmt(x)}%`;
}

const PREC: Record<BinOp | "neg" | "not", number> = {
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
const ATOM = 9;

function precOf(ast: ExprAst): number {
  if (ast.t === "bin") return PREC[ast.op];
  if (ast.t === "un") return PREC[ast.op];
  return ATOM;
}

const BIN_TEX: Record<BinOp, string> = {
  "+": " + ",
  "-": " - ",
  "*": " \\times ",
  "/": "", // rendered as \frac
  "^": "", // rendered as ^{}
  "<": " < ",
  "<=": " \\le ",
  ">": " > ",
  ">=": " \\ge ",
  "==": " = ",
  "!=": " \\ne ",
  and: " \\land ",
  or: " \\lor ",
};

/** Everything the expression walkers need: colour indexes and a number renderer (which registers slots). */
interface Ctx {
  vars: ReadonlyMap<string, number>;
  num: (n: Extract<ExprAst, { t: "num" }>) => string;
}

function exprTex(ast: ExprAst, c: Ctx, ctx = 0): string {
  const own = precOf(ast);
  const wrap = (s: string) => (own < ctx ? `\\left(${s}\\right)` : s);
  switch (ast.t) {
    case "num":
      return ast.v < 0 && ctx > PREC["+"] ? `\\left(${c.num(ast)}\\right)` : c.num(ast);
    case "var":
      return varTex(ast.name, c.vars.get(ast.name) ?? 0);
    case "un":
      if (ast.op === "neg") return wrap(`-${exprTex(ast.x, c, PREC.neg)}`);
      return wrap(`\\lnot ${exprTex(ast.x, c, PREC.not)}`);
    case "bin": {
      if (ast.op === "/") return `\\frac{${exprTex(ast.l, c, 0)}}{${exprTex(ast.r, c, 0)}}`;
      if (ast.op === "^") return `{${exprTex(ast.l, c, ATOM)}}^{${exprTex(ast.r, c, 0)}}`;
      // Left-associative: the right operand of - needs parens at equal precedence.
      const rightCtx = ast.op === "-" ? own + 1 : own;
      return wrap(`${exprTex(ast.l, c, own)}${BIN_TEX[ast.op]}${exprTex(ast.r, c, rightCtx)}`);
    }
    case "fn":
      return fnTex(ast.name, ast.args, c);
  }
}

function fnTex(name: FnName, args: ExprAst[], c: Ctx): string {
  const a = (i: number, ctx = 0) => exprTex(args[i], c, ctx);
  const list = () => args.map((_, i) => a(i)).join(",\\ ");
  switch (name) {
    case "log":
    case "ln":
      return `\\ln\\left(${a(0)}\\right)`;
    case "log10":
      return `\\log_{10}\\left(${a(0)}\\right)`;
    case "log2":
      return `\\log_{2}\\left(${a(0)}\\right)`;
    case "exp":
      return `e^{${a(0)}}`;
    case "sqrt":
      return `\\sqrt{${a(0)}}`;
    case "abs":
      return `\\left|${a(0)}\\right|`;
    case "pow":
      return `{${a(0, ATOM)}}^{${a(1)}}`;
    case "floor":
      return `\\left\\lfloor ${a(0)} \\right\\rfloor`;
    case "ceil":
      return `\\left\\lceil ${a(0)} \\right\\rceil`;
    case "round":
      return `\\operatorname{round}\\left(${a(0)}\\right)`;
    case "clamp":
      return `\\operatorname{clamp}\\left(${list()}\\right)`;
    case "min":
      return `\\min\\left(${list()}\\right)`;
    case "max":
      return `\\max\\left(${list()}\\right)`;
    case "if":
      return `\\begin{cases} ${a(1)} & \\text{if } ${a(0)} \\\\ ${a(2)} & \\text{otherwise} \\end{cases}`;
    case "logit":
      return `\\operatorname{logit}\\left(${a(0)}\\right)`;
    case "inv_logit":
      return `\\operatorname{logit}^{-1}\\left(${a(0)}\\right)`;
    case "odds":
      return `\\operatorname{odds}\\left(${a(0)}\\right)`;
    case "prob":
      return `\\operatorname{prob}\\left(${a(0)}\\right)`;
    case "cdf":
      return `P\\left(${a(0)} \\le ${a(1)}\\right)`;
    case "prob_lt":
      return `P\\left(${a(0)} < ${a(1)}\\right)`;
    case "prob_gt":
      return `P\\left(${a(0)} > ${a(1)}\\right)`;
    case "quantile":
      return `Q_{${a(1)}}\\left(${a(0)}\\right)`;
  }
}

/** Numbers inside a distribution; `n(value, key)` may register the parameter as an editable slot. */
type DistNum = (v: number, key: string) => string;

function distTex(d: Dist, unit: string | undefined, n: DistNum): string {
  const u = unitTex(unit);
  switch (d.dist) {
    case "point":
      return `= ${n(d.value, "value")}${u}`;
    case "uniform":
      return `\\sim \\mathrm{Uniform}\\left(${n(d.min, "min")},\\ ${n(d.max, "max")}\\right)${u}`;
    case "loguniform":
      return `\\sim \\mathrm{LogUniform}\\left(${n(d.min, "min")},\\ ${n(d.max, "max")}\\right)${u}`;
    case "normal":
      return `\\sim \\mathrm{Normal}\\left(\\mu{=}${n(d.mu, "mu")},\\ \\sigma{=}${n(d.sigma, "sigma")}\\right)${u}`;
    case "lognormal":
      return `\\sim \\mathrm{LogNormal}\\left(\\mu{=}${n(d.mu, "mu")},\\ \\sigma{=}${n(d.sigma, "sigma")}\\right)${u}`;
    case "beta":
      return `\\sim \\mathrm{Beta}\\left(${n(d.alpha, "alpha")},\\ ${n(d.beta, "beta")}\\right)`;
    case "bernoulli":
      return `\\sim \\mathrm{Bernoulli}\\left(${n(d.p, "p")}\\right)`;
    case "triangular":
      return `\\sim \\mathrm{Triangular}\\left(${n(d.min, "min")},\\ ${n(d.mode, "mode")},\\ ${n(d.max, "max")}\\right)${u}`;
    case "pert":
      return `\\sim \\mathrm{PERT}\\left(${n(d.min, "min")},\\ ${n(d.mode, "mode")},\\ ${n(d.max, "max")}\\right)${u}`;
    case "categorical": {
      // Probabilities must sum to one, so they are not offered one at a time.
      if (d.labels.length > 4) return `\\sim \\text{one of ${d.labels.length} labels}`;
      const total = d.probs.reduce((s, p) => s + p, 0) || 1;
      const items = d.labels.map((l, i) => `\\text{${texText(l)}}{:}\\,${numTex(d.probs[i] / total)}`);
      return `\\sim \\left\\{${items.join(",\\ ")}\\right\\}`;
    }
    case "percentiles": {
      const parts = [`P_{10}{=}${n(d.p10, "p10")}`];
      if (d.p50 !== undefined) parts.push(`P_{50}{=}${n(d.p50, "p50")}`);
      parts.push(`P_{90}{=}${n(d.p90, "p90")}`);
      return `\\sim \\left(${parts.join(",\\ ")}\\right)${u}`;
    }
  }
}

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

type S = Segment[];

function joinList(items: S[], conj = "and"): S {
  if (items.length === 0) return [];
  if (items.length === 1) return items[0];
  const out: S = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(i === items.length - 1 ? ` ${conj} ` : ", ");
    out.push(...item);
  });
  return out;
}

function v(name: string, vars: ReadonlyMap<string, number>): Segment {
  return { var: name, index: vars.get(name) ?? 0 };
}

const BIN_WORDS: Record<BinOp, string> = {
  "+": " plus ",
  "-": " minus ",
  "*": " times ",
  "/": " divided by ",
  "^": " to the power ",
  "<": " is less than ",
  "<=": " is at most ",
  ">": " is more than ",
  ">=": " is at least ",
  "==": " equals ",
  "!=": " differs from ",
  and: " and ",
  or: " or ",
};

/** A condition read as a clause: a bare boolean variable becomes "x is true". */
function condWords(ast: ExprAst, c: Ctx): S {
  if (ast.t === "var") return [v(ast.name, c.vars), " is true"];
  if (ast.t === "un" && ast.op === "not" && ast.x.t === "var") return [v(ast.x.name, c.vars), " is false"];
  return exprWords(ast, c);
}

function exprWords(ast: ExprAst, c: Ctx, ctx = 0): S {
  const own = precOf(ast);
  const wrap = (s: S): S => (own < ctx ? ["(", ...s, ")"] : s);
  switch (ast.t) {
    case "num":
      return [fmt(ast.v)];
    case "var":
      return [v(ast.name, c.vars)];
    case "un":
      if (ast.op === "neg") return wrap(["negative ", ...exprWords(ast.x, c, PREC.neg)]);
      return wrap(["not ", ...exprWords(ast.x, c, PREC.not)]);
    case "bin": {
      if (ast.op === "^" && ast.r.t === "num") {
        if (ast.r.v === 2) return wrap([...exprWords(ast.l, c, ATOM), " squared"]);
        if (ast.r.v === 3) return wrap([...exprWords(ast.l, c, ATOM), " cubed"]);
        if (ast.r.v === 0.5) return wrap(["the square root of ", ...exprWords(ast.l, c, ATOM)]);
      }
      const rightCtx = ast.op === "-" || ast.op === "/" ? own + 1 : own;
      return wrap([...exprWords(ast.l, c, own), BIN_WORDS[ast.op], ...exprWords(ast.r, c, rightCtx)]);
    }
    case "fn":
      return fnWords(ast, c);
  }
}

function fnWords(ast: Extract<ExprAst, { t: "fn" }>, c: Ctx): S {
  const args = ast.args;
  const a = (i: number): S => exprWords(args[i], c, 0);
  const all = () => joinList(args.map((_, i) => a(i)));
  switch (ast.name) {
    case "log":
    case "ln":
      return ["the natural log of ", ...a(0)];
    case "log10":
      return ["the base-10 log of ", ...a(0)];
    case "log2":
      return ["the base-2 log of ", ...a(0)];
    case "exp":
      return ["e raised to ", ...a(0)];
    case "sqrt":
      return ["the square root of ", ...a(0)];
    case "abs":
      return ["the size of ", ...a(0)];
    case "pow":
      return [...exprWords(args[0], c, ATOM), " to the power ", ...exprWords(args[1], c, ATOM)];
    case "floor":
      return [...a(0), " rounded down"];
    case "ceil":
      return [...a(0), " rounded up"];
    case "round":
      return [...a(0), " rounded to the nearest whole number"];
    case "clamp":
      return [...a(0), " held between ", ...a(1), " and ", ...a(2)];
    case "min":
      return [args.length === 2 ? "the smaller of " : "the smallest of ", ...all()];
    case "max":
      return [args.length === 2 ? "the larger of " : "the largest of ", ...all()];
    case "if":
      return [...a(1), " if ", ...condWords(args[0], c), ", otherwise ", ...a(2)];
    case "logit":
      return ["the log-odds of ", ...a(0)];
    case "inv_logit":
      return ["the probability whose log-odds is ", ...a(0)];
    case "odds":
      return ["the odds of ", ...a(0)];
    case "prob":
      return ["the probability with odds ", ...a(0)];
    case "cdf":
      return ["the chance that ", ...a(0), " is at most ", ...a(1)];
    case "prob_lt":
      return ["the chance that ", ...a(0), " is below ", ...a(1)];
    case "prob_gt":
      return ["the chance that ", ...a(0), " is above ", ...a(1)];
    case "quantile": {
      const p = args[1];
      if (p.t === "num") return [`the ${ordinalPercent(p.v)} percentile of `, ...a(0)];
      return ["the ", ...a(1), " quantile of ", ...a(0)];
    }
  }
}

function ordinalPercent(p: number): string {
  const n = Math.round(p * 100);
  if (Math.abs(n - p * 100) > 1e-9) return fmt(p * 100) + "th";
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function distWords(d: Dist, unit?: string): S {
  const q = (x: number) => withUnit(x, unit);
  switch (d.dist) {
    case "point":
      return [`fixed at ${q(d.value)}`];
    case "uniform":
      return [`anywhere from ${q(d.min)} to ${q(d.max)}, every value equally likely`];
    case "loguniform":
      return [`from ${q(d.min)} to ${q(d.max)}, every factor of ten equally likely`];
    case "normal":
      return [`a bell curve centred on ${q(d.mu)}, give or take ${q(d.sigma)}`];
    case "lognormal": {
      const med = Math.exp(d.mu);
      const f = Math.exp(d.sigma);
      return [`skewed right, median ${q(med)}, typically within a factor of ${fmt(f)} either way`];
    }
    case "beta":
      return [`a probability averaging ${fmtPct(d.alpha / (d.alpha + d.beta))}`];
    case "bernoulli":
      return [`true with probability ${fmtPct(d.p)}`];
    case "triangular":
    case "pert":
      return [`between ${q(d.min)} and ${q(d.max)}, most likely ${q(d.mode)}`];
    case "categorical": {
      const total = d.probs.reduce((s, p) => s + p, 0) || 1;
      if (d.labels.length > 6) return [`one of ${d.labels.length} labels`];
      return [
        "one of ",
        ...joinList(
          d.labels.map((l, i) => [`${l} (${fmtPct(d.probs[i] / total)})`]),
          "or",
        ),
      ];
    }
    case "percentiles": {
      const parts = [`10% chance below ${q(d.p10)}`];
      if (d.p50 !== undefined) parts.push(`median ${q(d.p50)}`);
      parts.push(`10% chance above ${q(d.p90)}`);
      return [parts.join(", ")];
    }
  }
}

// ---------------------------------------------------------------------------
// Per node kind
// ---------------------------------------------------------------------------

export function describeNode(node: AnyNode, byId: ReadonlyMap<string, AnyNode>): NodeDescription {
  const order = inputOrder(node);
  const vars = new Map(order.map((id, i) => [id, i]));
  const inputs: InputRef[] = order.map((id, index) => ({ id, index, title: byId.get(id)?.title }));
  const slots: EditableSlot[] = [];
  const self = selfTex(node.id);
  const V = (id: string) => varTex(id, vars.get(id) ?? 0);
  const W = (id: string) => v(id, vars);
  const done = (latex: string | null, english: Segment[]): NodeDescription => ({ latex, english, inputs, slots });

  /** Register an editable number and return its typeset form. */
  const slot = (value: number, label: string, apply: (text: string) => AnyNode): string => {
    slots.push({ value, label, apply });
    return `\\htmlClass{eq-num nodrag}{\\htmlData{slot=${slots.length - 1}}{${numTex(value)}}}`;
  };
  /** Dist parameters become slots that rewrite one key of `d` through `put`. */
  const distNum =
    (d: Dist, put: (next: Dist) => AnyNode): DistNum =>
    (value, key) =>
      slot(value, key, (text) => put({ ...d, [key]: Number(text) } as Dist));
  /** Expression literals become slots that splice the typed text into the source. */
  const exprCtx = (expr: string, put: (nextExpr: string) => AnyNode): Ctx => ({
    vars,
    num: (n) =>
      n.src
        ? slot(n.v, "coefficient", (text) => put(expr.slice(0, n.src!.pos) + text + expr.slice(n.src!.pos + n.src!.len)))
        : numTex(n.v),
  });

  switch (node.kind) {
    case "prior.dist":
      return done(
        `${self} ${distTex(node.dist, node.unit, distNum(node.dist, (dist) => ({ ...node, dist })))}`,
        distWords(node.dist, node.unit),
      );
    case "prior.sourced": {
      const d = node.resolved?.dist ?? node.fallback;
      const n: DistNum = node.resolved
        ? (value) => numTex(value) // live values come from the source; edit the fallback in the editor
        : distNum(d, (fallback) => ({ ...node, fallback }));
      const tail = node.resolved
        ? ` (from ${node.source.connector})`
        : ` (fallback until ${node.source.connector} is connected)`;
      return done(`${self} ${distTex(d, node.unit, n)}`, [...distWords(d, node.unit), tail]);
    }
    case "prior.pooled": {
      const op = node.method === "logodds" ? "\\operatorname{pool}_{\\text{log-odds}}" : "\\operatorname{blend}";
      const words =
        node.method === "logodds"
          ? ["the log-odds average of ", ...joinList(node.inputs.map((id) => [W(id)]))]
          : ["a weighted blend of ", ...joinList(node.inputs.map((id) => [W(id)]))];
      return done(`${self} = ${op}\\left(${node.inputs.map(V).join(",\\ ")}\\right)`, words);
    }
    case "cond.cpt":
      return done(`P\\left(${self} \\mid ${node.parents.map(V).join(",\\ ")}\\right)`, [
        `the chance of ${joinList(node.labels.map((l) => [l]), "or").join("")} given `,
        ...joinList(node.parents.map((id) => [W(id)])),
        ` (a ${node.rows.length}-row table)`,
      ]);
    case "cond.mixture": {
      const entries = Object.entries(node.cases);
      const on = V(node.on);
      let latex: string;
      if (entries.length <= 4) {
        const rows = entries
          .map(([label, d]) => {
            const n = distNum(d, (next) => ({ ...node, cases: { ...node.cases, [label]: next } }));
            const body = distTex(d, node.unit, n).replace(/^(\\sim|=)\s*/, "");
            return `${body} & \\text{if } ${on} = \\text{${texText(label)}}`;
          })
          .join(" \\\\ ");
        latex = `${self} \\sim \\begin{cases} ${rows} \\end{cases}`;
      } else {
        latex = `${self} \\sim \\text{one of ${entries.length} distributions, chosen by } ${on}`;
      }
      const words: S = [];
      entries.forEach(([label, d], i) => {
        if (i > 0) words.push("; ");
        words.push("when ", W(node.on), ` is ${label}: `, ...distWords(d, node.unit));
      });
      return done(latex, words);
    }
    case "formula":
    case "utility": {
      let ast: ExprAst;
      try {
        ast = parseExprAst(node.expr);
      } catch (e) {
        return { latex: null, english: [], inputs, slots, error: e instanceof Error ? e.message : String(e) };
      }
      const c = exprCtx(node.expr, (expr) => ({ ...node, expr }));
      let latex = exprTex(ast, c);
      let words = exprWords(ast, c);
      if (node.kind === "utility" && node.transform && node.transform.type !== "linear") {
        if (node.transform.type === "log") {
          latex = `\\ln\\left(${latex}\\right)`;
          words = ["the natural log of ", ...(precOf(ast) < ATOM ? ["(", ...words, ")"] : words)];
        } else {
          const gamma = node.transform.gamma;
          const g = slot(gamma, "risk aversion γ", (text) => ({
            ...node,
            transform: { type: "crra", gamma: Number(text) },
          }));
          latex = `\\frac{\\left(${latex}\\right)^{1-${g}} - 1}{1-${g}}`;
          words = [`CRRA utility (risk aversion ${fmt(gamma)}) of `, ...words];
        }
      }
      return done(`${self} = ${latex}`, words);
    }
    case "comparator": {
      const x = V(node.input);
      const xw = W(node.input);
      if (node.op === "between") {
        const lo = node.low ?? 0;
        const hi = node.high ?? 0;
        const loT = slot(lo, "lower bound", (text) => ({ ...node, low: Number(text) }));
        const hiT = slot(hi, "upper bound", (text) => ({ ...node, high: Number(text) }));
        return done(`${self} = \\left[\\, ${loT} \\le ${x} \\le ${hiT} \\,\\right]`, [
          "true when ",
          xw,
          ` is between ${fmt(lo)} and ${fmt(hi)}`,
        ]);
      }
      const value = node.value ?? 0;
      const vT = slot(value, "threshold", (text) => ({ ...node, value: Number(text) }));
      const op = node.op as BinOp;
      return done(`${self} = \\left[\\, ${x}${BIN_TEX[op]}${vT} \\,\\right]`, ["true when ", xw, BIN_WORDS[op], fmt(value)]);
    }
    case "logic": {
      const xs = node.inputs.map(V);
      const ws = node.inputs.map((id) => [W(id)] as S);
      switch (node.op) {
        case "and":
          return done(`${self} = ${xs.join(" \\land ")}`, [
            "true when ",
            ...joinList(ws),
            xs.length > 1 ? " are all true" : " is true",
          ]);
        case "or":
          return done(`${self} = ${xs.join(" \\lor ")}`, ["true when ", ...joinList(ws, "or"), " is true"]);
        case "not":
          return done(`${self} = \\lnot ${xs[0]}`, ["true when ", ...ws[0], " is false"]);
        case "k_of_n": {
          const k = node.k ?? 1;
          const kT = slot(k, "how many must be true", (text) => ({ ...node, k: Number(text) }));
          return done(`${self} = \\left[\\, ${xs.join(" + ")} \\ge ${kT} \\,\\right]`, [
            `true when at least ${k} of `,
            ...joinList(ws),
            " are true",
          ]);
        }
      }
      break;
    }
    case "evidence": {
      const valueT =
        typeof node.value === "number"
          ? slot(node.value, "observed value", (text) => ({ ...node, value: Number(text) }))
          : `\\text{${texText(node.value)}}`;
      return done(`${V(node.target)} = ${valueT}`, [
        W(node.target),
        ` is observed to be ${node.value}`,
        node.enabled ? "" : " (disabled)",
      ]);
    }
    case "decision":
      return done(null, []);
    case "output":
      return done(`${self} = ${V(node.target)}`, ["reports ", W(node.target)]);
  }
  return done(null, []);
}
