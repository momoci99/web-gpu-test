import { describe, expect, it } from 'vitest';
import { MAX_KEYS, RADIX, SCAN_BLOCK, TILE, scanLevels, tileCount } from './tiling';

describe('tileCount', () => {
  it('rounds up so a ragged tail gets its own tile', () => {
    expect(tileCount(1)).toBe(1);
    expect(tileCount(TILE)).toBe(1);
    expect(tileCount(TILE + 1)).toBe(2);
    expect(tileCount(1000)).toBe(4);
  });
});

describe('scanLevels', () => {
  it('is a single level when the table fits one block', () => {
    expect(scanLevels(1)).toEqual([1]);
    expect(scanLevels(SCAN_BLOCK)).toEqual([SCAN_BLOCK]);
  });

  it('adds a level per factor of SCAN_BLOCK', () => {
    expect(scanLevels(SCAN_BLOCK + 1)).toEqual([SCAN_BLOCK + 1, 2]);
    expect(scanLevels(RADIX * tileCount(2 ** 22))).toEqual([262144, 512]);
    expect(scanLevels(RADIX * tileCount(2 ** 24 - TILE))).toEqual([RADIX * 65535, 2048, 4]);
  });

  it('every level above the first covers the one below', () => {
    for (const entries of [513, 4096, 100000, 1048560]) {
      const levels = scanLevels(entries);
      levels.slice(1).forEach((m, k) => expect(m * SCAN_BLOCK).toBeGreaterThanOrEqual(levels[k]!));
      expect(levels[levels.length - 1]).toBeLessThanOrEqual(SCAN_BLOCK);
    }
  });
});

describe('MAX_KEYS', () => {
  it('keeps the tile count inside one dispatch dimension', () => {
    expect(tileCount(MAX_KEYS)).toBe(65535);
    expect(tileCount(MAX_KEYS + 1)).toBe(65536);
  });
});
