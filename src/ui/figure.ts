import { el } from './dom';

export interface Figure {
  el: HTMLElement;
  /** Empty box a demo draws into (canvas, svg). */
  stage: HTMLElement;
  setCaption(text: string): void;
}

/** A stage with a caption. Full-width break-out by default; pass `wide: false` to stay in the reading column. */
export function figure(spec: { caption: string; wide?: boolean; width?: number; height?: number }): Figure {
  const stage = el('div', { className: 'stage' });
  if (spec.width) stage.style.maxWidth = `${spec.width}px`;
  if (spec.width && spec.height) stage.style.aspectRatio = `${spec.width} / ${spec.height}`;
  const caption = el('figcaption', { textContent: spec.caption });
  const root = el('figure', { className: spec.wide === false ? 'fig' : 'fig wide' }, stage, caption);
  return { el: root, stage, setCaption: (t) => void (caption.textContent = t) };
}
