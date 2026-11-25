export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  for (const [div, suffix] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (abs >= div) return `${+(n / div).toFixed(1)}${suffix}`;
  }
  return String(+n.toFixed(3));
}
