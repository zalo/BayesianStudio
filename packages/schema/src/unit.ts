/**
 * Dimensional analysis. A unit is a vector of exponents over free-form base
 * symbols — not SI-only, because decision models trade in "$", "stars",
 * "planets", "civilizations", "yr", … Dimensionless quantities (probabilities,
 * fractions, multipliers) are the empty vector.
 *
 * Grammar (parse): `sym(^exp)?` factors joined by `*` or `·`, divided by `/`.
 *   "$/yr"  "stars/yr"  "planets/star"  "$*yr^-1"  "m^2"  "1" (dimensionless)
 *
 * `%` is special: it is a scale marker, not a dimension. "%" parses to
 * dimensionless and "%·civilizations/planets" to civilizations/planets, so a
 * percent-valued prior combines like the fraction it stands for. The ×100 is
 * NOT tracked — formulas that consume a percent must divide by 100 themselves —
 * but the display unit keeps the `%` (see deriveUnits) so readouts say "35%".
 */

export type Dim = Readonly<Record<string, number>>;

export const DIMENSIONLESS: Dim = Object.freeze({});

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

const FACTOR_RE = /^([A-Za-z_$%][A-Za-z_$%0-9]*)(?:\^(-?\d+(?:\.\d+)?))?$/;

export function parseUnit(src: string): Dim {
  const trimmed = src.trim();
  if (trimmed === "" || trimmed === "1" || trimmed === "%") return DIMENSIONLESS;
  const dim: Record<string, number> = {};
  // Split into /-separated chunks; the first is the numerator.
  const chunks = trimmed.split("/");
  for (let ci = 0; ci < chunks.length; ci++) {
    const sign = ci === 0 ? 1 : -1;
    const chunk = chunks[ci].trim();
    if (chunk === "" ) throw new UnitError(`Malformed unit '${src}': empty segment around '/'`);
    if (ci === 0 && chunk === "1") continue; // "1/yr"
    for (const factorRaw of chunk.split(/[*·]/)) {
      const factor = factorRaw.trim();
      const m = FACTOR_RE.exec(factor);
      if (!m) throw new UnitError(`Malformed unit '${src}': cannot parse factor '${factor}'`);
      const sym = m[1];
      if (sym === "%") continue; // scale marker; see the header comment
      const exp = m[2] === undefined ? 1 : Number(m[2]);
      dim[sym] = (dim[sym] ?? 0) + sign * exp;
      if (Math.abs(dim[sym]) < 1e-12) delete dim[sym];
    }
  }
  return dim;
}

const fmtExp = (e: number) => (Number.isInteger(e) ? String(e) : e.toFixed(2).replace(/0+$/, ""));

/** Canonical human-readable form: "a·b^2/c" style; "" for dimensionless. */
export function formatUnit(dim: Dim): string {
  const pos = Object.entries(dim).filter(([, e]) => e > 0).sort(([a], [b]) => a.localeCompare(b));
  const neg = Object.entries(dim).filter(([, e]) => e < 0).sort(([a], [b]) => a.localeCompare(b));
  if (pos.length === 0 && neg.length === 0) return "";
  const numer =
    pos.length === 0 ? "1" : pos.map(([s, e]) => (e === 1 ? s : `${s}^${fmtExp(e)}`)).join("·");
  const denom = neg.map(([s, e]) => (e === -1 ? s : `${s}^${fmtExp(-e)}`)).join("/");
  return denom ? `${numer}/${denom}` : numer;
}

/** Whether a declared unit string is percent-valued (its numbers are the fraction × 100). */
export function isPercentUnit(src: string | undefined): boolean {
  return src !== undefined && /(^|[*·/])\s*%\s*($|[*·/])/.test(src.trim());
}

export function dimsEqual(a: Dim, b: Dim): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-9) return false;
  return true;
}

export function isDimensionless(d: Dim): boolean {
  return Object.keys(d).length === 0;
}

/** a · b^sign — multiply (sign=1) or divide (sign=-1). */
export function mulDims(a: Dim, b: Dim, sign: 1 | -1 = 1): Dim {
  const out: Record<string, number> = { ...a };
  for (const [k, e] of Object.entries(b)) {
    out[k] = (out[k] ?? 0) + sign * e;
    if (Math.abs(out[k]) < 1e-12) delete out[k];
  }
  return out;
}

export function powDims(a: Dim, exp: number): Dim {
  const out: Record<string, number> = {};
  for (const [k, e] of Object.entries(a)) {
    const v = e * exp;
    if (Math.abs(v) > 1e-12) out[k] = v;
  }
  return out;
}
