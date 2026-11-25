import { mulberry32 } from '../../../../core/rng';
import type { CheckResult } from '../../../../core/oneshot';
import type { GemmInput } from './types';

const SAMPLES = 64;
const U32 = 2 ** -24;
const TOLERANCE_FACTOR = 8;

export function verifyGemm({ n, a, b }: GemmInput, c: Float32Array): CheckResult {
  if (c.length !== n * n) return { ok: false, detail: `출력 길이 ${c.length}, 기대 ${n * n}` };
  const rand = mulberry32(0x9e3779b9);
  let worst = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const i = Math.floor(rand() * n);
    const j = Math.floor(rand() * n);
    let ref = 0;
    let magnitude = 0;
    for (let k = 0; k < n; k++) {
      const p = a[i * n + k]! * b[k * n + j]!;
      ref += p;
      magnitude += Math.abs(p);
    }
    const tol = TOLERANCE_FACTOR * Math.sqrt(n) * U32 * magnitude;
    const ratio = Math.abs(c[i * n + j]! - ref) / tol;
    if (!Number.isFinite(ratio)) return { ok: false, detail: `C[${i}][${j}]가 유한하지 않음` };
    worst = Math.max(worst, ratio);
  }
  return {
    ok: worst <= 1,
    detail: `무작위 ${SAMPLES}개 원소를 f64 내적과 비교, 허용 오차 = ${TOLERANCE_FACTOR}·√n·2^-24·Σ|a·b| (최대 오차/허용 ${worst.toFixed(3)})`,
  };
}
