export interface FrameSample {
  intervalMs: number;
  cpuMs: number;
}

/**
 * Drives `frame` once per animation frame for `count` timed frames.
 * The first rAF callback only sets the interval baseline and is not timed or counted.
 */
export function collectFrames(frame: () => void, count: number): Promise<FrameSample[]> {
  return new Promise((resolve) => {
    const samples: FrameSample[] = [];
    let prev: number | null = null;
    const tick = (ts: number) => {
      if (prev !== null) {
        const t0 = performance.now();
        frame();
        samples.push({ intervalMs: ts - prev, cpuMs: performance.now() - t0 });
        if (samples.length >= count) return resolve(samples);
      }
      prev = ts;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
