/** Compact scientific formatting for uncertainty-bearing readouts. */

const SI: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-4) return v.toExponential(2).replace("e+", "e");
  for (const [t, suffix] of SI) {
    if (a >= t) return trim((v / t).toPrecision(3)) + suffix;
  }
  if (a >= 100) return trim(v.toPrecision(4));
  return trim(v.toPrecision(3));
}

export function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return String(p);
  if (p > 0 && p < 0.001) return "<0.1%";
  if (p < 1 && p > 0.999) return ">99.9%";
  return trim((p * 100).toPrecision(3)) + "%";
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
