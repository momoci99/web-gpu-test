import type { Capabilities } from '../../../core/capabilities';
import { createGpuTimer, type GpuTimer, type TimestampWrites } from '../../../core/gpu-timer';
import type { SceneData } from '../scene';
import { mountCanvas } from './canvas-util';

const DRAW_WGSL = /* wgsl */ `
struct Frame { size: vec2f }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> state: array<vec4f>;
@group(0) @binding(2) var<storage, read> radius: array<f32>;
@group(0) @binding(3) var<storage, read> color: array<u32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) radius: f32,
  @location(2) @interpolate(flat) color: vec4f,
}

const CORNERS = array<vec2f, 6>(
  vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
  vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1),
);

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  let r = radius[ii];
  let local = CORNERS[vi] * (r + 1.0);
  let px = state[ii].xy + local;
  var out: VsOut;
  out.pos = vec4f(px.x / frame.size.x * 2.0 - 1.0, 1.0 - px.y / frame.size.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.radius = r;
  out.color = unpack4x8unorm(color[ii]);
  return out;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let cover = 1.0 - smoothstep(in.radius - 0.5, in.radius + 0.5, length(in.local));
  if (cover <= 0.0) { discard; }
  let a = in.color.a * cover;
  return vec4f(in.color.rgb * a, a);
}
`;

export async function requestDevice(caps: Capabilities): Promise<GPUDevice> {
  if (caps.webgpu.kind !== 'available') throw new Error('WebGPU를 사용할 수 없습니다');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('requestAdapter()가 null을 반환했습니다');
  const device = await adapter.requestDevice({
    requiredFeatures: caps.webgpu.timestampQuery ? ['timestamp-query'] : [],
  });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU 오류:', (e as GPUUncapturedErrorEvent).error.message));
  return device;
}

function storageBuffer(device: GPUDevice, data: Float32Array | Uint32Array): GPUBuffer {
  const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, data as GPUAllowSharedBufferSource);
  return buf;
}

export interface Drawer {
  readonly timer: GpuTimer | null;
  encode(encoder: GPUCommandEncoder, timestampWrites?: TimestampWrites): void;
  dispose(): void;
}

/** Instanced-quad circle drawer. Reads instance state from `stateBuf`, which the caller owns and updates. */
export function createDrawer(
  device: GPUDevice,
  host: HTMLElement,
  scene: SceneData,
  caps: Capabilities,
  stateBuf: GPUBuffer,
): Drawer {
  const canvas = mountCanvas(host, scene.config, caps.dpr);
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('WebGPU 캔버스 컨텍스트를 만들 수 없습니다');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  const module = device.createShaderModule({ code: DRAW_WGSL });
  const blend: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module },
    fragment: { module, targets: [{ format, blend: { color: blend, alpha: blend } }] },
    primitive: { topology: 'triangle-list' },
  });

  const frameBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(frameBuf, 0, new Float32Array([scene.config.width, scene.config.height, 0, 0]));
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameBuf } },
      { binding: 1, resource: { buffer: stateBuf } },
      { binding: 2, resource: { buffer: storageBuffer(device, scene.radius) } },
      { binding: 3, resource: { buffer: storageBuffer(device, scene.color) } },
    ],
  });

  const timer = createGpuTimer(device);
  const count = scene.config.count;

  return {
    timer,
    encode(encoder, timestampWrites) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
        timestampWrites,
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6, count);
      pass.end();
    },
    dispose() {
      timer?.destroy();
      context.unconfigure();
      canvas.remove();
    },
  };
}
