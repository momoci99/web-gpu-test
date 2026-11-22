import type { Capabilities, Requirement } from '../../../core/capabilities';
import type { SceneData } from '../scene';

export type RendererId = 'svg' | 'canvas2d' | 'webgl2' | 'webgpu-cpu' | 'webgpu-compute';
export type { Requirement };

export interface Renderer {
  readonly id: RendererId;
  /** Advance one fixed step and draw. The harness times this call as main-thread cost. */
  frame(): void;
  /** Resolved timestamp-query durations (ms) since the last drain. Absent means no GPU timing. */
  drainGpuSamples?(): number[];
  /** Resolves when all work submitted so far has finished on the GPU. Absent when submission already blocks (WebGL2, Canvas, SVG). */
  settle?(): Promise<void>;
  /** Idempotent. Removes DOM and destroys GPU resources. */
  dispose(): void;
}

export interface RendererEntry {
  id: RendererId;
  label: string;
  summary: string;
  requires: Requirement;
  create(host: HTMLElement, scene: SceneData, caps: Capabilities): Promise<Renderer>;
}
