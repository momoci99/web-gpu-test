import type { HighlighterCore } from 'shiki/core';

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;
const LANGS = new Set(['wgsl', 'ts', 'typescript', 'js', 'javascript']);

export type Highlight = (code: string, lang: string) => string | null;

let loading: Promise<Highlight> | null = null;

/** Loads shiki with three grammars and two themes. Only the learn pages pay for it. */
export function loadHighlighter(): Promise<Highlight> {
  loading ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, wgsl, ts, js, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs/wgsl.mjs'),
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ]);
    const hl: HighlighterCore = await createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [wgsl.default, ts.default, js.default],
      engine: createJavaScriptRegexEngine(),
    });
    return (code, lang) => (LANGS.has(lang) ? hl.codeToHtml(code, { lang, themes: THEMES, defaultColor: false }) : null);
  })();
  return loading;
}
