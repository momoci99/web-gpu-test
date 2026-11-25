import { estimateRefresh } from './core/frame-bench';
import { detectCapabilities, unmetReason } from './core/capabilities';
import { runFixed } from './demos/render-compare/run';
import { registry } from './demos/render-compare/renderers/registry';
import { mountRenderCompare } from './demos/render-compare/ui';
import { verifyComputeParity } from './demos/render-compare/verify';
import './style.css';

declare global {
  interface Window {
    __bench: {
      detectCapabilities: typeof detectCapabilities;
      unmetReason: typeof unmetReason;
      estimateRefresh: typeof estimateRefresh;
      runFixed: typeof runFixed;
      verifyComputeParity: typeof verifyComputeParity;
      registry: typeof registry;
    };
  }
}

window.__bench = { detectCapabilities, unmetReason, estimateRefresh, runFixed, verifyComputeParity, registry };

const root = document.querySelector<HTMLElement>('#app')!;
detectCapabilities().then((caps) => mountRenderCompare(root, caps));
