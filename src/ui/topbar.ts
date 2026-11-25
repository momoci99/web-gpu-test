import { el, GITHUB_URL } from './dom';

export type NavSection = 'demos' | 'learn' | null;

export function topbar(active: NavSection): HTMLElement {
  const link = (href: string, text: string, current: boolean) => {
    const a = el('a', { href, textContent: text });
    if (current) a.setAttribute('aria-current', 'page');
    return a;
  };
  return el(
    'header',
    { className: 'topbar' },
    el('a', { className: 'brand', href: '#', textContent: 'WebGPU 실험실' }),
    el('nav', { className: 'topnav' }, link('#', '데모', active === 'demos'), link('#/learn', '학습', active === 'learn')),
    el('a', { className: 'ext', href: GITHUB_URL, target: '_blank', rel: 'noopener', textContent: 'GitHub' }),
  );
}
