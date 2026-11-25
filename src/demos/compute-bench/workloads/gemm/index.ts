import { mulberry32 } from '../../../../core/rng';
import type { Workload } from '../../../../core/oneshot';
import { cpuIkj, cpuNaive } from './cpu';
import { gpuBlocked, gpuNaive, gpuTiled } from './gpu';
import type { GemmInput } from './types';
import { verifyGemm } from './verify';

export const workload: Workload<GemmInput, Float32Array> = {
  id: 'gemm',
  label: '행렬 곱 GEMM (C = A × B, f32)',
  summary: 'n×n 행렬 두 개를 곱합니다. 연산은 O(n³), 전송은 O(n²)라서 n이 커지면 GPU가 업로드·읽기 비용을 갚고 앞섭니다.',
  sizes: [32, 64, 128, 256, 512, 1024, 2048],
  smokeSizes: [32, 64, 128],
  sizeLabel: (n) => `${n}×${n}`,
  makeInput(n, seed) {
    const rand = mulberry32(seed);
    const fill = () => {
      const m = new Float32Array(n * n);
      for (let i = 0; i < m.length; i++) m[i] = rand() * 2 - 1;
      return m;
    };
    return { n, a: fill(), b: fill() };
  },
  impls: [cpuNaive, cpuIkj, gpuNaive, gpuTiled, gpuBlocked],
  verify: verifyGemm,
  work: (n) => ({ amount: (2 * n ** 3) / 1e9, unit: 'GFLOP' }),
};
