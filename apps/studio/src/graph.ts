import type { Edge, Node } from "@xyflow/react";
import {
  deriveEdges,
  nodeDependencies,
  topologicalOrder,
  type AnyNode,
  type BayesDoc,
} from "@bayes-studio/schema";
import type { InferenceResult, NodeResult } from "@bayes-studio/engine";
import { describeNode, varColour, type NodeDescription } from "./explain.js";

export type Family = "prior" | "formula" | "struct" | "decision" | "utility" | "output";

export function kindFamily(kind: AnyNode["kind"]): Family {
  if (kind.startsWith("prior.")) return "prior";
  if (kind === "formula") return "formula";
  if (kind === "decision" || kind === "evidence") return "decision";
  if (kind === "utility") return "utility";
  if (kind === "output") return "output";
  return "struct"; // cond.cpt, cond.mixture, comparator, logic
}

/** Human-readable kind names, sentence case, as shown on cards and in the inspector. */
export const FAMILY_LABEL: Record<AnyNode["kind"], string> = {
  "prior.dist": "Prior",
  "prior.sourced": "Sourced prior",
  "prior.pooled": "Pooled prior",
  "cond.cpt": "Probability table",
  "cond.mixture": "Mixture",
  formula: "Formula",
  comparator: "Comparator",
  logic: "Logic",
  evidence: "Evidence",
  decision: "Decision",
  utility: "Utility",
  output: "Output",
};

/** CSS custom property carrying a family's accent colour. */
export function familyAccent(kind: AnyNode["kind"]): string {
  return `var(--acc-${kindFamily(kind)})`;
}

export interface StudioNodeData extends Record<string, unknown> {
  node: AnyNode;
  result: NodeResult | null;
  /** Why the engine produced no value for this node (null when it ran). */
  blocked: string | null;
  /** Typeset equation, English reading, and the colour-indexed inputs that become ports. */
  desc: NodeDescription;
  hasDependents: boolean;
}

export type StudioFlowNode = Node<StudioNodeData, "studio">;

export interface StudioEdgeData extends Record<string, unknown> {
  /** Family accent of the source node (where the wire starts). */
  fromColour: string;
  /** The target's colour for this variable (where the wire lands). */
  toColour: string;
}

export type StudioFlowEdge = Edge<StudioEdgeData, "studio">;

/**
 * Layered auto-layout for nodes without a stored position: x by dependency
 * depth, y by order within the layer. Stored layout always wins.
 */
function autoPositions(doc: BayesDoc): Map<string, { x: number; y: number }> {
  const { order } = topologicalOrder(doc);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    const deps = nodeDependencies(node);
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((p) => (depth.get(p) ?? 0) + 1));
    depth.set(id, d);
  }
  const perLayerCount = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    const row = perLayerCount.get(d) ?? 0;
    perLayerCount.set(d, row + 1);
    pos.set(id, { x: d * 340, y: row * 220 });
  }
  return pos;
}

export function toFlow(
  doc: BayesDoc,
  results: InferenceResult | null,
): { nodes: StudioFlowNode[]; edges: StudioFlowEdge[] } {
  const auto = autoPositions(doc);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const dependents = new Set<string>();
  const derived = deriveEdges(doc);
  for (const e of derived) dependents.add(e.from);

  const descs = new Map(doc.nodes.map((n) => [n.id, describeNode(n, byId)]));

  const nodes: StudioFlowNode[] = doc.nodes.map((node) => {
    const stored = doc.layout?.[node.id];
    const position = stored ?? auto.get(node.id) ?? { x: 0, y: 0 };
    return {
      id: node.id,
      type: "studio",
      position,
      data: {
        node,
        result: results?.nodes[node.id] ?? null,
        blocked: results?.blocked[node.id] ?? null,
        desc: descs.get(node.id)!,
        hasDependents: dependents.has(node.id),
      },
    };
  });

  // Each wire lands on the port of the variable it feeds: the target handle
  // is named after the source id, and the arriving colour is the target's
  // colour for that variable.
  const edges: StudioFlowEdge[] = derived.map((e) => {
    const source = byId.get(e.from);
    const input = descs.get(e.to)?.inputs.find((i) => i.id === e.from);
    return {
      id: `${e.from}--${e.to}`,
      type: "studio",
      source: e.from,
      target: e.to,
      targetHandle: e.from,
      data: {
        fromColour: source ? familyAccent(source.kind) : "var(--ink-3)",
        toColour: input ? varColour(input.index) : "var(--ink-3)",
      },
    };
  });

  return { nodes, edges };
}
