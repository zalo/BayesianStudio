/**
 * Summary statistics over a sample vector. Every displayed number in the
 * studio carries its uncertainty — the summary is the unit of reporting.
 */

export interface Histogram {
  start: number;
  binWidth: number;
  counts: number[];
}

export interface Summary {
  n: number;
  /** Samples that were NaN/±Infinity and excluded from the stats. */
  nonFinite: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  quantiles: {
    p05: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
  };
  ci80: [number, number];
  ci95: [number, number];
  /** For boolean-valued nodes: P(true). */
  probTrue?: number;
  /** For discrete nodes: probability of each label. */
  categorical?: { labels: string[]; probs: number[] };
  /** For continuous nodes with spread. */
  histogram?: Histogram;
}

function quantileSorted(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export const HISTOGRAM_BINS = 40;

export function summarize(samples: Float64Array, labels?: readonly string[] | null): Summary {
  const n = samples.length;
  // Filter non-finite values once.
  let finiteCount = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(samples[i])) finiteCount++;
  const nonFinite = n - finiteCount;
  let finite: Float64Array;
  if (nonFinite === 0) {
    finite = samples;
  } else {
    finite = new Float64Array(finiteCount);
    let j = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(samples[i])) finite[j++] = samples[i];
  }
  if (finite.length === 0) {
    throw new Error("All samples are non-finite — check for division by zero or log of a negative value");
  }

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < finite.length; i++) {
    const v = finite[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // A constant vector is exactly its value: don't let summation rounding
  // turn "exact" into sd ≈ 1e-14 (the UI keys "exact" off sd === 0).
  let mean = sum / finite.length;
  let sd = 0;
  if (max === min) {
    mean = min;
  } else {
    let ss = 0;
    for (let i = 0; i < finite.length; i++) {
      const d = finite[i] - mean;
      ss += d * d;
    }
    sd = Math.sqrt(ss / Math.max(1, finite.length - 1));
  }

  const sorted = finite.slice().sort();
  const q = (p: number) => quantileSorted(sorted, p);
  const quantiles = {
    p05: q(0.05),
    p10: q(0.1),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p95: q(0.95),
  };

  const summary: Summary = {
    n,
    nonFinite,
    mean,
    sd,
    min,
    max,
    quantiles,
    ci80: [quantiles.p10, quantiles.p90],
    ci95: [q(0.025), q(0.975)],
  };

  if (labels && labels.length > 0) {
    const counts = new Array<number>(labels.length).fill(0);
    for (let i = 0; i < finite.length; i++) {
      const idx = finite[i];
      if (idx >= 0 && idx < labels.length) counts[idx]++;
    }
    summary.categorical = {
      labels: [...labels],
      probs: counts.map((c) => c / finite.length),
    };
    if (labels.length === 2 && labels[0] === "false" && labels[1] === "true") {
      summary.probTrue = summary.categorical.probs[1];
    }
  } else if (max > min) {
    const binWidth = (max - min) / HISTOGRAM_BINS;
    const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
    for (let i = 0; i < finite.length; i++) {
      let b = Math.floor((finite[i] - min) / binWidth);
      if (b >= HISTOGRAM_BINS) b = HISTOGRAM_BINS - 1;
      counts[b]++;
    }
    summary.histogram = { start: min, binWidth, counts };
  }

  return summary;
}
