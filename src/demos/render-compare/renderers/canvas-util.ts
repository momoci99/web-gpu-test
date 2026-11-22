import type { SceneConfig } from '../scene';

export function mountCanvas(host: HTMLElement, config: SceneConfig, dpr: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(config.width * dpr);
  canvas.height = Math.round(config.height * dpr);
  canvas.style.width = `${config.width}px`;
  canvas.style.height = `${config.height}px`;
  host.replaceChildren(canvas);
  return canvas;
}
