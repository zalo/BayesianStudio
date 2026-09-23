import { describe, expect, it } from "vitest";
import { runInference } from "../src/index.js";

const N = 20_000;

function doc(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    meta: { title: "test", seed: 7, samples: N },
    nodes,
    ...extra,
  };
}

const prior = (id: string, dist: Record<string, unknown>) => ({ id, kind: "prior.dist", dist });

describe("distribution sampling (analytic checks)", () => {
  it("normal(3, 2) has the right mean and sd", () => {
    const r = runInference(doc([prior("x", { dist: "normal", mu: 3, sigma: 2 })]));
    expect(r.nodes.x.summary.mean).toBeCloseTo(3, 1);
    expect(r.nodes.x.summary.sd).toBeCloseTo(2, 1);
  });

  it("beta(2, 5) has mean 2/7", () => {
    const r = runInference(doc([prior("x", { dist: "beta", alpha: 2, beta: 5 })]));
    expect(Math.abs(r.nodes.x.summary.mean - 2 / 7)).toBeLessThan(0.01);
    expect(r.nodes.x.summary.min).toBeGreaterThanOrEqual(0);
    expect(r.nodes.x.summary.max).toBeLessThanOrEqual(1);
  });

  it("lognormal(mu=1, sigma=0.5) has median e", () => {
    const r = runInference(doc([prior("x", { dist: "lognormal", mu: 1, sigma: 0.5 })]));
    expect(Math.abs(r.nodes.x.summary.quantiles.p50 - Math.E)).toBeLessThan(0.08);
  });

  it("bernoulli(0.3) reports probTrue ≈ 0.3 and labels", () => {
    const r = runInference(doc([prior("x", { dist: "bernoulli", p: 0.3 })]));
    expect(r.nodes.x.labels).toEqual(["false", "true"]);
    expect(Math.abs(r.nodes.x.summary.probTrue! - 0.3)).toBeLessThan(0.015);
  });

  it("loguniform(10, 1000) has median 100 (geometric mean)", () => {
    const r = runInference(doc([prior("x", { dist: "loguniform", min: 10, max: 1000 })]));
    expect(Math.abs(Math.log(r.nodes.x.summary.quantiles.p50) - Math.log(100))).toBeLessThan(0.06);
  });

  it("pert(0, 10, 20) is symmetric around 10", () => {
    const r = runInference(doc([prior("x", { dist: "pert", min: 0, mode: 10, max: 20 })]));
    expect(Math.abs(r.nodes.x.summary.mean - 10)).toBeLessThan(0.15);
  });

  it("triangular(0, 1, 4) has mean 5/3", () => {
    const r = runInference(doc([prior("x", { dist: "triangular", min: 0, mode: 1, max: 4 })]));
    expect(Math.abs(r.nodes.x.summary.mean - 5 / 3)).toBeLessThan(0.05);
  });

  it("categorical respects probabilities", () => {
    const r = runInference(
      doc([prior("x", { dist: "categorical", labels: ["a", "b", "c"], probs: [0.5, 0.3, 0.2] })]),
    );
    const cat = r.nodes.x.summary.categorical!;
    expect(cat.labels).toEqual(["a", "b", "c"]);
    expect(Math.abs(cat.probs[0] - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(cat.probs[1] - 0.3)).toBeLessThan(0.02);
  });
});

describe("structural nodes", () => {
  it("formula over point priors is exact", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "point", value: 3 }),
        prior("b", { dist: "point", value: 4 }),
        { id: "c", kind: "formula", expr: "sqrt(a^2 + b^2)" },
      ]),
    );
    expect(r.nodes.c.summary.mean).toBe(5);
    expect(r.nodes.c.summary.sd).toBe(0);
  });

  it("formula precedence and unary minus", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "point", value: 2 }),
        { id: "f1", kind: "formula", expr: "a + 3 * 4" },
        { id: "f2", kind: "formula", expr: "2 ^ 3 ^ 2" },
        { id: "f3", kind: "formula", expr: "-a + 5" },
        { id: "f4", kind: "formula", expr: "min(a, 1, 7) + max(3, a)" },
        { id: "f5", kind: "formula", expr: "clamp(a * 10, 0, 15)" },
      ]),
    );
    expect(r.nodes.f1.summary.mean).toBe(14);
    expect(r.nodes.f2.summary.mean).toBe(512); // right-associative
    expect(r.nodes.f3.summary.mean).toBe(3);
    expect(r.nodes.f4.summary.mean).toBe(4);
    expect(r.nodes.f5.summary.mean).toBe(15);
  });

  it("if() does piecewise arithmetic driven by a comparator", () => {
    const r = runInference(
      doc([
        prior("u", { dist: "uniform", min: 0, max: 1 }),
        { id: "high", kind: "comparator", input: "u", op: ">", value: 0.5 },
        // piecewise: 100 when u > 0.5, else -10; E = 0.5*100 + 0.5*(-10) = 45
        { id: "payout", kind: "formula", expr: "if(high, 100, -10)" },
      ]),
    );
    expect(Math.abs(r.nodes.payout.summary.mean - 45)).toBeLessThan(1.5);
    expect(r.nodes.payout.summary.min).toBe(-10);
    expect(r.nodes.payout.summary.max).toBe(100);
  });

  it("comparator on uniform(0,1) > 0.25 gives P ≈ 0.75", () => {
    const r = runInference(
      doc([
        prior("u", { dist: "uniform", min: 0, max: 1 }),
        { id: "hit", kind: "comparator", input: "u", op: ">", value: 0.25 },
      ]),
    );
    expect(Math.abs(r.nodes.hit.summary.probTrue! - 0.75)).toBeLessThan(0.015);
  });

  it("comparator between", () => {
    const r = runInference(
      doc([
        prior("u", { dist: "uniform", min: 0, max: 10 }),
        { id: "mid", kind: "comparator", input: "u", op: "between", low: 2, high: 4 },
      ]),
    );
    expect(Math.abs(r.nodes.mid.summary.probTrue! - 0.2)).toBeLessThan(0.015);
  });

  it("logic and / or / not / k_of_n", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "bernoulli", p: 0.5 }),
        prior("b", { dist: "bernoulli", p: 0.5 }),
        prior("c", { dist: "bernoulli", p: 0.5 }),
        { id: "both", kind: "logic", op: "and", inputs: ["a", "b"] },
        { id: "either", kind: "logic", op: "or", inputs: ["a", "b"] },
        { id: "nota", kind: "logic", op: "not", inputs: ["a"] },
        { id: "twoOf", kind: "logic", op: "k_of_n", inputs: ["a", "b", "c"], k: 2 },
      ]),
    );
    expect(Math.abs(r.nodes.both.summary.probTrue! - 0.25)).toBeLessThan(0.02);
    expect(Math.abs(r.nodes.either.summary.probTrue! - 0.75)).toBeLessThan(0.02);
    expect(Math.abs(r.nodes.nota.summary.probTrue! - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(r.nodes.twoOf.summary.probTrue! - 0.5)).toBeLessThan(0.02);
  });

  it("mixture switches on a discrete parent", () => {
    const r = runInference(
      doc([
        prior("success", { dist: "bernoulli", p: 0.5 }),
        {
          id: "payoff",
          kind: "cond.mixture",
          on: "success",
          cases: {
            true: { dist: "point", value: 10 },
            false: { dist: "point", value: 0 },
          },
        },
      ]),
    );
    expect(Math.abs(r.nodes.payoff.summary.mean - 5)).toBeLessThan(0.2);
  });

  it("cpt marginalizes correctly (rain → sprinkler)", () => {
    const r = runInference(
      doc([
        prior("rain", { dist: "bernoulli", p: 0.3 }),
        {
          id: "sprinkler",
          kind: "cond.cpt",
          parents: ["rain"],
          labels: ["false", "true"],
          rows: [
            { when: ["true"], probs: [0.9, 0.1] },
            { when: ["false"], probs: [0.5, 0.5] },
          ],
        },
      ]),
    );
    // P(sprinkler) = 0.3*0.1 + 0.7*0.5 = 0.38
    expect(Math.abs(r.nodes.sprinkler.summary.probTrue! - 0.38)).toBeLessThan(0.015);
  });

  it("cpt wildcard rows act as catch-alls", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "bernoulli", p: 0.5 }),
        prior("b", { dist: "bernoulli", p: 0.5 }),
        {
          id: "c",
          kind: "cond.cpt",
          parents: ["a", "b"],
          labels: ["false", "true"],
          rows: [
            { when: ["true", "true"], probs: [0, 1] },
            { when: ["*", "*"], probs: [1, 0] },
          ],
        },
      ]),
    );
    expect(Math.abs(r.nodes.c.summary.probTrue! - 0.25)).toBeLessThan(0.02);
  });

  it("pooled linear is a weighted mixture", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "point", value: 0.2 }),
        prior("b", { dist: "point", value: 0.6 }),
        { id: "pool", kind: "prior.pooled", inputs: ["a", "b"], method: "linear" },
      ]),
    );
    expect(Math.abs(r.nodes.pool.summary.mean - 0.4)).toBeLessThan(0.01);
  });

  it("pooled logodds averages in logit space", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "point", value: 0.2 }),
        prior("b", { dist: "point", value: 0.6 }),
        { id: "pool", kind: "prior.pooled", inputs: ["a", "b"], method: "logodds" },
      ]),
    );
    const expected = 1 / (1 + Math.exp(-(Math.log(0.2 / 0.8) + Math.log(0.6 / 0.4)) / 2));
    expect(r.nodes.pool.summary.mean).toBeCloseTo(expected, 6);
  });

  it("sourced priors use resolved when present, fallback otherwise", () => {
    const base = {
      id: "p",
      kind: "prior.sourced",
      source: { connector: "polymarket", config: {} },
      fallback: { dist: "point", value: 0.25 },
    };
    const rFallback = runInference(doc([base]));
    expect(rFallback.nodes.p.summary.mean).toBe(0.25);

    const rResolved = runInference(
      doc([
        {
          ...base,
          resolved: {
            dist: { dist: "point", value: 0.66 },
            fetchedAt: "2026-08-12T00:00:00Z",
            freshness: "fresh",
          },
        },
      ]),
    );
    expect(rResolved.nodes.p.summary.mean).toBeCloseTo(0.66, 9);
  });

  it("output nodes mirror their target", () => {
    const r = runInference(
      doc([
        prior("x", { dist: "point", value: 3 }),
        { id: "headline", kind: "output", target: "x" },
      ]),
    );
    expect(r.nodes.headline.summary.mean).toBe(3);
    expect(r.outputs.headline).toBe("x");
  });
});

describe("determinism and errors", () => {
  it("same seed → identical results; different seed → different draws", () => {
    const d = doc([prior("x", { dist: "normal", mu: 0, sigma: 1 })]);
    const r1 = runInference(d, { seed: 123 });
    const r2 = runInference(d, { seed: 123 });
    const r3 = runInference(d, { seed: 124 });
    expect(r1.nodes.x.summary).toEqual(r2.nodes.x.summary);
    expect(r1.nodes.x.summary.mean).not.toBe(r3.nodes.x.summary.mean);
  });

  it("adding an unrelated node does not perturb an existing node's stream", () => {
    const r1 = runInference(doc([prior("x", { dist: "normal", mu: 0, sigma: 1 })]), { seed: 5 });
    const r2 = runInference(
      doc([prior("aaa_new", { dist: "uniform", min: 0, max: 1 }), prior("x", { dist: "normal", mu: 0, sigma: 1 })]),
      { seed: 5 },
    );
    expect(r2.nodes.x.summary).toEqual(r1.nodes.x.summary);
  });

  it("rejects cyclic documents", () => {
    expect(() =>
      runInference(
        doc([
          { id: "a", kind: "formula", expr: "b + 1" },
          { id: "b", kind: "formula", expr: "a + 1" },
        ]),
      ),
    ).toThrow(/[Cc]ycle/);
  });

  it("rejects unknown references with a readable message", () => {
    expect(() =>
      runInference(doc([{ id: "f", kind: "formula", expr: "missing * 2" }])),
    ).toThrow(/unknown node 'missing'/);
  });

  it("blocks evidence nodes with a Phase-5 pointer instead of failing the run", () => {
    const r = runInference(
      doc([
        prior("x", { dist: "bernoulli", p: 0.5 }),
        { id: "seen", kind: "evidence", target: "x", value: "true" },
      ]),
    );
    expect(r.blocked.seen).toMatch(/Phase 5/);
    expect(r.nodes.x.summary.probTrue).toBeDefined();
  });
});

describe("per-node blocking", () => {
  it("a runtime failure blocks the node and its downstream cone only", () => {
    const r = runInference(
      doc([
        prior("zero", { dist: "point", value: 0 }),
        prior("ok", { dist: "normal", mu: 1, sigma: 0.1 }),
        { id: "bad", kind: "formula", expr: "1 / zero" }, // every sample is ±Infinity
        { id: "worse", kind: "formula", expr: "bad + 1" },
        { id: "fine", kind: "formula", expr: "ok * 2" },
        { id: "head_bad", kind: "output", target: "worse" },
        { id: "head_fine", kind: "output", target: "fine" },
      ]),
    );
    expect(r.blocked.bad).toMatch(/non-finite/);
    expect(r.blocked.worse).toBe("Blocked by upstream 'bad'");
    expect(r.blocked.head_bad).toBe("Blocked by upstream 'worse'");
    expect(r.nodes.bad).toBeUndefined();
    expect(r.nodes.worse).toBeUndefined();
    expect(r.nodes.fine.summary.mean).toBeCloseTo(2, 1);
    expect(r.nodes.head_fine.summary.mean).toBeCloseTo(2, 1);
    expect(r.blocked.fine).toBeUndefined();
  });

  it("a CPT with no matching row blocks itself with the combination named", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "bernoulli", p: 0.5 }),
        {
          id: "c",
          kind: "cond.cpt",
          parents: ["a"],
          labels: ["false", "true"],
          rows: [{ when: ["true"], probs: [0.5, 0.5] }],
        },
      ]),
    );
    expect(r.blocked.c).toMatch(/no row matching parent combination \(false\)/);
    expect(r.nodes.a).toBeDefined();
  });

  it("a blocked utility drops out of the decision analysis; others remain", () => {
    const r = runInference(
      doc([
        prior("zero", { dist: "point", value: 0 }),
        { id: "choice", kind: "decision", alternatives: ["a", "b"] },
        { id: "payout", kind: "formula", expr: "if(choice, 10, 5)" },
        { id: "u_good", kind: "utility", expr: "payout" },
        { id: "u_bad", kind: "utility", expr: "payout / zero" },
      ]),
    );
    expect(r.blocked.u_bad).toBeDefined();
    const ids = r.decisions[0].metrics.map((m) => m.nodeId);
    expect(ids).toEqual(["u_good"]);
  });
});

describe("expression language extensions", () => {
  it("comparisons and boolean words produce 0/1 with float tolerance", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "point", value: 0.1 }),
        prior("b", { dist: "point", value: 0.2 }),
        { id: "sum_eq", kind: "formula", expr: "a + b == 0.3" }, // 0.30000000000000004
        { id: "lt", kind: "formula", expr: "a < b" },
        { id: "ge", kind: "formula", expr: "a >= b" },
        { id: "ne", kind: "formula", expr: "a != b" },
        { id: "both", kind: "formula", expr: "a < b and b < 1" },
        { id: "either", kind: "formula", expr: "a > b or b > a" },
        { id: "neg", kind: "formula", expr: "not a > b" }, // not (a > b)
        { id: "mixed", kind: "formula", expr: "not a > b and b > a" }, // (not (a>b)) and (b>a)
        { id: "chosen", kind: "formula", expr: "if(a < b, 100, -1)" },
        { id: "consts", kind: "formula", expr: "if(true and not false, 1, 0)" },
      ]),
    );
    expect(r.nodes.sum_eq.summary.mean).toBe(1);
    expect(r.nodes.lt.summary.mean).toBe(1);
    expect(r.nodes.ge.summary.mean).toBe(0);
    expect(r.nodes.ne.summary.mean).toBe(1);
    expect(r.nodes.both.summary.mean).toBe(1);
    expect(r.nodes.either.summary.mean).toBe(1);
    expect(r.nodes.neg.summary.mean).toBe(1);
    expect(r.nodes.mixed.summary.mean).toBe(1);
    expect(r.nodes.chosen.summary.mean).toBe(100);
    expect(r.nodes.consts.summary.mean).toBe(1);
  });

  it("comparator '==' is tolerant of floating-point noise", () => {
    const r = runInference(
      doc([
        prior("a", { dist: "point", value: 0.1 }),
        { id: "triple", kind: "formula", expr: "a * 3" }, // 0.30000000000000004
        { id: "eq", kind: "comparator", input: "triple", op: "==", value: 0.3 },
      ]),
    );
    expect(r.nodes.eq.summary.probTrue).toBe(1);
  });

  it("logit / inv_logit / odds / prob round-trip and reject out-of-range inputs", () => {
    const r = runInference(
      doc([
        prior("p", { dist: "point", value: 0.8 }),
        { id: "l", kind: "formula", expr: "logit(p)" },
        { id: "back", kind: "formula", expr: "inv_logit(logit(p))" },
        { id: "o", kind: "formula", expr: "odds(p)" },
        { id: "pb", kind: "formula", expr: "prob(odds(p))" },
        { id: "pooled", kind: "formula", expr: "inv_logit((logit(p) + logit(0.5)) / 2)" },
      ]),
    );
    expect(r.nodes.l.summary.mean).toBeCloseTo(Math.log(4), 9);
    expect(r.nodes.back.summary.mean).toBeCloseTo(0.8, 9);
    expect(r.nodes.o.summary.mean).toBeCloseTo(4, 9);
    expect(r.nodes.pb.summary.mean).toBeCloseTo(0.8, 9);
    expect(r.nodes.pooled.summary.mean).toBeCloseTo(1 / (1 + Math.exp(-Math.log(4) / 2)), 9);

    const bad = runInference(
      doc([prior("one", { dist: "point", value: 1 }), { id: "l", kind: "formula", expr: "logit(one)" }]),
    );
    expect(bad.blocked.l).toMatch(/non-finite/);
  });

  it("distribution queries read the whole sample vector", () => {
    const r = runInference(
      doc([
        prior("u", { dist: "uniform", min: 0, max: 10 }),
        prior("thresh", { dist: "point", value: 2.5 }),
        { id: "c", kind: "formula", expr: "cdf(u, 2.5)" },
        { id: "lt", kind: "formula", expr: "prob_lt(u, thresh)" },
        { id: "gt", kind: "formula", expr: "prob_gt(u, 7.5)" },
        { id: "q", kind: "formula", expr: "quantile(u, 0.9)" },
        // Threshold that varies per sample: P(u ≤ v) for v ~ U(0,10) is v/10 → mean 0.5.
        prior("v", { dist: "uniform", min: 0, max: 10 }),
        { id: "varying", kind: "formula", expr: "cdf(u, v)" },
        { id: "bad_p", kind: "formula", expr: "quantile(u, 1.5)" },
      ]),
    );
    expect(r.nodes.c.summary.sd).toBe(0); // a statistic, constant across samples
    expect(Math.abs(r.nodes.c.summary.mean - 0.25)).toBeLessThan(0.015);
    expect(Math.abs(r.nodes.lt.summary.mean - 0.25)).toBeLessThan(0.015);
    expect(Math.abs(r.nodes.gt.summary.mean - 0.25)).toBeLessThan(0.015);
    expect(Math.abs(r.nodes.q.summary.mean - 9)).toBeLessThan(0.1);
    expect(Math.abs(r.nodes.varying.summary.mean - 0.5)).toBeLessThan(0.015);
    expect(r.nodes.varying.summary.sd).toBeGreaterThan(0.2);
    expect(r.blocked.bad_p).toMatch(/non-finite/);
  });
});

describe("percentile-specified priors", () => {
  it("P10/P90 on a positive range fits a lognormal that hits both percentiles", () => {
    const r = runInference(doc([prior("x", { dist: "percentiles", p10: 10, p90: 1000 })]));
    const q = r.nodes.x.summary.quantiles;
    expect(Math.abs(Math.log(q.p10) - Math.log(10))).toBeLessThan(0.06);
    expect(Math.abs(Math.log(q.p90) - Math.log(1000))).toBeLessThan(0.06);
    expect(Math.abs(Math.log(q.p50) - Math.log(100))).toBeLessThan(0.05); // geometric midpoint
    expect(r.nodes.x.summary.min).toBeGreaterThan(0);
  });

  it("P10/P90 spanning zero fits a normal with the arithmetic midpoint", () => {
    const r = runInference(doc([prior("x", { dist: "percentiles", p10: -10, p90: 30 })]));
    const q = r.nodes.x.summary.quantiles;
    expect(Math.abs(q.p10 + 10)).toBeLessThan(0.5);
    expect(Math.abs(q.p90 - 30)).toBeLessThan(0.5);
    expect(Math.abs(q.p50 - 10)).toBeLessThan(0.4);
  });

  it("P10/P50/P90 fits a metalog exact at all three, skew included", () => {
    const r = runInference(doc([prior("x", { dist: "percentiles", p10: 1, p50: 2, p90: 8 })]));
    const q = r.nodes.x.summary.quantiles;
    expect(Math.abs(Math.log(q.p10) - Math.log(1))).toBeLessThan(0.05);
    expect(Math.abs(Math.log(q.p50) - Math.log(2))).toBeLessThan(0.04);
    expect(Math.abs(Math.log(q.p90) - Math.log(8))).toBeLessThan(0.05);
    expect(r.nodes.x.summary.min).toBeGreaterThan(0);
    expect(r.nodes.x.summary.mean).toBeGreaterThan(q.p50); // right-skewed
  });

  it("rejects a median outside the feasible band with guidance", () => {
    expect(() => runInference(doc([prior("x", { dist: "percentiles", p10: 0, p50: 1, p90: 100 })]))).toThrow(
      /too close to P10\/P90/,
    );
    expect(() => runInference(doc([prior("x", { dist: "percentiles", p10: 5, p90: 1 })]))).toThrow(
      /P10 must be less than P90/,
    );
  });
});

describe("decision layer", () => {
  it("compares expected utility per alternative with conditional means", () => {
    const r = runInference(
      doc([
        prior("success", { dist: "bernoulli", p: 0.3 }),
        {
          id: "risky_payoff",
          kind: "cond.mixture",
          on: "success",
          cases: { true: { dist: "point", value: 20 }, false: { dist: "point", value: 0 } },
        },
        { id: "take_risk", kind: "decision", title: "Take the risky bet?", alternatives: ["pass", "take"] },
        { id: "payout", kind: "formula", expr: "if(take_risk, risky_payoff, 5)" },
        { id: "payout_utility", kind: "utility", expr: "payout" },
        { id: "headline", kind: "output", target: "payout" },
        // Not downstream of the decision → must not appear as a metric.
        { id: "unrelated", kind: "output", target: "success" },
      ]),
    );
    expect(r.decisions).toHaveLength(1);
    const analysis = r.decisions[0];
    expect(analysis.decisionId).toBe("take_risk");
    expect(analysis.alternatives).toEqual(["pass", "take"]);
    expect(analysis.metrics.map((m) => m.nodeId).sort()).toEqual(["payout", "payout_utility"]);
    // utility + the output target (same underlying samples, two metrics)
    const util = analysis.metrics.find((m) => m.kind === "utility")!;
    const pass = util.perAlternative.find((a) => a.label === "pass")!;
    const take = util.perAlternative.find((a) => a.label === "take")!;
    expect(pass.mean).toBe(5); // deterministic branch
    expect(Math.abs(take.mean - 6)).toBeLessThan(0.35); // E = 0.3·20 = 6
    expect(util.best).toBe("take");
    // roughly half the samples land in each partition
    expect(pass.n + take.n).toBe(r.sampleCount);
    expect(Math.abs(pass.n - take.n)).toBeLessThan(r.sampleCount * 0.05);
  });

  it("applies utility transforms (log and CRRA)", () => {
    const r = runInference(
      doc([
        prior("w", { dist: "point", value: Math.E }),
        { id: "u_log", kind: "utility", expr: "w", transform: { type: "log" } },
        { id: "u_crra", kind: "utility", expr: "w", transform: { type: "crra", gamma: 2 } },
      ]),
    );
    expect(r.nodes.u_log.summary.mean).toBeCloseTo(1, 9);
    // CRRA γ=2: (w^-1 − 1)/(−1) = 1 − 1/w
    expect(r.nodes.u_crra.summary.mean).toBeCloseTo(1 - 1 / Math.E, 9);
  });

  it("no decision nodes → empty analysis", () => {
    const r = runInference(doc([prior("x", { dist: "point", value: 1 })]));
    expect(r.decisions).toEqual([]);
  });
});
