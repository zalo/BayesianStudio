import { z } from "zod";

/**
 * Distribution primitives. Every uncertain quantity in a document bottoms out
 * in one of these. `lognormal` takes log-scale parameters (mu/sigma of ln X).
 */

export const PointDist = z.object({ dist: z.literal("point"), value: z.number().finite() });
export const UniformDist = z.object({
  dist: z.literal("uniform"),
  min: z.number().finite(),
  max: z.number().finite(),
});
export const LogUniformDist = z.object({
  dist: z.literal("loguniform"),
  min: z.number().positive(),
  max: z.number().positive(),
});
export const NormalDist = z.object({
  dist: z.literal("normal"),
  mu: z.number().finite(),
  sigma: z.number().positive(),
});
export const LogNormalDist = z.object({
  dist: z.literal("lognormal"),
  mu: z.number().finite(),
  sigma: z.number().positive(),
});
export const BetaDist = z.object({
  dist: z.literal("beta"),
  alpha: z.number().positive(),
  beta: z.number().positive(),
});
export const BernoulliDist = z.object({
  dist: z.literal("bernoulli"),
  p: z.number().min(0).max(1),
});
export const TriangularDist = z.object({
  dist: z.literal("triangular"),
  min: z.number().finite(),
  mode: z.number().finite(),
  max: z.number().finite(),
});
export const PertDist = z.object({
  dist: z.literal("pert"),
  min: z.number().finite(),
  mode: z.number().finite(),
  max: z.number().finite(),
  lambda: z.number().positive().optional(),
});
export const CategoricalDist = z.object({
  dist: z.literal("categorical"),
  labels: z.array(z.string().min(1)).min(2),
  probs: z.array(z.number().min(0)).min(2),
});
/**
 * Percentile-specified: "10% chance below p10, 10% chance above p90", with
 * an optional median. Fitted as lognormal/normal (P10/P90 only) or a 3-term
 * metalog (with P50) — see percentiles.ts. Positive ranges stay positive.
 */
export const PercentilesDist = z.object({
  dist: z.literal("percentiles"),
  p10: z.number().finite(),
  p50: z.number().finite().optional(),
  p90: z.number().finite(),
});

export const Dist = z.discriminatedUnion("dist", [
  PercentilesDist,
  PointDist,
  UniformDist,
  LogUniformDist,
  NormalDist,
  LogNormalDist,
  BetaDist,
  BernoulliDist,
  TriangularDist,
  PertDist,
  CategoricalDist,
]);

export type Dist = z.infer<typeof Dist>;

/** Labels for the boolean-valued nodes (bernoulli, comparator, logic). Index === numeric value. */
export const BOOL_LABELS = ["false", "true"] as const;

/**
 * Discrete label set of a distribution, or null when it is continuous.
 */
export function distLabels(d: Dist): readonly string[] | null {
  switch (d.dist) {
    case "bernoulli":
      return BOOL_LABELS;
    case "categorical":
      return d.labels;
    default:
      return null;
  }
}
