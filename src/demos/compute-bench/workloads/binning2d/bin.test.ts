import { describe, expect, it } from 'vitest';
import { BINS, GRID, binOf, clusteredPoints, compareCounts, referenceCounts } from './bin';

describe('binOf', () => {
  it('floors x * 512 and clamps to 511', () => {
    expect(binOf(0)).toBe(0);
    expect(binOf(1 / 512)).toBe(1);
    expect(binOf(Math.fround(1 - 2 ** -24))).toBe(GRID - 1);
    expect(binOf(1)).toBe(GRID - 1);
  });
});

describe('clusteredPoints', () => {
  it('is deterministic and stays inside [0, 1)', () => {
    const a = clusteredPoints(5000, 7);
    expect(a).toEqual(clusteredPoints(5000, 7));
    expect(a).not.toEqual(clusteredPoints(5000, 8));
    expect(a.length).toBe(10000);
    expect(a.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('is clustered: the busiest bin holds far more than a uniform spread would', () => {
    const n = 100_000;
    const counts = referenceCounts(clusteredPoints(n, 1));
    expect(counts.reduce((m, v) => Math.max(m, v), 0)).toBeGreaterThan(50 * (n / BINS));
  });
});

describe('compareCounts', () => {
  const points = clusteredPoints(1000, 3);
  const ref = referenceCounts(points);

  it('accepts the reference and conserves n', () => {
    expect(ref.reduce((s, v) => s + v, 0)).toBe(1000);
    expect(compareCounts(1000, ref, ref).ok).toBe(true);
  });

  it('rejects a moved point and a wrong length', () => {
    const bad = ref.slice();
    const i = bad.findIndex((v) => v > 0);
    bad[i]!--;
    bad[(i + 1) % BINS]!++;
    expect(compareCounts(1000, bad, ref).ok).toBe(false);
    expect(compareCounts(1000, ref.slice(1), ref).ok).toBe(false);
  });
});
