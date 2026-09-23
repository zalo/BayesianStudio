import { create } from "zustand";
import {
  nodeDependencies,
  nodeLabels,
  validateDoc,
  type AnyNode,
  type BayesDoc,
  type Dist,
  type ValidationIssue,
} from "@bayes-studio/schema";
import type { InferenceResult } from "@bayes-studio/engine";
import type { RunResponse } from "./engine.worker.js";
import { DEFAULT_EXAMPLE, EXAMPLES } from "./examples.js";

export type RunStatus =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; ms: number }
  | { state: "error"; error: string };

interface StudioState {
  doc: BayesDoc;
  /** Which bundled example the doc came from (null once diverged/custom). */
  exampleKey: string | null;
  /** Validation findings on the current doc (warnings only — errors never land). */
  issues: ValidationIssue[];
  results: InferenceResult | null;
  status: RunStatus;
  selectedId: string | null;
  /** Replace the document (semantic change) and re-run inference. */
  setDoc: (doc: BayesDoc) => void;
  /** Swap in a bundled example and re-run. */
  loadExample: (key: string) => void;
  /** Persist a canvas position — layout only, no re-run. */
  moveNode: (id: string, x: number, y: number) => void;
  select: (id: string | null) => void;
  run: () => void;
  /** Add a node of the given kind with friendly defaults. Returns an error message or null. */
  addNode: (kind: AnyNode["kind"]) => string | null;
  /** Replace one node from edited JSON. Returns validation issues, or null when applied. */
  updateNode: (id: string, json: string) => ValidationIssue[] | null;
  /** Delete a node (refused while other nodes reference it). Returns an error message or null. */
  deleteNode: (id: string) => string | null;
  /** Replace the distribution of a prior (or a sourced prior's fallback). */
  setNodeDist: (id: string, dist: Dist) => string | null;
  /**
   * Same as setNodeDist but for mid-drag frames: applies immediately and runs
   * a fast preview (reduced samples, latest-wins) so the whole graph tracks
   * the slider in real time. Call setNodeDist on release for full quality.
   */
  scrubNodeDist: (id: string, dist: Dist) => void;
}

function exampleDoc(key: string): BayesDoc {
  const entry = EXAMPLES.find((e) => e.key === key) ?? EXAMPLES[0];
  return entry.doc;
}

/** Warnings the validator raised on an already-accepted document. */
function warningsOf(doc: BayesDoc): ValidationIssue[] {
  return validateDoc(doc).issues;
}

const ID_PREFIX: Record<string, string> = {
  "prior.dist": "new_prior",
  "prior.sourced": "new_sourced_prior",
  "prior.pooled": "pooled_estimate",
  "cond.cpt": "probability_table",
  "cond.mixture": "conditional_value",
  formula: "calculation",
  comparator: "threshold_check",
  logic: "combined_condition",
  decision: "choice",
  utility: "utility_score",
  output: "headline",
  evidence: "observed_fact",
};

function freshId(doc: BayesDoc, kind: AnyNode["kind"]): string {
  const base = ID_PREFIX[kind] ?? "node";
  if (!doc.nodes.some((n) => n.id === base)) return base;
  let i = 2;
  while (doc.nodes.some((n) => n.id === `${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** A self-explanatory starter node for each kind, anchored to existing nodes. */
function defaultNode(doc: BayesDoc, kind: AnyNode["kind"], selectedId: string | null): AnyNode | string {
  const id = freshId(doc, kind);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const anchor = (selectedId && byId.has(selectedId) ? selectedId : doc.nodes[0]?.id) ?? null;
  const firstDiscrete = doc.nodes.find((n) => nodeLabels(n, byId) !== null);

  switch (kind) {
    case "prior.dist":
      return {
        id,
        kind,
        title: "New prior (edit me)",
        notes: "Describe what this quantity is and where your belief comes from.",
        dist: { dist: "beta", alpha: 2, beta: 2 },
      };
    case "prior.sourced":
      return {
        id,
        kind,
        title: "New sourced prior (uses its fallback until connectors exist)",
        source: { connector: "manual", config: {} },
        fallback: { dist: "bernoulli", p: 0.5 },
      };
    case "prior.pooled": {
      if (doc.nodes.length < 2) return "Pooled priors need at least two existing nodes to combine.";
      return {
        id,
        kind,
        title: "Pooled estimate of the same quantity",
        inputs: [doc.nodes[0].id, doc.nodes[1].id],
        method: "linear",
      };
    }
    case "formula": {
      if (!anchor) return "Formulas need an existing node to reference.";
      return { id, kind, title: "New calculation", expr: `${anchor} * 1` };
    }
    case "comparator": {
      if (!anchor) return "Comparators need an existing node as input.";
      return { id, kind, title: `Is ${anchor} above threshold?`, input: anchor, op: ">", value: 0.5 };
    }
    case "logic": {
      if (!firstDiscrete) return "Logic nodes need a discrete input (a bernoulli prior, comparator, …). Add one first.";
      return { id, kind, title: "Combined condition", op: "and", inputs: [firstDiscrete.id] };
    }
    case "cond.mixture": {
      if (!firstDiscrete) return "Mixtures switch on a discrete node (bernoulli prior, comparator, decision, …). Add one first.";
      const labels = nodeLabels(firstDiscrete, byId)!;
      const cases = Object.fromEntries(
        labels.map((label, i) => [label, { dist: "point" as const, value: i }]),
      );
      return {
        id,
        kind,
        title: `Value depending on ${firstDiscrete.id}`,
        on: firstDiscrete.id,
        cases,
      };
    }
    case "cond.cpt": {
      if (!firstDiscrete) return "Probability tables need a discrete parent. Add one first.";
      return {
        id,
        kind,
        title: `Probability given ${firstDiscrete.id}`,
        parents: [firstDiscrete.id],
        labels: ["false", "true"],
        rows: [{ when: ["*"], probs: [0.5, 0.5] }],
      };
    }
    case "decision":
      return {
        id,
        kind,
        title: "New decision (name the options!)",
        alternatives: ["option_a", "option_b"],
      };
    case "utility": {
      if (!anchor) return "Utility nodes need an existing node to score.";
      return { id, kind, title: "Utility (what you value)", expr: anchor, transform: { type: "linear" } };
    }
    case "output": {
      if (!anchor) return "Output nodes need an existing node to headline.";
      return { id, kind, title: "Headline result", target: anchor };
    }
    case "evidence":
      return "Evidence nodes can't run yet — conditioning is not built (PLAN.md §3).";
  }
}

const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
let requestId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/** Sample count while a slider is mid-drag — small enough to run every frame. */
const PREVIEW_SAMPLES = 4000;

export const useStudio = create<StudioState>((set, get) => {
  // Latest-wins pipeline: at most one run in flight; while it runs, edits
  // collapse into a single queued run of the newest document. A queued
  // full-quality request outranks queued previews.
  let inFlight = false;
  let queued: boolean | null = null; // null = nothing queued, else preview?

  const dispatchRun = (preview: boolean) => {
    const { doc } = get();
    requestId++;
    inFlight = true;
    set({ status: { state: "running" } });
    const samples = preview
      ? Math.min(PREVIEW_SAMPLES, doc.meta.samples ?? 10_000)
      : undefined;
    worker.postMessage({ id: requestId, doc, samples });
  };

  const requestRun = (preview: boolean) => {
    if (inFlight) {
      queued = queued === null ? preview : queued && preview;
      return;
    }
    dispatchRun(preview);
  };

  worker.onmessage = (e: MessageEvent<RunResponse>) => {
    const msg = e.data;
    inFlight = false;
    if (msg.id === requestId) {
      if (msg.ok) {
        set({ results: msg.result, status: { state: "done", ms: msg.ms } });
      } else {
        set({ status: { state: "error", error: msg.error } });
      }
    }
    if (queued !== null) {
      const preview = queued;
      queued = null;
      dispatchRun(preview);
    }
  };

  const runNow = () => requestRun(false);

  return {
    doc: exampleDoc(DEFAULT_EXAMPLE),
    exampleKey: DEFAULT_EXAMPLE,
    issues: warningsOf(exampleDoc(DEFAULT_EXAMPLE)),
    results: null,
    status: { state: "idle" },
    selectedId: null,

    setDoc: (doc) => {
      set({ doc, exampleKey: null, issues: warningsOf(doc) });
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runNow, 250);
    },

    loadExample: (key) => {
      const doc = exampleDoc(key);
      set({ doc, exampleKey: key, issues: warningsOf(doc), selectedId: null, results: null });
      runNow();
    },

    moveNode: (id, x, y) => {
      const { doc } = get();
      set({ doc: { ...doc, layout: { ...doc.layout, [id]: { x, y } } } });
    },

    select: (id) => set({ selectedId: id }),

    run: runNow,

    addNode: (kind) => {
      const { doc, selectedId } = get();
      const node = defaultNode(doc, kind, selectedId);
      if (typeof node === "string") return node;

      // Place it to the right of the current graph, roughly mid-height.
      const positions = Object.values(doc.layout ?? {});
      const x = positions.length ? Math.max(...positions.map((p) => p.x)) + 320 : 0;
      const ys = positions.map((p) => p.y);
      const y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;

      const next: BayesDoc = {
        ...doc,
        nodes: [...doc.nodes, node],
        layout: { ...doc.layout, [node.id]: { x, y } },
      };
      const res = validateDoc(next);
      if (!res.ok || !res.doc) {
        return res.issues.find((i) => i.severity === "error")?.message ?? "Invalid node";
      }
      get().setDoc(res.doc);
      set({ selectedId: node.id });
      return null;
    },

    updateNode: (id, json) => {
      const { doc } = get();
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        return [{ severity: "error", nodeId: id, message: `Not valid JSON: ${(e as Error).message}` }];
      }
      const idx = doc.nodes.findIndex((n) => n.id === id);
      if (idx === -1) return [{ severity: "error", message: `Node '${id}' no longer exists` }];
      const nodes = doc.nodes.slice();
      nodes[idx] = parsed as AnyNode;
      const res = validateDoc({ ...doc, nodes });
      if (!res.ok || !res.doc) return res.issues.filter((i) => i.severity === "error");
      let newDoc = res.doc;
      const newId = newDoc.nodes[idx].id;
      // Follow an id rename in layout + selection.
      if (newId !== id && newDoc.layout?.[id]) {
        const layout = { ...newDoc.layout, [newId]: newDoc.layout[id] };
        delete layout[id];
        newDoc = { ...newDoc, layout };
      }
      get().setDoc(newDoc);
      set({ selectedId: newId });
      return null;
    },

    deleteNode: (id) => {
      const { doc } = get();
      const dependents = doc.nodes
        .filter((n) => n.id !== id && nodeDependencies(n).includes(id))
        .map((n) => n.id);
      if (dependents.length > 0) {
        return `Can't delete '${id}' — still referenced by: ${dependents.join(", ")}. Edit or delete those first.`;
      }
      const layout = { ...doc.layout };
      delete layout[id];
      const next: BayesDoc = { ...doc, nodes: doc.nodes.filter((n) => n.id !== id), layout };
      if (next.nodes.length === 0) return "A document needs at least one node.";
      const res = validateDoc(next);
      if (!res.ok || !res.doc) {
        return res.issues.find((i) => i.severity === "error")?.message ?? "Delete would invalidate the document";
      }
      get().setDoc(res.doc);
      set({ selectedId: null });
      return null;
    },

    setNodeDist: (id, dist) => {
      const applied = withDist(get().doc, id, dist);
      if (typeof applied === "string") return applied;
      // Final commit: apply and run at full quality straight away.
      clearTimeout(debounceTimer);
      set({ doc: applied.doc, exampleKey: null, issues: applied.issues });
      requestRun(false);
      return null;
    },

    scrubNodeDist: (id, dist) => {
      const applied = withDist(get().doc, id, dist);
      if (typeof applied === "string") return; // ignore transient invalid drag states
      clearTimeout(debounceTimer);
      set({ doc: applied.doc, exampleKey: null, issues: applied.issues });
      requestRun(true);
    },
  };
});

/** Doc with one prior's distribution (or sourced fallback) replaced, or an error. */
function withDist(
  doc: BayesDoc,
  id: string,
  dist: Dist,
): { doc: BayesDoc; issues: ValidationIssue[] } | string {
  const idx = doc.nodes.findIndex((n) => n.id === id);
  const node = doc.nodes[idx];
  if (!node) return `Node '${id}' no longer exists`;
  let replacement: AnyNode;
  if (node.kind === "prior.dist") {
    replacement = { ...node, dist };
  } else if (node.kind === "prior.sourced") {
    replacement = { ...node, fallback: dist };
  } else {
    return `'${node.kind}' nodes have no editable distribution`;
  }
  const nodes = doc.nodes.slice();
  nodes[idx] = replacement;
  const res = validateDoc({ ...doc, nodes });
  if (!res.ok || !res.doc) {
    return res.issues.find((i) => i.severity === "error")?.message ?? "Invalid distribution";
  }
  return { doc: res.doc, issues: res.issues };
}

// Kick off the first inference as soon as the store exists.
queueMicrotask(() => useStudio.getState().run());
