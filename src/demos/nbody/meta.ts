import type { DemoMeta } from '../../core/demo';

export const meta: DemoMeta = {
  id: 'nbody',
  title: 'N체 중력 시뮬레이션',
  summary: '모든 쌍(O(N²))의 중력을 계산하는 입자 시뮬레이션을 CPU(JS), GPU 순진한 커널, GPU 타일링 커널로 비교합니다.',
  order: 40,
};
