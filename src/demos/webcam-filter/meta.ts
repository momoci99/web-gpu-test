import type { DemoMeta } from '../../core/demo';

export const meta: DemoMeta = {
  id: 'webcam-filter',
  title: '웹캠 필터: 블러와 엣지 검출',
  summary: '비디오 스트림에 가우시안 블러, 소벨, 그레이스케일을 적용해 CPU(getImageData)와 WebGPU 컴퓨트를 비교하고 블러 반경에 따른 비용 증가를 봅니다.',
  order: 40,
};
