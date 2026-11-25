import type { CpuImpl } from '../../../../core/oneshot';
import type { GemmInput } from './types';

export function gemmNaive({ n, a, b }: GemmInput): Float32Array {
  const c = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += a[i * n + k]! * b[k * n + j]!;
      c[i * n + j] = acc;
    }
  }
  return c;
}

export function gemmIkj({ n, a, b }: GemmInput): Float32Array {
  const c = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const cRow = i * n;
    for (let k = 0; k < n; k++) {
      const aik = a[i * n + k]!;
      const bRow = k * n;
      for (let j = 0; j < n; j++) c[cRow + j]! += aik * b[bRow + j]!;
    }
  }
  return c;
}

export const cpuNaive: CpuImpl<GemmInput, Float32Array> = {
  kind: 'cpu',
  id: 'cpu-naive',
  label: 'CPU (i-j-k 삼중 루프)',
  maxN: 1024,
  run: gemmNaive,
};

export const cpuIkj: CpuImpl<GemmInput, Float32Array> = {
  kind: 'cpu',
  id: 'cpu-ikj',
  label: 'CPU (i-k-j, 행 단위 접근)',
  run: gemmIkj,
};
