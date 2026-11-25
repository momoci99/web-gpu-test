import type { DemoMeta } from './core/demo';
import { loadChapters, type Chapter } from './learn/chapters';
import { el } from './ui/dom';

const DEMO_ACCENT: Record<string, string> = {
  'render-compare': 'var(--gpu-a)',
  'compute-bench': 'var(--gpu-b)',
  nbody: 'var(--gpu-c)',
  'webcam-filter': 'var(--cpu-a)',
};

const no = (c: Chapter) => (c.hasFrontMatter && c.order < 90 ? String(c.order).padStart(2, '0') : '');

export function renderHome(root: HTMLElement, metas: readonly DemoMeta[], notice?: string): void {
  const pathList = el('ol', { className: 'path-list' }, el('li', { className: 'path-empty', textContent: '불러오는 중…' }));
  const cards = metas.map((m) => {
    const rel = el('span', { className: 'rel' });
    rel.hidden = true;
    const card = el('a', { className: 'card', href: `#/${m.id}` }, el('strong', { textContent: m.title }), el('span', { className: 'sum', textContent: m.summary }), rel);
    card.dataset.demoId = m.id;
    card.style.setProperty('--card-accent', DEMO_ACCENT[m.id] ?? 'var(--border-strong)');
    return { card, rel, id: m.id };
  });

  root.replaceChildren(
    el(
      'div',
      { className: 'page home' },
      el(
        'header',
        { className: 'home-hero' },
        el('h1', { textContent: 'GPU는 언제 빨라지고, 언제 느릴까' }),
        el('p', { className: 'lede', textContent: '같은 일을 CPU, WebGL2, WebGPU로 시켜 보고 걸린 시간을 나란히 재는 학습용 사이트입니다.' }),
        el('p', { className: 'lede', textContent: '처음이라면 학습 경로를 위에서부터 읽고, 장마다 붙은 데모를 열어 숫자를 직접 확인해 보세요.' }),
      ),
      notice ? el('p', { className: 'notice', textContent: notice }) : null,
      el('h2', { textContent: '학습 경로' }),
      pathList,
      el('h2', { textContent: '데모' }),
      el('div', { className: 'demo-list' }, ...cards.map((c) => c.card)),
    ),
  );

  void loadChapters().then((chapters) => {
    pathList.replaceChildren(
      ...(chapters.length
        ? chapters.map((c) =>
            el(
              'li',
              { className: 'path-item' },
              el('a', { href: `#/learn/${c.slug}` }, el('span', { className: 'no', textContent: no(c) }), el('span', {}, el('strong', { textContent: c.title }), c.summary ? el('span', { className: 'sum', textContent: c.summary }) : null)),
            ),
          )
        : [el('li', { className: 'path-empty', textContent: '아직 등록된 장이 없습니다.' })]),
    );
    for (const { rel, id } of cards) {
      const related = chapters.filter((c) => c.demo === id);
      if (!related.length) continue;
      rel.textContent = `관련 장: ${related.map((c) => c.title).join(', ')}`;
      rel.hidden = false;
    }
  });
}
