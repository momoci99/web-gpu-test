import { detectCapabilities } from './core/capabilities';
import type { DemoMeta, MountDemo } from './core/demo';
import './style.css';

const metas = Object.values(import.meta.glob<{ meta: DemoMeta }>('./demos/*/meta.ts', { eager: true }))
  .map((m) => m.meta)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
const loaders = import.meta.glob<{ mount: MountDemo }>('./demos/*/main.ts');

const root = document.querySelector<HTMLElement>('#app')!;

function renderHome(notice?: string): void {
  const h1 = Object.assign(document.createElement('h1'), { textContent: 'WebGPU 성능 데모' });
  const intro = Object.assign(document.createElement('p'), {
    textContent: 'WebGPU가 실제로 빨라지는 지점을, 공정한 비-WebGPU 기준선과 나란히 측정합니다.',
  });
  const list = Object.assign(document.createElement('div'), { className: 'cards' });
  for (const m of metas) {
    const card = Object.assign(document.createElement('a'), { className: 'card', href: `#/${m.id}` });
    card.dataset.demoId = m.id;
    card.append(
      Object.assign(document.createElement('strong'), { textContent: m.title }),
      Object.assign(document.createElement('span'), { textContent: m.summary }),
    );
    list.append(card);
  }
  root.replaceChildren(h1, intro);
  if (notice) root.append(Object.assign(document.createElement('p'), { className: 'notice', textContent: notice }));
  root.append(list);
}

async function start(): Promise<void> {
  window.addEventListener('hashchange', () => location.reload());
  const id = /^#\/([^/?]+)/.exec(location.hash)?.[1];
  if (!id) return renderHome();
  const load = loaders[`./demos/${id}/main.ts`];
  if (!load || !metas.some((m) => m.id === id)) return renderHome(`알 수 없는 데모: ${id}`);

  const back = Object.assign(document.createElement('a'), { className: 'back', href: '#', textContent: '← 데모 목록' });
  const host = document.createElement('div');
  root.replaceChildren(back, host);
  window.__caps = await detectCapabilities();
  const { mount } = await load();
  await mount(host, window.__caps);
}

void start();
