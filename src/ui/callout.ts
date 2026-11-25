import { el } from './dom';

export const CALLOUT_KINDS = ['핵심', '주의', '해보기', '측정 한계', '용어'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export function isCalloutKind(label: string): label is CalloutKind {
  return (CALLOUT_KINDS as readonly string[]).includes(label);
}

export function calloutClass(kind: CalloutKind): string {
  return `callout callout-${CALLOUT_KINDS.indexOf(kind)}`;
}

/** `body` may be plain text, a node, or several nodes. */
export function callout(kind: CalloutKind, body: string | Node | Node[], title?: string): HTMLElement {
  const content = typeof body === 'string' ? [el('p', { textContent: body })] : Array.isArray(body) ? body : [body];
  return el(
    'aside',
    { className: calloutClass(kind) },
    el('div', { className: 'callout-label', textContent: title ? `${kind} · ${title}` : kind }),
    ...content,
  );
}
