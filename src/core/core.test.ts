import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { summarize } from './stats';
import { rampMaxN, trialPasses, type RunResult } from './bench';

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 20 }, a);
    const seqB = Array.from({ length: 20 }, b);
    expect(seqA).toEqual(seqB);
  });

  it('differs across seeds and stays in [0, 1)', () => {
    const a = Array.from({ length: 1000 }, mulberry32(1));
    const b = Array.from({ length: 1000 }, mulberry32(2));
    expect(a).not.toEqual(b);
    expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('summarize', () => {
  it('computes order statistics for an odd sample', () => {
    const s = summarize([5, 1, 3, 2, 4]);
    expect(s).toEqual({ median: 3, p95: 5, mean: 3, min: 1, max: 5, n: 5 });
  });

  it('averages the middle pair for an even sample', () => {
    expect(summarize([1, 2, 3, 4]).median).toBe(2.5);
  });

  it('uses nearest-rank p95', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarize(xs).p95).toBe(95);
  });

  it('rejects an empty sample', () => {
    expect(() => summarize([])).toThrow();
  });
});

describe('rampMaxN', () => {
  const threshold = (limit: number) => async (n: number) => n <= limit;

  it('finds the limit within the requested precision', async () => {
    const limit = 123_456;
    const { maxN } = await rampMaxN(threshold(limit), { precision: 0.05 });
    expect(maxN).toBeLessThanOrEqual(limit);
    expect((limit - maxN) / maxN).toBeLessThanOrEqual(0.05);
  });

  it('returns 0 when the start size already fails', async () => {
    expect((await rampMaxN(threshold(10), { start: 1000 })).maxN).toBe(0);
  });

  it('caps at max when every trial passes', async () => {
    const r = await rampMaxN(async () => true, { start: 1000, max: 8000 });
    expect(r.maxN).toBe(8000);
    expect(r.trials.map((t) => t.n)).toEqual([1000, 2000, 4000, 8000]);
  });

  it('records every trial it ran', async () => {
    const r = await rampMaxN(threshold(5000), { start: 1000, max: 100_000 });
    expect(r.trials.slice(0, 4).map((t) => t.pass)).toEqual([true, true, true, false]);
  });
});

describe('trialPasses', () => {
  const base = (median: number, droppedRatio: number, effectiveFrameMs = median): RunResult => ({
    rendererId: 'canvas2d',
    count: 1,
    refreshHz: 60,
    frames: 120,
    interval: { median, p95: median, mean: median, min: median, max: median, n: 120 },
    cpu: { median: 1, p95: 1, mean: 1, min: 1, max: 1, n: 120 },
    gpu: null,
    longFrames: null,
    droppedRatio,
    effectiveFrameMs,
  });

  it('passes a steady 60 Hz run', () => {
    expect(trialPasses(base(16.7, 0))).toBe(true);
  });

  it('fails when the median interval exceeds 1.1 periods', () => {
    expect(trialPasses(base(19, 0))).toBe(false);
  });

  it('fails when more than 5% of frames dropped', () => {
    expect(trialPasses(base(16.7, 0.06))).toBe(false);
  });

  it('fails a GPU-backlogged run whose rAF interval still looks steady', () => {
    expect(trialPasses(base(16.7, 0, 78))).toBe(false);
  });
});
