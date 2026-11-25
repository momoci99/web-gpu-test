import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../../core/rng';
import { radixSortU32 } from './cpu-radix';

function randomKeys(n: number, seed: number): Uint32Array {
  const rand = mulberry32(seed);
  return Uint32Array.from({ length: n }, () => Math.floor(rand() * 4294967296));
}

describe('radixSortU32', () => {
  it('matches the native sort, including keys above 2^31', () => {
    for (const n of [0, 1, 2, 255, 1000, 65537]) {
      const input = randomKeys(n, n + 1);
      expect(Array.from(radixSortU32(input))).toEqual(Array.from(input.slice().sort()));
    }
  });

  it('handles duplicates and extremes', () => {
    const input = Uint32Array.of(5, 0xffffffff, 0, 5, 0x80000000, 0x7fffffff, 0, 0xffffffff);
    expect(Array.from(radixSortU32(input))).toEqual([0, 0, 5, 5, 0x7fffffff, 0x80000000, 0xffffffff, 0xffffffff]);
  });

  it('leaves the input untouched and returns a distinct buffer', () => {
    const input = randomKeys(5000, 7);
    const before = input.slice();
    const out = radixSortU32(input);
    expect(out).not.toBe(input);
    expect(Array.from(input)).toEqual(Array.from(before));
  });

  it('is repeatable on the same input', () => {
    const input = randomKeys(3000, 3);
    expect(Array.from(radixSortU32(input))).toEqual(Array.from(radixSortU32(input)));
  });
});
