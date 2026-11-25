import { unmetReason } from '../../core/capabilities';
import type { MountDemo } from '../../core/demo';
import { estimateRefresh, rampMaxN, trialPasses } from '../../core/frame-bench';
import { runFixed } from './run';
import { mountNBody } from './ui';
import { registry } from './variants';
import { verifyNBody } from './verify';

export const mount: MountDemo = async (root, caps) => {
  window.__demo = { estimateRefresh, rampMaxN, trialPasses, unmetReason, runFixed, verifyNBody, registry };
  mountNBody(root, caps);
};
