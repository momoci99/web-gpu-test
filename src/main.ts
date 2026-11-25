import { detectCapabilities } from './core/capabilities';
import type { DemoMeta, MountDemo } from './core/demo';
import { renderHome } from './home';
import { isLearn, parseRoute, type Route } from './router';
import { topbar, type NavSection } from './ui/topbar';
import './style.css';
import './ui/kit.css';

const metas = Object.values(import.meta.glob<{ meta: DemoMeta }>('./demos/*/meta.ts', { eager: true }))
  .map((m) => m.meta)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
const loaders = import.meta.glob<{ mount: MountDemo }>('./demos/*/main.ts');

const app = document.querySelector<HTMLElement>('#app')!;

function shell(active: NavSection): HTMLElement {
  const main = Object.assign(document.createElement('main'), { className: 'demo-root' });
  app.replaceChildren(topbar(active), main);
  return main;
}

async function showLearn(route: Extract<Route, { kind: 'learn' | 'learn-index' }>): Promise<void> {
  const main = document.querySelector<HTMLElement>('main') ?? shell('learn');
  const { renderLearn } = await import('./learn/learn-view');
  await renderLearn(main, route, metas);
}

async function start(): Promise<void> {
  let current = parseRoute(location.hash);

  window.addEventListener('hashchange', () => {
    const next = parseRoute(location.hash);
    const prev = current;
    current = next;
    if (isLearn(prev) && isLearn(next)) {
      if (prev.kind === 'learn' && next.kind === 'learn' && prev.slug === next.slug) {
        void import('./learn/learn-view').then((m) => m.scrollToFragment(next.fragment));
      } else {
        void showLearn(next as Extract<Route, { kind: 'learn' | 'learn-index' }>);
      }
      return;
    }
    location.reload();
  });

  if (current.kind === 'home') return renderHome(shell('demos'), metas);
  if (current.kind === 'learn' || current.kind === 'learn-index') {
    shell('learn');
    return showLearn(current);
  }

  const id = current.id;
  const load = loaders[`./demos/${id}/main.ts`];
  if (!load || !metas.some((m) => m.id === id)) return renderHome(shell('demos'), metas, `알 수 없는 데모: ${id}`);

  const host = shell('demos');
  window.__caps = await detectCapabilities();
  const { mount } = await load();
  await mount(host, window.__caps);
}

void start();
