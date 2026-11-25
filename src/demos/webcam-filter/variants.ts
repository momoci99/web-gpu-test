import type { Capabilities, Requirement } from '../../core/capabilities';
import type { FrameTarget } from '../../core/frame-bench';
import { createGpuTimer } from '../../core/gpu-timer';
import { CpuFilter } from './cpu-filter';
import type { FilterParams } from './filters';
import { GpuFilter, PRESENT_SHADER } from './gpu-filter';
import type { VideoSource } from './source';

export type VariantId = 'cpu-canvas' | 'gpu-compute';

export interface VariantContext {
  host: HTMLElement;
  source: VideoSource;
  width: number;
  height: number;
  params: FilterParams;
  caps: Capabilities;
}

export interface VariantEntry {
  id: VariantId;
  label: string;
  summary: string;
  requires: Requirement;
  create(ctx: VariantContext): Promise<FrameTarget>;
}

function mountCanvas(host: HTMLElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  host.replaceChildren(canvas);
  return canvas;
}

const cpuCanvas: VariantEntry = {
  id: 'cpu-canvas',
  label: 'CPU (Canvas2D + getImageData)',
  summary: 'drawImage로 프레임을 캔버스에 그린 뒤 getImageData로 CPU로 읽어 JS 루프로 필터링하고 putImageData로 되돌립니다.',
  requires: 'none',
  async create({ host, source, width, height, params }) {
    const canvas = mountCanvas(host, width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const filter = new CpuFilter(width, height);
    const out = new ImageData(width, height);
    return {
      frame() {
        ctx.drawImage(source.video, 0, 0, width, height);
        const img = ctx.getImageData(0, 0, width, height);
        filter.run(img.data, out.data, params);
        ctx.putImageData(out, 0, 0);
      },
      dispose() {
        canvas.remove();
      },
    };
  },
};

let sharedDevice: Promise<GPUDevice> | null = null;

// One device per page, never destroyed by a run. Destroying a device that imported video frames and requesting a new
// one right after left Chromium without a valid instance for the next requestAdapter/requestDevice.
export function getFilterDevice(caps: Capabilities): Promise<GPUDevice> {
  if (caps.webgpu.kind !== 'available') return Promise.reject(new Error('WebGPU를 사용할 수 없습니다'));
  const requiredFeatures: GPUFeatureName[] = caps.webgpu.timestampQuery ? ['timestamp-query'] : [];
  sharedDevice ??= (async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('requestAdapter()가 null을 반환했습니다');
    const device = await adapter.requestDevice({ requiredFeatures });
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU 오류:', (e as GPUUncapturedErrorEvent).error.message));
    void device.lost.then(() => {
      sharedDevice = null;
    });
    return device;
  })();
  return sharedDevice;
}

const gpuCompute: VariantEntry = {
  id: 'gpu-compute',
  label: 'WebGPU (컴퓨트 패스)',
  summary: 'importExternalTexture로 비디오 프레임을 복사 없이 바인딩하고, 컴퓨트 패스(분리형 블러는 핑퐁 스토리지 텍스처)로 필터링한 뒤 캔버스에 그립니다.',
  requires: 'webgpu',
  async create({ host, source, width, height, params, caps }) {
    const device = await getFilterDevice(caps);
    const canvas = mountCanvas(host, width, height);
    const context = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const filter = await GpuFilter.create(device, width, height);
    filter.setParams(params);
    const module = device.createShaderModule({ code: PRESENT_SHADER });
    const present = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    });
    const presentGroup = device.createBindGroup({
      layout: present.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: filter.output.createView() }],
    });
    const timer = createGpuTimer(device);

    let disposed = false;
    return {
      frame() {
        const encoder = device.createCommandEncoder();
        // The external texture expires at the end of the current task, so it is imported again every frame.
        filter.encode(encoder, { kind: 'external', texture: device.importExternalTexture({ source: source.video }) }, timer?.first);
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }],
          timestampWrites: timer?.last,
        });
        pass.setPipeline(present);
        pass.setBindGroup(0, presentGroup);
        pass.draw(3);
        pass.end();
        timer?.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        timer?.afterSubmit();
      },
      settle: () => device.queue.onSubmittedWorkDone(),
      drainGpuSamples: timer ? () => timer.drain() : undefined,
      dispose() {
        if (disposed) return;
        disposed = true;
        filter.dispose();
        timer?.destroy();
        context.unconfigure();
        canvas.remove();
      },
    };
  },
};

export const registry: readonly VariantEntry[] = [cpuCanvas, gpuCompute];
