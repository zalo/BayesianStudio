import { useMemo, useRef, useState } from "react";
import {
  feasibleP50Range,
  fitPercentiles,
  percentileDensity,
  percentileQuantile,
  type Dist,
} from "@bayes-studio/schema";
import { fmt, fmtPct } from "../format.js";

/**
 * Metaculus-style distribution editor: the PDF curve is the control surface.
 * Drag the handles under the curve to reshape the belief — each family gets
 * handles in its own natural terms (center/spread, min/peak/max, chance).
 * Changes preview live; the engine re-runs when you release.
 */

const W = 280;
const H = 96;
const AXIS_H = 26; // room for handles + labels below the curve
const EPS = 1e-9;

interface Handle {
  key: string;
  label: string;
  /** Position in domain coordinates. */
  x: number;
  /** Produce a new dist from a dragged domain position. */
  apply: (x: number, d: Dist) => Dist;
}

interface Family {
  /** [lo, hi] display domain (already in transform space for log families). */
  domain: (d: Dist) => [number, number];
  /** Plot on a log axis — fixed per family, or decided per distribution. */
  log?: boolean | ((d: Dist) => boolean);
  handles: (d: Dist) => Handle[];
  /** Unnormalized pdf in *linear* x (log families receive linear x too). */
  pdf: (d: Dist, x: number) => number;
  params: (d: Dist) => { key: string; label: string; value: number }[];
  setParam: (d: Dist, key: string, value: number) => Dist;
  /**
   * Translate the whole distribution by `delta` (transform-space: linear
   * offset, or log-offset for log families → multiplicative). Dragging the
   * body between the handles moves everything at once, preserving spread.
   */
  shift?: (d: Dist, delta: number) => Dist;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const betaShape = (x: number, a: number, b: number) => {
  const xx = clamp(x, 1e-4, 1 - 1e-4);
  return Math.exp((a - 1) * Math.log(xx) + (b - 1) * Math.log(1 - xx));
};

type Pct = Extract<Dist, { dist: "percentiles" }>;
const pctLog = (d: Pct) => d.p10 > 0;
/** Smallest gap to keep between P10 and P90 while dragging. */
const pctGap = (d: Pct) => (pctLog(d) ? 1.001 : Math.max(Math.abs(d.p90 - d.p10) * 1e-3, EPS));
/** Nudge P50 back inside the band the metalog can fit, if one is set. */
const tidyP50 = (d: Pct): Pct => {
  if (d.p50 === undefined || !(d.p10 < d.p90)) return d;
  const [lo, hi] = feasibleP50Range(d.p10, d.p90);
  return { ...d, p50: clamp(d.p50, lo, hi) };
};

const FAMILIES: Partial<Record<Dist["dist"], Family>> = {
  percentiles: {
    log: (d) => d.dist === "percentiles" && pctLog(d),
    domain: (d) => {
      if (d.dist !== "percentiles") return [0, 1];
      const fit = fitPercentiles(d);
      if (!fit) return [d.p10, d.p90];
      return [percentileQuantile(fit, 0.003), percentileQuantile(fit, 0.997)];
    },
    handles: (d) => {
      if (d.dist !== "percentiles") return [];
      const hs: Handle[] = [
        {
          key: "p10",
          label: "P10",
          x: d.p10,
          apply: (x, dd) => {
            const n = dd as Pct;
            const gap = pctGap(n);
            let p10 = pctLog(n) ? Math.max(x, EPS) : x;
            if (pctLog(n)) p10 = Math.min(p10, n.p90 / gap);
            else p10 = Math.min(p10, n.p90 - gap);
            return tidyP50({ ...n, p10 });
          },
        },
      ];
      if (d.p50 !== undefined) {
        hs.push({
          key: "p50",
          label: "median",
          x: d.p50,
          apply: (x, dd) => {
            const n = dd as Pct;
            const [lo, hi] = feasibleP50Range(n.p10, n.p90);
            return { ...n, p50: clamp(x, lo, hi) };
          },
        });
      }
      hs.push({
        key: "p90",
        label: "P90",
        x: d.p90,
        apply: (x, dd) => {
          const n = dd as Pct;
          const gap = pctGap(n);
          const p90 = pctLog(n) ? Math.max(x, n.p10 * gap) : Math.max(x, n.p10 + gap);
          return tidyP50({ ...n, p90 });
        },
      });
      return hs;
    },
    pdf: (d, x) => {
      if (d.dist !== "percentiles") return 0;
      const fit = fitPercentiles(d);
      return fit ? percentileDensity(fit, x) : 0;
    },
    params: (d) =>
      d.dist !== "percentiles"
        ? []
        : [
            { key: "p10", label: "P10", value: d.p10 },
            ...(d.p50 !== undefined ? [{ key: "p50", label: "P50 (median)", value: d.p50 }] : []),
            { key: "p90", label: "P90", value: d.p90 },
          ],
    setParam: (d, key, value) => {
      if (d.dist !== "percentiles") return d;
      const next = { ...d, [key]: value } as Pct;
      return key === "p50" ? next : tidyP50(next);
    },
    shift: (d, delta) => {
      if (d.dist !== "percentiles") return d;
      if (pctLog(d)) {
        const f = Math.exp(delta);
        return { ...d, p10: d.p10 * f, p90: d.p90 * f, ...(d.p50 !== undefined ? { p50: d.p50 * f } : {}) };
      }
      return { ...d, p10: d.p10 + delta, p90: d.p90 + delta, ...(d.p50 !== undefined ? { p50: d.p50 + delta } : {}) };
    },
  },

  normal: {
    domain: (d) => (d.dist === "normal" ? [d.mu - 4 * d.sigma, d.mu + 4 * d.sigma] : [0, 1]),
    handles: (d) =>
      d.dist !== "normal"
        ? []
        : [
            { key: "mu", label: "center", x: d.mu, apply: (x, dd) => ({ ...(dd as typeof d), mu: x }) },
            {
              key: "sigma",
              label: "spread",
              x: d.mu + d.sigma,
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, sigma: Math.max(Math.abs(x - n.mu), Math.abs(n.mu) * 1e-6 + EPS) };
              },
            },
          ],
    pdf: (d, x) => (d.dist === "normal" ? Math.exp(-0.5 * ((x - d.mu) / d.sigma) ** 2) : 0),
    params: (d) =>
      d.dist === "normal"
        ? [
            { key: "mu", label: "center (μ)", value: d.mu },
            { key: "sigma", label: "spread (σ)", value: d.sigma },
          ]
        : [],
    setParam: (d, key, value) =>
      d.dist === "normal" ? { ...d, [key]: key === "sigma" ? Math.max(value, EPS) : value } : d,
    shift: (d, delta) => (d.dist === "normal" ? { ...d, mu: d.mu + delta } : d),
  },

  lognormal: {
    log: true,
    domain: (d) =>
      d.dist === "lognormal" ? [Math.exp(d.mu - 3.2 * d.sigma), Math.exp(d.mu + 3.2 * d.sigma)] : [1, 10],
    handles: (d) =>
      d.dist !== "lognormal"
        ? []
        : [
            {
              key: "median",
              label: "median",
              x: Math.exp(d.mu),
              apply: (x, dd) => ({ ...(dd as typeof d), mu: Math.log(Math.max(x, EPS)) }),
            },
            {
              key: "spread",
              label: "spread (×σ)",
              x: Math.exp(d.mu + d.sigma),
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, sigma: Math.max(Math.log(Math.max(x, EPS)) - n.mu, 0.01) };
              },
            },
          ],
    pdf: (d, x) =>
      d.dist === "lognormal" && x > 0 ? Math.exp(-0.5 * ((Math.log(x) - d.mu) / d.sigma) ** 2) : 0,
    params: (d) =>
      d.dist === "lognormal"
        ? [
            { key: "median", label: "median", value: Math.exp(d.mu) },
            { key: "sigma", label: "log-spread (σ)", value: d.sigma },
          ]
        : [],
    setParam: (d, key, value) =>
      d.dist !== "lognormal"
        ? d
        : key === "median"
          ? { ...d, mu: Math.log(Math.max(value, EPS)) }
          : { ...d, sigma: Math.max(value, 0.01) },
    shift: (d, delta) => (d.dist === "lognormal" ? { ...d, mu: d.mu + delta } : d),
  },

  uniform: {
    domain: (d) => {
      if (d.dist !== "uniform") return [0, 1];
      const pad = (d.max - d.min) * 0.2;
      return [d.min - pad, d.max + pad];
    },
    handles: (d) =>
      d.dist !== "uniform"
        ? []
        : [
            {
              key: "min",
              label: "min",
              x: d.min,
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, min: Math.min(x, n.max - Math.abs(n.max) * 1e-6 - EPS) };
              },
            },
            {
              key: "max",
              label: "max",
              x: d.max,
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, max: Math.max(x, n.min + Math.abs(n.min) * 1e-6 + EPS) };
              },
            },
          ],
    pdf: (d, x) => (d.dist === "uniform" && x >= d.min && x <= d.max ? 1 : 0),
    params: (d) =>
      d.dist === "uniform"
        ? [
            { key: "min", label: "min", value: d.min },
            { key: "max", label: "max", value: d.max },
          ]
        : [],
    setParam: (d, key, value) => (d.dist === "uniform" ? { ...d, [key]: value } : d),
    shift: (d, delta) =>
      d.dist === "uniform" ? { ...d, min: d.min + delta, max: d.max + delta } : d,
  },

  loguniform: {
    log: true,
    domain: (d) => {
      if (d.dist !== "loguniform") return [1, 10];
      const r = d.max / d.min;
      return [d.min / Math.pow(r, 0.12), d.max * Math.pow(r, 0.12)];
    },
    handles: (d) =>
      d.dist !== "loguniform"
        ? []
        : [
            {
              key: "min",
              label: "min",
              x: d.min,
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, min: clamp(x, EPS, n.max / 1.0001) };
              },
            },
            {
              key: "max",
              label: "max",
              x: d.max,
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, max: Math.max(x, n.min * 1.0001) };
              },
            },
          ],
    pdf: (d, x) => (d.dist === "loguniform" && x >= d.min && x <= d.max ? 1 : 0),
    params: (d) =>
      d.dist === "loguniform"
        ? [
            { key: "min", label: "min", value: d.min },
            { key: "max", label: "max", value: d.max },
          ]
        : [],
    setParam: (d, key, value) =>
      d.dist === "loguniform" ? { ...d, [key]: Math.max(value, EPS) } : d,
    shift: (d, delta) => {
      if (d.dist !== "loguniform") return d;
      const f = Math.exp(delta);
      return { ...d, min: Math.max(d.min * f, EPS), max: Math.max(d.max * f, EPS) };
    },
  },

  triangular: {
    domain: (d) => {
      if (d.dist !== "triangular") return [0, 1];
      const pad = (d.max - d.min) * 0.15;
      return [d.min - pad, d.max + pad];
    },
    handles: (d) =>
      d.dist !== "triangular"
        ? []
        : [
            {
              key: "min",
              label: "min",
              x: d.min,
              apply: (x, dd) => {
                const n = dd as typeof d;
                const min = Math.min(x, n.mode);
                return { ...n, min, mode: Math.max(n.mode, min) };
              },
            },
            {
              key: "mode",
              label: "peak",
              x: d.mode,
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, mode: clamp(x, n.min, n.max) };
              },
            },
            {
              key: "max",
              label: "max",
              x: d.max,
              apply: (x, dd) => {
                const n = dd as typeof d;
                const max = Math.max(x, n.mode);
                return { ...n, max, mode: Math.min(n.mode, max) };
              },
            },
          ],
    pdf: (d, x) => {
      if (d.dist !== "triangular" || x < d.min || x > d.max) return 0;
      return x <= d.mode
        ? (x - d.min) / Math.max(d.mode - d.min, EPS)
        : (d.max - x) / Math.max(d.max - d.mode, EPS);
    },
    params: (d) =>
      d.dist === "triangular"
        ? [
            { key: "min", label: "min", value: d.min },
            { key: "mode", label: "peak", value: d.mode },
            { key: "max", label: "max", value: d.max },
          ]
        : [],
    setParam: (d, key, value) => (d.dist === "triangular" ? { ...d, [key]: value } : d),
    shift: (d, delta) =>
      d.dist === "triangular"
        ? { ...d, min: d.min + delta, mode: d.mode + delta, max: d.max + delta }
        : d,
  },

  pert: {
    domain: (d) => {
      if (d.dist !== "pert") return [0, 1];
      const pad = (d.max - d.min) * 0.15;
      return [d.min - pad, d.max + pad];
    },
    handles: (d) =>
      d.dist !== "pert"
        ? []
        : [
            {
              key: "min",
              label: "min",
              x: d.min,
              apply: (x, dd) => {
                const n = dd as typeof d;
                const min = Math.min(x, n.mode);
                return { ...n, min };
              },
            },
            {
              key: "mode",
              label: "peak",
              x: d.mode,
              apply: (x, dd) => {
                const n = dd as typeof d;
                return { ...n, mode: clamp(x, n.min, n.max) };
              },
            },
            {
              key: "max",
              label: "max",
              x: d.max,
              apply: (x, dd) => {
                const n = dd as typeof d;
                const max = Math.max(x, n.mode);
                return { ...n, max };
              },
            },
          ],
    pdf: (d, x) => {
      if (d.dist !== "pert" || x <= d.min || x >= d.max) return 0;
      const lambda = d.lambda ?? 4;
      const span = d.max - d.min;
      const a = 1 + (lambda * (d.mode - d.min)) / span;
      const b = 1 + (lambda * (d.max - d.mode)) / span;
      return betaShape((x - d.min) / span, a, b);
    },
    params: (d) =>
      d.dist === "pert"
        ? [
            { key: "min", label: "min", value: d.min },
            { key: "mode", label: "peak", value: d.mode },
            { key: "max", label: "max", value: d.max },
          ]
        : [],
    setParam: (d, key, value) => (d.dist === "pert" ? { ...d, [key]: value } : d),
    shift: (d, delta) =>
      d.dist === "pert"
        ? { ...d, min: d.min + delta, mode: d.mode + delta, max: d.max + delta }
        : d,
  },

  beta: {
    domain: () => [0, 1],
    handles: (d) => {
      if (d.dist !== "beta") return [];
      const kappa = d.alpha + d.beta;
      const mean = d.alpha / kappa;
      const sd = Math.sqrt((mean * (1 - mean)) / (kappa + 1));
      const fromMeanKappa = (m: number, k: number): Dist => ({
        dist: "beta",
        alpha: Math.max(m * k, 0.02),
        beta: Math.max((1 - m) * k, 0.02),
      });
      return [
        {
          key: "mean",
          label: "mean",
          x: mean,
          apply: (x) => fromMeanKappa(clamp(x, 0.01, 0.99), kappa),
        },
        {
          key: "spread",
          label: "spread",
          x: clamp(mean + sd, 0.01, 0.999),
          apply: (x) => {
            const target = clamp(Math.abs(x - mean), 0.004, Math.sqrt(mean * (1 - mean)) * 0.98);
            const k = Math.max((mean * (1 - mean)) / (target * target) - 1, 0.05);
            return fromMeanKappa(mean, k);
          },
        },
      ];
    },
    pdf: (d, x) => (d.dist === "beta" ? betaShape(x, d.alpha, d.beta) : 0),
    params: (d) =>
      d.dist === "beta"
        ? [
            { key: "alpha", label: "α", value: d.alpha },
            { key: "beta", label: "β", value: d.beta },
          ]
        : [],
    setParam: (d, key, value) => (d.dist === "beta" ? { ...d, [key]: Math.max(value, 0.02) } : d),
    shift: (d, delta) => {
      if (d.dist !== "beta") return d;
      const kappa = d.alpha + d.beta;
      const mean = clamp(d.alpha / kappa + delta, 0.01, 0.99);
      return { dist: "beta", alpha: Math.max(mean * kappa, 0.02), beta: Math.max((1 - mean) * kappa, 0.02) };
    },
  },

  bernoulli: {
    domain: () => [0, 1],
    handles: (d) =>
      d.dist !== "bernoulli"
        ? []
        : [
            {
              key: "p",
              label: "chance",
              x: d.p,
              apply: (x) => ({ dist: "bernoulli", p: clamp(x, 0, 1) }),
            },
          ],
    pdf: () => 0, // rendered as bars, not a curve
    params: (d) => (d.dist === "bernoulli" ? [{ key: "p", label: "P(true)", value: d.p }] : []),
    setParam: (d, key, value) => (d.dist === "bernoulli" ? { ...d, p: clamp(value, 0, 1) } : d),
    shift: (d, delta) => (d.dist === "bernoulli" ? { ...d, p: clamp(d.p + delta, 0, 1) } : d),
  },

  point: {
    domain: (d) => {
      if (d.dist !== "point") return [0, 1];
      const spread = Math.max(Math.abs(d.value) * 0.6, 1);
      return [d.value - spread, d.value + spread];
    },
    handles: (d) =>
      d.dist !== "point"
        ? []
        : [
            {
              key: "value",
              label: "value",
              x: d.value,
              apply: (x) => ({ dist: "point", value: x }),
            },
          ],
    pdf: () => 0, // rendered as a stem
    params: (d) => (d.dist === "point" ? [{ key: "value", label: "value", value: d.value }] : []),
    setParam: (d, _key, value) => (d.dist === "point" ? { ...d, value } : d),
    shift: (d, delta) => (d.dist === "point" ? { ...d, value: d.value + delta } : d),
  },
};

function CategoricalEditor({
  dist,
  onScrub,
  onCommit,
}: {
  dist: Extract<Dist, { dist: "categorical" }>;
  onScrub: (d: Dist) => void;
  onCommit: (d: Dist) => void;
}) {
  const latest = useRef<Dist>(dist);
  latest.current = dist;
  const renormalized = (i: number, raw: number): Dist => {
    const probs = dist.probs.slice();
    const others = probs.reduce((a, b, j) => (j === i ? a : a + b), 0);
    probs[i] = clamp(raw, 0.001, 0.999);
    const scale = (1 - probs[i]) / Math.max(others, EPS);
    for (let j = 0; j < probs.length; j++) if (j !== i) probs[j] *= scale;
    return { ...dist, probs: probs.map((p) => Number(p.toFixed(6))) };
  };
  return (
    <div className="dist-editor">
      <div className="de-kind">
        categorical<span className="de-hint">Moving one slider rebalances the others</span>
      </div>
      {dist.labels.map((label, i) => (
        <div className="de-cat-row" key={label}>
          <span className="de-cat-label" title={label}>{label}</span>
          <input
            type="range"
            min={0.001}
            max={0.999}
            step={0.001}
            value={dist.probs[i]}
            onChange={(e) => onScrub(renormalized(i, Number(e.target.value)))}
            onPointerUp={() => onCommit(latest.current)}
            onKeyUp={(e) => {
              if (e.key.startsWith("Arrow")) onCommit(latest.current);
            }}
          />
          <span className="de-cat-pct">{fmtPct(dist.probs[i])}</span>
        </div>
      ))}
    </div>
  );
}

export function DistEditor({
  dist,
  unit,
  onScrub,
  onCommit,
}: {
  dist: Dist;
  unit?: string | undefined;
  /** Called on every drag frame — drives the real-time preview run. */
  onScrub: (d: Dist) => void;
  /** Called on release — drives the full-quality run. */
  onCommit: (d: Dist) => void;
}) {
  const [draft, setDraft] = useState<Dist | null>(null);
  const frozenDomain = useRef<[number, number] | null>(null);
  // The axis transform is frozen with the domain so a drag that crosses zero
  // on a per-dist log family doesn't flip the axis mid-gesture.
  const frozenLog = useRef<boolean | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const current = draft ?? dist;

  const family = FAMILIES[dist.dist];
  const isBars = current.dist === "bernoulli" || current.dist === "point";

  const domain = useMemo(() => {
    if (!family) return [0, 1] as [number, number];
    return frozenDomain.current ?? family.domain(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, current, draft === null]);

  if (dist.dist === "categorical") {
    return <CategoricalEditor dist={dist} onScrub={onScrub} onCommit={onCommit} />;
  }
  if (!family) return null;

  const familyLog = (d: Dist) => (typeof family.log === "function" ? family.log(d) : !!family.log);
  const isLog = frozenLog.current ?? familyLog(current);
  const toLin = (x: number) => (isLog ? Math.log(x) : x);
  const [d0, d1] = [toLin(domain[0]), toLin(domain[1])];
  const xPix = (x: number) => ((toLin(x) - d0) / (d1 - d0)) * W;
  const xVal = (px: number) => {
    const t = d0 + (clamp(px, 0, W) / W) * (d1 - d0);
    return isLog ? Math.exp(t) : t;
  };

  // Curve path (max-normalized shape — we care about form, not scale).
  let path = "";
  if (!isBars) {
    const pts: [number, number][] = [];
    let maxY = 0;
    for (let i = 0; i <= 120; i++) {
      const px = (i / 120) * W;
      const y = family.pdf(current, xVal(px));
      pts.push([px, y]);
      if (y > maxY) maxY = y;
    }
    path =
      `M 0 ${H} ` +
      pts.map(([px, y]) => `L ${px.toFixed(1)} ${(H - (maxY > 0 ? (y / maxY) * (H - 8) : 0)).toFixed(1)}`).join(" ") +
      ` L ${W} ${H} Z`;
  }

  const handles = family.handles(current);

  const startDrag = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // keep the body-drag handler out of it
    frozenDomain.current = family.domain(current);
    frozenLog.current = familyLog(current);
    const svg = svgRef.current!;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or exotic pointers may not be capturable */
    }
    const move = (ev: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const next = handle.apply(xVal(ev.clientX - rect.left), draft ?? dist);
      setDraft(next);
      onScrub(next); // full-graph preview tracks the drag in real time
    };
    const up = (ev: PointerEvent) => {
      try {
        svg.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      frozenDomain.current = null;
      frozenLog.current = null;
      setDraft((finalDraft) => {
        if (finalDraft) onCommit(finalDraft);
        return null;
      });
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  };

  /**
   * Body drag: pointer-down between the handles translates the WHOLE
   * distribution — mean shifts, spread preserved. Delta is measured in
   * transform space, so log families slide multiplicatively.
   */
  const startBodyDrag = (e: React.PointerEvent) => {
    const shift = family.shift;
    if (!shift) return;
    e.preventDefault();
    frozenDomain.current = family.domain(current);
    frozenLog.current = familyLog(current);
    const startDist = draft ?? dist;
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const startT = d0 + (clamp(e.clientX - rect.left, 0, W) / W) * (d1 - d0);
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or exotic pointers may not be capturable */
    }
    const move = (ev: PointerEvent) => {
      const t = d0 + (clamp(ev.clientX - rect.left, 0, W) / W) * (d1 - d0);
      const next = shift(startDist, t - startT);
      setDraft(next);
      onScrub(next);
    };
    const up = (ev: PointerEvent) => {
      try {
        svg.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      frozenDomain.current = null;
      frozenLog.current = null;
      setDraft((finalDraft) => {
        if (finalDraft) onCommit(finalDraft);
        return null;
      });
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  };

  return (
    <div className="dist-editor">
      <div className="de-kind">
        {current.dist}
        {unit ? <span className="de-unit">{unit}</span> : null}
        <span className="de-hint">Drag a handle, or the curve to shift it</span>
      </div>
      <svg
        ref={svgRef}
        width={W}
        height={H + AXIS_H}
        className={`de-chart${family.shift ? " shiftable" : ""}`}
        style={{ touchAction: "none" }}
        onPointerDown={startBodyDrag}
      >
        {/* curve / bars */}
        {!isBars && <path d={path} className="de-curve" />}
        {current.dist === "bernoulli" && (
          <>
            <rect x={W * 0.12} y={H - (1 - current.p) * (H - 8)} width={W * 0.25} height={(1 - current.p) * (H - 8)} className="de-bar" />
            <rect x={W * 0.62} y={H - current.p * (H - 8)} width={W * 0.25} height={current.p * (H - 8)} className="de-bar strong" />
            <text x={W * 0.245} y={H + 12} textAnchor="middle" className="de-tick">false</text>
            <text x={W * 0.745} y={H + 12} textAnchor="middle" className="de-tick">true</text>
          </>
        )}
        {current.dist === "point" && (
          <line x1={xPix(current.value)} x2={xPix(current.value)} y1={8} y2={H} className="de-stem" />
        )}
        {/* baseline */}
        <line x1={0} x2={W} y1={H} y2={H} className="de-axis" />
        {/* domain ticks */}
        {!isBars && (
          <>
            <text x={2} y={H + 12} className="de-tick">{fmt(domain[0])}</text>
            <text x={W - 2} y={H + 12} textAnchor="end" className="de-tick">{fmt(domain[1])}</text>
          </>
        )}
        {/* handles */}
        {handles.map((h) => {
          const px = current.dist === "bernoulli" ? W * 0.745 : clamp(xPix(h.x), 6, W - 6);
          return (
            <g key={h.key} className="de-handle" onPointerDown={startDrag(h)}>
              <line x1={px} x2={px} y1={10} y2={H} className="de-handle-line" />
              <circle cx={px} cy={H} r={7} className="de-handle-dot" />
              <text x={px} y={H + 24} textAnchor="middle" className="de-handle-label">
                {h.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="de-params">
        {family.params(current).map((p) => (
          <label key={p.key}>
            <span>{p.label}</span>
            <input
              type="number"
              step="any"
              value={draft ? Number(p.value.toPrecision(6)) : Number(p.value.toPrecision(6))}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setDraft(family.setParam(current, p.key, v));
              }}
              onBlur={() => {
                setDraft((finalDraft) => {
                  if (finalDraft) onCommit(finalDraft);
                  return null;
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
