import { FIXED_DT, stepScene } from '../scene';
import { createDrawer, requestDevice } from './gpu-common';
import type { RendererEntry } from './types';

export const webgpuCpuEntry: RendererEntry = {
  id: 'webgpu-cpu',
  label: 'WebGPU (CPU 시뮬레이션)',
  summary: 'CPU에서 시뮬레이션하고 매 프레임 queue.writeBuffer로 상태를 올린 뒤 인스턴스 draw로 그립니다.',
  requires: 'webgpu',
  async create(host, scene, caps) {
    const device = await requestDevice(caps);
    const stateBuf = device.createBuffer({
      size: scene.state.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(stateBuf, 0, scene.state);
    const drawer = createDrawer(device, host, scene, caps, stateBuf);
    const timer = drawer.timer;

    let disposed = false;
    return {
      id: 'webgpu-cpu',
      frame() {
        stepScene(scene, FIXED_DT);
        device.queue.writeBuffer(stateBuf, 0, scene.state);
        const encoder = device.createCommandEncoder();
        drawer.encode(encoder, timer?.only);
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
