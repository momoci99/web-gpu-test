import { FIXED_DT, STATE_STRIDE, stepScene, unpackColor } from '../scene';
import { mountCanvas } from './canvas-util';
import type { RendererEntry } from './types';

export const canvas2dEntry: RendererEntry = {
  id: 'canvas2d',
  label: 'Canvas2D',
  summary: '매 프레임 clearRect 후 원마다 arc + fill을 호출합니다. 색 문자열은 미리 계산해 둡니다.',
  requires: 'none',
  async create(host, scene, caps) {
    const { width, height, count } = scene.config;
    const canvas = mountCanvas(host, scene.config, caps.dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D 컨텍스트를 만들 수 없습니다');
    ctx.scale(caps.dpr, caps.dpr);
    const fills = Array.from(scene.color, (packed) => {
      const c = unpackColor(packed);
      return `rgb(${c.r} ${c.g} ${c.b} / ${c.a / 255})`;
    });
    const TAU = Math.PI * 2;

    return {
      id: 'canvas2d',
      frame() {
        stepScene(scene, FIXED_DT);
        const s = scene.state;
        ctx.clearRect(0, 0, width, height);
        for (let i = 0; i < count; i++) {
          ctx.fillStyle = fills[i]!;
          ctx.beginPath();
          ctx.arc(s[i * STATE_STRIDE]!, s[i * STATE_STRIDE + 1]!, scene.radius[i]!, 0, TAU);
          ctx.fill();
        }
      },
      dispose() {
        canvas.remove();
      },
    };
  },
};
