import { fitPercentiles, percentileQuantile, type Dist } from "@bayes-studio/schema";
import type { Rng } from "./rng.js";

/**
 * Draw n samples from a distribution primitive. Discrete distributions
 * (bernoulli, categorical) return label indexes (bernoulli: 0=false, 1=true).
 */
export function sampleDist(dist: Dist, rng: Rng, n: number): Float64Array {
  const out = new Float64Array(n);
  switch (dist.dist) {
    case "point":
      out.fill(dist.value);
      break;
    case "uniform": {
      const span = dist.max - dist.min;
      for (let i = 0; i < n; i++) out[i] = dist.min + span * rng.next();
      break;
    }
    case "loguniform": {
      const logMin = Math.log(dist.min);
      const span = Math.log(dist.max) - logMin;
      for (let i = 0; i < n; i++) out[i] = Math.exp(logMin + span * rng.next());
      break;
    }
    case "normal":
      for (let i = 0; i < n; i++) out[i] = dist.mu + dist.sigma * rng.normal();
      break;
    case "lognormal":
      for (let i = 0; i < n; i++) out[i] = Math.exp(dist.mu + dist.sigma * rng.normal());
      break;
    case "beta":
      for (let i = 0; i < n; i++) out[i] = rng.beta(dist.alpha, dist.beta);
      break;
    case "bernoulli":
      for (let i = 0; i < n; i++) out[i] = rng.next() < dist.p ? 1 : 0;
      break;
    case "triangular": {
      const { min, mode, max } = dist;
      const fc = (mode - min) / (max - min);
      for (let i = 0; i < n; i++) {
        const u = rng.next();
        out[i] =
          u < fc
            ? min + Math.sqrt(u * (max - min) * (mode - min))
            : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
      }
      break;
    }
    case "pert": {
      // Classic PERT: a beta on [min, max] shaped by the mode.
      const { min, mode, max } = dist;
      const lambda = dist.lambda ?? 4;
      const span = max - min;
      const alpha = 1 + (lambda * (mode - min)) / span;
      const beta = 1 + (lambda * (max - mode)) / span;
      for (let i = 0; i < n; i++) out[i] = min + span * rng.beta(alpha, beta);
      break;
    }
    case "percentiles": {
      const fit = fitPercentiles(dist);
      if (!fit) throw new Error("percentiles: parameters cannot be fitted (validation should have caught this)");
      if (fit.kind === "normal") {
        // Closed form: the normal sampler is exact and cheaper than inverting Φ.
        for (let i = 0; i < n; i++) {
          const t = fit.mu + fit.sigma * rng.normal();
          out[i] = fit.log ? Math.exp(t) : t;
        }
      } else {
        // Inverse-transform: the metalog is defined by its quantile function.
        for (let i = 0; i < n; i++) out[i] = percentileQuantile(fit, rng.nextOpen());
      }
      break;
    }
    case "categorical": {
      const k = dist.probs.length;
      const cdf = new Float64Array(k);
      let acc = 0;
      for (let j = 0; j < k; j++) {
        acc += dist.probs[j];
        cdf[j] = acc;
      }
      for (let i = 0; i < n; i++) {
        const u = rng.next() * acc; // tolerate tiny normalization error
        let j = 0;
        while (j < k - 1 && u >= cdf[j]) j++;
        out[i] = j;
      }
      break;
    }
  }
  return out;
}
