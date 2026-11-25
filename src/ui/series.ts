/** Fixed series roles: cpu-* are warm, gpu-* are cool. The same role keeps the same color on every page. */
export type SeriesToken = 'cpu-a' | 'cpu-b' | 'gpu-a' | 'gpu-b' | 'gpu-c';

export const seriesVar = (token: SeriesToken): string => `var(--${token})`;

export function resolveCssColor(value: string, scope: Element = document.documentElement): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value);
  return m ? getComputedStyle(scope).getPropertyValue(m[1]!).trim() : value;
}
