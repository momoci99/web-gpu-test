import { canvas2dEntry } from './canvas2d';
import { svgEntry } from './svg';
import type { RendererEntry } from './types';
import { webgl2Entry } from './webgl2';
import { webgpuComputeEntry } from './webgpu-compute';
import { webgpuCpuEntry } from './webgpu-cpu';

export const registry: readonly RendererEntry[] = [svgEntry, canvas2dEntry, webgl2Entry, webgpuCpuEntry, webgpuComputeEntry];
