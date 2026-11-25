import type { Capabilities, Requirement } from '../../core/capabilities';
import type { FrameTarget } from '../../core/frame-bench';
import { createDrawer, createGpuSim, requestDevice, type Drawer, type GpuSim, type KernelKind } from './gpu';
import { stepCpu } from './sim';

export type VariantId = 'cpu-js' | 'gpu-naive' | 'gpu-tiled';

export interface VariantInput {
  host: HTMLElement;
  caps: Capabilities;
  /** Interleaved [x, y, vx, vy]. Not modified. */
  bodies: Float32Array;
  /** Simulation steps per drawn frame. */
  stepsPerFrame: number;
}

export interface VariantEntry {
  id: VariantId;
  label: string;
  summary: string;
  /** cpu-js simulates on the CPU but draws with the shared WebGPU point renderer, so it needs WebGPU too. */
  requires: Requirement;
  create(input: VariantInput): Promise<FrameTarget>;
}

function finish(device: GPUDevice, encoder: GPUCommandEncoder, drawer: Drawer): void {
  drawer.timer?.resolve(encoder);
  device.queue.submit([encoder.finish()]);
  drawer.timer?.afterSubmit();
}

function disposer(device: GPUDevice, drawer: Drawer, sim?: GpuSim): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    drawer.dispose();
    sim?.dispose();
    device.destroy();
  };
}

async function createCpuJs({ host, caps, bodies, stepsPerFrame }: VariantInput): Promise<FrameTarget> {
  const count = bodies.length / 4;
  const device = await requestDevice(caps);
  const drawer = createDrawer(device, host, count, caps);
  const stateBuf = device.createBuffer({ size: bodies.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  let a = Float32Array.from(bodies);
  let b = new Float32Array(bodies.length);
  const disposeGpu = disposer(device, drawer);
  return {
    frame() {
      for (let s = 0; s < stepsPerFrame; s++) {
        stepCpu(a, b, count);
        [a, b] = [b, a];
      }
      device.queue.writeBuffer(stateBuf, 0, a as GPUAllowSharedBufferSource);
      const encoder = device.createCommandEncoder();
      drawer.encode(encoder, stateBuf, drawer.timer?.only);
      finish(device, encoder, drawer);
    },
    settle: () => device.queue.onSubmittedWorkDone(),
    drainGpuSamples: drawer.timer ? () => drawer.timer!.drain() : undefined,
    dispose() {
      disposeGpu();
      stateBuf.destroy();
    },
  };
}

function gpuVariant(kind: KernelKind) {
  return async ({ host, caps, bodies, stepsPerFrame }: VariantInput): Promise<FrameTarget> => {
    const device = await requestDevice(caps);
    const sim = await createGpuSim(device, kind, bodies);
    const drawer = createDrawer(device, host, bodies.length / 4, caps);
    const timer = drawer.timer;
    return {
      frame() {
        const encoder = device.createCommandEncoder();
        sim.encodeSteps(encoder, stepsPerFrame, timer?.first);
        drawer.encode(encoder, sim.current(), timer?.last);
        finish(device, encoder, drawer);
      },
      settle: () => device.queue.onSubmittedWorkDone(),
      drainGpuSamples: timer ? () => timer.drain() : undefined,
      dispose: disposer(device, drawer, sim),
    };
  };
}

export const registry: readonly VariantEntry[] = [
  {
    id: 'cpu-js',
    label: 'CPU (JS, 메인 스레드)',
    summary: '모든 쌍을 JS 이중 루프로 계산한 뒤 상태를 GPU 버퍼에 올려 같은 포인트 렌더러로 그립니다. 그리기 비용은 GPU 변형과 같습니다.',
    requires: 'webgpu',
    create: createCpuJs,
  },
  {
    id: 'gpu-naive',
    label: 'WebGPU (순진한 컴퓨트)',
    summary: '물체 하나당 스레드 하나가 스토리지 버퍼의 모든 물체를 직접 읽으며 힘을 합산합니다. 스텝 후 렌더 패스가 같은 버퍼를 읽습니다.',
    requires: 'webgpu',
    create: gpuVariant('naive'),
  },
  {
    id: 'gpu-tiled',
    label: 'WebGPU (타일링 컴퓨트)',
    summary: '워크그룹이 물체를 256개씩 var<workgroup> 타일에 올리고 workgroupBarrier로 동기화한 뒤 공유 메모리에서 읽습니다 (GPU Gems 3 31장).',
    requires: 'webgpu',
    create: gpuVariant('tiled'),
  },
];
