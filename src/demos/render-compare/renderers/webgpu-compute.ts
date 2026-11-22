import { createComputeSim } from './compute-sim';
import { createDrawer, requestDevice } from './gpu-common';
import type { RendererEntry } from './types';

export const webgpuComputeEntry: RendererEntry = {
  id: 'webgpu-compute',
  label: 'WebGPU (컴퓨트 시뮬레이션)',
  summary: '상태가 GPU 스토리지 버퍼에 있고, 컴퓨트 패스가 바운스를 계산한 뒤 같은 버퍼를 렌더 패스가 읽습니다. CPU 루프와 readback이 없습니다.',
  requires: 'webgpu',
  async create(host, scene, caps) {
    const device = await requestDevice(caps);
    const sim = createComputeSim(device, scene);
    const drawer = createDrawer(device, host, scene, caps, sim.stateBuf);
    const timer = drawer.timer;

    let disposed = false;
    return {
      id: 'webgpu-compute',
      frame() {
        const encoder = device.createCommandEncoder();
        sim.encodeStep(encoder, timer?.first);
        drawer.encode(encoder, timer?.last);
        timer?.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        timer?.afterSubmit();
      },
      settle: () => device.queue.onSubmittedWorkDone(),
      drainGpuSamples: timer ? () => timer.drain() : undefined,
      dispose() {
        if (disposed) return;
        disposed = true;
        drawer.dispose();
        device.destroy();
      },
    };
  },
};
