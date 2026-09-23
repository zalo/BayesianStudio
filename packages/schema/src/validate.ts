import { BayesDoc, type AnyNode } from "./doc.js";
import { distLabels, BOOL_LABELS } from "./dist.js";
import { exprIdentifiers, ExprError, RESERVED_IDENTIFIERS } from "./expr.js";
import { deriveUnits } from "./units-derive.js";
import { feasibleP50Range, fitPercentiles } from "./percentiles.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  /** Node id the issue is anchored to, when applicable. */
  nodeId?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  doc?: BayesDoc;
  issues: ValidationIssue[];
  /** Node id → derived unit string ("" = dimensionless). Present when structure is valid. */
  units?: Record<string, string>;
}

/**
 * Parent node ids a node depends on, in a stable order. This is the single
 * source of truth for graph structure — edges are derived, never authored.
 */
export function nodeDependencies(node: AnyNode): string[] {
  switch (node.kind) {
    case "prior.dist":
    case "prior.sourced":
    case "decision":
      return [];
    case "prior.pooled":
    case "logic":
      return [...node.inputs];
    case "cond.cpt":
      return [...node.parents];
    case "cond.mixture":
      return [node.on];
    case "formula":
    case "utility":
      try {
        return [...exprIdentifiers(node.expr)].sort();
      } catch {
        return []; // the expression error is reported separately
      }
    case "comparator":
      return [node.input];
    case "evidence":
    case "output":
      return [node.target];
  }
}

export interface DerivedEdge {
  from: string;
  to: string;
}

export function deriveEdges(doc: BayesDoc): DerivedEdge[] {
  const edges: DerivedEdge[] = [];
  for (const node of doc.nodes) {
    for (const dep of nodeDependencies(node)) {
      edges.push({ from: dep, to: node.id });
    }
  }
  return edges;
}

/**
 * Discrete label set of a node, or null if the node is continuous-valued.
 * Sampled values of discrete nodes are indexes into this array.
 */
export function nodeLabels(node: AnyNode, byId: Map<string, AnyNode>): readonly string[] | null {
  switch (node.kind) {
    case "prior.dist":
      return distLabels(node.dist);
    case "prior.sourced":
      return distLabels(node.resolved?.dist ?? node.fallback);
    case "comparator":
    case "logic":
      return BOOL_LABELS;
    case "cond.cpt":
      return node.labels;
    case "decision":
      return node.alternatives;
    case "cond.mixture": {
      // Discrete only if every case is discrete with the same label set.
      const dists = Object.values(node.cases);
      const first = dists[0] ? distLabels(dists[0]) : null;
      if (!first) return null;
      for (const d of dists) {
        const l = distLabels(d);
        if (!l || l.length !== first.length || l.some((x, i) => x !== first[i])) return null;
      }
      return first;
    }
    default:
      return null;
  }
}

/** Kahn's algorithm with a sorted ready-set for deterministic order. */
export function topologicalOrder(doc: BayesDoc): { order: string[]; cycle: string[] | null } {
  const nodes = doc.nodes;
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) indegree.set(n.id, 0);
  for (const n of nodes) {
    for (const dep of nodeDependencies(n)) {
      if (!indegree.has(dep)) continue; // missing ref reported elsewhere
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(n.id);
      dependents.set(dep, list);
    }
  }
  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dep of (dependents.get(id) ?? []).slice().sort()) {
      const d = indegree.get(dep)! - 1;
      indegree.set(dep, d);
      if (d === 0) {
        // insert keeping `ready` sorted
        let i = 0;
        while (i < ready.length && ready[i] < dep) i++;
        ready.splice(i, 0, dep);
      }
    }
  }
  if (order.length !== nodes.length) {
    const inCycle = nodes.map((n) => n.id).filter((id) => !order.includes(id));
    return { order, cycle: inCycle };
  }
  return { order, cycle: null };
}

const DISCRETE_CAPABLE = new Set(["prior.dist", "prior.sourced", "comparator", "logic", "cond.cpt", "decision", "cond.mixture"]);

/**
 * Full document validation: zod shape first, then semantic checks (unique
 * ids, resolvable references, acyclicity, probability sums, CPT/mixture label
 * coverage). Returns readable issues instead of throwing.
 */
export function validateDoc(input: unknown): ValidationResult {
  const parsed = BayesDoc.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        severity: "error" as const,
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const doc = parsed.data;
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, AnyNode>();

  for (const node of doc.nodes) {
    if (byId.has(node.id)) {
      issues.push({ severity: "error", nodeId: node.id, message: `Duplicate node id '${node.id}'` });
    }
    byId.set(node.id, node);
    if (RESERVED_IDENTIFIERS.has(node.id)) {
      issues.push({
        severity: "error",
        nodeId: node.id,
        message: `'${node.id}' is a reserved identifier (function or constant) and cannot be a node id`,
      });
    }
  }

  for (const node of doc.nodes) {
    // Expression syntax
    if (node.kind === "formula" || node.kind === "utility") {
      try {
        exprIdentifiers(node.expr);
      } catch (e) {
        if (e instanceof ExprError) {
          issues.push({ severity: "error", nodeId: node.id, message: `Invalid expression: ${e.message}` });
        } else throw e;
      }
    }

    // Reference resolution
    for (const dep of nodeDependencies(node)) {
      if (!byId.has(dep)) {
        issues.push({
          severity: "error",
          nodeId: node.id,
          message: `References unknown node '${dep}'`,
        });
      }
    }

    // Distribution sanity
    const dists =
      node.kind === "prior.dist"
        ? [node.dist]
        : node.kind === "prior.sourced"
          ? [node.fallback, ...(node.resolved ? [node.resolved.dist] : [])]
          : node.kind === "cond.mixture"
            ? Object.values(node.cases)
            : [];
    for (const d of dists) {
      if ((d.dist === "uniform" || d.dist === "loguniform") && d.min >= d.max) {
        issues.push({ severity: "error", nodeId: node.id, message: `${d.dist}: min must be < max` });
      }
      if ((d.dist === "triangular" || d.dist === "pert") && !(d.min <= d.mode && d.mode <= d.max && d.min < d.max)) {
        issues.push({ severity: "error", nodeId: node.id, message: `${d.dist}: requires min <= mode <= max and min < max` });
      }
      if (d.dist === "percentiles") {
        if (!(d.p10 < d.p90)) {
          issues.push({ severity: "error", nodeId: node.id, message: "percentiles: P10 must be less than P90" });
        } else if (d.p50 !== undefined && !(d.p10 < d.p50 && d.p50 < d.p90)) {
          issues.push({ severity: "error", nodeId: node.id, message: "percentiles: requires P10 < P50 < P90 (omit P50 for a symmetric fit)" });
        } else if (fitPercentiles(d) === null) {
          const [lo, hi] = feasibleP50Range(d.p10, d.p90);
          issues.push({
            severity: "error",
            nodeId: node.id,
            message: `percentiles: P50 is too close to P10/P90 for a smooth fit — keep it between ${lo.toPrecision(4)} and ${hi.toPrecision(4)}, or omit P50 for a symmetric fit`,
          });
        }
      }
      if (d.dist === "categorical") {
        if (d.labels.length !== d.probs.length) {
          issues.push({ severity: "error", nodeId: node.id, message: "categorical: labels and probs must have the same length" });
        }
        const sum = d.probs.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 1e-6) {
          issues.push({ severity: "error", nodeId: node.id, message: `categorical: probs must sum to 1 (got ${sum.toFixed(6)})` });
        }
      }
    }

    if (node.kind === "prior.pooled") {
      if (node.weights && node.weights.length !== node.inputs.length) {
        issues.push({ severity: "error", nodeId: node.id, message: "pooled: weights must match inputs length" });
      }
    }

    if (node.kind === "comparator") {
      if (node.op === "between") {
        if (node.low === undefined || node.high === undefined) {
          issues.push({ severity: "error", nodeId: node.id, message: "comparator 'between' requires low and high" });
        } else if (node.low > node.high) {
          issues.push({ severity: "error", nodeId: node.id, message: "comparator 'between' requires low <= high" });
        }
      } else if (node.value === undefined) {
        issues.push({ severity: "error", nodeId: node.id, message: `comparator '${node.op}' requires a value` });
      }
    }

    if (node.kind === "logic") {
      if (node.op === "not" && node.inputs.length !== 1) {
        issues.push({ severity: "error", nodeId: node.id, message: "logic 'not' takes exactly one input" });
      }
      if (node.op === "k_of_n") {
        if (node.k === undefined) {
          issues.push({ severity: "error", nodeId: node.id, message: "logic 'k_of_n' requires k" });
        } else if (node.k > node.inputs.length) {
          issues.push({ severity: "error", nodeId: node.id, message: "logic 'k_of_n': k exceeds number of inputs" });
        }
      }
      for (const dep of node.inputs) {
        const parent = byId.get(dep);
        if (parent && nodeLabels(parent, byId) === null) {
          issues.push({
            severity: "warning",
            nodeId: node.id,
            message: `logic input '${dep}' is continuous; values > 0.5 are treated as true`,
          });
        }
      }
    }

    if (node.kind === "cond.cpt") {
      for (const [pi, pid] of node.parents.entries()) {
        const parent = byId.get(pid);
        if (!parent) continue;
        if (!DISCRETE_CAPABLE.has(parent.kind) || nodeLabels(parent, byId) === null) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            message: `cpt parent #${pi} ('${pid}') must be a discrete node`,
          });
        }
      }
      for (const [ri, row] of node.rows.entries()) {
        if (row.when.length !== node.parents.length) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            message: `cpt row ${ri}: 'when' must have one entry per parent (${node.parents.length})`,
          });
        }
        if (row.probs.length !== node.labels.length) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            message: `cpt row ${ri}: 'probs' must have one entry per label (${node.labels.length})`,
          });
        }
        const sum = row.probs.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 1e-6) {
          issues.push({ severity: "error", nodeId: node.id, message: `cpt row ${ri}: probs must sum to 1 (got ${sum.toFixed(6)})` });
        }
        for (const [wi, label] of row.when.entries()) {
          if (label === "*") continue;
          const parent = byId.get(node.parents[wi] ?? "");
          if (!parent) continue;
          const labels = nodeLabels(parent, byId);
          if (labels && !labels.includes(label)) {
            issues.push({
              severity: "error",
              nodeId: node.id,
              message: `cpt row ${ri}: '${label}' is not a label of parent '${node.parents[wi]}' (has: ${labels.join(", ")})`,
            });
          }
        }
      }
    }

    if (node.kind === "cond.mixture") {
      const parent = byId.get(node.on);
      if (parent) {
        const labels = nodeLabels(parent, byId);
        if (labels === null) {
          issues.push({ severity: "error", nodeId: node.id, message: `mixture 'on' node '${node.on}' must be discrete` });
        } else {
          for (const label of labels) {
            if (!(label in node.cases)) {
              issues.push({
                severity: "error",
                nodeId: node.id,
                message: `mixture is missing a case for parent label '${label}'`,
              });
            }
          }
          for (const key of Object.keys(node.cases)) {
            if (!labels.includes(key)) {
              issues.push({
                severity: "warning",
                nodeId: node.id,
                message: `mixture case '${key}' matches no label of '${node.on}' (has: ${labels.join(", ")})`,
              });
            }
          }
        }
      }
    }

    if (node.kind === "evidence") {
      const target = byId.get(node.target);
      if (target && typeof node.value === "string") {
        const labels = nodeLabels(target, byId);
        if (labels && !labels.includes(node.value)) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            message: `evidence value '${node.value}' is not a label of '${node.target}' (has: ${labels.join(", ")})`,
          });
        }
      }
    }
  }

  // Acyclicity (only meaningful once refs resolve)
  if (!issues.some((i) => i.severity === "error")) {
    const { cycle } = topologicalOrder(doc);
    if (cycle) {
      issues.push({
        severity: "error",
        message: `Cycle detected involving: ${cycle.join(" → ")} — the graph must be a DAG`,
      });
    }
  }

  // Dimensional analysis (needs a structurally sound graph to walk)
  let units: Record<string, string> | undefined;
  if (!issues.some((i) => i.severity === "error")) {
    const derivation = deriveUnits(doc);
    issues.push(...derivation.issues);
    units = derivation.units;
  }

  const ok = !issues.some((i) => i.severity === "error");
  if (!ok) return { ok, issues };
  return units ? { ok, doc, issues, units } : { ok, doc, issues };
}
