import './learn.css';
import type { DemoMeta } from '../core/demo';
import type { Route } from '../router';
import { page } from '../ui/page';
import { el } from '../ui/dom';
import { loadChapters, type Chapter } from './chapters';
import { loadHighlighter } from './highlight';
import { resolveImage } from './images';
import { renderMarkdown } from './markdown';

type LearnRoute = Extract<Route, { kind: 'learn' | 'learn-index' }>;

const chapterNo = (c: Chapter) => (c.hasFrontMatter && c.order < 90 ? String(c.order).padStart(2, '0') : '');

export function scrollToFragment(fragment: string | null): void {
  const target = fragment ? document.getElementById(fragment) : null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

function chapterNav(chapters: readonly Chapter[], current: string | null): HTMLElement {
  const list = el(
    'ol',
    { className: 'learn-nav-list' },
    ...chapters.map((c) => {
      const a = el('a', { href: `#/learn/${c.slug}` }, el('span', { className: 'no', textContent: chapterNo(c) }), el('span', { textContent: c.title }));
      if (c.slug === current) a.setAttribute('aria-current', 'page');
      return el('li', {}, a);
    }),
  );
  const details = el('details', { className: 'learn-nav' }, el('summary', { textContent: '목차' }), list);
  const wide = matchMedia('(min-width: 1000px)');
  const sync = () => void (details.open = wide.matches);
  sync();
  wide.addEventListener('change', sync);
  return details;
}

function indexView(chapters: readonly Chapter[]): HTMLElement {
  const items = chapters.map((c) =>
    el(
      'li',
      { className: 'path-item' },
      el('a', { href: `#/learn/${c.slug}` }, el('span', { className: 'no', textContent: chapterNo(c) }), el('span', {}, el('strong', { textContent: c.title }), c.summary ? el('span', { className: 'sum', textContent: c.summary }) : null)),
    ),
  );
  return page(
    { title: '학습', lede: 'GPU 프로그래밍을 처음 접하는 웹 개발자를 위한 순서입니다. 위에서부터 읽고, 장마다 붙은 데모를 열어 숫자를 직접 확인하세요.' },
    el('ol', { className: 'path-list' }, ...(items.length ? items : [el('li', { className: 'path-empty', textContent: '아직 등록된 장이 없습니다.' })])),
  );
}

function neighbour(c: Chapter | undefined, dir: 'prev' | 'next'): HTMLElement | null {
  if (!c) return null;
  return el('a', { className: `pn pn-${dir}`, href: `#/learn/${c.slug}` }, el('span', { className: 'pn-dir', textContent: dir === 'prev' ? '이전 장' : '다음 장' }), el('span', { className: 'pn-title', textContent: c.title }));
}

async function chapterView(chapters: readonly Chapter[], slug: string, demos: readonly DemoMeta[]): Promise<HTMLElement | null> {
  const i = chapters.findIndex((c) => c.slug === slug);
  const chapter = chapters[i];
  if (!chapter) return null;
  const highlight = await loadHighlighter().catch(() => undefined);
  const article = el('div', { className: 'prose' });
  article.innerHTML = renderMarkdown(chapter.body, { slug, resolveImage, highlight });

  const demo = chapter.demo ? demos.find((d) => d.id === chapter.demo) : undefined;
  const head = el(
    'header',
    { className: 'learn-head' },
    chapterNo(chapter) ? el('div', { className: 'eyebrow', textContent: `${chapterNo(chapter)}장` }) : null,
    el('h1', { textContent: chapter.title }),
    chapter.summary ? el('p', { className: 'lede', textContent: chapter.summary }) : null,
    demo ? el('a', { className: 'demo-button', href: `#/${demo.id}`, textContent: `데모 열기: ${demo.title}` }) : null,
  );
  const pn = el('nav', { className: 'pn-row', ariaLabel: '장 이동' }, neighbour(chapters[i - 1], 'prev'), neighbour(chapters[i + 1], 'next'));
  return el('div', { className: 'learn' }, chapterNav(chapters, slug), el('article', { className: 'learn-article' }, head, article, pn));
}

export async function renderLearn(root: HTMLElement, route: LearnRoute, demos: readonly DemoMeta[]): Promise<void> {
  const chapters = await loadChapters();
  if (route.kind === 'learn-index') {
    root.replaceChildren(indexView(chapters));
    return scrollToFragment(null);
  }
  const view = await chapterView(chapters, route.slug, demos);
  if (!view) {
    root.replaceChildren(
      page({ title: '찾을 수 없는 장', lede: `"${route.slug}" 장이 없습니다.` }, el('p', {}, el('a', { href: '#/learn', textContent: '학습 목차로' }))),
    );
    return scrollToFragment(null);
  }
  root.replaceChildren(view);
  scrollToFragment(route.fragment);
}
