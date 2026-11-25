import { el } from './dom';

export type StatusTone = 'info' | 'ok' | 'error';

export function status(initial = '준비됨'): { el: HTMLElement; set(text: string, tone?: StatusTone): void } {
  const node = el('p', { className: 'status', textContent: initial });
  node.setAttribute('role', 'status');
  return {
    el: node,
    set(text, tone = 'info') {
      node.textContent = text;
      node.dataset.tone = tone;
    },
  };
}
