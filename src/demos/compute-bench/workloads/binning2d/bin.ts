import { mulberry32 } from '../../../../core/rng';

export const GRID = 512;
export const BINS = GRID * GRID;
const BELOW_ONE = 1 - 2 ** -24;
const CLUSTERS = 8;
const BACKGROUND = 0.05;

/** Bin rule shared with the WGSL kernels: min(floor(x * 512), 511). x * 512 is exact in f32 and f64. */
export function binOf(v: number): number {
  return Math.min(Math.floor(v * GRID), GRID - 1);
}

export function binInto(points: Float32Array, counts: Uint32Array): void {
  for (let i = 0; i < points.length; i += 2) counts[binOf(points[i + 1]!) * GRID + binOf(points[i]!)]!++;
}

/** Interleaved (x, y) f32 in [0, 1): a deterministic Gaussian mixture plus a thin uniform background. */
export function clusteredPoints(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const centers = Array.from({ length: CLUSTERS }, () => ({
    x: 0.1 + 0.8 * rand(),
    y: 0.1 + 0.8 * rand(),
    sigma: 0.01 + 0.05 * rand(),
  }));
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    if (rand() < BACKGROUND) {
      out[2 * i] = rand();
      out[2 * i + 1] = rand();
    } else {
      const c = centers[Math.floor(rand() * CLUSTERS)]!;
      out[2 * i] = Math.min(Math.max(c.x + c.sigma * gauss(), 0), BELOW_ONE);
      out[2 * i + 1] = Math.min(Math.max(c.y + c.sigma * gauss(), 0), BELOW_ONE);
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i]! >= 1) out[i] = BELOW_ONE;
  return out;
}

export function referenceCounts(points: Float32Array): Uint32Array {
  const counts = new Uint32Array(BINS);
  binInto(points, counts);
  return counts;
}

export function compareCounts(n: number, got: Uint32Array, ref: Uint32Array): { ok: boolean; detail: string } {
  if (got.length !== BINS) return { ok: false, detail: `길이 ${got.length} (기대 ${BINS})` };
  let sum = 0;
  let bad = -1;
  for (let i = 0; i < BINS; i++) {
    sum += got[i]!;
    if (bad < 0 && got[i] !== ref[i]) bad = i;
  }
  if (bad >= 0) return { ok: false, detail: `빈 ${bad}: ${got[bad]} (기준 ${ref[bad]})` };
  if (sum !== n) return { ok: false, detail: `합계 ${sum} != n ${n}` };
  return { ok: true, detail: `512×512 빈 전부 일치, 합계 ${sum} = n` };
}
