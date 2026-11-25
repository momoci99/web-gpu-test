import type { Capabilities } from '../core/capabilities';
import { el } from './dom';

export type CapsExtra = readonly (readonly [label: string, value: string])[];

export function capsRows(caps: Capabilities, extra: CapsExtra = []): [string, string][] {
  const gpu = caps.webgpu;
  return [
    ['WebGPU', gpu.kind === 'available' ? gpu.adapterInfo : `사용 불가 (${gpu.reason})`],
    ['timestamp-query', gpu.kind === 'available' && gpu.timestampQuery ? '지원' : '미지원'],
    ['WebGL2', caps.webgl2 ? '지원' : '미지원'],
    ['Long Animation Frames', caps.longAnimationFrames ? '지원' : '미지원'],
    ['DPR', String(caps.dpr)],
    ...extra.map(([l, v]): [string, string] => [l, v]),
  ];
}

/** Compact environment summary. Call `update` when an extra value (e.g. refresh rate) becomes known. */
export function capsPanel(caps: Capabilities, extra: CapsExtra = []): { el: HTMLElement; update(extra: CapsExtra): void } {
  const dl = el('dl', { className: 'caps-panel' });
  const render = (x: CapsExtra) => dl.replaceChildren(...capsRows(caps, x).flatMap(([l, v]) => [el('dt', { textContent: l }), el('dd', { textContent: v })]));
  render(extra);
  return { el: el('details', { className: 'caps-details' }, el('summary', { textContent: '측정 환경' }), dl), update: render };
}
