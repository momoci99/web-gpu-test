/** Keys one workgroup ranks per pass: 64 threads, 4 contiguous keys each. */
export const TILE = 256;
export const RADIX = 16;
export const DIGIT_BITS = 4;
export const PASSES = 32 / DIGIT_BITS;
/** Entries one scan workgroup covers: 256 threads, 2 entries each. */
export const SCAN_BLOCK = 512;
/** Dispatch limit per dimension; the count and scatter kernels use one workgroup per tile. */
export const MAX_WORKGROUPS = 65535;
export const MAX_KEYS = MAX_WORKGROUPS * TILE;

export function tileCount(n: number): number {
  return Math.ceil(n / TILE);
}

/** Entry counts of the scan hierarchy. levels[0] is the (digit, tile) table; the last level fits one block. */
export function scanLevels(entries: number): number[] {
  const levels = [entries];
  while (levels[levels.length - 1]! > SCAN_BLOCK) levels.push(Math.ceil(levels[levels.length - 1]! / SCAN_BLOCK));
  return levels;
}
