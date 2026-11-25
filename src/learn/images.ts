const svgs = import.meta.glob<string>('/docs/learn/img/*.svg', { query: '?raw', import: 'default', eager: true });

/** Raw SVG for a Markdown reference like `img/gemm-tiling.svg`. */
export function resolveImage(href: string): string | null {
  return svgs[`/docs/learn/${href.replace(/^\.\//, '')}`] ?? null;
}
