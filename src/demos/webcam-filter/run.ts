import type { Capabilities } from '../../core/capabilities';
import { runFrames, trialPasses, type FrameOptions, type FrameStats } from '../../core/frame-bench';
import { maxRadiusAtRefresh, type FilterParams } from './filters';
import type { VideoSource } from './source';
import type { VariantEntry, VariantId } from './variants';

export interface RunConfig extends FilterParams {
  width: number;
  height: number;
}

export type RunResult = { variantId: VariantId } & RunConfig & FrameStats;

export async function runVariant(
  entry: VariantEntry,
  config: RunConfig,
  source: VideoSource,
  caps: Capabilities,
  refreshHz: number,
  opts: FrameOptions & { host: HTMLElement },
): Promise<RunResult> {
  const { host, ...frameOpts } = opts;
  const { width, height, filter, radius } = config;
  const stats = await runFrames(
    () => entry.create({ host, source, width, height, params: { filter, radius }, caps }),
    caps,
    refreshHz,
    frameOpts,
  );
  return { variantId: entry.id, ...config, ...stats };
}

/** Blur radius search: every trial is a full runVariant, judged by trialPasses (settled frame time). */
export async function findMaxRadius(
  entry: VariantEntry,
  config: Omit<RunConfig, 'filter' | 'radius'>,
  source: VideoSource,
  caps: Capabilities,
  refreshHz: number,
  opts: FrameOptions & { host: HTMLElement; onTrial?: (r: RunResult) => void },
): Promise<number> {
  const { onTrial, ...runOpts } = opts;
  return maxRadiusAtRefresh(async (radius) => {
    const r = await runVariant(entry, { ...config, filter: 'blur', radius }, source, caps, refreshHz, runOpts);
    onTrial?.(r);
    return trialPasses(r);
  });
}
