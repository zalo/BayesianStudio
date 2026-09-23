/**
 * Percentile-specified distributions: "10% chance it's below P10, 10% chance
 * it's above P90 (and here's my median)". The fit is shared by the engine
 * (sampling) and the studio (curve drawing) so both agree on the shape.
 *
 * - P10/P90 only → symmetric fit: lognormal when the range is strictly
 *   positive (a positive quantity stays positive; the median is the
 *   geometric midpoint), otherwise normal.
 * - P10/P50/P90 → 3-term metalog (Keelin 2016), exact at all three
 *   quantiles and smooth in between. Fitted in log space when P10 > 0 so the
 *   result stays positive. A metalog is only a valid distribution when the
 *   median sits inside the middle two-thirds of the P10–P90 band (in fit
 *   space); outside that the quantile function bends back on itself.
 */

export interface PercentilesParams {
  p10: number;
  p50?: number | undefined;
  p90: number;
}

export type PercentileFit =
  | { kind: "normal"; mu: number; sigma: number; log: boolean }
  | { kind: "metalog"; a1: number; a2: number; a3: number; log: boolean };

/** Φ⁻¹(0.9) — the standard-normal 90th percentile. */
export const Z90 = 1.2815515655446004;
/** logit(0.9) — the standard-logistic 90th percentile. */
const L90 = Math.log(9);
/** 3-term metalog feasibility bound on |a3| / a2. */
const METALOG_A3_LIMIT = 1.66711;

/**
 * Feasible fractional positions of P50 inside [P10, P90] in fit space:
 * |a3|/a2 = 2.5 · |1 − 2r| < 1.66711  ⇒  r ∈ (0.1666, 0.8334). Rounded
 * inward slightly so anything inside the band fits with margin.
 */
export const P50_BAND: readonly [number, number] = [0.17, 0.83];

export function percentilesUseLog(p: PercentilesParams): boolean {
  return p.p10 > 0;
}

/** Allowed [lo, hi] for P50 given P10 and P90 (linear values). */
export function feasibleP50Range(p10: number, p90: number): [number, number] {
  const log = p10 > 0;
  const t10 = log ? Math.log(p10) : p10;
  const t90 = log ? Math.log(p90) : p90;
  const lo = t10 + P50_BAND[0] * (t90 - t10);
  const hi = t10 + P50_BAND[1] * (t90 - t10);
  return log ? [Math.exp(lo), Math.exp(hi)] : [lo, hi];
}

/**
 * Fit the distribution. Returns null when the parameters cannot be fitted
 * (unordered, or a median outside the feasible band).
 */
export function fitPercentiles(p: PercentilesParams): PercentileFit | null {
  if (!(p.p10 < p.p90)) return null;
  const log = percentilesUseLog(p);
  const t10 = log ? Math.log(p.p10) : p.p10;
  const t90 = log ? Math.log(p.p90) : p.p90;
  if (p.p50 === undefined) {
    return { kind: "normal", mu: (t10 + t90) / 2, sigma: (t90 - t10) / (2 * Z90), log };
  }
  if (!(p.p10 < p.p50 && p.p50 < p.p90)) return null;
  const t50 = log ? Math.log(p.p50) : p.p50;
  const a1 = t50;
  const a2 = (t90 - t10) / (2 * L90);
  const a3 = (t90 + t10 - 2 * t50) / (0.8 * L90);
  if (Math.abs(a3) / a2 >= METALOG_A3_LIMIT) return null;
  return { kind: "metalog", a1, a2, a3, log };
}

const logitFn = (y: number) => Math.log(y / (1 - y));

/** Rational approximation of Φ⁻¹ (Acklam), |ε| < 1.2e-9. */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number;
  let r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Quantile function in FIT space (before exp for log fits). */
function fitSpaceQuantile(fit: PercentileFit, y: number): number {
  if (fit.kind === "normal") return fit.mu + fit.sigma * normalQuantile(y);
  const l = logitFn(y);
  return fit.a1 + fit.a2 * l + fit.a3 * (y - 0.5) * l;
}

/** Value at cumulative probability y ∈ (0, 1), in linear units. */
export function percentileQuantile(fit: PercentileFit, y: number): number {
  const t = fitSpaceQuantile(fit, y);
  return fit.log ? Math.exp(t) : t;
}

/**
 * Density used for DRAWING (unnormalized), expressed against the axis the
 * studio plots the family on: log-space density for log fits (matching how
 * lognormal is drawn on a log axis), linear otherwise.
 */
export function percentileDensity(fit: PercentileFit, x: number): number {
  if (fit.log && x <= 0) return 0;
  const t = fit.log ? Math.log(x) : x;
  if (fit.kind === "normal") {
    return Math.exp(-0.5 * ((t - fit.mu) / fit.sigma) ** 2);
  }
  // Invert the (monotone) metalog quantile function by bisection, then
  // density = 1 / M'(y).
  let lo = 1e-9;
  let hi = 1 - 1e-9;
  if (t <= fitSpaceQuantile(fit, lo) || t >= fitSpaceQuantile(fit, hi)) return 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fitSpaceQuantile(fit, mid) < t) lo = mid;
    else hi = mid;
  }
  const y = (lo + hi) / 2;
  const yy = y * (1 - y);
  const dM = fit.a2 / yy + fit.a3 * (logitFn(y) + (y - 0.5) / yy);
  return dM > 0 ? 1 / dM : 0;
}
