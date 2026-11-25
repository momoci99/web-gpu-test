import { describe, expect, it } from 'vitest';
import { gemmIkj, gemmNaive } from './cpu';
import { workload } from './index';
import { verifyGemm } from './verify';

const input = workload.makeInput(48, 7);

describe('gemm', () => {
  it('makeInput is deterministic and in [-1, 1]', () => {
    const again = workload.makeInput(48, 7);
    expect(again.a).toEqual(input.a);
    expect(again.b).toEqual(input.b);
    expect(Math.max(...input.a.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('cpu impls agree and pass verify', () => {
    const naive = gemmNaive(input);
    const ikj = gemmIkj(input);
    expect(verifyGemm(input, naive).ok).toBe(true);
    expect(verifyGemm(input, ikj).ok).toBe(true);
  });

  it('multiplies a known 2x2', () => {
    const c = gemmIkj({ n: 2, a: new Float32Array([1, 2, 3, 4]), b: new Float32Array([5, 6, 7, 8]) });
    expect([...c]).toEqual([19, 22, 43, 50]);
  });

  it('verify rejects a corrupted entry and a wrong length', () => {
    const c = gemmNaive(input);
    for (let i = 0; i < c.length; i++) c[i]! += 1e-2;
    expect(verifyGemm(input, c).ok).toBe(false);
    expect(verifyGemm(input, new Float32Array(3)).ok).toBe(false);
    const nan = gemmNaive(input).fill(NaN);
    expect(verifyGemm(input, nan).ok).toBe(false);
  });

  it('work counts 2n^3 FLOP in GFLOP', () => {
    expect(workload.work!(1000)).toEqual({ amount: 2, unit: 'GFLOP' });
  });
});
