import type { CpuImpl, GpuImpl, Workload } from '../../../../core/oneshot';
import { BINS, GRID, binInto, clusteredPoints, compareCounts, referenceCounts } from './bin';

const GROUP = 256;
const MAX_GROUPS = 8192;
const TILE = 64;
const TILES = (GRID / TILE) ** 2;
const SLICES = 64;
const MAX_N = 2 ** 24;

const SHARED = /* wgsl */ `
struct Params { count: u32, stride: u32 }
@group(0) @binding(0) var<storage, read> pts: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn binOf(v: f32) -> u32 { return min(u32(floor(v * ${GRID}.0)), ${GRID - 1}u); }
`;

const GLOBAL_ATOMIC = /* wgsl */ `${SHARED}
@compute @workgroup_size(${GROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  for (var i = gid.x; i < params.count; i += params.stride) {
    let p = pts[i];
    atomicAdd(&bins[binOf(p.y) * ${GRID}u + binOf(p.x)], 1u);
  }
}
`;

// Workgroup w owns tile (w % TILES) and scans every SLICES-th block of points, counting only the points that land in its tile.
const PRIVATIZED = /* wgsl */ `${SHARED}
var<workgroup> local: array<atomic<u32>, ${TILE * TILE}>;

@compute @workgroup_size(${GROUP})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let tile = wg.x % ${TILES}u;
  let slice = wg.x / ${TILES}u;
  let tx = (tile % ${GRID / TILE}u) * ${TILE}u;
  let ty = (tile / ${GRID / TILE}u) * ${TILE}u;
  for (var b = lid; b < ${TILE * TILE}u; b += ${GROUP}u) { atomicStore(&local[b], 0u); }
  workgroupBarrier();
  for (var i = slice * ${GROUP}u + lid; i < params.count; i += params.stride) {
    let p = pts[i];
    let bx = binOf(p.x);
    let by = binOf(p.y);
    if (bx - tx < ${TILE}u && by - ty < ${TILE}u) {
      atomicAdd(&local[(by - ty) * ${TILE}u + (bx - tx)], 1u);
    }
  }
  workgroupBarrier();
  for (var b = lid; b < ${TILE * TILE}u; b += ${GROUP}u) {
    let v = atomicLoad(&local[b]);
    if (v > 0u) { atomicAdd(&bins[(ty + b / ${TILE}u) * ${GRID}u + tx + b % ${TILE}u], v); }
  }
}
`;

const cpuLoop: CpuImpl<Float32Array, Uint32Array> = {
  kind: 'cpu',
  id: 'cpu-loop',
  label: 'CPU (JS 루프, 한 번 훑기)',
  run(input) {
    const counts = new Uint32Array(BINS);
    binInto(input, counts);
    return counts;
  },
};

function gpuImpl(
  id: string,
  label: string,
  code: string,
  groupsFor: (n: number) => { groups: number; stride: number },
): GpuImpl<Float32Array, Uint32Array> {
  return {
    kind: 'gpu',
    id,
    label,
    maxN: MAX_N,
    async prepare(device, input) {
      const n = input.length / 2;
      const module = device.createShaderModule({ code });
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const { groups, stride } = groupsFor(n);

      const pts = device.createBuffer({ size: Math.max(8, n * 8), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const bins = device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const readBuf = device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([n, stride]));
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pts } },
          { binding: 1, resource: { buffer: bins } },
          { binding: 2, resource: { buffer: params } },
        ],
      });

      return {
        upload() {
          device.queue.writeBuffer(pts, 0, input as GPUAllowSharedBufferSource);
        },
        encode(encoder, ts) {
          encoder.clearBuffer(bins);
          const pass = encoder.beginComputePass({ timestampWrites: ts?.only });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(groups);
          pass.end();
          encoder.copyBufferToBuffer(bins, 0, readBuf, 0, BINS * 4);
        },
        async readback() {
          await readBuf.mapAsync(GPUMapMode.READ);
          const out = new Uint32Array(readBuf.getMappedRange().slice(0));
          readBuf.unmap();
          return out;
        },
        dispose() {
          for (const b of [pts, bins, params, readBuf]) b.destroy();
        },
      };
    },
  };
}

const globalAtomic = gpuImpl('gpu-global-atomic', 'WebGPU (전역 atomicAdd)', GLOBAL_ATOMIC, (n) => {
  const groups = Math.max(1, Math.min(Math.ceil(n / GROUP), MAX_GROUPS));
  return { groups, stride: groups * GROUP };
});

const privatized = gpuImpl('gpu-privatized', 'WebGPU (워크그룹 타일 privatization)', PRIVATIZED, () => ({
  groups: TILES * SLICES,
  stride: SLICES * GROUP,
}));

export const workload: Workload<Float32Array, Uint32Array> = {
  id: 'binning2d',
  label: '2D 빈닝 (밀도 히스토그램)',
  summary: '군집을 이룬 (x, y) 점 N개를 512×512 격자의 카운트로 세어 히트맵 재료를 만듭니다. 점당 연산은 정수 덧셈 하나라 업로드가 크고, 군집 때문에 같은 빈에 쓰기가 몰립니다.',
  sizes: Array.from({ length: 13 }, (_, i) => 2 ** (12 + i)),
  smokeSizes: [2 ** 12, 2 ** 16, 2 ** 20],
  sizeLabel: (n) => `2^${Math.log2(n)} (${n.toLocaleString('ko-KR')}점)`,
  makeInput: (n, seed) => clusteredPoints(n, seed),
  impls: [cpuLoop, globalAtomic, privatized],
  verify(input, output) {
    return compareCounts(input.length / 2, output, referenceCounts(input));
  },
  work: (n) => ({ amount: n / 1e9, unit: 'G점' }),
};
