import { mulberry32 } from '../../core/rng';

/** World units are CSS px. The disc is centred on the origin and the view spans [-VIEW_HALF, VIEW_HALF]. */
export const SIM = {
  dt: 1 / 60,
  /** G times total mass. Every body has mass 1/N of it, so the disc looks the same at any N. */
  gm: 6.75e6,
  /** Plummer softening length. */
  eps: 10,
  discRadius: 300,
} as const;

export const VIEW_HALF = 400;

export interface BodiesConfig {
  seed: number;
  count: number;
}

/** Interleaved [x, y, vx, vy] per body: a uniform disc on near-circular orbits around its enclosed mass. */
export function createBodies({ seed, count }: BodiesConfig): Float32Array {
  const rand = mulberry32(seed);
  const state = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = SIM.discRadius * Math.sqrt(rand());
    const theta = 2 * Math.PI * rand();
    const speed = (Math.sqrt(SIM.gm * r) / SIM.discRadius) * (1 + 0.05 * (rand() - 0.5));
    state[i * 4] = r * Math.cos(theta);
    state[i * 4 + 1] = r * Math.sin(theta);
    state[i * 4 + 2] = -speed * Math.sin(theta);
    state[i * 4 + 3] = speed * Math.cos(theta);
  }
  return state;
}

/**
 * One symplectic (semi-implicit) Euler step: v' = v + a(p) dt, then p' = p + v' dt.
 * Reads `src`, writes `dst`; the WGSL kernels use the same rule and the same ping-pong.
 * Accumulates in f64 and stores f32, like the f32 state buffer the GPU keeps.
 */
export function stepCpu(src: Float32Array, dst: Float32Array, count: number): void {
  const eps2 = SIM.eps * SIM.eps;
  const kdt = (SIM.gm / count) * SIM.dt;
  for (let i = 0; i < count; i++) {
    const xi = src[i * 4]!;
    const yi = src[i * 4 + 1]!;
    let ax = 0;
    let ay = 0;
    for (let j = 0; j < count; j++) {
      const dx = src[j * 4]! - xi;
      const dy = src[j * 4 + 1]! - yi;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + eps2);
      const inv3 = inv * inv * inv;
      ax += dx * inv3;
      ay += dy * inv3;
    }
    const vx = src[i * 4 + 2]! + ax * kdt;
    const vy = src[i * 4 + 3]! + ay * kdt;
    dst[i * 4] = xi + vx * SIM.dt;
    dst[i * 4 + 1] = yi + vy * SIM.dt;
    dst[i * 4 + 2] = vx;
    dst[i * 4 + 3] = vy;
  }
}

/** Runs `steps` steps from `initial` and returns the final state. Does not modify `initial`. */
export function runCpu(initial: Float32Array, count: number, steps: number): Float32Array {
  let a = Float32Array.from(initial);
  let b = new Float32Array(initial.length);
  for (let s = 0; s < steps; s++) {
    stepCpu(a, b, count);
    [a, b] = [b, a];
  }
  return a;
}

export interface Throughput {
  stepsPerSec: number;
  pairsPerSec: number;
}

/** Wall-clock throughput. rAF caps it at the refresh rate while a variant keeps up, so it is a floor then. */
export function throughput(count: number, stepsPerFrame: number, effectiveFrameMs: number): Throughput {
  const stepsPerSec = (stepsPerFrame * 1000) / effectiveFrameMs;
  return { stepsPerSec, pairsPerSec: count * count * stepsPerSec };
}
