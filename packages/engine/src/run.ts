import {
  type AnyNode,
  type BayesDoc,
  parseExpr,
  type RpnItem,
  validateDoc,
  topologicalOrder,
  nodeLabels,
  nodeDependencies,
} from "@bayes-studio/schema";
import { nodeRng, type Rng } from "./rng.js";
import { sampleDist } from "./sample.js";
import { summarize, type Summary } from "./stats.js";

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly nodeId?: string,
  ) {
    super(nodeId ? `[${nodeId}] ${message}` : message);
    this.name = "EngineError";
  }
}

export interface RunOptions {
  /** Joint sample count. Default: doc.meta.samples ?? 10_000. */
  samples?: number;
  /** RNG seed. Default: doc.meta.seed ?? 42. */
  seed?: number;
  /** Attach raw sample vectors to each node result (costs memory). */
  includeSamples?: boolean;
}

export interface NodeResult {
  kind: AnyNode["kind"];
  title?: string;
  /** Derived unit (dimensional analysis), e.g. "$", "civilizations", "stars/yr". */
  unit?: string;
  /** Label set for discrete nodes; sampled values are indexes into it. */
  labels?: string[];
  summary: Summary;
  samples?: Float64Array;
}

export interface AlternativeStats {
  label: string;
  /** Samples that fell in this alternative's partition. */
  n: number;
  mean: number;
  ci80: [number, number];
}

export interface DecisionMetric {
  /** Utility node id, or the target node id of an output. */
  nodeId: string;
  title?: string;
  kind: "utility" | "output";
  /** Unit the per-alternative means are expressed in. */
  unit?: string;
  perAlternative: AlternativeStats[];
  /** Alternative with the highest mean of this metric. */
  best: string;
}

export interface DecisionAnalysis {
  decisionId: string;
  title?: string;
  alternatives: string[];
  metrics: DecisionMetric[];
}

export interface InferenceResult {
  seed: number;
  sampleCount: number;
  /** Deterministic evaluation order. */
  order: string[];
  nodes: Record<string, NodeResult>;
  /**
   * Nodes that produced no result, with the reason. A node fails on its own
   * (e.g. every sample non-finite, no matching CPT row) or because something
   * upstream did; everything else on the map still evaluates.
   */
  blocked: Record<string, string>;
  /** Output-node id → target node id, for the results panel. */
  outputs: Record<string, string>;
  /** Per-alternative expected values for every decision × (utility|output). */
  decisions: DecisionAnalysis[];
}

const EPS = 1e-9;

/**
 * Equality with a relative tolerance so values that differ only by
 * floating-point noise compare equal; strict orderings use the same band so
 * `<` and `>=` stay complementary.
 */
const REL_TOL = 1e-9;
function approxEq(a: number, b: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  return diff <= REL_TOL * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Position of the first sorted element > x (upper bound). */
function upperBound(sorted: Float64Array, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Position of the first sorted element >= x (lower bound). */
function lowerBound(sorted: Float64Array, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Finite samples, sorted ascending — the empirical distribution a query reads. */
function sortedFinite(samples: Float64Array): Float64Array {
  let count = 0;
  for (let i = 0; i < samples.length; i++) if (Number.isFinite(samples[i])) count++;
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < samples.length; i++) if (Number.isFinite(samples[i])) out[j++] = samples[i];
  return out.sort();
}

function quantileSorted(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0 || !(p >= 0 && p <= 1)) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function evalRpn(
  rpn: RpnItem[],
  lookup: (name: string) => Float64Array,
  n: number,
  nodeId: string,
): Float64Array {
  const stack: Float64Array[] = [];
  const pop = () => {
    const v = stack.pop();
    if (!v) throw new EngineError("Expression stack underflow (malformed expression)", nodeId);
    return v;
  };
  for (const item of rpn) {
    switch (item.t) {
      case "num": {
        const arr = new Float64Array(n);
        arr.fill(item.v);
        stack.push(arr);
        break;
      }
      case "var":
        stack.push(lookup(item.name));
        break;
      case "op": {
        if (item.op === "neg" || item.op === "not") {
          const a = pop();
          const out = new Float64Array(n);
          if (item.op === "neg") for (let i = 0; i < n; i++) out[i] = -a[i];
          else for (let i = 0; i < n; i++) out[i] = a[i] > 0.5 ? 0 : 1;
          stack.push(out);
          break;
        }
        const b = pop();
        const a = pop();
        const out = new Float64Array(n);
        switch (item.op) {
          case "+":
            for (let i = 0; i < n; i++) out[i] = a[i] + b[i];
            break;
          case "-":
            for (let i = 0; i < n; i++) out[i] = a[i] - b[i];
            break;
          case "*":
            for (let i = 0; i < n; i++) out[i] = a[i] * b[i];
            break;
          case "/":
            for (let i = 0; i < n; i++) out[i] = a[i] / b[i];
            break;
          case "^":
            for (let i = 0; i < n; i++) out[i] = Math.pow(a[i], b[i]);
            break;
          case "<":
            for (let i = 0; i < n; i++) out[i] = a[i] < b[i] && !approxEq(a[i], b[i]) ? 1 : 0;
            break;
          case "<=":
            for (let i = 0; i < n; i++) out[i] = a[i] <= b[i] || approxEq(a[i], b[i]) ? 1 : 0;
            break;
          case ">":
            for (let i = 0; i < n; i++) out[i] = a[i] > b[i] && !approxEq(a[i], b[i]) ? 1 : 0;
            break;
          case ">=":
            for (let i = 0; i < n; i++) out[i] = a[i] >= b[i] || approxEq(a[i], b[i]) ? 1 : 0;
            break;
          case "==":
            for (let i = 0; i < n; i++) out[i] = approxEq(a[i], b[i]) ? 1 : 0;
            break;
          case "!=":
            for (let i = 0; i < n; i++) out[i] = approxEq(a[i], b[i]) ? 0 : 1;
            break;
          case "and":
            for (let i = 0; i < n; i++) out[i] = a[i] > 0.5 && b[i] > 0.5 ? 1 : 0;
            break;
          case "or":
            for (let i = 0; i < n; i++) out[i] = a[i] > 0.5 || b[i] > 0.5 ? 1 : 0;
            break;
        }
        stack.push(out);
        break;
      }
      case "fn": {
        const args: Float64Array[] = new Array(item.arity);
        for (let k = item.arity - 1; k >= 0; k--) args[k] = pop();
        const out = new Float64Array(n);
        switch (item.name) {
          case "min":
            for (let i = 0; i < n; i++) {
              let m = args[0][i];
              for (let k = 1; k < args.length; k++) if (args[k][i] < m) m = args[k][i];
              out[i] = m;
            }
            break;
          case "max":
            for (let i = 0; i < n; i++) {
              let m = args[0][i];
              for (let k = 1; k < args.length; k++) if (args[k][i] > m) m = args[k][i];
              out[i] = m;
            }
            break;
          case "log":
          case "ln":
            for (let i = 0; i < n; i++) out[i] = Math.log(args[0][i]);
            break;
          case "log10":
            for (let i = 0; i < n; i++) out[i] = Math.log10(args[0][i]);
            break;
          case "log2":
            for (let i = 0; i < n; i++) out[i] = Math.log2(args[0][i]);
            break;
          case "exp":
            for (let i = 0; i < n; i++) out[i] = Math.exp(args[0][i]);
            break;
          case "sqrt":
            for (let i = 0; i < n; i++) out[i] = Math.sqrt(args[0][i]);
            break;
          case "abs":
            for (let i = 0; i < n; i++) out[i] = Math.abs(args[0][i]);
            break;
          case "pow":
            for (let i = 0; i < n; i++) out[i] = Math.pow(args[0][i], args[1][i]);
            break;
          case "floor":
            for (let i = 0; i < n; i++) out[i] = Math.floor(args[0][i]);
            break;
          case "ceil":
            for (let i = 0; i < n; i++) out[i] = Math.ceil(args[0][i]);
            break;
          case "round":
            for (let i = 0; i < n; i++) out[i] = Math.round(args[0][i]);
            break;
          case "clamp":
            for (let i = 0; i < n; i++) {
              const v = args[0][i];
              out[i] = v < args[1][i] ? args[1][i] : v > args[2][i] ? args[2][i] : v;
            }
            break;
          case "if":
            for (let i = 0; i < n; i++) out[i] = args[0][i] > 0.5 ? args[1][i] : args[2][i];
            break;
          case "logit":
            // Domain (0, 1); out-of-range → NaN, reported as non-finite samples.
            for (let i = 0; i < n; i++) {
              const p = args[0][i];
              out[i] = p > 0 && p < 1 ? Math.log(p / (1 - p)) : NaN;
            }
            break;
          case "inv_logit":
            for (let i = 0; i < n; i++) out[i] = 1 / (1 + Math.exp(-args[0][i]));
            break;
          case "odds":
            for (let i = 0; i < n; i++) {
              const p = args[0][i];
              out[i] = p >= 0 && p < 1 ? p / (1 - p) : NaN;
            }
            break;
          case "prob":
            for (let i = 0; i < n; i++) {
              const o = args[0][i];
              out[i] = o >= 0 ? o / (1 + o) : NaN;
            }
            break;
          case "cdf":
          case "prob_lt":
          case "prob_gt": {
            // Empirical CDF of the first argument's WHOLE sample vector,
            // queried at each sample of the second argument.
            const sorted = sortedFinite(args[0]);
            const m = sorted.length;
            if (m === 0) {
              out.fill(NaN);
              break;
            }
            for (let i = 0; i < n; i++) {
              const x = args[1][i];
              if (!Number.isFinite(x)) {
                out[i] = NaN;
                continue;
              }
              if (item.name === "cdf") out[i] = upperBound(sorted, x) / m;
              else if (item.name === "prob_lt") out[i] = lowerBound(sorted, x) / m;
              else out[i] = (m - upperBound(sorted, x)) / m;
            }
            break;
          }
          case "quantile": {
            const sorted = sortedFinite(args[0]);
            for (let i = 0; i < n; i++) out[i] = quantileSorted(sorted, args[1][i]);
            break;
          }
        }
        stack.push(out);
        break;
      }
    }
  }
  if (stack.length !== 1) {
    throw new EngineError("Expression did not reduce to a single value", nodeId);
  }
  return stack[0];
}

function evalCpt(
  node: Extract<AnyNode, { kind: "cond.cpt" }>,
  parentSamples: Float64Array[],
  parentLabels: (readonly string[])[],
  rng: Rng,
  n: number,
): Float64Array {
  // Precompute per-row cumulative probabilities.
  const rowCdfs = node.rows.map((row) => {
    const cdf = new Float64Array(row.probs.length);
    let acc = 0;
    for (let j = 0; j < row.probs.length; j++) {
      acc += row.probs[j];
      cdf[j] = acc;
    }
    return { when: row.when, cdf, total: acc };
  });

  // Memoized combo -> row resolution (first matching row wins; "*" matches anything).
  const rowByCombo = new Map<string, (typeof rowCdfs)[number]>();
  const resolveRow = (labels: string[], key: string) => {
    const memo = rowByCombo.get(key);
    if (memo) return memo;
    for (const row of rowCdfs) {
      let match = true;
      for (let p = 0; p < labels.length; p++) {
        if (row.when[p] !== "*" && row.when[p] !== labels[p]) {
          match = false;
          break;
        }
      }
      if (match) {
        rowByCombo.set(key, row);
        return row;
      }
    }
    return null;
  };

  const out = new Float64Array(n);
  const comboLabels = new Array<string>(node.parents.length);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < node.parents.length; p++) {
      const idx = parentSamples[p][i];
      comboLabels[p] = parentLabels[p][idx] ?? String(idx);
    }
    const key = comboLabels.join(" ");
    const row = resolveRow([...comboLabels], key);
    if (!row) {
      throw new EngineError(
        `CPT has no row matching parent combination (${comboLabels.join(", ")}) — add a row or a "*" catch-all`,
        node.id,
      );
    }
    const u = rng.next() * row.total;
    let j = 0;
    while (j < row.cdf.length - 1 && u >= row.cdf[j]) j++;
    out[i] = j;
  }
  return out;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Evaluate one node to its sample vector, or null for nodes that carry no value (output). */
function evalNode(
  node: AnyNode,
  byId: Map<string, AnyNode>,
  getSamples: (id: string, from: string) => Float64Array,
  seed: number,
  n: number,
): Float64Array | null {
  const id = node.id;
  const rng = nodeRng(seed, id);

  switch (node.kind) {
    case "prior.dist":
      return sampleDist(node.dist, rng, n);

    case "prior.sourced":
      return sampleDist(node.resolved?.dist ?? node.fallback, rng, n);

    case "prior.pooled": {
      const inputs = node.inputs.map((pid) => getSamples(pid, id));
      const rawW = node.weights ?? node.inputs.map(() => 1);
      const wSum = rawW.reduce((a, b) => a + b, 0);
      const w = rawW.map((x) => x / wSum);
      const out = new Float64Array(n);
      if (node.method === "linear") {
        // Mixture: pick a source per sample by weight.
        const cdf = new Float64Array(w.length);
        let acc = 0;
        for (let j = 0; j < w.length; j++) {
          acc += w[j];
          cdf[j] = acc;
        }
        for (let i = 0; i < n; i++) {
          const u = rng.next() * acc;
          let j = 0;
          while (j < cdf.length - 1 && u >= cdf[j]) j++;
          out[i] = inputs[j][i];
        }
      } else {
        // Weighted log-odds pooling of probability-valued inputs.
        const ex = node.extremize ?? 1;
        for (let i = 0; i < n; i++) {
          let acc = 0;
          for (let j = 0; j < inputs.length; j++) {
            const p = Math.min(1 - EPS, Math.max(EPS, inputs[j][i]));
            acc += w[j] * logit(p);
          }
          out[i] = sigmoid(ex * acc);
        }
      }
      return out;
    }

    case "formula": {
      const rpn = parseExpr(node.expr);
      return evalRpn(rpn, (name) => getSamples(name, id), n, id);
    }

    case "comparator": {
      const input = getSamples(node.input, id);
      const out = new Float64Array(n);
      switch (node.op) {
        case ">":
          for (let i = 0; i < n; i++) out[i] = input[i] > node.value! && !approxEq(input[i], node.value!) ? 1 : 0;
          break;
        case ">=":
          for (let i = 0; i < n; i++) out[i] = input[i] >= node.value! || approxEq(input[i], node.value!) ? 1 : 0;
          break;
        case "<":
          for (let i = 0; i < n; i++) out[i] = input[i] < node.value! && !approxEq(input[i], node.value!) ? 1 : 0;
          break;
        case "<=":
          for (let i = 0; i < n; i++) out[i] = input[i] <= node.value! || approxEq(input[i], node.value!) ? 1 : 0;
          break;
        case "==":
          for (let i = 0; i < n; i++) out[i] = approxEq(input[i], node.value!) ? 1 : 0;
          break;
        case "between":
          for (let i = 0; i < n; i++) out[i] = input[i] >= node.low! && input[i] <= node.high! ? 1 : 0;
          break;
      }
      return out;
    }

    case "logic": {
      const inputs = node.inputs.map((pid) => getSamples(pid, id));
      const out = new Float64Array(n);
      switch (node.op) {
        case "and":
          for (let i = 0; i < n; i++) {
            let v = 1;
            for (const arr of inputs)
              if (arr[i] <= 0.5) {
                v = 0;
                break;
              }
            out[i] = v;
          }
          break;
        case "or":
          for (let i = 0; i < n; i++) {
            let v = 0;
            for (const arr of inputs)
              if (arr[i] > 0.5) {
                v = 1;
                break;
              }
            out[i] = v;
          }
          break;
        case "not":
          for (let i = 0; i < n; i++) out[i] = inputs[0][i] > 0.5 ? 0 : 1;
          break;
        case "k_of_n":
          for (let i = 0; i < n; i++) {
            let c = 0;
            for (const arr of inputs) if (arr[i] > 0.5) c++;
            out[i] = c >= node.k! ? 1 : 0;
          }
          break;
      }
      return out;
    }

    case "cond.cpt": {
      const parentSamples = node.parents.map((pid) => getSamples(pid, id));
      const parentLabels = node.parents.map((pid) => {
        const parent = byId.get(pid)!;
        const labels = nodeLabels(parent, byId);
        if (!labels) throw new EngineError(`CPT parent '${pid}' is not discrete`, id);
        return labels;
      });
      return evalCpt(node, parentSamples, parentLabels, rng, n);
    }

    case "cond.mixture": {
      const on = getSamples(node.on, id);
      const parent = byId.get(node.on)!;
      const labels = nodeLabels(parent, byId);
      if (!labels) throw new EngineError(`Mixture 'on' node '${node.on}' is not discrete`, id);
      // Pre-sample every case with its own stream, then select per sample.
      const caseSamples = new Map<string, Float64Array>();
      for (const [label, dist] of Object.entries(node.cases)) {
        caseSamples.set(label, sampleDist(dist, nodeRng(seed, `${id}::case::${label}`), n));
      }
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const label = labels[on[i]] ?? String(on[i]);
        const arr = caseSamples.get(label);
        if (!arr) throw new EngineError(`Mixture has no case for label '${label}'`, id);
        out[i] = arr[i];
      }
      return out;
    }

    case "output":
      return null;

    case "decision": {
      // Alternatives are sampled uniformly; downstream nodes branch on the
      // decision (mixture/cpt/if), and the per-alternative analysis
      // partitions samples to compare expected utilities.
      const k = node.alternatives.length;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = Math.floor(rng.next() * k);
        out[i] = j >= k ? k - 1 : j;
      }
      return out;
    }

    case "utility": {
      const rpn = parseExpr(node.expr);
      const raw = evalRpn(rpn, (name) => getSamples(name, id), n, id);
      const t = node.transform;
      if (!t || t.type === "linear") return raw;
      if (t.type === "log") {
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) out[i] = Math.log(raw[i]);
        return out;
      }
      // CRRA: u(w) = (w^(1-γ) − 1) / (1 − γ); γ = 1 is the log case.
      const g = t.gamma;
      const out = new Float64Array(n);
      if (Math.abs(g - 1) < 1e-12) {
        for (let i = 0; i < n; i++) out[i] = Math.log(raw[i]);
      } else {
        const e = 1 - g;
        for (let i = 0; i < n; i++) out[i] = (Math.pow(raw[i], e) - 1) / e;
      }
      return out;
    }

    case "evidence":
      throw new EngineError(
        `'evidence' nodes are not supported by the engine yet — conditioning (likelihood weighting) is planned in PLAN.md §3, Phase 5`,
        id,
      );
  }
}

/**
 * Run Monte Carlo inference over a document. The document must validate
 * (throws EngineError with readable messages otherwise); after that, a node
 * that fails at runtime blocks only itself and its downstream cone — see
 * `InferenceResult.blocked` — while the rest of the map still evaluates.
 */
export function runInference(input: BayesDoc | unknown, opts: RunOptions = {}): InferenceResult {
  const validation = validateDoc(input);
  if (!validation.ok || !validation.doc) {
    const msgs = validation.issues
      .filter((i) => i.severity === "error")
      .map((i) => (i.nodeId ? `[${i.nodeId}] ${i.message}` : i.message));
    throw new EngineError(`Invalid document:\n  - ${msgs.join("\n  - ")}`);
  }
  const doc = validation.doc;
  const n = opts.samples ?? doc.meta.samples ?? 10_000;
  const seed = (opts.seed ?? doc.meta.seed ?? 42) >>> 0;

  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const { order, cycle } = topologicalOrder(doc);
  if (cycle) throw new EngineError(`Cycle detected: ${cycle.join(" → ")}`);

  const samplesById = new Map<string, Float64Array>();
  const results: Record<string, NodeResult> = {};
  const blocked: Record<string, string> = {};
  const outputs: Record<string, string> = {};

  const getSamples = (id: string, from: string): Float64Array => {
    const s = samplesById.get(id);
    if (!s) throw new EngineError(`Depends on '${id}' which produced no samples`, from);
    return s;
  };

  const stripPrefix = (message: string, id: string) =>
    message.startsWith(`[${id}] `) ? message.slice(id.length + 3) : message;

  for (const id of order) {
    const node = byId.get(id)!;

    // A blocked input blocks this node too, with a pointer to the root cause.
    const upstream = nodeDependencies(node).find((dep) => blocked[dep] !== undefined);
    if (upstream !== undefined) {
      blocked[id] = `Blocked by upstream '${upstream}'`;
      continue;
    }

    if (node.kind === "output") {
      outputs[node.id] = node.target;
      continue;
    }

    let samples: Float64Array | null;
    try {
      samples = evalNode(node, byId, getSamples, seed, n);
      if (samples) {
        const labels = nodeLabels(node, byId);
        const result: NodeResult = {
          kind: node.kind,
          summary: summarize(samples, labels),
        };
        if (node.title !== undefined) result.title = node.title;
        const unit = validation.units?.[id];
        if (unit) result.unit = unit;
        if (labels) result.labels = [...labels];
        if (opts.includeSamples) result.samples = samples;
        samplesById.set(id, samples);
        results[id] = result;
      }
    } catch (err) {
      if (err instanceof EngineError || err instanceof Error) {
        blocked[id] = stripPrefix(err.message, id);
      } else {
        throw err;
      }
    }
  }

  // Output nodes surface their target's result.
  for (const [outId, targetId] of Object.entries(outputs)) {
    const target = results[targetId];
    if (target) results[outId] = { ...target, kind: "output" };
    else if (blocked[outId] === undefined) blocked[outId] = `Blocked by upstream '${targetId}'`;
  }

  // --- Decision analysis -------------------------------------------------
  // For every decision node, partition each metric's samples by the sampled
  // alternative and compare conditional means: E[metric | decision = alt].
  const decisions: DecisionAnalysis[] = [];
  const decisionNodes = doc.nodes.filter((nd) => nd.kind === "decision");
  if (decisionNodes.length > 0) {
    const metricSources = new Map<string, { title?: string; kind: "utility" | "output" }>();
    for (const nd of doc.nodes) {
      if (nd.kind === "utility") {
        metricSources.set(nd.id, { title: nd.title, kind: "utility" });
      } else if (nd.kind === "output" && !metricSources.has(nd.target)) {
        const targetNode = doc.nodes.find((t) => t.id === nd.target);
        metricSources.set(nd.target, { title: targetNode?.title ?? nd.title, kind: "output" });
      }
    }

    // Dependents map, to restrict each decision's metrics to nodes it can
    // actually influence — a metric upstream of or unrelated to the decision
    // would just show the same number for every alternative.
    const dependents = new Map<string, string[]>();
    for (const nd of doc.nodes) {
      for (const dep of nodeDependencies(nd)) {
        const list = dependents.get(dep) ?? [];
        list.push(nd.id);
        dependents.set(dep, list);
      }
    }
    const descendantsOf = (root: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [root];
      while (stack.length > 0) {
        for (const next of dependents.get(stack.pop()!) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      return seen;
    };

    for (const dn of decisionNodes) {
      if (dn.kind !== "decision") continue;
      const dSamples = samplesById.get(dn.id);
      if (!dSamples) continue;
      const downstream = descendantsOf(dn.id);
      const metrics: DecisionMetric[] = [];
      for (const [metricId, meta] of metricSources) {
        if (metricId === dn.id || !downstream.has(metricId)) continue;
        const ms = samplesById.get(metricId);
        if (!ms) continue; // blocked metrics are simply absent
        const perAlternative: AlternativeStats[] = dn.alternatives.map((label, ai) => {
          let count = 0;
          for (let i = 0; i < n; i++) if (dSamples[i] === ai) count++;
          if (count === 0) return { label, n: 0, mean: NaN, ci80: [NaN, NaN] as [number, number] };
          const part = new Float64Array(count);
          let j = 0;
          for (let i = 0; i < n; i++) if (dSamples[i] === ai) part[j++] = ms[i];
          const s = summarize(part);
          return { label, n: count, mean: s.mean, ci80: s.ci80 };
        });
        const best = perAlternative.reduce((a, b) =>
          Number.isNaN(a.mean) || b.mean > a.mean ? b : a,
        ).label;
        const metric: DecisionMetric = { nodeId: metricId, kind: meta.kind, perAlternative, best };
        if (meta.title !== undefined) metric.title = meta.title;
        const metricUnit = validation.units?.[metricId];
        if (metricUnit) metric.unit = metricUnit;
        metrics.push(metric);
      }
      const analysis: DecisionAnalysis = {
        decisionId: dn.id,
        alternatives: [...dn.alternatives],
        metrics,
      };
      if (dn.title !== undefined) analysis.title = dn.title;
      decisions.push(analysis);
    }
  }

  return { seed, sampleCount: n, order, nodes: results, blocked, outputs, decisions };
}
