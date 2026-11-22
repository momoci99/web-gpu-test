import type { Capabilities } from '../../core/capabilities';
import { createComputeSim } from './renderers/compute-sim';
import { requestDevice } from './renderers/gpu-common';
import { createScene, FIXED_DT, stepScene } from './scene';

const STEPS = 60;
const COUNT = 4096;
// GPUs may fuse v * dt + p into one rounding. That drifts at most 1 ulp (6.1e-5 px near 800) per step, 3.7e-3 over 60 steps.
// A wrong bounce rule errs by whole pixels, so 1e-2 px separates the two.
const TOLERANCE = 1e-2;

export interface ParityResult {
  pass: boolean;
  maxAbsError: number;
  count: number;
  steps: number;
}

export async function verifyComputeParity(caps: Capabilities): Promise<ParityResult> {
  const config = { seed: 1234, count: COUNT, width: 800, height: 600 };
  const cpuScene = createScene(config);
  const gpuScene = createScene(config);
  for (let k = 0; k < STEPS; k++) stepScene(cpuScene, FIXED_DT);

  const device = await requestDevice(caps);
  try {
    const sim = createComputeSim(device, gpuScene);
    const readback = device.createBuffer({ size: gpuScene.state.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    for (let k = 0; k < STEPS; k++) sim.encodeStep(encoder);
    encoder.copyBufferToBuffer(sim.stateBuf, 0, readback, 0, gpuScene.state.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const gpuState = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    let maxAbsError = 0;
    for (let i = 0; i < gpuState.length; i++) {
      maxAbsError = Math.max(maxAbsError, Math.abs(gpuState[i]! - cpuScene.state[i]!));
    }
    return { pass: maxAbsError <= TOLERANCE, maxAbsError, count: COUNT, steps: STEPS };
  } finally {
    device.destroy();
  }
}
