import { rampMaxN } from '../../core/frame-bench';

export type FilterId = 'grayscale' | 'blur' | 'sobel';

export const FILTERS: readonly { id: FilterId; label: string }[] = [
  { id: 'grayscale', label: '그레이스케일 (픽셀 단위 연산)' },
  { id: 'blur', label: '가우시안 블러 (분리형)' },
  { id: 'sobel', label: '소벨 엣지 검출' },
];

export const MAX_RADIUS = 32;

export const RESOLUTIONS: readonly { width: number; height: number }[] = [
  { width: 640, height: 360 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
];

export interface FilterParams {
  filter: FilterId;
  radius: number;
}

/** Rec. 709 luma, shared by the grayscale and Sobel filters on both sides. */
export const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/**
 * One-sided Gaussian taps for a kernel of 2r+1 samples: index 0 is the center, index k the pair at +-k.
 * sigma = r / 2, normalized so the full kernel sums to 1. CPU and GPU both use these float32 values.
 */
export function gaussianWeights(radius: number): Float32Array {
  const sigma = Math.max(radius / 2, 0.5);
  const w = new Float64Array(radius + 1);
  let sum = 0;
  for (let k = 0; k <= radius; k++) {
    w[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
    sum += k === 0 ? w[k]! : 2 * w[k]!;
  }
  return Float32Array.from(w, (x) => x / sum);
}

/** Largest blur radius in 1..MAX_RADIUS for which `passes` holds; 0 when even radius 1 fails. */
export async function maxRadiusAtRefresh(passes: (radius: number) => Promise<boolean>): Promise<number> {
  const { maxN } = await rampMaxN(passes, { start: 1, max: MAX_RADIUS, precision: 0 });
  return maxN;
}
