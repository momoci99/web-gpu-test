export interface GemmInput {
  n: number;
  /** Row-major n x n. */
  a: Float32Array;
  /** Row-major n x n. */
  b: Float32Array;
}
