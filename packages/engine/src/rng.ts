/**
 * Deterministic, seedable RNG (sfc32) with per-node stream derivation, plus
 * the samplers the distribution set needs. Same doc + same seed = identical
 * results, and each node draws from its own stream keyed by (seed, nodeId) so
 * adding or reordering nodes never perturbs the randomness of other nodes.
 */

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    // Seed the four sfc32 words from splitmix32 and warm up.
    const sm = splitmix32(seed >>> 0);
    this.a = (sm() * 4294967296) >>> 0;
    this.b = (sm() * 4294967296) >>> 0;
    this.c = (sm() * 4294967296) >>> 0;
    this.d = (sm() * 4294967296) >>> 0;
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Uniform in (0, 1) — never exactly 0, safe for log(). */
  nextOpen(): number {
    let u = this.next();
    while (u === 0) u = this.next();
    return u;
  }

  /** Standard normal via Box–Muller with a cached spare. */
  normal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    const u1 = this.nextOpen();
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    this.spareNormal = r * Math.sin(theta);
    return r * Math.cos(theta);
  }

  /** Gamma(shape, 1) via Marsaglia–Tsang; boosted for shape < 1. */
  gamma(shape: number): number {
    if (shape < 1) {
      const u = this.nextOpen();
      return this.gamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.nextOpen();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  beta(alpha: number, beta: number): number {
    const x = this.gamma(alpha);
    const y = this.gamma(beta);
    return x / (x + y);
  }
}

/**
 * Independent stream for one node: mixes the document seed with a hash of the
 * node id so streams are stable under document edits elsewhere.
 */
export function nodeRng(seed: number, nodeId: string): Rng {
  return new Rng(((seed >>> 0) ^ fnv1a(nodeId)) >>> 0);
}
