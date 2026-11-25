import type { FrameTarget } from '../core/frame-bench';

export interface LivePreview {
  /** Create the target and start animating. No-op while suspended or already running. */
  start(): Promise<void>;
  /** Dispose the target and stop the loop, e.g. before a measurement. Resumes with `resume()`. */
  suspend(): void;
  /** Start again unless the tab is hidden. */
  resume(): void;
}

/**
 * Runs `create()`'s target at one `frame()` per rAF. It stops while the tab is hidden and while suspended,
 * so a measurement never shares the GPU or main thread with it.
 */
export function livePreview(create: () => Promise<FrameTarget>, onError: (err: unknown) => void = () => {}): LivePreview {
  let target: FrameTarget | null = null;
  let raf = 0;
  let suspended = false;
  let generation = 0;

  const stop = () => {
    generation++;
    cancelAnimationFrame(raf);
    target?.dispose();
    target = null;
  };

  const start = async () => {
    if (suspended || document.hidden || target) return;
    const mine = ++generation;
    try {
      const t = await create();
      if (mine !== generation) return t.dispose();
      target = t;
      const tick = () => {
        t.frame();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch (err) {
      onError(err);
    }
  };

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : void start()));

  return {
    start,
    suspend() {
      suspended = true;
      stop();
    },
    resume() {
      suspended = false;
      void start();
    },
  };
}
