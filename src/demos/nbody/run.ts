import type { Capabilities } from '../../core/capabilities';
import { runFrames, type FrameOptions, type FrameStats } from '../../core/frame-bench';
import { createBodies } from './sim';
import type { VariantEntry, VariantId } from './variants';

export type RunResult = { variantId: VariantId; count: number; stepsPerFrame: number } & FrameStats;

export interface RunConfig {
  count: number;
  seed: number;
  stepsPerFrame: number;
}

export async function runFixed(
  entry: VariantEntry,
  config: RunConfig,
  caps: Capabilities,
  refreshHz: number,
  opts: FrameOptions & { host: HTMLElement },
): Promise<RunResult> {
  const { host, ...frameOpts } = opts;
  const bodies = createBodies(config);
  const stats = await runFrames(() => entry.create({ host, caps, bodies, stepsPerFrame: config.stepsPerFrame }), caps, refreshHz, frameOpts);
  return { variantId: entry.id, count: config.count, stepsPerFrame: config.stepsPerFrame, ...stats };
}
