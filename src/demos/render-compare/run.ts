import type { Capabilities } from '../../core/capabilities';
import { runFrames, type FrameOptions, type FrameStats } from '../../core/frame-bench';
import type { RendererEntry, RendererId } from './renderers/types';
import { createScene, type SceneConfig } from './scene';

export type RunResult = { rendererId: RendererId; count: number } & FrameStats;

export async function runFixed(
  entry: RendererEntry,
  config: SceneConfig,
  caps: Capabilities,
  refreshHz: number,
  opts: FrameOptions & { host: HTMLElement },
): Promise<RunResult> {
  const { host, ...frameOpts } = opts;
  const stats = await runFrames(() => entry.create(host, createScene(config), caps), caps, refreshHz, frameOpts);
  return { rendererId: entry.id, count: config.count, ...stats };
}
