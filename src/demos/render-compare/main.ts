import type { MountDemo } from '../../core/demo';
import { estimateRefresh } from '../../core/frame-bench';
import { registry } from './renderers/registry';
import { runFixed } from './run';
import { mountRenderCompare } from './ui';
import { verifyComputeParity } from './verify';

export const mount: MountDemo = async (root, caps) => {
  window.__demo = { estimateRefresh, runFixed, verifyComputeParity, registry };
  mountRenderCompare(root, caps);
};
