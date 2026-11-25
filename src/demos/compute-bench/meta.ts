import type { DemoMeta } from '../../core/demo';

export const meta: DemoMeta = {
  id: 'compute-bench',
  title: '컴퓨트 벤치: CPU 대 GPU 교차점',
  summary: '리덕션 등 한 번 실행하는 계산을 입력 크기별로 CPU와 WebGPU로 돌려, GPU가 빨라지는 크기를 찾습니다.',
  order: 20,
};
