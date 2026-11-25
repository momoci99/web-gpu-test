import type { MountDemo } from '../../core/demo';
import { requestComputeDevice } from './device';
import { sweep, workloads } from './sweep';
import { mountComputeBench } from './ui';

export const mount: MountDemo = async (root, caps) => {
  const device = await requestComputeDevice(caps);
  const all = workloads();
  const hooks = {
    workloads: all.map((w) => ({
      id: w.id,
      sizes: w.sizes,
      smokeSizes: w.smokeSizes,
      impls: w.impls.map((i) => ({ id: i.id, kind: i.kind, maxN: i.maxN ?? null })),
    })),
    hasDevice: device !== null,
    /** Runs `implIds` (default all) at `sizes` (default the workload's sweep) and returns every OneShotResult plus crossoverN. */
    runSweep(workloadId: string, sizes?: number[], implIds?: string[]) {
      const w = all.find((x) => x.id === workloadId);
      if (!w) throw new Error(`unknown workload: ${workloadId}`);
      const impls = w.impls.filter((i) => !implIds || implIds.includes(i.id));
      return sweep(w, sizes ?? w.sizes, impls, device);
    },
  };
  window.__demo = hooks;
  Object.assign(hooks, mountComputeBench(root, all, device, caps));
};
