import { z } from "zod";
import { Dist } from "./dist.js";

/**
 * The canonical Bayes Studio document. Semantics live in `nodes`; layout is a
 * separate, optional map so AI-authored documents can omit it entirely and be
 * auto-laid-out. Edges are NOT authored — they are derived from node
 * semantics (parents / inputs / expression identifiers), which removes a
 * whole class of inconsistency an author (human or AI) could introduce.
 */

/** Node ids double as expression identifiers, so they must be identifier-shaped. */
export const NodeId = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
  message: "Node ids must look like identifiers: letters, digits, underscores; not starting with a digit",
});

const baseFields = {
  id: NodeId,
  title: z.string().optional(),
  /** Markdown rationale — models double as arguments; cite sources here. */
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

/**
 * Unit string, e.g. "$/yr", "stars/yr", "planets/star", "" (dimensionless).
 * Declared on priors and mixtures; DERIVED through formulas (multiplication
 * adds exponents, division cancels, additive positions must agree). On a
 * formula the field is an assertion checked against the derived unit.
 */
const unitField = z.string().max(64).optional();

// ---------------------------------------------------------------------------
// Priors
// ---------------------------------------------------------------------------

export const PriorDistNode = z.object({
  ...baseFields,
  kind: z.literal("prior.dist"),
  unit: unitField,
  dist: Dist,
});

/**
 * A prior bound to an external source (Polymarket, Metaculus, FRED, scraped
 * page, PDF, dataset). The binding config is intentionally loose until
 * connectors exist (PLAN.md §4) and tighten it. The engine samples
 * `resolved` when a refresh has populated it, else `fallback` — every
 * sourced prior MUST carry a fallback so a broken source never breaks the
 * model.
 */
export const SourceBinding = z.object({
  connector: z.string().min(1),
  /** Refresh TTL, e.g. "15m", "24h". */
  ttl: z.string().regex(/^\d+(s|m|h|d)$/).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const SourceFreshness = z.enum(["fresh", "stale", "refreshing", "error"]);

export const PriorSourcedNode = z.object({
  ...baseFields,
  kind: z.literal("prior.sourced"),
  unit: unitField,
  source: SourceBinding,
  fallback: Dist,
  /** Populated by the refresh machinery; never hand-authored in practice. */
  resolved: z
    .object({
      dist: Dist,
      fetchedAt: z.string().datetime({ offset: true }),
      freshness: SourceFreshness,
      /** Raw extracted value(s), for display/debugging. */
      raw: z.unknown().optional(),
    })
    .optional(),
  /** Epistemic source quality in [0,1] (liquidity, forecaster count, …). */
  confidence: z
    .object({
      value: z.number().min(0).max(1),
      basis: z.string().optional(),
    })
    .optional(),
});

/**
 * Combines multiple parents estimating the SAME quantity. `linear` picks a
 * parent per sample by weight (a mixture); `logodds` pools probability-valued
 * parents via weighted log-odds averaging with optional extremization.
 */
export const PriorPooledNode = z.object({
  ...baseFields,
  kind: z.literal("prior.pooled"),
  inputs: z.array(NodeId).min(2),
  method: z.enum(["linear", "logodds"]),
  weights: z.array(z.number().positive()).optional(),
  /** Log-odds extremization factor; 1 = none. */
  extremize: z.number().positive().optional(),
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * Discrete conditional probability table. Parents must be discrete
 * (bernoulli / categorical / comparator / logic / another cpt). Each row maps
 * one combination of parent labels to a distribution over `labels`.
 */
export const CptNode = z.object({
  ...baseFields,
  kind: z.literal("cond.cpt"),
  parents: z.array(NodeId).min(1),
  labels: z.array(z.string().min(1)).min(2),
  rows: z
    .array(
      z.object({
        /** One label per parent, in `parents` order. "*" matches any label. */
        when: z.array(z.string().min(1)).min(1),
        probs: z.array(z.number().min(0)),
      }),
    )
    .min(1),
});

/** Continuous output switched by a discrete parent: label -> distribution. */
export const MixtureNode = z.object({
  ...baseFields,
  kind: z.literal("cond.mixture"),
  unit: unitField,
  on: NodeId,
  cases: z.record(z.string(), Dist),
});

/** Deterministic expression over parent nodes, evaluated per-sample. */
export const FormulaNode = z.object({
  ...baseFields,
  kind: z.literal("formula"),
  expr: z.string().min(1),
  /** Optional assertion: validation fails if the derived unit differs. */
  unit: unitField,
});

export const ComparatorNode = z.object({
  ...baseFields,
  kind: z.literal("comparator"),
  input: NodeId,
  op: z.enum([">", ">=", "<", "<=", "==", "between"]),
  /** For scalar ops. */
  value: z.number().optional(),
  /** For `between` (inclusive). */
  low: z.number().optional(),
  high: z.number().optional(),
});

export const LogicNode = z.object({
  ...baseFields,
  kind: z.literal("logic"),
  op: z.enum(["and", "or", "not", "k_of_n"]),
  inputs: z.array(NodeId).min(1),
  k: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Decision layer. Decision and utility nodes run today; `evidence` is
// schema-complete but the engine blocks it until likelihood weighting lands
// (PLAN.md §3, Phase 5).
// ---------------------------------------------------------------------------

export const EvidenceNode = z.object({
  ...baseFields,
  kind: z.literal("evidence"),
  target: NodeId,
  /** Observed label (discrete targets) or number (continuous targets). */
  value: z.union([z.string(), z.number()]),
  enabled: z.boolean().default(true),
});

export const DecisionNode = z.object({
  ...baseFields,
  kind: z.literal("decision"),
  alternatives: z.array(z.string().min(1)).min(2),
});

export const UtilityNode = z.object({
  ...baseFields,
  kind: z.literal("utility"),
  expr: z.string().min(1),
  transform: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("linear") }),
      z.object({ type: z.literal("log") }),
      z.object({ type: z.literal("crra"), gamma: z.number().positive() }),
    ])
    .optional(),
});

/** Marks a node as a headline result for the results panel and exports. */
export const OutputNode = z.object({
  ...baseFields,
  kind: z.literal("output"),
  target: NodeId,
});

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export const AnyNode = z.discriminatedUnion("kind", [
  PriorDistNode,
  PriorSourcedNode,
  PriorPooledNode,
  CptNode,
  MixtureNode,
  FormulaNode,
  ComparatorNode,
  LogicNode,
  EvidenceNode,
  DecisionNode,
  UtilityNode,
  OutputNode,
]);

export const DocMeta = z.object({
  title: z.string().min(1),
  author: z.string().optional(),
  description: z.string().optional(),
  seed: z.number().int().optional(),
  samples: z.number().int().min(100).max(1_000_000).optional(),
});

export const LayoutEntry = z.object({ x: z.number(), y: z.number() });

export const BayesDoc = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  meta: DocMeta,
  nodes: z.array(AnyNode).min(1),
  layout: z.record(z.string(), LayoutEntry).optional(),
  /** Reserved for Gaussian-copula rank correlations between priors. */
  correlations: z.array(z.unknown()).optional(),
});

export type PriorDistNode = z.infer<typeof PriorDistNode>;
export type PriorSourcedNode = z.infer<typeof PriorSourcedNode>;
export type PriorPooledNode = z.infer<typeof PriorPooledNode>;
export type CptNode = z.infer<typeof CptNode>;
export type MixtureNode = z.infer<typeof MixtureNode>;
export type FormulaNode = z.infer<typeof FormulaNode>;
export type ComparatorNode = z.infer<typeof ComparatorNode>;
export type LogicNode = z.infer<typeof LogicNode>;
export type EvidenceNode = z.infer<typeof EvidenceNode>;
export type DecisionNode = z.infer<typeof DecisionNode>;
export type UtilityNode = z.infer<typeof UtilityNode>;
export type OutputNode = z.infer<typeof OutputNode>;
export type AnyNode = z.infer<typeof AnyNode>;
export type BayesDoc = z.infer<typeof BayesDoc>;
export type SourceFreshness = z.infer<typeof SourceFreshness>;
