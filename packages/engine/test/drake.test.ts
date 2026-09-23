import { describe, expect, it } from "vitest";
import { runInference } from "../src/index.js";
import drake from "../../../examples/drake.json";

/**
 * Golden test — Phase 0 exit criterion.
 *
 * All seven Drake priors are log-uniform, so ln(N) is a sum of independent
 * uniforms. That gives closed forms to test against:
 *   - median(N) = Π geometric-mean(lo, hi)  (symmetric summands in log space)
 *   - P(N < 1) ≈ Φ(-μ/σ) with μ = Σ ln(gm), σ² = Σ ln(hi/lo)²/12
 *   - mean(N)  = Π (hi-lo)/ln(hi/lo), enormously larger than the median
 */
describe("Drake equation golden test", () => {
  const ranges: [number, number][] = [
    [1, 100], // R*
    [0.1, 1], // f_p
    [0.1, 10], // n_e
    [0.001, 1], // f_l
    [0.001, 1], // f_i
    [0.01, 0.2], // f_c
    [100, 1e10], // L
  ];
  const expectedLogMedian = ranges.reduce((acc, [lo, hi]) => acc + (Math.log(lo) + Math.log(hi)) / 2, 0);
  const logVariance = ranges.reduce((acc, [lo, hi]) => acc + Math.log(hi / lo) ** 2 / 12, 0);

  const result = runInference(drake);

  it("evaluates all nodes in a valid topological order", () => {
    expect(result.order.indexOf("N")).toBeGreaterThan(result.order.indexOf("R_star"));
    expect(result.order.indexOf("alone")).toBeGreaterThan(result.order.indexOf("N"));
    expect(Object.keys(result.nodes)).toContain("N");
  });

  it("derives N's unit by cancellation: stars/yr · planets/star · civs/planet · yr → civilizations", () => {
    expect(result.nodes.N.unit).toBe("civilizations");
    expect(result.nodes.R_star.unit).toBe("stars/yr");
    expect(result.nodes.L.unit).toBe("yr");
    expect(result.nodes.alone.unit).toBeUndefined(); // booleans are dimensionless
    expect(result.nodes.result.unit).toBe("civilizations"); // output mirrors target
  });

  it("median of N matches the analytic product of medians (~141)", () => {
    const median = result.nodes.N.summary.quantiles.p50;
    expect(Math.abs(Math.log(median) - expectedLogMedian)).toBeLessThan(0.2);
    // Sanity on the absolute number so a broken analytic expectation can't hide.
    expect(median).toBeGreaterThan(90);
    expect(median).toBeLessThan(220);
  });

  it("P(alone) — i.e. P(N < 1) — is sizable despite the huge mean", () => {
    const pAlone = result.nodes.alone.summary.probTrue!;
    const z = -expectedLogMedian / Math.sqrt(logVariance);
    // Normal approximation of the sum of 7 uniforms is good here (~0.22).
    const phi = 0.5 * (1 + erf(z / Math.SQRT2));
    expect(Math.abs(pAlone - phi)).toBeLessThan(0.03);
    expect(pAlone).toBeGreaterThan(0.15);
  });

  it("mean of N dwarfs the median (the Fermi-paradox dissolution)", () => {
    const { mean, quantiles } = result.nodes.N.summary;
    expect(mean).toBeGreaterThan(100 * quantiles.p50);
  });

  it("is reproducible: doc seed pins the exact result", () => {
    const again = runInference(drake);
    expect(again.nodes.N.summary).toEqual(result.nodes.N.summary);
    expect(again.nodes.alone.summary.probTrue).toBe(result.nodes.alone.summary.probTrue);
  });
});

/** Abramowitz–Stegun erf approximation (max error ~1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
