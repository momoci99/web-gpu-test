import type { Capabilities, Requirement } from '../../../core/capabilities';
import type { FrameTarget } from '../../../core/frame-bench';
import type { SceneData } from '../scene';

export type RendererId = 'svg' | 'canvas2d' | 'webgl2' | 'webgpu-cpu' | 'webgpu-compute';
export type { Requirement };

export type Renderer = FrameTarget & { readonly id: RendererId };

export interface RendererEntry {
  id: RendererId;
  label: string;
  summary: string;
  requires: Requirement;
  create(host: HTMLElement, scene: SceneData, caps: Capabilities): Promise<Renderer>;
}
