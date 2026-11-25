import { chapterTitle } from '../learn/chapters';
import { el, type Child } from './dom';

export interface PageSpec {
  title: string;
  lede: string;
  /** Learn chapter slug (file name without .md). The link appears once the chapter exists. */
  chapter?: string;
  /** Small line above the title, e.g. the demo group. */
  eyebrow?: string;
}

export function chapterLink(slug: string, text = '이 데모의 원리 읽기'): HTMLAnchorElement {
  const a = el('a', { className: 'chapter-link', href: `#/learn/${slug}`, hidden: true });
  void chapterTitle(slug).then((title) => {
    if (title === null) return;
    a.textContent = `${text}: ${title}`;
    a.hidden = false;
  });
  return a;
}

/** The article root of a demo page. Append `section()`s and `figure()`s to it, then `root.replaceChildren(article)`. */
export function page(spec: PageSpec, ...children: Child[]): HTMLElement {
  return el(
    'article',
    { className: 'page' },
    el(
      'header',
      { className: 'page-head' },
      spec.eyebrow ? el('div', { className: 'eyebrow', textContent: spec.eyebrow }) : null,
      el('h1', { textContent: spec.title }),
      el('p', { className: 'lede', textContent: spec.lede }),
      spec.chapter ? chapterLink(spec.chapter) : null,
    ),
    ...children,
  );
}

/** A titled block. Tables, charts and figures inside it break out to the wide column on their own. */
export function section(spec: { title: string }, ...children: Child[]): HTMLElement {
  return el('section', { className: 'page-section' }, el('h2', { textContent: spec.title }), ...children);
}
