import { describe, expect, it } from 'vitest';
import { workload } from './index';

describe('verify', () => {
  const input = workload.makeInput(2000, 42);
  const sorted = input.slice().sort();

  it('accepts the sorted copy', () => {
    expect(workload.verify(input, sorted).ok).toBe(true);
  });

  it('rejects unsorted output, a replaced key and a wrong length', () => {
    const swapped = sorted.slice();
    [swapped[10], swapped[11]] = [swapped[11]!, swapped[10]!];
    expect(workload.verify(input, swapped).ok).toBe(false);
    const replaced = sorted.slice();
    replaced[5] = replaced[6]!;
    expect(workload.verify(input, replaced).ok).toBe(false);
    expect(workload.verify(input, sorted.slice(1)).ok).toBe(false);
  });

  it('rejects the result of an unstable per-digit scatter', () => {
    let cur = input;
    for (let shift = 0; shift < 32; shift += 8) {
      const buckets: number[][] = Array.from({ length: 256 }, () => []);
      for (const k of cur) buckets[(k >>> shift) & 0xff]!.push(k);
      cur = Uint32Array.from(buckets.flatMap((b) => b.reverse()));
    }
    expect(workload.verify(input, cur).ok).toBe(false);
  });
});
