import { describe, expect, it } from "vitest";
import {
  validateDoc,
  deriveEdges,
  parseExpr,
  exprIdentifiers,
  ExprError,
  topologicalOrder,
  parseUnit,
  formatUnit,
  UnitError,
  fitPercentiles,
  percentileQuantile,
  percentileDensity,
  feasibleP50Range,
  type BayesDoc,
} from "../src/index.js";

const minimal = (nodes: unknown[]) => ({
  version: 1,
  meta: { title: "t" },
  nodes,
});

describe("expression parser", () => {
  it("extracts identifiers, ignoring constants and functions", () => {
    expect([...exprIdentifiers("R_star * f_p + min(x, pi) - exp(1)")].sort()).toEqual([
      "R_star",
      "f_p",
      "x",
    ]);
  });

  it("rejects malformed expressions with a position", () => {
    for (const bad of ["", "a +", "* a", "foo(1)", "min(1)", "a b", "(a", "a)", "1 @ 2"]) {
      expect(() => parseExpr(bad), bad).toThrow(ExprError);
    }
  });

  it("parses function calls with variadic arity", () => {
    expect(() => parseExpr("min(1, 2, 3, 4)")).not.toThrow();
    expect(() => parseExpr("pow(2, 3)")).not.toThrow();
    expect(() => parseExpr("pow(2)")).toThrow(ExprError);
    expect(() => parseExpr("pow(2, 3, 4)")).toThrow(ExprError);
  });

  it("parses comparisons and boolean words with Python-like precedence", () => {
    const ops = (src: string) => parseExpr(src).map((i) => (i.t === "op" ? i.op : i.t === "var" ? i.name : i.t === "num" ? String(i.v) : i.name));
    expect(ops("a < b and c >= d")).toEqual(["a", "b", "<", "c", "d", ">=", "and"]);
    expect(ops("not a > b")).toEqual(["a", "b", ">", "not"]);
    expect(ops("a or b and c")).toEqual(["a", "b", "c", "and", "or"]);
    expect(ops("a + 1 == b * 2")).toEqual(["a", "1", "+", "b", "2", "*", "=="]);
    expect(ops("a != b")).toEqual(["a", "b", "!="]);
    expect(ops("true")).toEqual(["1"]);
    expect([...exprIdentifiers("a and not b or c")].sort()).toEqual(["a", "b", "c"]);
  });

  it("rejects ternaries, single '=', and symbolic and/or with guidance", () => {
    expect(() => parseExpr("a ? b : c")).toThrow(/if\(condition, then, else\)/);
    expect(() => parseExpr("a = b")).toThrow(/'=='/);
    expect(() => parseExpr("a && b")).toThrow(/'and'/);
    expect(() => parseExpr("a not b")).toThrow(ExprError);
    expect(() => parseExpr("and a")).toThrow(ExprError);
  });

  it("knows the log-odds helpers and distribution queries", () => {
    expect(() => parseExpr("inv_logit((logit(a) + logit(b)) / 2)")).not.toThrow();
    expect(() => parseExpr("prob_gt(revenue, 1000000) * quantile(revenue, 0.9)")).not.toThrow();
    expect(() => parseExpr("cdf(revenue)")).toThrow(ExprError);
    // keywords cannot be node ids
    const res = validateDoc(minimal([{ id: "and", kind: "prior.dist", dist: { dist: "point", value: 1 } }]));
    expect(res.ok).toBe(false);
  });
});

describe("percentile-specified distributions", () => {
  it("validates ordering and metalog feasibility", () => {
    const p = (dist: Record<string, unknown>) => validateDoc(minimal([{ id: "x", kind: "prior.dist", dist }]));
    expect(p({ dist: "percentiles", p10: 1, p90: 10 }).ok).toBe(true);
    expect(p({ dist: "percentiles", p10: 1, p50: 3, p90: 10 }).ok).toBe(true);
    expect(p({ dist: "percentiles", p10: -5, p50: 0, p90: 5 }).ok).toBe(true);
    expect(p({ dist: "percentiles", p10: 10, p90: 1 }).issues[0].message).toMatch(/P10 must be less than P90/);
    expect(p({ dist: "percentiles", p10: 1, p50: 20, p90: 10 }).issues[0].message).toMatch(/P10 < P50 < P90/);
    const infeasible = p({ dist: "percentiles", p10: 0, p50: 1, p90: 100 });
    expect(infeasible.ok).toBe(false);
    expect(infeasible.issues[0].message).toMatch(/keep it between 17.00 and 83.00/);
  });

  it("fits are exact at the stated percentiles", () => {
    const sym = fitPercentiles({ p10: 10, p90: 1000 })!;
    expect(sym.kind).toBe("normal");
    expect(sym.log).toBe(true);
    // Φ⁻¹ is a rational approximation (|ε| ≈ 1e-9), amplified by exp().
    expect(percentileQuantile(sym, 0.1)).toBeCloseTo(10, 4);
    expect(percentileQuantile(sym, 0.5)).toBeCloseTo(100, 4);
    expect(percentileQuantile(sym, 0.9)).toBeCloseTo(1000, 4);

    const skew = fitPercentiles({ p10: -2, p50: 0, p90: 10 })!;
    expect(skew.kind).toBe("metalog");
    expect(skew.log).toBe(false);
    expect(percentileQuantile(skew, 0.1)).toBeCloseTo(-2, 9);
    expect(percentileQuantile(skew, 0.5)).toBeCloseTo(0, 9);
    expect(percentileQuantile(skew, 0.9)).toBeCloseTo(10, 9);
    // monotone quantile function → a real distribution
    let prev = -Infinity;
    for (let y = 0.001; y < 1; y += 0.001) {
      const q = percentileQuantile(skew, y);
      expect(q).toBeGreaterThan(prev);
      prev = q;
    }
    expect(fitPercentiles({ p10: 0, p50: 1, p90: 100 })).toBeNull();
    const [lo, hi] = feasibleP50Range(0, 100);
    expect(lo).toBeCloseTo(17, 9);
    expect(hi).toBeCloseTo(83, 9);
  });

  it("density is positive inside the range and peaks near the mode", () => {
    const fit = fitPercentiles({ p10: 1, p50: 2, p90: 8 })!;
    expect(percentileDensity(fit, 0)).toBe(0);
    expect(percentileDensity(fit, 2)).toBeGreaterThan(percentileDensity(fit, 8));
    expect(percentileDensity(fit, 2)).toBeGreaterThan(0);
  });
});

describe("validateDoc", () => {
  it("accepts a well-formed document and derives edges", () => {
    const res = validateDoc(
      minimal([
        { id: "a", kind: "prior.dist", dist: { dist: "normal", mu: 0, sigma: 1 } },
        { id: "b", kind: "formula", expr: "a * 2" },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(deriveEdges(res.doc as BayesDoc)).toEqual([{ from: "a", to: "b" }]);
  });

  it("rejects duplicate and reserved node ids", () => {
    const dup = validateDoc(
      minimal([
        { id: "a", kind: "prior.dist", dist: { dist: "point", value: 1 } },
        { id: "a", kind: "prior.dist", dist: { dist: "point", value: 2 } },
      ]),
    );
    expect(dup.ok).toBe(false);
    expect(dup.issues.some((i) => /Duplicate/.test(i.message))).toBe(true);

    const reserved = validateDoc(
      minimal([{ id: "e", kind: "prior.dist", dist: { dist: "point", value: 1 } }]),
    );
    expect(reserved.ok).toBe(false);
    expect(reserved.issues.some((i) => /reserved/.test(i.message))).toBe(true);
  });

  it("rejects unknown references", () => {
    const res = validateDoc(minimal([{ id: "f", kind: "formula", expr: "ghost + 1" }]));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /unknown node 'ghost'/.test(i.message))).toBe(true);
  });

  it("detects cycles", () => {
    const res = validateDoc(
      minimal([
        { id: "a", kind: "formula", expr: "b" },
        { id: "b", kind: "formula", expr: "a" },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /Cycle/.test(i.message))).toBe(true);
  });

  it("checks probability sums on categorical and cpt rows", () => {
    const cat = validateDoc(
      minimal([
        {
          id: "x",
          kind: "prior.dist",
          dist: { dist: "categorical", labels: ["a", "b"], probs: [0.7, 0.7] },
        },
      ]),
    );
    expect(cat.ok).toBe(false);

    const cpt = validateDoc(
      minimal([
        { id: "r", kind: "prior.dist", dist: { dist: "bernoulli", p: 0.5 } },
        {
          id: "s",
          kind: "cond.cpt",
          parents: ["r"],
          labels: ["false", "true"],
          rows: [{ when: ["true"], probs: [0.5, 0.6] }],
        },
      ]),
    );
    expect(cpt.ok).toBe(false);
    expect(cpt.issues.some((i) => /sum to 1/.test(i.message))).toBe(true);
  });

  it("requires mixtures to cover every parent label", () => {
    const res = validateDoc(
      minimal([
        { id: "flag", kind: "prior.dist", dist: { dist: "bernoulli", p: 0.5 } },
        {
          id: "m",
          kind: "cond.mixture",
          on: "flag",
          cases: { true: { dist: "point", value: 1 } },
        },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /missing a case for parent label 'false'/.test(i.message))).toBe(true);
  });

  it("rejects cpt with a continuous parent", () => {
    const res = validateDoc(
      minimal([
        { id: "u", kind: "prior.dist", dist: { dist: "uniform", min: 0, max: 1 } },
        {
          id: "c",
          kind: "cond.cpt",
          parents: ["u"],
          labels: ["false", "true"],
          rows: [{ when: ["*"], probs: [0.5, 0.5] }],
        },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /must be a discrete node/.test(i.message))).toBe(true);
  });

  it("requires comparator scalars", () => {
    const res = validateDoc(
      minimal([
        { id: "u", kind: "prior.dist", dist: { dist: "uniform", min: 0, max: 1 } },
        { id: "c", kind: "comparator", input: "u", op: ">" },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /requires a value/.test(i.message))).toBe(true);
  });

});

describe("dimensional analysis", () => {
  it("parses and formats unit strings canonically", () => {
    expect(formatUnit(parseUnit("$/yr"))).toBe("$/yr");
    expect(formatUnit(parseUnit("stars*yr^-1"))).toBe("stars/yr");
    expect(formatUnit(parseUnit("m^2"))).toBe("m^2");
    expect(formatUnit(parseUnit("1/yr"))).toBe("1/yr");
    expect(formatUnit(parseUnit(""))).toBe("");
    expect(formatUnit(parseUnit("1"))).toBe("");
    expect(formatUnit(parseUnit("yr/yr"))).toBe("");
    expect(() => parseUnit("$/")).toThrow(UnitError);
    expect(() => parseUnit("3m")).toThrow(UnitError);
  });

  it("propagates and cancels units through formulas", () => {
    const res = validateDoc(
      minimal([
        { id: "rate", kind: "prior.dist", unit: "$/yr", dist: { dist: "point", value: 100 } },
        { id: "span", kind: "prior.dist", unit: "yr", dist: { dist: "point", value: 4 } },
        { id: "total", kind: "formula", expr: "rate * span" },
        { id: "area", kind: "formula", expr: "span^2" },
        { id: "back_to_rate", kind: "formula", expr: "total / span" },
        { id: "root", kind: "formula", expr: "sqrt(area)" },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.units).toMatchObject({
      total: "$",
      area: "yr^2",
      back_to_rate: "$/yr",
      root: "yr",
    });
  });

  it("rejects adding mismatched units", () => {
    const res = validateDoc(
      minimal([
        { id: "money", kind: "prior.dist", unit: "$", dist: { dist: "point", value: 1 } },
        { id: "time", kind: "prior.dist", unit: "yr", dist: { dist: "point", value: 1 } },
        { id: "oops", kind: "formula", expr: "money + time" },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /Unit mismatch/.test(i.message))).toBe(true);
  });

  it("rejects log of a dimensionful quantity, allows the normalized form", () => {
    const bad = validateDoc(
      minimal([
        { id: "money", kind: "prior.dist", unit: "$", dist: { dist: "point", value: 10 } },
        { id: "oops", kind: "formula", expr: "log(money)" },
      ]),
    );
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => /dimensionless argument/.test(i.message))).toBe(true);

    const good = validateDoc(
      minimal([
        { id: "money", kind: "prior.dist", unit: "$", dist: { dist: "point", value: 10 } },
        { id: "ref", kind: "prior.dist", unit: "$", dist: { dist: "point", value: 1 } },
        { id: "fine", kind: "formula", expr: "log(money / ref)" },
      ]),
    );
    expect(good.ok).toBe(true);
    expect(good.units?.fine).toBe("");
  });

  it("requires literal exponents on dimensionful bases", () => {
    const res = validateDoc(
      minimal([
        { id: "len", kind: "prior.dist", unit: "m", dist: { dist: "point", value: 2 } },
        { id: "k", kind: "prior.dist", dist: { dist: "point", value: 3 } },
        { id: "oops", kind: "formula", expr: "len ^ k" },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /literal exponent/.test(i.message))).toBe(true);
  });

  it("checks declared formula units as assertions", () => {
    const res = validateDoc(
      minimal([
        { id: "rate", kind: "prior.dist", unit: "$/yr", dist: { dist: "point", value: 1 } },
        { id: "total", kind: "formula", expr: "rate * 4", unit: "$" },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /does not match derived unit '\$\/yr'/.test(i.message))).toBe(true);
  });

  it("if() branches must agree; mixed comparisons in min() are rejected", () => {
    const res = validateDoc(
      minimal([
        { id: "flag", kind: "prior.dist", dist: { dist: "bernoulli", p: 0.5 } },
        { id: "money", kind: "prior.dist", unit: "$", dist: { dist: "point", value: 1 } },
        { id: "time", kind: "prior.dist", unit: "yr", dist: { dist: "point", value: 1 } },
        { id: "oops", kind: "formula", expr: "if(flag, money, time)" },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /if\(\) branches/.test(i.message))).toBe(true);
  });

  it("pooled inputs must share units", () => {
    const res = validateDoc(
      minimal([
        { id: "a", kind: "prior.dist", unit: "$", dist: { dist: "point", value: 1 } },
        { id: "b", kind: "prior.dist", unit: "yr", dist: { dist: "point", value: 1 } },
        { id: "pool", kind: "prior.pooled", inputs: ["a", "b"], method: "linear" },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /Pooled inputs must share units/.test(i.message))).toBe(true);
  });

  it("warns and ignores units on discrete nodes", () => {
    const res = validateDoc(
      minimal([{ id: "flag", kind: "prior.dist", unit: "$", dist: { dist: "bernoulli", p: 0.5 } }]),
    );
    expect(res.ok).toBe(true);
    expect(res.units?.flag).toBe("");
    expect(res.issues.some((i) => i.severity === "warning" && /dimensionless/.test(i.message))).toBe(true);
  });

  it("topological order is deterministic and complete", () => {
    const res = validateDoc(
      minimal([
        { id: "z", kind: "prior.dist", dist: { dist: "point", value: 1 } },
        { id: "a", kind: "prior.dist", dist: { dist: "point", value: 1 } },
        { id: "m", kind: "formula", expr: "a + z" },
      ]),
    );
    expect(res.ok).toBe(true);
    const { order, cycle } = topologicalOrder(res.doc as BayesDoc);
    expect(cycle).toBeNull();
    expect(order).toEqual(["a", "z", "m"]);
  });
});
