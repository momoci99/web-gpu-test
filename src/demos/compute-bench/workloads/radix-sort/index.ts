import { mulberry32 } from '../../../../core/rng';
import type { CpuImpl, Workload } from '../../../../core/oneshot';
import { radixSortU32 } from './cpu-radix';
import { gpuRadix } from './gpu-radix';

// Each run sorts a fresh copy (or fresh scratch buffers), so the copy and allocation cost is part of the CPU time.
const cpuTypedSort: CpuImpl<Uint32Array, Uint32Array> = {
  kind: 'cpu',
  id: 'cpu-typed-sort',
  label: 'CPU (Uint32Array.sort, 복사본 정렬)',
  run: (input) => input.slice().sort(),
};

const cpuRadix: CpuImpl<Uint32Array, Uint32Array> = {
  kind: 'cpu',
  id: 'cpu-radix',
  label: 'CPU (JS 기수 정렬, 8비트 x 4패스)',
  run: radixSortU32,
};

const isPow2 = (n: number) => Number.isInteger(Math.log2(n));

export const workload: Workload<Uint32Array, Uint32Array> = {
  id: 'radix-sort',
  label: '기수 정렬 (u32 키)',
  summary: 'N개의 u32 키를 오름차순으로 정렬합니다. 히스토그램, 스캔, 안정적 스캐터를 자릿수마다 반복하는 GPU 정렬을 CPU 정렬과 비교합니다.',
  sizes: Array.from({ length: 13 }, (_, i) => 2 ** (10 + i)),
  smokeSizes: [1000, 2 ** 16, 2 ** 20],
  sizeLabel: (n) => (isPow2(n) ? `2^${Math.log2(n)} (${n.toLocaleString('ko-KR')}개)` : `${n.toLocaleString('ko-KR')}개`),
  makeInput(n, seed) {
    const rand = mulberry32(seed);
    const keys = new Uint32Array(n);
    for (let i = 0; i < n; i++) keys[i] = Math.floor(rand() * 4294967296);
    return keys;
  },
  impls: [cpuTypedSort, cpuRadix, gpuRadix],
  verify(input, output) {
    if (output.length !== input.length) return { ok: false, detail: `길이 ${output.length} (기대 ${input.length})` };
    const ref = input.slice().sort();
    for (let i = 0; i < ref.length; i++) {
      if (output[i] !== ref[i]) return { ok: false, detail: `인덱스 ${i}: ${output[i]} (기대 ${ref[i]})` };
    }
    return { ok: true, detail: `정렬된 복사본과 ${ref.length.toLocaleString('ko-KR')}개 모두 일치 (정렬성과 멀티셋 동시 검증)` };
  },
  work: (n) => ({ amount: n / 1e6, unit: 'M키' }),
};
