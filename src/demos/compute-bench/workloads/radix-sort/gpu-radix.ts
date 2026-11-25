import type { GpuImpl } from '../../../../core/oneshot';
import { DIGIT_BITS, MAX_KEYS, PASSES, RADIX, SCAN_BLOCK, TILE, scanLevels, tileCount } from './tiling';

const THREADS = 64;
const PER_THREAD = TILE / THREADS;
const SCAN_THREADS = SCAN_BLOCK / 2;

// Each thread owns PER_THREAD contiguous keys of the tile. Counting its own digits per thread and scanning
// the per-thread counts in digit order gives a stable rank without atomics.
const TILE_COMMON = /* wgsl */ `
struct Params { n: u32, shift: u32, tiles: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;
var<workgroup> cnt: array<u32, ${RADIX * THREADS}>;

fn load_counts(base: u32, lid: u32, mine: ptr<function, array<u32, ${PER_THREAD}>>) {
  var local: array<u32, ${RADIX}>;
  for (var j = 0u; j < ${PER_THREAD}u; j++) {
    let i = base + j;
    var d = ${RADIX}u;
    if (i < p.n) {
      d = (keys[i] >> p.shift) & ${RADIX - 1}u;
      local[d] += 1u;
    }
    (*mine)[j] = d;
  }
  for (var d = 0u; d < ${RADIX}u; d++) { cnt[d * ${THREADS}u + lid] = local[d]; }
  workgroupBarrier();
}
`;

const COUNT_WGSL = /* wgsl */ `
${TILE_COMMON}
@group(0) @binding(1) var<storage, read_write> hist: array<u32>;

@compute @workgroup_size(${THREADS})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  var mine: array<u32, ${PER_THREAD}>;
  load_counts(wg.x * ${TILE}u + lid * ${PER_THREAD}u, lid, &mine);
  if (lid < ${RADIX}u) {
    var total = 0u;
    for (var t = 0u; t < ${THREADS}u; t++) { total += cnt[lid * ${THREADS}u + t]; }
    hist[lid * p.tiles + wg.x] = total;
  }
}
`;

const SCATTER_WGSL = /* wgsl */ `
${TILE_COMMON}
@group(0) @binding(1) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32>;

@compute @workgroup_size(${THREADS})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let base = wg.x * ${TILE}u + lid * ${PER_THREAD}u;
  var mine: array<u32, ${PER_THREAD}>;
  load_counts(base, lid, &mine);
  if (lid < ${RADIX}u) {
    var run = 0u;
    for (var t = 0u; t < ${THREADS}u; t++) {
      let c = cnt[lid * ${THREADS}u + t];
      cnt[lid * ${THREADS}u + t] = run;
      run += c;
    }
  }
  workgroupBarrier();
  var seen: array<u32, ${RADIX}>;
  for (var j = 0u; j < ${PER_THREAD}u; j++) {
    let d = mine[j];
    if (d < ${RADIX}u) {
      let rank = cnt[d * ${THREADS}u + lid] + seen[d];
      seen[d] += 1u;
      out[offsets[d * p.tiles + wg.x] + rank] = keys[base + j];
    }
  }
}
`;

const SCAN_WGSL = /* wgsl */ `
struct Params { count: u32 }
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@group(0) @binding(1) var<storage, read_write> sums: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;
var<workgroup> s: array<u32, ${SCAN_BLOCK}>;

@compute @workgroup_size(${SCAN_THREADS})
fn scan(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let a = wg.x * ${SCAN_BLOCK}u + 2u * lid;
  s[2u * lid] = select(0u, data[a], a < p.count);
  s[2u * lid + 1u] = select(0u, data[a + 1u], a + 1u < p.count);
  var off = 1u;
  for (var d = ${SCAN_THREADS}u; d > 0u; d >>= 1u) {
    workgroupBarrier();
    if (lid < d) { s[off * (2u * lid + 2u) - 1u] += s[off * (2u * lid + 1u) - 1u]; }
    off <<= 1u;
  }
  workgroupBarrier();
  if (lid == 0u) { sums[wg.x] = s[${SCAN_BLOCK - 1}]; s[${SCAN_BLOCK - 1}] = 0u; }
  for (var d = 1u; d < ${SCAN_BLOCK}u; d <<= 1u) {
    off >>= 1u;
    workgroupBarrier();
    if (lid < d) {
      let i = off * (2u * lid + 1u) - 1u;
      let j = off * (2u * lid + 2u) - 1u;
      let t = s[i];
      s[i] = s[j];
      s[j] += t;
    }
  }
  workgroupBarrier();
  if (a < p.count) { data[a] = s[2u * lid]; }
  if (a + 1u < p.count) { data[a + 1u] = s[2u * lid + 1u]; }
}

@compute @workgroup_size(${SCAN_THREADS})
fn add(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let a = wg.x * ${SCAN_BLOCK}u + 2u * lid;
  let base = sums[wg.x];
  if (a < p.count) { data[a] += base; }
  if (a + 1u < p.count) { data[a + 1u] += base; }
}
`;

export const gpuRadix: GpuImpl<Uint32Array, Uint32Array> = {
  kind: 'gpu',
  id: 'gpu-radix',
  label: 'WebGPU (LSD 기수 정렬, 4비트 x 8패스)',
  maxN: MAX_KEYS,
  async prepare(device, input) {
    const n = input.length;
    const tiles = tileCount(n);
    const levels = scanLevels(RADIX * tiles);

    const compile = (code: string, entryPoint: string) =>
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint } });
    const [count, scatter, scan, add] = await Promise.all([
      compile(COUNT_WGSL, 'main'),
      compile(SCATTER_WGSL, 'main'),
      compile(SCAN_WGSL, 'scan'),
      compile(SCAN_WGSL, 'add'),
    ]);

    const STORAGE = GPUBufferUsage.STORAGE;
    const owned: GPUBuffer[] = [];
    const make = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size: Math.max(16, size), usage });
      owned.push(buffer);
      return buffer;
    };
    const uniform = (...words: number[]) => {
      const buffer = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(buffer, 0, new Uint32Array([...words, 0, 0, 0, 0].slice(0, 4)));
      return buffer;
    };
    const bind = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });

    const a = make(n * 4, STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const b = make(n * 4, STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const readBuf = make(n * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const table = levels.map((m) => make(m * 4, STORAGE));
    const topSums = make(4, STORAGE);

    // Scan hierarchy shared by all passes: level k is scanned in blocks, block totals land in level k+1.
    const scanSteps = levels.map((m, k) => {
      const sums = table[k + 1] ?? topSums;
      const params = uniform(m);
      return { groups: Math.ceil(m / SCAN_BLOCK), scan: bind(scan, [table[k]!, sums, params]), add: bind(add, [table[k]!, sums, params]) };
    });
    const hist = table[0]!;

    const radixPasses = Array.from({ length: PASSES }, (_, i) => {
      const src = i % 2 === 0 ? a : b;
      const dst = i % 2 === 0 ? b : a;
      const params = uniform(n, i * DIGIT_BITS, tiles);
      return { count: bind(count, [src, hist, params]), scatter: bind(scatter, [src, hist, params, dst]) };
    });

    return {
      upload() {
        device.queue.writeBuffer(a, 0, input as GPUAllowSharedBufferSource);
      },
      encode(encoder, ts) {
        const dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup, x: number, timestampWrites?: GPUComputePassTimestampWrites) => {
          const pass = encoder.beginComputePass({ timestampWrites });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(x);
          pass.end();
        };
        radixPasses.forEach((rp, i) => {
          dispatch(count, rp.count, tiles, i === 0 ? ts?.first : undefined);
          for (const step of scanSteps) dispatch(scan, step.scan, step.groups);
          for (let k = scanSteps.length - 2; k >= 0; k--) dispatch(add, scanSteps[k]!.add, scanSteps[k]!.groups);
          dispatch(scatter, rp.scatter, tiles, i === PASSES - 1 ? ts?.last : undefined);
        });
        encoder.copyBufferToBuffer(a, 0, readBuf, 0, n * 4);
      },
      async readback() {
        await readBuf.mapAsync(GPUMapMode.READ);
        const out = new Uint32Array(readBuf.getMappedRange().slice(0), 0, n);
        readBuf.unmap();
        return out;
      },
      dispose() {
        for (const buffer of owned) buffer.destroy();
      },
    };
  },
};
