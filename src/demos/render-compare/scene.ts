import { mulberry32 } from '../../core/rng';

export interface SceneConfig {
  seed: number;
  count: number;
  width: number;
  height: number;
}

export interface SceneData {
  config: SceneConfig;
  /** Interleaved [x, y, vx, vy] per instance, CSS px and px/s. The only per-frame mutable data. */
  state: Float32Array;
  radius: Float32Array;
  /** RGBA8 packed with r in the low byte. Alpha is below 255 so blending cost is real. */
  color: Uint32Array;
}

export const FIXED_DT = 1 / 60;
export const STATE_STRIDE = 4;

const MIN_RADIUS = 3;
const MAX_RADIUS = 8;
const MIN_SPEED = 40;
const MAX_SPEED = 200;
const MIN_ALPHA = 90;
const MAX_ALPHA = 200;

export function createScene(config: SceneConfig): SceneData {
  const { count, width, height } = config;
  const rand = mulberry32(config.seed);
  const state = new Float32Array(count * STATE_STRIDE);
  const radius = new Float32Array(count);
  const color = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const r = Math.fround(MIN_RADIUS + rand() * (MAX_RADIUS - MIN_RADIUS));
    const angle = rand() * Math.PI * 2;
    const speed = MIN_SPEED + rand() * (MAX_SPEED - MIN_SPEED);
    const o = i * STATE_STRIDE;
    state[o] = r + rand() * (width - 2 * r);
    state[o + 1] = r + rand() * (height - 2 * r);
    state[o + 2] = Math.cos(angle) * speed;
    state[o + 3] = Math.sin(angle) * speed;
    radius[i] = r;
    const cr = Math.floor(rand() * 256);
    const cg = Math.floor(rand() * 256);
    const cb = Math.floor(rand() * 256);
    const ca = MIN_ALPHA + Math.floor(rand() * (MAX_ALPHA - MIN_ALPHA + 1));
    color[i] = (cr | (cg << 8) | (cb << 16) | (ca << 24)) >>> 0;
  }
  return { config, state, radius, color };
}

/** Float32 arithmetic is mirrored with Math.fround so the WGSL pass can match it. */
function bounceAxis(state: Float32Array, pi: number, vi: number, r: number, size: number, dt: number): void {
  let p = Math.fround(state[pi]! + Math.fround(state[vi]! * dt));
  let v = state[vi]!;
  if (p - r < 0) {
    p = r;
    v = Math.abs(v);
  }
  if (p + r > size) {
    p = Math.fround(size - r);
    v = -Math.abs(v);
  }
  state[pi] = p;
  state[vi] = v;
}

export function stepScene(scene: SceneData, dt: number): void {
  const { state, radius, config } = scene;
  const fdt = Math.fround(dt);
  for (let i = 0; i < config.count; i++) {
    const o = i * STATE_STRIDE;
    const r = radius[i]!;
    bounceAxis(state, o, o + 2, r, config.width, fdt);
    bounceAxis(state, o + 1, o + 3, r, config.height, fdt);
  }
}

export function unpackColor(packed: number): { r: number; g: number; b: number; a: number } {
  return { r: packed & 0xff, g: (packed >>> 8) & 0xff, b: (packed >>> 16) & 0xff, a: packed >>> 24 };
}
