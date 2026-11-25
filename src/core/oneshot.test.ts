import { describe, expect, it, vi } from 'vitest';
import {
  crossoverN,
  implApplies,
  runOneShot,
  shouldStop,
  type CpuImpl,
  type GpuImpl,
  type OneShotResult,
  type Workload,
} from './oneshot';
import { summarize } from './stats';

type Out = number;

function workload(impls: Workload<number, Out>['impls'], verify?: Workload<number, Out>['verify']): Workload<number, Out> {
  return {
    id: 'fake',
    label: 'fake',
    summary: '',
    sizes: [1],
    smokeSizes: [1],
    sizeLabel: String,
    makeInput: (n) => n,
    impls,
    verify: verify ?? ((input, out) => ({ ok: out === input * 2, detail: `out=${out}` })),
    work: (n) => ({ amount: n * 10, unit: 'ops' }),
  };
}

function fakeDevice() {
  const log: string[] = [];
  const device = {
    features: new Set<string>(),
    createCommandEncoder: () => ({ finish: () => ({}) }),
    queue: {
      submit: () => log.push('submit'),
      onSubmittedWorkDone: async () => {
        log.push('done');
      },
    },
  } as unknown as GPUDevice;
  return { device, log };
}

function fakeGpuImpl(overrides: { broken?: boolean } = {}) {
  const log: string[] = [];
  let disposed = 0;
  const impl: GpuImpl<number, Out> = {
    kind: 'gpu',
    id: 'gpu-fake',
    label: 'gpu fake',
    async prepare(_device, input) {
      log.push('prepare');
      return {
        upload: () => log.push('upload'),
        encode: () => log.push('encode'),
        readback: async () => {
          log.push('readback');
          return overrides.broken ? -1 : input * 2;
        },
        dispose: () => void disposed++,
      };
    },
  };
  return { impl, log, disposed: () => disposed };
}

describe('shouldStop', () => {
  it('never stops before 3 runs, however long they took', () => {
    expect(shouldStop(2, 99_999)).toBe(false);
  });

  it('stops at 3+ runs once the time budget is exceeded', () => {
    expect(shouldStop(3, 2001)).toBe(true);
    expect(shouldStop(3, 2000)).toBe(false);
  });

  it('stops at 10 runs even when fast', () => {
    expect(shouldStop(9, 1)).toBe(false);
    expect(shouldStop(10, 1)).toBe(true);
  });
});

describe('implApplies', () => {
  it('respects maxN', () => {
    const impl: CpuImpl<number, Out> = { kind: 'cpu', id: 'c', label: 'c', maxN: 100, run: (x) => x };
    expect(implApplies(impl, 100)).toBe(true);
    expect(implApplies(impl, 101)).toBe(false);
    expect(implApplies({}, 1e9)).toBe(true);
  });
});

describe('runOneShot with a cpu impl', () => {
  const cpu = (run: (x: number) => Out): CpuImpl<number, Out> => ({ kind: 'cpu', id: 'cpu-fake', label: 'cpu', run });

  it('runs 10 timed samples (each a batch average) and assembles the result', async () => {
    let calls = 0;
    const impl = cpu((x) => (calls++, x * 2));
    const r = await runOneShot(workload([impl]), impl, 5, 5, { device: null });
    expect(calls).toBeGreaterThan(10);
    expect(r).toMatchObject({ workloadId: 'fake', implId: 'cpu-fake', kind: 'cpu', n: 5, runs: 10, setupMs: null });
    expect(r.compute).toBeNull();
    expect(r.readback).toBeNull();
    expect(r.kernel).toBeNull();
    expect(r.check.ok).toBe(true);
    expect(r.throughput).toBeCloseTo(50 / (r.e2e.median / 1000), 5);
  });

  it('reports a failed check from the first measured run', async () => {
    const impl = cpu(() => 0);
    const r = await runOneShot(workload([impl]), impl, 4, 4, { device: null });
    expect(r.check.ok).toBe(false);
  });

  it('verifies the first and the last measured output only, and reports the first failure', async () => {
    const impl = cpu((x) => x * 2);
    const seen: number[] = [];
    let verifies = 0;
    const w = workload([impl], (input, out) => {
      seen.push(out);
      return { ok: ++verifies !== 2, detail: `${input}` };
    });
    const r = await runOneShot(w, impl, 4, 4, { device: null });
    expect(verifies).toBe(2);
    expect(r.check.ok).toBe(false);
  });

  it('leaves throughput null without a work model', async () => {
    const impl = cpu((x) => x * 2);
    const w = { ...workload([impl]), work: undefined };
    const r = await runOneShot(w, impl, 1, 1, { device: null });
    expect(r.throughput).toBeNull();
  });
});

describe('runOneShot with a gpu impl', () => {
  it('uploads, encodes, submits and reads back on every run, then disposes', async () => {
    const { device, log: deviceLog } = fakeDevice();
    const { impl, log, disposed } = fakeGpuImpl();
    const r = await runOneShot(workload([impl]), impl, 3, 3, { device });
    expect(log[0]).toBe('prepare');
    expect(log.filter((l) => l === 'readback')).toHaveLength(11);
    expect(log.slice(1, 4)).toEqual(['upload', 'encode', 'readback']);
    expect(deviceLog.filter((l) => l === 'submit')).toHaveLength(11);
    expect(disposed()).toBe(1);
    expect(r.kind).toBe('gpu');
    expect(r.runs).toBe(10);
    expect(r.setupMs).toBeGreaterThanOrEqual(0);
    expect(r.compute).not.toBeNull();
    expect(r.readback).not.toBeNull();
    expect(r.kernel).toBeNull();
    expect(r.e2e.median).toBeGreaterThanOrEqual(r.compute!.median);
    expect(r.check.ok).toBe(true);
  });

  it('flags a wrong readback', async () => {
    const { device } = fakeDevice();
    const { impl } = fakeGpuImpl({ broken: true });
    const r = await runOneShot(workload([impl]), impl, 3, 3, { device });
    expect(r.check.ok).toBe(false);
  });

  it('requires a device', async () => {
    const { impl } = fakeGpuImpl();
    await expect(runOneShot(workload([impl]), impl, 3, 3, { device: null })).rejects.toThrow();
  });
});

describe('crossoverN', () => {
  const result = (kind: 'cpu' | 'gpu', n: number, median: number): OneShotResult => ({
    workloadId: 'w',
    implId: `${kind}-${median}`,
    kind,
    n,
    runs: 3,
    e2e: summarize([median]),
    compute: null,
    readback: null,
    kernel: null,
    setupMs: null,
    check: { ok: true, detail: '' },
    throughput: null,
  });

  it('returns the first n from which gpu stays faster', () => {
    const rs = [
      result('cpu', 10, 1), result('gpu', 10, 5),
      result('cpu', 100, 4), result('gpu', 100, 5),
      result('cpu', 1000, 40), result('gpu', 1000, 6),
      result('cpu', 10000, 400), result('gpu', 10000, 9),
    ];
    expect(crossoverN(rs)).toBe(1000);
  });

  it('ignores an early gpu win that later flips back', () => {
    const rs = [
      result('cpu', 10, 5), result('gpu', 10, 1),
      result('cpu', 100, 1), result('gpu', 100, 5),
      result('cpu', 1000, 40), result('gpu', 1000, 6),
    ];
    expect(crossoverN(rs)).toBe(1000);
  });

  it('is null when gpu never wins or loses at the largest n', () => {
    expect(crossoverN([result('cpu', 10, 1), result('gpu', 10, 5)])).toBeNull();
    expect(crossoverN([result('cpu', 10, 5), result('gpu', 10, 1), result('cpu', 100, 1), result('gpu', 100, 5)])).toBeNull();
  });

  it('compares best-of per kind and skips sizes missing one kind', () => {
    const rs = [
      result('cpu', 10, 9), result('cpu', 10, 2), result('gpu', 10, 3),
      result('gpu', 100, 1),
      result('cpu', 1000, 50), result('gpu', 1000, 5), result('gpu', 1000, 60),
    ];
    expect(crossoverN(rs)).toBe(1000);
  });

  it('is null without both kinds', () => {
    expect(crossoverN([result('gpu', 10, 1)])).toBeNull();
    expect(crossoverN([])).toBeNull();
  });
});

describe('runOneShot CPU timing under a quantized clock', () => {
  it('reports a non-zero median when only the first call is slow', async () => {
    const realNow = performance.now.bind(performance);
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => Math.floor(realNow() / 0.1) * 0.1);
    try {
      let calls = 0;
      const impl: CpuImpl<number, Out> = {
        kind: 'cpu',
        id: 'cold-then-fast',
        label: 'cold',
        run: (x) => {
          if (calls++ === 0) {
            const until = realNow() + 3;
            while (realNow() < until);
          }
          return x * 2;
        },
      };
      const r = await runOneShot(workload([impl]), impl, 1, 1, { device: null });
      expect(r.e2e.median).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
