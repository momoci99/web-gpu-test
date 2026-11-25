import { describe, expect, it } from 'vitest';
import { CpuFilter } from './cpu-filter';
import { gaussianWeights, MAX_RADIUS, maxRadiusAtRefresh } from './filters';

function image(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      out.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return out;
}

const px = (img: Uint8ClampedArray, w: number, x: number, y: number) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];

describe('gaussianWeights', () => {
  it('is normalized over the full 2r+1 kernel and decreases away from the center', () => {
    for (const r of [1, 4, 16, MAX_RADIUS]) {
      const w = gaussianWeights(r);
      expect(w).toHaveLength(r + 1);
      const sum = w[0]! + 2 * w.slice(1).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
      for (let k = 1; k <= r; k++) expect(w[k]!).toBeLessThan(w[k - 1]!);
    }
  });
});

describe('CpuFilter', () => {
  const w = 40;
  const h = 30;
  const f = new CpuFilter(w, h);
  const out = () => new Uint8ClampedArray(w * h * 4);

  it('blur keeps a constant image constant, edges included (clamp-to-edge)', () => {
    const src = image(w, h, () => [200, 100, 50]);
    const dst = out();
    f.run(src, dst, { filter: 'blur', radius: MAX_RADIUS });
    for (const [x, y] of [[0, 0], [w - 1, h - 1], [20, 15]] as const) expect(px(dst, w, x, y)).toEqual([200, 100, 50]);
  });

  it('blur spreads a bright pixel symmetrically and lowers its peak', () => {
    const src = image(w, h, (x, y) => (x === 20 && y === 15 ? [255, 255, 255] : [0, 0, 0]));
    const dst = out();
    f.run(src, dst, { filter: 'blur', radius: 4 });
    const peak = px(dst, w, 20, 15)[0]!;
    expect(peak).toBeLessThan(255);
    expect(peak).toBeGreaterThan(0);
    expect(px(dst, w, 18, 15)).toEqual(px(dst, w, 22, 15));
    expect(px(dst, w, 20, 13)).toEqual(px(dst, w, 20, 17));
    expect(px(dst, w, 20, 15)[0]!).toBeGreaterThan(px(dst, w, 22, 15)[0]!);
  });

  it('sobel is zero on a flat image and strong on a vertical step', () => {
    const flat = out();
    f.run(image(w, h, () => [90, 90, 90]), flat, { filter: 'sobel', radius: 1 });
    expect(px(flat, w, 10, 10)).toEqual([0, 0, 0]);
    const step = out();
    f.run(image(w, h, (x) => (x < 20 ? [0, 0, 0] : [255, 255, 255])), step, { filter: 'sobel', radius: 1 });
    expect(px(step, w, 19, 10)[0]).toBe(255);
    expect(px(step, w, 5, 10)[0]).toBe(0);
  });

  it('grayscale maps pure red to its Rec. 709 luma on every channel', () => {
    const dst = out();
    f.run(image(w, h, () => [255, 0, 0]), dst, { filter: 'grayscale', radius: 1 });
    expect(px(dst, w, 3, 3)).toEqual([54, 54, 54]);
  });
});

describe('maxRadiusAtRefresh', () => {
  const limit = (t: number) => async (r: number) => r <= t;
  it('finds the exact largest passing radius', async () => {
    expect(await maxRadiusAtRefresh(limit(11))).toBe(11);
    expect(await maxRadiusAtRefresh(limit(1))).toBe(1);
  });
  it('returns 0 when radius 1 already fails and the cap when nothing fails', async () => {
    expect(await maxRadiusAtRefresh(limit(0))).toBe(0);
    expect(await maxRadiusAtRefresh(limit(1000))).toBe(MAX_RADIUS);
  });
});
