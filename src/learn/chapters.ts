import { parseFrontMatter } from './frontmatter';

export interface Chapter {
  /** File name without `.md`, also the route: `#/learn/<slug>`. */
  slug: string;
  order: number;
  title: string;
  summary: string;
  demo?: string;
  /** Markdown without front matter and without the leading `# title` line. */
  body: string;
  hasFrontMatter: boolean;
}

export const DEFAULT_ORDER = 50;

const sources = import.meta.glob<string>('/docs/learn/*.md', { query: '?raw', import: 'default' });

function plain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstParagraph(body: string): string {
  const para = body.split(/\n{2,}/).find((p) => p.trim() && !/^\s*(#|```|>|[-*|]|\d+\.)/.test(p));
  const text = para ? plain(para) : '';
  return text.length > 90 ? `${text.slice(0, 88)}…` : text;
}

export function parseChapter(slug: string, raw: string): Chapter {
  const { data, body: afterFm, found } = parseFrontMatter(raw);
  const heading = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(afterFm);
  const body = heading ? afterFm.slice(heading[0].length) : afterFm;
  return {
    slug,
    order: data.order ?? DEFAULT_ORDER,
    title: data.title ?? (heading ? plain(heading[1]!) : slug),
    summary: data.summary ?? firstParagraph(body),
    demo: data.demo,
    body,
    hasFrontMatter: found,
  };
}

let cache: Promise<Chapter[]> | null = null;

export function loadChapters(): Promise<Chapter[]> {
  cache ??= Promise.all(
    Object.entries(sources).map(async ([path, load]) => parseChapter(/([^/]+)\.md$/.exec(path)![1]!, await load())),
  ).then((list) => list.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug)));
  return cache;
}

export async function chapterTitle(slug: string): Promise<string | null> {
  return (await loadChapters()).find((c) => c.slug === slug)?.title ?? null;
}
