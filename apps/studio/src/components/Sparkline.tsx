import type { Summary } from "@bayes-studio/engine";

const W = 214;
const H = 38;

/**
 * On-node distribution readout. Continuous nodes get a histogram with the
 * 80% credible interval band and a median tick; discrete nodes get a
 * per-label bar row. Single-series, accent-colored — identity comes from the
 * node itself, so no legend (dataviz: one series needs none).
 */
export function Sparkline({ summary, accent }: { summary: Summary; accent: string }) {
  if (summary.categorical) {
    const { labels, probs } = summary.categorical;
    const gap = 2;
    const bw = (W - gap * (labels.length - 1)) / labels.length;
    return (
      <svg width={W} height={H} role="img" aria-label="category probabilities">
        {probs.map((p, i) => {
          const h = Math.max(1.5, p * (H - 12));
          return (
            <g key={labels[i]}>
              <rect
                x={i * (bw + gap)}
                y={H - 12 - h}
                width={bw}
                height={h}
                rx={1.5}
                fill={accent}
                opacity={0.85}
              />
              <text
                x={i * (bw + gap) + bw / 2}
                y={H - 2}
                textAnchor="middle"
                fontSize={8}
                fontFamily="var(--font-num)"
                fill="var(--ink-3)"
              >
                {labels[i].length > 9 ? labels[i].slice(0, 8) + "…" : labels[i]}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  const hist = summary.histogram;
  if (!hist) return null;

  const max = Math.max(...hist.counts);
  const n = hist.counts.length;
  const bw = W / n;
  const xOf = (v: number) => ((v - hist.start) / (hist.binWidth * n)) * W;
  const [lo, hi] = summary.ci80;
  const median = summary.quantiles.p50;

  return (
    <svg width={W} height={H} role="img" aria-label="distribution histogram">
      {/* 80% credible interval band */}
      <rect
        x={xOf(lo)}
        y={0}
        width={Math.max(0, xOf(hi) - xOf(lo))}
        height={H}
        fill={accent}
        opacity={0.12}
      />
      {hist.counts.map((c, i) => {
        const h = max > 0 ? Math.max(c > 0 ? 1 : 0, (c / max) * (H - 4)) : 0;
        return (
          <rect
            key={i}
            x={i * bw + 0.5}
            y={H - h}
            width={Math.max(0.5, bw - 1)}
            height={h}
            fill={accent}
            opacity={0.8}
          />
        );
      })}
      {/* median tick */}
      <line x1={xOf(median)} x2={xOf(median)} y1={0} y2={H} stroke="var(--ink)" strokeWidth={1.25} />
    </svg>
  );
}
