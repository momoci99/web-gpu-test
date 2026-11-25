import { gaussianWeights, LUMA, type FilterParams } from './filters';

/**
 * Straightforward typed-array implementation over RGBA bytes. Edges clamp to the border pixel.
 * The output alpha is 255; the sources are opaque.
 */
export class CpuFilter {
  readonly #w: number;
  readonly #h: number;
  readonly #tmp: Float32Array;
  readonly #luma: Float32Array;

  constructor(width: number, height: number) {
    this.#w = width;
    this.#h = height;
    this.#tmp = new Float32Array(width * height * 3);
    this.#luma = new Float32Array(width * height);
  }

  run(src: Uint8ClampedArray, dst: Uint8ClampedArray, { filter, radius }: FilterParams): void {
    if (filter === 'blur') this.#blur(src, dst, radius);
    else if (filter === 'sobel') this.#sobel(src, dst);
    else this.#grayscale(src, dst);
  }

  #grayscale(src: Uint8ClampedArray, dst: Uint8ClampedArray): void {
    for (let i = 0; i < src.length; i += 4) {
      const l = LUMA.r * src[i]! + LUMA.g * src[i + 1]! + LUMA.b * src[i + 2]!;
      dst[i] = dst[i + 1] = dst[i + 2] = l;
      dst[i + 3] = 255;
    }
  }

  #blur(src: Uint8ClampedArray, dst: Uint8ClampedArray, radius: number): void {
    const w = this.#w;
    const h = this.#h;
    const tmp = this.#tmp;
    const wt = gaussianWeights(radius);

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const c = (row + x) * 4;
        let r = wt[0]! * src[c]!;
        let g = wt[0]! * src[c + 1]!;
        let b = wt[0]! * src[c + 2]!;
        for (let k = 1; k <= radius; k++) {
          const wk = wt[k]!;
          const l = (row + (x - k < 0 ? 0 : x - k)) * 4;
          const rr = (row + (x + k >= w ? w - 1 : x + k)) * 4;
          r += wk * (src[l]! + src[rr]!);
          g += wk * (src[l + 1]! + src[rr + 1]!);
          b += wk * (src[l + 2]! + src[rr + 2]!);
        }
        const t = (row + x) * 3;
        tmp[t] = r;
        tmp[t + 1] = g;
        tmp[t + 2] = b;
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = (y * w + x) * 3;
        let r = wt[0]! * tmp[t]!;
        let g = wt[0]! * tmp[t + 1]!;
        let b = wt[0]! * tmp[t + 2]!;
        for (let k = 1; k <= radius; k++) {
          const wk = wt[k]!;
          const u = ((y - k < 0 ? 0 : y - k) * w + x) * 3;
          const d = ((y + k >= h ? h - 1 : y + k) * w + x) * 3;
          r += wk * (tmp[u]! + tmp[d]!);
          g += wk * (tmp[u + 1]! + tmp[d + 1]!);
          b += wk * (tmp[u + 2]! + tmp[d + 2]!);
        }
        const o = (y * w + x) * 4;
        dst[o] = r;
        dst[o + 1] = g;
        dst[o + 2] = b;
        dst[o + 3] = 255;
      }
    }
  }

  #sobel(src: Uint8ClampedArray, dst: Uint8ClampedArray): void {
    const w = this.#w;
    const h = this.#h;
    const lum = this.#luma;
    for (let i = 0, p = 0; p < w * h; i += 4, p++) {
      lum[p] = LUMA.r * src[i]! + LUMA.g * src[i + 1]! + LUMA.b * src[i + 2]!;
    }
    for (let y = 0; y < h; y++) {
      const r0 = (y > 0 ? y - 1 : 0) * w;
      const r1 = y * w;
      const r2 = (y < h - 1 ? y + 1 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        const xl = x > 0 ? x - 1 : 0;
        const xr = x < w - 1 ? x + 1 : w - 1;
        const gx = lum[r0 + xr]! + 2 * lum[r1 + xr]! + lum[r2 + xr]! - lum[r0 + xl]! - 2 * lum[r1 + xl]! - lum[r2 + xl]!;
        const gy = lum[r2 + xl]! + 2 * lum[r2 + x]! + lum[r2 + xr]! - lum[r0 + xl]! - 2 * lum[r0 + x]! - lum[r0 + xr]!;
        const m = Math.sqrt(gx * gx + gy * gy);
        const o = (r1 + x) * 4;
        dst[o] = dst[o + 1] = dst[o + 2] = m;
        dst[o + 3] = 255;
      }
    }
  }
}
