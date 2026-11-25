import { describe, expect, it } from 'vitest';
import { createBodies, runCpu, SIM, stepCpu, throughput } from './sim';

describe('createBodies', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createBodies({ seed: 7, count: 64 });
    expect(Array.from(createBodies({ seed: 7, count: 64 }))).toEqual(Array.from(a));
    expect(Array.from(createBodies({ seed: 8, count: 64 }))).not.toEqual(Array.from(a));
  });

  it('puts every body inside the disc and rotates one way', () => {
    const s = createBodies({ seed: 1, count: 500 });
    let angularMomentum = 0;
    for (let i = 0; i < 500; i++) {
      const [x, y, vx, vy] = [s[i * 4]!, s[i * 4 + 1]!, s[i * 4 + 2]!, s[i * 4 + 3]!];
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(SIM.discRadius + 1e-3);
      angularMomentum += x * vy - y * vx;
    }
    expect(angularMomentum).toBeGreaterThan(0);
  });
});

describe('stepCpu', () => {
  it('pulls two bodies toward each other with equal and opposite velocity change', () => {
    const src = new Float32Array([-50, 0, 0, 0, 50, 0, 0, 0]);
    const dst = new Float32Array(8);
    stepCpu(src, dst, 2);
    expect(dst[2]!).toBeGreaterThan(0);
    expect(dst[6]!).toBeLessThan(0);
    expect(dst[2]! + dst[6]!).toBeCloseTo(0, 6);
    expect(dst[3]).toBe(0);
  });

  it('matches the hand-computed softened force and symplectic update', () => {
    const src = new Float32Array([0, 0, 0, 0, 30, 40, 0, 0]);
    const dst = new Float32Array(8);
    stepCpu(src, dst, 2);
    const r2 = 2500 + SIM.eps * SIM.eps;
    const dv = (SIM.gm / 2) * SIM.dt * (30 / Math.pow(r2, 1.5));
    expect(dst[2]!).toBeCloseTo(dv, 5);
    expect(dst[0]!).toBeCloseTo(dv * SIM.dt, 7);
  });

  it('exerts no self force', () => {
    const dst = new Float32Array(4);
    stepCpu(new Float32Array([5, 5, 1, 2]), dst, 1);
    expect(Array.from(dst)).toEqual([5 + SIM.dt, 5 + 2 * SIM.dt, 1, 2].map(Math.fround));
  });
});

describe('runCpu', () => {
  it('is reproducible, finite and leaves the input untouched', () => {
    const init = createBodies({ seed: 3, count: 200 });
    const copy = Array.from(init);
    const a = runCpu(init, 200, 20);
    expect(Array.from(init)).toEqual(copy);
    expect(Array.from(runCpu(init, 200, 20))).toEqual(Array.from(a));
    expect(a.every(Number.isFinite)).toBe(true);
  });

  it('keeps the disc bound over a short run', () => {
    const final = runCpu(createBodies({ seed: 1, count: 300 }), 300, 120);
    let maxR = 0;
    for (let i = 0; i < 300; i++) maxR = Math.max(maxR, Math.hypot(final[i * 4]!, final[i * 4 + 1]!));
    expect(maxR).toBeLessThan(SIM.discRadius * 1.2);
  });
});

describe('throughput', () => {
  it('counts N^2 pair interactions per step', () => {
    const t = throughput(1000, 2, 20);
    expect(t.stepsPerSec).toBeCloseTo(100);
    expect(t.pairsPerSec).toBeCloseTo(1e8);
  });
});
