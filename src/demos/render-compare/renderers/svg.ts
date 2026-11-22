import { FIXED_DT, STATE_STRIDE, stepScene, unpackColor } from '../scene';
import type { RendererEntry } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const svgEntry: RendererEntry = {
  id: 'svg',
  label: 'SVG',
  summary: '원마다 <circle> DOM 노드를 만들고 매 프레임 cx/cy 속성을 갱신합니다.',
  requires: 'none',
  async create(host, scene) {
    const { width, height, count } = scene.config;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const circles: SVGCircleElement[] = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const c = unpackColor(scene.color[i]!);
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('r', String(scene.radius[i]));
      el.setAttribute('fill', `rgb(${c.r} ${c.g} ${c.b})`);
      el.setAttribute('fill-opacity', String(c.a / 255));
      circles.push(el);
      frag.appendChild(el);
    }
    svg.appendChild(frag);
    host.replaceChildren(svg);

    return {
      id: 'svg',
      frame() {
        stepScene(scene, FIXED_DT);
        const s = scene.state;
        for (let i = 0; i < count; i++) {
          const el = circles[i]!;
          el.setAttribute('cx', String(s[i * STATE_STRIDE]));
          el.setAttribute('cy', String(s[i * STATE_STRIDE + 1]));
        }
      },
      dispose() {
        svg.remove();
      },
    };
  },
};
