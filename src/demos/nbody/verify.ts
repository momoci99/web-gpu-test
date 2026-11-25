import type { Capabilities } from '../../core/capabilities';
import { createGpuSim, requestDevice, type KernelKind } from './gpu';
import { createBodies, runCpu } from './sim';

export const VERIFY_COUNT = 4096;
export const VERIFY_STEPS = 10;
export const VERIFY_TOLERANCE = 1e-3;

export interface VerifyResult {
  id: string;
  pass: boolean;
  maxAbsError: number;
  count: number;
  steps: number;
  tolerance: number;
}

const KINDS: { id: string; kind: KernelKind }[] = [
  { id: 'gpu-naive', kind: 'naive' },
  { id: 'gpu-tiled', kind: 'tiled' },
];

async function readBack(device: GPUDevice, source: GPUBuffer, byteLength: number): Promise<Float32Array> {
  const staging = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

/** Same seed, same K steps on the CPU and on each GPU kernel, one readback each. */
export async function verifyNBody(caps: Capabilities): Promise<VerifyResult[]> {
  const initial = createBodies({ seed: 1234, count: VERIFY_COUNT });
  const reference = runCpu(initial, VERIFY_COUNT, VERIFY_STEPS);
  const device = await requestDevice(caps);
  try {
    const results: VerifyResult[] = [];
    for (const { id, kind } of KINDS) {
      const sim = await createGpuSim(device, kind, initial);
      const encoder = device.createCommandEncoder();
      sim.encodeSteps(encoder, VERIFY_STEPS);
      device.queue.submit([encoder.finish()]);
      const gpu = await readBack(device, sim.current(), initial.byteLength);
      sim.dispose();

      let maxAbsError = 0;
      for (let i = 0; i < VERIFY_COUNT; i++) {
        for (const c of [0, 1]) maxAbsError = Math.max(maxAbsError, Math.abs(gpu[i * 4 + c]! - reference[i * 4 + c]!));
      }
      const finite = gpu.every(Number.isFinite);
      results.push({
        id,
        pass: finite && maxAbsError <= VERIFY_TOLERANCE,
        maxAbsError: finite ? maxAbsError : Number.POSITIVE_INFINITY,
        count: VERIFY_COUNT,
        steps: VERIFY_STEPS,
        tolerance: VERIFY_TOLERANCE,
      });
    }
    return results;
  } finally {
    device.destroy();
  }
}
