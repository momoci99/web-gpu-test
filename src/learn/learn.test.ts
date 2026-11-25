import { describe, expect, it } from 'vitest';
import fixture from '../ui/__fixtures__/chapter.md?raw';
import { parseChapter } from './chapters';
import { parseFrontMatter } from './frontmatter';
import { rewriteHref, slugifyHeading } from './links';
import { renderMarkdown } from './markdown';
import { parseRoute } from '../router';

describe('parseFrontMatter', () => {
  it('reads the four keys, strips quotes and trailing comments', () => {
    const { data, body, found } = parseFrontMatter(fixture);
    expect(found).toBe(true);
    expect(data).toEqual({ title: '워크그룹 메모리와 타일링', order: 4, summary: '타일링으로 글로벌 메모리 로드를 줄입니다: 행렬 곱 예제', demo: 'compute-bench' });
    expect(body.startsWith('\n# 워크그룹')).toBe(true);
  });

  it('keeps colons and parentheses inside values', () => {
    const { data } = parseFrontMatter('---\ntitle: 계산 결과를 바로 그리기 (N-body)\nsummary: CPU 대 GPU: 교차점\nrefs: x\n---\nb');
    expect(data).toEqual({ title: '계산 결과를 바로 그리기 (N-body)', summary: 'CPU 대 GPU: 교차점' });
  });

  it('treats a file without a closed block as plain Markdown', () => {
    expect(parseFrontMatter('# 제목\n\n본문')).toEqual({ data: {}, body: '# 제목\n\n본문', found: false });
    expect(parseFrontMatter('---\ntitle: x\n본문').found).toBe(false);
  });

  it('handles CRLF and ignores unknown keys and a non-numeric order', () => {
    const { data } = parseFrontMatter('---\r\ntitle: A\r\norder: x\r\nfoo: 1\r\n---\r\nbody');
    expect(data).toEqual({ title: 'A' });
  });
});

describe('parseChapter', () => {
  it('uses the first heading and order 50 without front matter', () => {
    const c = parseChapter('gemm', '# GEMM으로 배우는 컴퓨트\n\n`C = A × B`를 계산합니다.\n\n## 1. 실행');
    expect(c).toMatchObject({ slug: 'gemm', order: 50, title: 'GEMM으로 배우는 컴퓨트', hasFrontMatter: false });
    expect(c.body.startsWith('`C = A')).toBe(true);
    expect(c.summary).toBe('C = A × B를 계산합니다.');
  });

  it('prefers front matter', () => {
    expect(parseChapter('04-workgroup-memory', fixture)).toMatchObject({ order: 4, demo: 'compute-bench', hasFrontMatter: true });
  });
});

describe('rewriteHref', () => {
  it.each([
    ['04-workgroup-memory.md', '#/learn/04-workgroup-memory', false],
    ['./04-workgroup-memory.md#표', '#/learn/04-workgroup-memory#표', false],
    ['#메모리', '#/learn/00-why#메모리', false],
    ['https://gpuweb.github.io/gpuweb/', 'https://gpuweb.github.io/gpuweb/', true],
    ['../../src/core/oneshot.ts', 'https://github.com/momoci99/web-gpu-test/blob/main/src/core/oneshot.ts', true],
  ])('%s', (href, out, external) => {
    expect(rewriteHref(href, '00-why')).toEqual({ href: out, external });
  });
});

describe('slugifyHeading', () => {
  it('keeps Korean, drops punctuation, dedupes', () => {
    const seen = new Map<string, number>();
    expect(slugifyHeading('1. 메모리 계층 (GPU)', seen)).toBe('1-메모리-계층-gpu');
    expect(slugifyHeading('코드', seen)).toBe('코드');
    expect(slugifyHeading('코드', seen)).toBe('코드-2');
  });
});

describe('parseRoute', () => {
  it.each([
    ['', { kind: 'home' }],
    ['#/', { kind: 'home' }],
    ['#/learn', { kind: 'learn-index' }],
    ['#/learn/', { kind: 'learn-index' }],
    ['#/learn/04-x', { kind: 'learn', slug: '04-x', fragment: null }],
    ['#/learn/04-x#%EC%BD%94%EB%93%9C', { kind: 'learn', slug: '04-x', fragment: '코드' }],
    ['#/nbody', { kind: 'demo', id: 'nbody' }],
  ])('%s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});

describe('renderMarkdown on the fixture', () => {
  const body = parseChapter('04-workgroup-memory', fixture).body;
  const html = renderMarkdown(body, {
    slug: '04-workgroup-memory',
    resolveImage: (href) => (href === 'img/memory-hierarchy.svg' ? '<svg viewBox="0 0 1 1"></svg>' : null),
    highlight: (code, lang) => (lang === 'wgsl' ? `<pre class="shiki">${code}</pre>` : null),
  });

  it('renders all five callout kinds with their body', () => {
    for (const kind of ['핵심', '주의', '해보기', '측정 한계', '용어']) expect(html).toContain(`<div class="callout-label">${kind}</div>`);
    expect(html.match(/<aside class="callout /g)).toHaveLength(5);
    expect(html).toContain('두 번째 배리어를 빼면');
    expect(html).toContain('두 번째 문단도 같은 상자에 들어갑니다.');
    expect(html).not.toContain('<strong>핵심</strong>');
    expect(html).toContain('<blockquote>');
  });

  it('adds heading anchors with unique ids', () => {
    expect(html).toContain('<h2 id="메모리-계층">');
    expect(html).toContain('href="#/learn/04-workgroup-memory#%EB%A9%94%EB%AA%A8%EB%A6%AC-%EA%B3%84%EC%B8%B5"');
    expect(html).toContain('<h2 id="코드-2">');
  });

  it('rewrites links', () => {
    expect(html).toContain('href="#/learn/05-atomics"');
    expect(html).toContain('href="#/learn/09-measuring#타임스탬프"');
    expect(html).toContain('href="#/learn/04-workgroup-memory#메모리-계층"');
    expect(html).toContain('blob/main/src/demos/compute-bench/workloads/gemm/kernels.ts" target="_blank"');
  });

  it('inlines diagrams and wraps tables and code', () => {
    expect(html).toContain('<span class="diagram-art"><svg role="img" aria-label="메모리 계층 다이어그램" viewBox');
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain('<div class="code" data-lang="wgsl"><pre class="shiki">');
    expect(html).toContain('<div class="code" data-lang="ts"><pre><code>');
    expect(html).toContain('<div class="code" data-lang="text">');
  });

  it('strips scripts from inlined SVG', () => {
    const out = renderMarkdown('![x](img/a.svg)', { slug: 's', resolveImage: () => '<svg><script>alert(1)</script><path/></svg>' });
    expect(out).not.toContain('script');
    expect(out).toContain('<path/>');
  });

  it('falls back to <img> for an unknown image', () => {
    expect(renderMarkdown('![x](img/none.svg)', { slug: 's' })).toContain('<img src="img/none.svg" alt="x">');
  });
});
