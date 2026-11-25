import { unmetReason } from '../../core/capabilities';
import type { MountDemo } from '../../core/demo';
import { estimateRefresh } from '../../core/frame-bench';
import { findMaxRadius, runVariant } from './run';
import { openSource } from './source';
import { mountWebcamFilter } from './ui';
import { registry } from './variants';
import { verifyParity } from './verify';

export const mount: MountDemo = async (root, caps) => {
  window.__demo = { estimateRefresh, unmetReason, openSource, runVariant, findMaxRadius, verifyParity, registry };
  mountWebcamFilter(root, caps);
};
