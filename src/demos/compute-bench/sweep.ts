import { crossoverN, implApplies, runOneShot, type AnyImpl, type AnyWorkload, type OneShotResult } from '../../core/oneshot';

export const SEED = 1;

export function workloads(): AnyWorkload[] {
  const modules = import.meta.glob<{ workload: AnyWorkload }>('./workloads/*/index.ts', { eager: true });
  return Object.values(modules)
    .map((m) => m.workload)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function implRunnable(impl: { kind: 'cpu' | 'gpu' }, device: GPUDevice | null): boolean {
  return impl.kind === 'cpu' || device !== null;
}

/** One input per n shared by every impl, so impls are compared on identical data. */
export async function sweep(
  workload: AnyWorkload,
  sizes: readonly number[],
  impls: readonly AnyImpl[],
  device: GPUDevice | null,
  onResult?: (r: OneShotResult) => void,
): Promise<{ results: OneShotResult[]; crossoverN: number | null }> {
  const results: OneShotResult[] = [];
  for (const n of [...sizes].sort((a, b) => a - b)) {
    const input = workload.makeInput(n, SEED);
    for (const impl of impls) {
      if (!implApplies(impl, n) || !implRunnable(impl, device)) continue;
      const r = await runOneShot(workload, impl, n, input, { device });
      results.push(r);
      onResult?.(r);
    }
  }
  return { results, crossoverN: crossoverN(results) };
}
