const BITS = 8;
const BUCKETS = 1 << BITS;
const PASSES = 32 / BITS;

/** LSD radix sort, 8-bit digits, 4 passes, ping-pong between two scratch buffers. Never writes to `input`. */
export function radixSortU32(input: Uint32Array): Uint32Array {
  const n = input.length;
  const a = new Uint32Array(n);
  const b = new Uint32Array(n);
  const count = new Uint32Array(BUCKETS);
  let src = input;
  let dst = a;
  for (let pass = 0; pass < PASSES; pass++) {
    const shift = pass * BITS;
    count.fill(0);
    for (let i = 0; i < n; i++) count[(src[i]! >>> shift) & 0xff]!++;
    let sum = 0;
    for (let d = 0; d < BUCKETS; d++) {
      const c = count[d]!;
      count[d] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const key = src[i]!;
      dst[count[(key >>> shift) & 0xff]!++] = key;
    }
    src = dst;
    dst = src === a ? b : a;
  }
  return src;
}
