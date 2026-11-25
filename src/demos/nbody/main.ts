import { unmetReason } from '../../core/capabilities';
import type { MountDemo } from '../../core/demo';
import { estimateRefresh } from '../../core/frame-bench';
import { runFixed } from './run';
import { mountNBody } from './ui';
import { registry } from './variants';
import { verifyNBody } from './verify';

export const mount: MountDemo = async (root, caps) => {
  window.__demo = { estimateRefresh, unmetReason, runFixed, verifyNBody, registry };
  mountNBody(root, caps);
};
