import { Marked, Renderer, type Tokens } from 'marked';
import { CALLOUT_KINDS, calloutClass, isCalloutKind } from '../ui/callout';
import { rewriteHref, slugifyHeading } from './links';

export interface RenderOptions {
  slug: string;
  /** Raw SVG markup for an `img/...` reference, or null when unknown. Inlined so `currentColor` follows the theme. */
  resolveImage?: (href: string) => string | null;
  /** Highlighted HTML for a fenced block, or null to fall back to plain text. */
  highlight?: (code: string, lang: string) => string | null;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function createRenderer(opts: RenderOptions): Renderer {
  const seen = new Map<string, number>();

  class LearnRenderer extends Renderer {
    override heading({ tokens, depth, text }: Tokens.Heading): string {
      const id = slugifyHeading(text, seen);
      const inner = this.parser.parseInline(tokens);
      const anchor = `<a class="anchor" href="#/learn/${opts.slug}#${encodeURIComponent(id)}" aria-label="이 절의 링크">#</a>`;
      return `<h${depth} id="${escapeHtml(id)}">${inner}${anchor}</h${depth}>\n`;
    }

    override link({ href, title, tokens }: Tokens.Link): string {
      const link = rewriteHref(href, opts.slug);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      const ext = link.external ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${escapeHtml(link.href)}"${t}${ext}>${this.parser.parseInline(tokens)}</a>`;
    }

    override image({ href, text, title }: Tokens.Image): string {
      const svg = opts.resolveImage?.(href) ?? null;
      const alt = escapeHtml(text);
      const art = svg
        ? svg.replace(/^\s*<\?xml[^>]*\?>/, '').replace(/<svg\b/, `<svg role="img" aria-label="${alt}"`)
        : `<img src="${escapeHtml(href)}" alt="${alt}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
      return `<span class="diagram"><span class="diagram-art">${art}</span>${text ? `<span class="diagram-cap">${alt}</span>` : ''}</span>`;
    }

    override code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
      const html = opts.highlight?.(text, language) ?? null;
      const inner = html ?? `<pre><code>${escapeHtml(text)}</code></pre>`;
      return `<div class="code"${language ? ` data-lang="${escapeHtml(language)}"` : ''}>${inner}</div>\n`;
    }

    override table(token: Tokens.Table): string {
      return `<div class="table-wrap">${super.table(token)}</div>`;
    }

    override blockquote(token: Tokens.Blockquote): string {
      const { tokens } = token;
      const first = tokens[0];
      if (first?.type === 'paragraph') {
        const strong = (first.tokens ?? [])[0];
        if (strong?.type === 'strong') {
          const label = strong.text.trim().replace(/[:：]$/, '').trim();
          if (isCalloutKind(label)) {
            const rest = (first.tokens ?? []).slice(1).map((t) => (t.type === 'text' ? { ...t, text: t.text.replace(/^[\s:：]+/, '') } : t));
            const head = rest.length && rest.some((t) => t.type !== 'text' || t.text !== '') ? [{ ...first, tokens: rest }] : [];
            const body = this.parser.parse([...head, ...tokens.slice(1)]);
            return `<aside class="${calloutClass(label)}"><div class="callout-label">${label}</div>${body}</aside>\n`;
          }
        }
      }
      return super.blockquote(token);
    }
  }

  return new LearnRenderer();
}

export function renderMarkdown(body: string, opts: RenderOptions): string {
  return new Marked().parse(body, { gfm: true, async: false, renderer: createRenderer(opts) });
}

export { CALLOUT_KINDS };
