export interface Summary {
  median: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  n: number;
}

export function summarize(xs: readonly number[]): Summary {
  if (xs.length === 0) throw new RangeError('summarize: empty sample');
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  const median = n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const p95 = sorted[Math.ceil(0.95 * n) - 1]!;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  return { median, p95, mean, min: sorted[0]!, max: sorted[n - 1]!, n };
}
