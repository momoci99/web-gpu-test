import type { Capabilities } from './capabilities';

export interface DemoMeta {
  id: string;
  title: string;
  summary: string;
  order: number;
}

export type MountDemo = (root: HTMLElement, caps: Capabilities) => Promise<void>;

declare global {
  interface Window {
    /** Test hooks. Each demo sets this in mount(); its smoke.mjs knows the shape. */
    __demo: unknown;
    /** Set by the shell before any demo mounts. */
    __caps: Capabilities;
  }
}
