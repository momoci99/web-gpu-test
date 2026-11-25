export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
  return node;
}

export const GITHUB_URL = 'https://github.com/momoci99/web-gpu-test';
