import { GITHUB_URL } from '../ui/dom';

export interface Link {
  href: string;
  external: boolean;
}

/** Maps a Markdown link in `docs/learn/<slug>.md` to an app route or a GitHub URL. */
export function rewriteHref(href: string, slug: string): Link {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return { href, external: true };
  if (href.startsWith('#')) return { href: `#/learn/${slug}${href}`, external: false };
  const chapter = /^(?:\.\/)?([^/#?]+)\.md(#.*)?$/.exec(href);
  if (chapter) return { href: `#/learn/${chapter[1]}${chapter[2] ?? ''}`, external: false };
  const url = new URL(href, 'https://repo.invalid/docs/learn/');
  return { href: `${GITHUB_URL}/blob/main${url.pathname}${url.hash}`, external: true };
}

export function slugifyHeading(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section';
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}
