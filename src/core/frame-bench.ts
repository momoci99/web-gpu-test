import type { Capabilities } from './capabilities';
import { collectFrames } from './frame-loop';
import { summarize, type Summary } from './stats';

export interface FrameTarget {
  /** Advance and draw one frame. The harness times this call as main-thread cost. */
  frame(): void;
  /** Resolved timestamp-query durations (ms) since the last drain. Absent means no GPU timing. */
  drainGpuSamples?(): number[];
  /** Resolves when all work submitted so far has finished on the GPU. Absent when submission already blocks. */
  settle?(): Promise<void>;
  /** Idempotent. Releases DOM and GPU resources. */
  dispose(): void;
}

export interface FrameStats {
  refreshHz: number;
  frames: number;
  interval: Summary;
  cpu: Summary;
  gpu: Summary | null;
  longFrames: { count: number; totalBlockingMs: number } | null;
  droppedRatio: number;
  /** Wall time per measured frame with the GPU queue drained at the end; exposes GPU-bound work rAF does not throttle. */
  effectiveFrameMs: number;
}

export interface FrameOptions {
  warmupFrames?: number;
  measureFrames?: number;
}

interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
}

const DROPPED_FACTOR = 1.5;
const PASS_MEDIAN_FACTOR = 1.1;
const PASS_DROPPED_RATIO = 0.05;

export async function estimateRefresh(): Promise<number> {
  const samples = await collectFrames(() => {}, 60);
  return 1000 / summarize(samples.map((s) => s.intervalMs)).median;
}

function idleFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runFrames(
  create: () => Promise<FrameTarget>,
  caps: Capabilities,
  refreshHz: number,
  opts: FrameOptions = {},
): Promise<FrameStats> {
  const { warmupFrames = 30, measureFrames = 120 } = opts;
  const renderer = await create();
  try {
    await collectFrames(() => renderer.frame(), warmupFrames);
    await renderer.settle?.();
    renderer.drainGpuSamples?.();

    let loaf: PerformanceObserver | null = null;
    const loafEntries: LoafEntry[] = [];
    if (caps.longAnimationFrames) {
      loaf = new PerformanceObserver((list) => loafEntries.push(...list.getEntries()));
      loaf.observe({ type: 'long-animation-frame' });
    }
    const t0 = performance.now();
    const samples = await collectFrames(() => renderer.frame(), measureFrames);
    await renderer.settle?.();
    const t1 = performance.now();
    await idleFor(50);
    const gpuMs = renderer.drainGpuSamples?.() ?? [];
    if (loaf) {
      loafEntries.push(...loaf.takeRecords());
      loaf.disconnect();
    }

    const intervals = samples.map((s) => s.intervalMs);
    const period = 1000 / refreshHz;
    return {
      refreshHz,
      frames: samples.length,
      interval: summarize(intervals),
      cpu: summarize(samples.map((s) => s.cpuMs)),
      gpu: gpuMs.length > 0 ? summarize(gpuMs) : null,
      longFrames: loaf
        ? {
            count: loafEntries.length,
            totalBlockingMs: loafEntries.reduce((s, e) => s + (e.blockingDuration ?? Math.max(0, e.duration - 50)), 0),
          }
        : null,
      droppedRatio: intervals.filter((x) => x > DROPPED_FACTOR * period).length / intervals.length,
      effectiveFrameMs: (t1 - t0) / samples.length,
    };
  } finally {
    await renderer.settle?.();
    renderer.dispose();
  }
}

export function trialPasses(r: FrameStats): boolean {
  const period = 1000 / r.refreshHz;
  return (
    r.interval.median <= PASS_MEDIAN_FACTOR * period &&
    r.droppedRatio <= PASS_DROPPED_RATIO &&
    r.effectiveFrameMs <= PASS_MEDIAN_FACTOR * period
  );
}

export interface RampOptions {
  start?: number;
  max?: number;
  precision?: number;
}

export interface RampResult {
  /** Largest N that passed; 0 when even `start` failed. */
  maxN: number;
  trials: { n: number; pass: boolean }[];
}

/** Doubles N until a trial fails, then bisects the last pass and first fail to within `precision`. */
export async function rampMaxN(trial: (n: number) => Promise<boolean>, opts: RampOptions = {}): Promise<RampResult> {
  const { start = 1000, max = 2_000_000, precision = 0.05 } = opts;
  const trials: RampResult['trials'] = [];
  const run = async (n: number) => {
    const pass = await trial(n);
    trials.push({ n, pass });
    return pass;
  };

  let lo = 0;
  let hi = 0;
  for (let n = start; ; n = Math.min(n * 2, max)) {
    if (await run(n)) {
      lo = n;
      if (n >= max) return { maxN: max, trials };
    } else {
      hi = n;
      break;
    }
  }
  if (lo === 0) return { maxN: 0, trials };

  while ((hi - lo) / lo > precision) {
    const mid = Math.round((lo + hi) / 2);
    if (mid <= lo || mid >= hi) break;
    if (await run(mid)) lo = mid;
    else hi = mid;
  }
  return { maxN: lo, trials };
}
