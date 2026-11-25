import type { GpuImpl, GpuRun } from '../../../../core/oneshot';
import { BLOCKED_WGSL, BLOCK_TILE, NAIVE_WGSL, TILE, TILED_WGSL } from './kernels';
import type { GemmInput } from './types';

function makeGpuImpl(id: string, label: string, code: string, groupSpan: number): GpuImpl<GemmInput, Float32Array> {
  return {
    kind: 'gpu',
    id,
    label,
    async prepare(device, { n, a, b }): Promise<GpuRun<Float32Array>> {
      const module = device.createShaderModule({ code });
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const bytes = n * n * 4;
      const bufA = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const bufB = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const bufC = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const readBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([n]));
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: bufA } },
          { binding: 1, resource: { buffer: bufB } },
          { binding: 2, resource: { buffer: bufC } },
          { binding: 3, resource: { buffer: params } },
        ],
      });
      const groups = Math.ceil(n / groupSpan);

      return {
        upload() {
          device.queue.writeBuffer(bufA, 0, a as GPUAllowSharedBufferSource);
          device.queue.writeBuffer(bufB, 0, b as GPUAllowSharedBufferSource);
        },
        encode(encoder, ts) {
          const pass = encoder.beginComputePass({ timestampWrites: ts?.only });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(groups, groups);
          pass.end();
          encoder.copyBufferToBuffer(bufC, 0, readBuf, 0, bytes);
        },
        async readback() {
          await readBuf.mapAsync(GPUMapMode.READ);
          const out = new Float32Array(readBuf.getMappedRange().slice(0));
          readBuf.unmap();
          return out;
        },
        dispose() {
          for (const buf of [bufA, bufB, bufC, params, readBuf]) buf.destroy();
        },
      };
    },
  };
}

export const gpuNaive = makeGpuImpl('gpu-naive', 'WebGPU (원소당 스레드 1개)', NAIVE_WGSL, TILE);
export const gpuTiled = makeGpuImpl('gpu-tiled', 'WebGPU (16×16 공유 메모리 타일)', TILED_WGSL, TILE);
export const gpuBlocked = makeGpuImpl('gpu-blocked', 'WebGPU (타일 + 스레드당 4×4 레지스터 블록)', BLOCKED_WGSL, BLOCK_TILE);
