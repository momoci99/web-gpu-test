import { mulberry32 } from '../../../../core/rng';
import type { CpuImpl, GpuImpl, Workload } from '../../../../core/oneshot';

const GROUP = 256;
const PER_THREAD = 4;
const PER_GROUP = GROUP * PER_THREAD;
const TOLERANCE = 1e-4;

const WGSL = /* wgsl */ `
struct Params { count: u32 }
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

var<workgroup> scratch: array<f32, ${GROUP}>;

@compute @workgroup_size(${GROUP})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let base = wg.x * ${PER_GROUP}u + lid;
  var acc = 0.0;
  for (var k = 0u; k < ${PER_THREAD}u; k++) {
    let i = base + k * ${GROUP}u;
    if (i < params.count) { acc += src[i]; }
  }
  scratch[lid] = acc;
  workgroupBarrier();
  for (var s = ${GROUP / 2}u; s > 0u; s >>= 1u) {
    if (lid < s) { scratch[lid] += scratch[lid + s]; }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[wg.x] = scratch[0]; }
}
`;

const cpuSum: CpuImpl<Float32Array, number> = {
  kind: 'cpu',
  id: 'cpu-loop',
  label: 'CPU (JS 루프, f64 누적)',
  run(input) {
    let s = 0;
    for (let i = 0; i < input.length; i++) s += input[i]!;
    return s;
  },
};

const gpuTree: GpuImpl<Float32Array, number> = {
  kind: 'gpu',
  id: 'gpu-tree',
  label: 'WebGPU (워크그룹 트리 리덕션)',
  async prepare(device, input) {
    const n = input.length;
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });

    // counts[i] is the element count entering pass i; pass i writes ceil(counts[i] / PER_GROUP) partials.
    const counts: number[] = [];
    let c = n;
    do {
      counts.push(c);
      c = Math.ceil(c / PER_GROUP);
    } while (c > 1);

    const inBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const partialSize = Math.max(4, Math.ceil(n / PER_GROUP) * 4);
    const ping = device.createBuffer({ size: partialSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const pong = device.createBuffer({ size: partialSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const passes = counts.map((count, i) => {
      const src = i === 0 ? inBuf : i % 2 === 1 ? ping : pong;
      const dst = i % 2 === 0 ? ping : pong;
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([count]));
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: src } },
          { binding: 1, resource: { buffer: dst } },
          { binding: 2, resource: { buffer: params } },
        ],
      });
      return { bindGroup, groups: Math.ceil(count / PER_GROUP), params, dst };
    });
    const finalBuf = passes[passes.length - 1]!.dst;

    return {
      upload() {
        device.queue.writeBuffer(inBuf, 0, input as GPUAllowSharedBufferSource);
      },
      encode(encoder, ts) {
        passes.forEach((p, i) => {
          const timestampWrites =
            passes.length === 1 ? ts?.only : i === 0 ? ts?.first : i === passes.length - 1 ? ts?.last : undefined;
          const pass = encoder.beginComputePass({ timestampWrites });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, p.bindGroup);
          pass.dispatchWorkgroups(p.groups);
          pass.end();
        });
        encoder.copyBufferToBuffer(finalBuf, 0, readBuf, 0, 4);
      },
      async readback() {
        await readBuf.mapAsync(GPUMapMode.READ);
        const value = new Float32Array(readBuf.getMappedRange().slice(0))[0]!;
        readBuf.unmap();
        return value;
      },
      dispose() {
        for (const b of [inBuf, ping, pong, readBuf, ...passes.map((p) => p.params)]) b.destroy();
      },
    };
  },
};

export const workload: Workload<Float32Array, number> = {
  id: 'reduction',
  label: '리덕션 (f32 합계)',
  summary: 'N개의 f32를 모두 더해 값 하나를 구합니다. 연산량이 작아 업로드와 읽기 비용이 승패를 좌우합니다.',
  sizes: Array.from({ length: 15 }, (_, i) => 2 ** (10 + i)),
  smokeSizes: [2 ** 10, 2 ** 16, 2 ** 20],
  sizeLabel: (n) => `2^${Math.log2(n)} (${n.toLocaleString('ko-KR')}개)`,
  makeInput(n, seed) {
    const rand = mulberry32(seed);
    const xs = new Float32Array(n);
    for (let i = 0; i < n; i++) xs[i] = rand();
    return xs;
  },
  impls: [cpuSum, gpuTree],
  verify(input, output) {
    let ref = 0;
    for (let i = 0; i < input.length; i++) ref += input[i]!;
    const rel = Math.abs(output - ref) / Math.abs(ref);
    return { ok: Number.isFinite(rel) && rel <= TOLERANCE, detail: `상대 오차 ${rel.toExponential(2)} (기준 ${ref.toFixed(1)})` };
  },
  work: (n) => ({ amount: n / 1e9, unit: 'G원소' }),
};
