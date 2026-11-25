import { createGpuTimer, type GpuTimer, type TimestampWrites } from './gpu-timer';
import { summarize, type Summary } from './stats';

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export type KernelTimestamps = { first: TimestampWrites; last: TimestampWrites; only: TimestampWrites };

export interface CpuImpl<I, O> {
  kind: 'cpu';
  id: string;
  label: string;
  /** Largest n this impl is run at. */
  maxN?: number;
  run(input: I): O;
}

export interface GpuRun<O> {
  /** queue.writeBuffer of the input. Timed in e2e. */
  upload(): void;
  /** Record every kernel pass. Use `ts.only` for a single pass, otherwise `ts.first` on the first and `ts.last` on the last. */
  encode(encoder: GPUCommandEncoder, ts?: KernelTimestamps): void;
  /** Copy the result to a MAP_READ buffer, map it and decode. Timed in e2e. */
  readback(): Promise<O>;
  dispose(): void;
}

export interface GpuImpl<I, O> {
  kind: 'gpu';
  id: string;
  label: string;
  maxN?: number;
  /** Compile pipelines and allocate buffers. Not part of e2e; reported as setupMs. */
  prepare(device: GPUDevice, input: I): Promise<GpuRun<O>>;
}

export type Impl<I, O> = CpuImpl<I, O> | GpuImpl<I, O>;

export interface Workload<I, O> {
  id: string;
  label: string;
  summary: string;
  /** Default sweep. */
  sizes: number[];
  /** Tiny sizes used by the smoke script. */
  smokeSizes: number[];
  sizeLabel(n: number): string;
  makeInput(n: number, seed: number): I;
  impls: Impl<I, O>[];
  /** Workload-owned; may sample instead of checking everything. */
  verify(input: I, output: O): CheckResult;
  /** `amount` is in `unit`, so throughput is `amount / seconds` in `unit`/s. */
  work?(n: number): { amount: number; unit: string };
}

// Impls are heterogeneous across workloads, so the discovery layer holds them with erased types.
export type AnyWorkload = Workload<any, any>;
export type AnyImpl = Impl<any, any>;

export interface OneShotResult {
  workloadId: string;
  implId: string;
  kind: 'cpu' | 'gpu';
  n: number;
  runs: number;
  e2e: Summary;
  /** GPU only: upload + kernels, until onSubmittedWorkDone. */
  compute: Summary | null;
  /** GPU only: copy + mapAsync + decode. */
  readback: Summary | null;
  /** GPU only: timestamp-query span of the kernel passes; null when unsupported. */
  kernel: Summary | null;
  setupMs: number | null;
  check: CheckResult;
  /** `work.amount / e2e.median` in unit/s. */
  throughput: number | null;
}

export const MIN_RUNS = 3;
export const MAX_RUNS = 10;
export const BUDGET_MS = 2000;

/** Stop once there are at least MIN_RUNS runs and either MAX_RUNS runs or more than BUDGET_MS of accumulated run time. */
export function shouldStop(runs: number, totalMs: number): boolean {
  return runs >= MIN_RUNS && (runs >= MAX_RUNS || totalMs > BUDGET_MS);
}

export function implApplies(impl: { maxN?: number }, n: number): boolean {
  return impl.maxN === undefined || n <= impl.maxN;
}

interface RunSample {
  e2e: number;
  compute?: number;
  readback?: number;
  kernel?: number;
}

export function assembleResult<I, O>(
  workload: Workload<I, O>,
  impl: Impl<I, O>,
  n: number,
  samples: RunSample[],
  setupMs: number | null,
  check: CheckResult,
): OneShotResult {
  const column = (pick: (s: RunSample) => number | undefined): Summary | null => {
    const xs = samples.map(pick).filter((x): x is number => x !== undefined);
    return xs.length > 0 ? summarize(xs) : null;
  };
  const e2e = summarize(samples.map((s) => s.e2e));
  const work = workload.work?.(n);
  return {
    workloadId: workload.id,
    implId: impl.id,
    kind: impl.kind,
    n,
    runs: samples.length,
    e2e,
    compute: column((s) => s.compute),
    readback: column((s) => s.readback),
    kernel: column((s) => s.kernel),
    setupMs,
    check,
    throughput: work ? work.amount / (e2e.median / 1000) : null,
  };
}

/** Smallest n from which the best GPU e2e median beats the best CPU e2e median at every larger measured n; null if never. */
export function crossoverN(results: readonly OneShotResult[]): number | null {
  const best = new Map<number, { cpu: number; gpu: number }>();
  for (const r of results) {
    const e = best.get(r.n) ?? { cpu: Infinity, gpu: Infinity };
    e[r.kind] = Math.min(e[r.kind], r.e2e.median);
    best.set(r.n, e);
  }
  const ns = [...best.entries()]
    .filter(([, e]) => Number.isFinite(e.cpu) && Number.isFinite(e.gpu))
    .sort(([a], [b]) => a - b);
  let result: number | null = null;
  for (let i = ns.length - 1; i >= 0; i--) {
    const [n, e] = ns[i]!;
    if (e.gpu < e.cpu) result = n;
    else break;
  }
  return result;
}

export interface OneShotEnv {
  /** Required to run a GPU impl. */
  device: GPUDevice | null;
}

const CALIBRATE_MS = 1;
const MAX_BATCH = 4096;

/** performance.now() is quantized (about 0.1 ms), so a CPU run is timed as a batch of `batch` runs averaged. */
function calibrateBatch<I, O>(impl: CpuImpl<I, O>, input: I): number {
  let batch = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) impl.run(input);
    if (performance.now() - t0 >= CALIBRATE_MS || batch >= MAX_BATCH) return batch;
    batch *= 2;
  }
}

function runCpu<I, O>(impl: CpuImpl<I, O>, input: I, batch: number): { sample: RunSample; output: O } {
  const t0 = performance.now();
  let output = impl.run(input);
  for (let i = 1; i < batch; i++) output = impl.run(input);
  return { sample: { e2e: (performance.now() - t0) / batch }, output };
}

async function runGpuOnce<O>(device: GPUDevice, run: GpuRun<O>, timer: GpuTimer | null): Promise<{ sample: RunSample; output: O }> {
  const t0 = performance.now();
  run.upload();
  const encoder = device.createCommandEncoder();
  run.encode(encoder, timer ?? undefined);
  timer?.resolve(encoder);
  device.queue.submit([encoder.finish()]);
  const timed = timer?.afterSubmit();
  await device.queue.onSubmittedWorkDone();
  const t1 = performance.now();
  const output = await run.readback();
  const t2 = performance.now();
  await timed;
  const kernel = timer?.drain()[0];
  return { sample: { e2e: t2 - t0, compute: t1 - t0, readback: t2 - t1, kernel }, output };
}

/**
 * One warm-up run (CPU: a doubling batch calibration), then runs until `shouldStop`. The first and the last measured outputs go through `workload.verify`;
 * the check reported is the first failure, else the last result.
 */
export async function runOneShot<I, O>(
  workload: Workload<I, O>,
  impl: Impl<I, O>,
  n: number,
  input: I,
  env: OneShotEnv,
): Promise<OneShotResult> {
  const samples: RunSample[] = [];
  const checks: CheckResult[] = [];
  const record = (output: O) => checks.push(workload.verify(input, output));
  let setupMs: number | null = null;
  let totalMs = 0;

  if (impl.kind === 'cpu') {
    const batch = calibrateBatch(impl, input);
    while (!shouldStop(samples.length, totalMs)) {
      const { sample, output } = runCpu(impl, input, batch);
      samples.push(sample);
      totalMs += sample.e2e * batch;
      if (samples.length === 1 || shouldStop(samples.length, totalMs)) record(output);
    }
  } else {
    const { device } = env;
    if (!device) throw new Error(`${impl.id}: GPUDevice가 필요합니다`);
    const s0 = performance.now();
    const run = await impl.prepare(device, input);
    setupMs = performance.now() - s0;
    const timer = createGpuTimer(device);
    try {
      await runGpuOnce(device, run, timer);
      timer?.drain();
      while (!shouldStop(samples.length, totalMs)) {
        const { sample, output } = await runGpuOnce(device, run, timer);
        samples.push(sample);
        totalMs += sample.e2e;
        if (samples.length === 1 || shouldStop(samples.length, totalMs)) record(output);
      }
    } finally {
      timer?.destroy();
      run.dispose();
    }
  }

  const check = checks.find((c) => !c.ok) ?? checks[checks.length - 1]!;
  return assembleResult(workload, impl, n, samples, setupMs, check);
}
