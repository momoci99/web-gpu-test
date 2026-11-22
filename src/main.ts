import { estimateRefresh, runFixed } from './core/bench';
import { detectCapabilities, unmetReason } from './core/capabilities';
import { registry } from './demos/render-compare/renderers/registry';
import { verifyComputeParity } from './demos/render-compare/verify';

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
