import type { Capabilities } from '../../core/capabilities';
import { createGpuTimer, type GpuTimer, type TimestampWrites } from '../../core/gpu-timer';
import { DRAW_WGSL, NAIVE_WGSL, NAIVE_WORKGROUP, TILE, TILED_WGSL } from './kernels';
import { SIM, VIEW_HALF } from './sim';

export type KernelKind = 'naive' | 'tiled';

const KERNELS = {
  naive: { code: NAIVE_WGSL, workgroup: NAIVE_WORKGROUP },
  tiled: { code: TILED_WGSL, workgroup: TILE },
} as const;

export const CANVAS_SIZE = 720;
const POINT_RADIUS_PX = 1.6;

export async function requestDevice(caps: Capabilities): Promise<GPUDevice> {
  if (caps.webgpu.kind !== 'available') throw new Error('WebGPU를 사용할 수 없습니다');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('requestAdapter()가 null을 반환했습니다');
  const device = await adapter.requestDevice({
    requiredFeatures: caps.webgpu.timestampQuery ? ['timestamp-query'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU 오류:', (e as GPUUncapturedErrorEvent).error.message));
  return device;
}

export interface GpuSim {
  /** Records `steps` dependent steps into one compute pass. */
  encodeSteps(encoder: GPUCommandEncoder, steps: number, timestampWrites?: TimestampWrites): void;
  /** The buffer holding the latest state. */
  current(): GPUBuffer;
  dispose(): void;
}

/** State lives in two storage buffers; each step reads one and writes the other, so no invocation sees a half-updated state. */
export async function createGpuSim(device: GPUDevice, kind: KernelKind, initial: Float32Array): Promise<GpuSim> {
  const count = initial.length / 4;
  const { code, workgroup } = KERNELS[kind];
  const module = device.createShaderModule({ code });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  const stateUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const bufs = [0, 1].map(() => device.createBuffer({ size: initial.byteLength, usage: stateUsage }));
  device.queue.writeBuffer(bufs[0]!, 0, initial as GPUAllowSharedBufferSource);

  const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const raw = new ArrayBuffer(16);
  new Uint32Array(raw)[0] = count;
  new Float32Array(raw).set([SIM.dt, (SIM.gm / count) * SIM.dt, SIM.eps * SIM.eps], 1);
  device.queue.writeBuffer(params, 0, raw);

  const groups = [0, 1].map((from) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: bufs[from]! } },
        { binding: 2, resource: { buffer: bufs[1 - from]! } },
      ],
    }),
  );

  const groupCount = Math.ceil(count / workgroup);
  let latest = 0;
  return {
    encodeSteps(encoder, steps, timestampWrites) {
      const pass = encoder.beginComputePass({ timestampWrites });
      pass.setPipeline(pipeline);
      for (let s = 0; s < steps; s++) {
        pass.setBindGroup(0, groups[latest]!);
        pass.dispatchWorkgroups(groupCount);
        latest = 1 - latest;
      }
      pass.end();
    },
    current: () => bufs[latest]!,
    dispose() {
      bufs.forEach((b) => b.destroy());
      params.destroy();
    },
  };
}

export interface Drawer {
  readonly timer: GpuTimer | null;
  encode(encoder: GPUCommandEncoder, bodies: GPUBuffer, timestampWrites?: TimestampWrites): void;
  dispose(): void;
}

/** Additive instanced quads read straight from a state buffer. Identical for every variant. */
export function createDrawer(device: GPUDevice, host: HTMLElement, count: number, caps: Capabilities): Drawer {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(CANVAS_SIZE * caps.dpr);
  canvas.height = canvas.width;
  canvas.style.width = `${CANVAS_SIZE}px`;
  canvas.style.height = `${CANVAS_SIZE}px`;
  canvas.style.background = '#000';
  host.replaceChildren(canvas);
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('WebGPU 캔버스 컨텍스트를 만들 수 없습니다');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const module = device.createShaderModule({ code: DRAW_WGSL });
  const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module },
    fragment: { module, targets: [{ format, blend: { color: add, alpha: add } }] },
    primitive: { topology: 'triangle-list' },
  });

  const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const intensity = Math.min(0.8, Math.max(0.03, 30 / Math.sqrt(count)));
  device.queue.writeBuffer(uniform, 0, new Float32Array([VIEW_HALF, (POINT_RADIUS_PX * 2) / CANVAS_SIZE, intensity, 0]));

  const groups = new Map<GPUBuffer, GPUBindGroup>();
  const groupFor = (bodies: GPUBuffer) => {
    let g = groups.get(bodies);
    if (!g) {
      g = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: bodies } },
        ],
      });
      groups.set(bodies, g);
    }
    return g;
  };

  const timer = createGpuTimer(device);
  return {
    timer,
    encode(encoder, bodies, timestampWrites) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        timestampWrites,
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groupFor(bodies));
      pass.draw(6, count);
      pass.end();
    },
    dispose() {
      timer?.destroy();
      uniform.destroy();
      context.unconfigure();
      canvas.remove();
    },
  };
}
