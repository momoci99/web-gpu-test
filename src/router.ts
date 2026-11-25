export type Route =
  | { kind: 'home' }
  | { kind: 'learn-index' }
  | { kind: 'learn'; slug: string; fragment: string | null }
  | { kind: 'demo'; id: string };

/** `#/learn/<slug>#<heading-id>` carries a second `#` for the in-page anchor. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [route = '', ...rest] = path.split('#');
  const parts = route.split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home' };
  if (parts[0] === 'learn') {
    if (!parts[1]) return { kind: 'learn-index' };
    const fragment = rest.join('#');
    return { kind: 'learn', slug: decodeURIComponent(parts[1]), fragment: fragment ? decodeURIComponent(fragment) : null };
  }
  return { kind: 'demo', id: parts[0]!.split('?')[0]! };
}

export const isLearn = (r: Route): boolean => r.kind === 'learn' || r.kind === 'learn-index';
