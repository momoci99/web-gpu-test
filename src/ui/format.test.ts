import { describe, expect, it } from 'vitest';
import { compactNumber } from './format';

describe('compactNumber', () => {
  it('shortens log-axis ticks so they fit on a phone', () => {
    expect([1000, 10_000, 100_000, 1_000_000, 10_000_000, 1_500_000_000].map(compactNumber)).toEqual(['1K', '10K', '100K', '1M', '10M', '1.5G']);
    expect([0.001, 1, 512].map(compactNumber)).toEqual(['0.001', '1', '512']);
  });
});
