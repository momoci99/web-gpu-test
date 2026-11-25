import type { TimestampWrites } from '../../core/gpu-timer';
import { gaussianWeights, LUMA, MAX_RADIUS, type FilterParams } from './filters';

export type IngestSource = { kind: 'external'; texture: GPUExternalTexture } | { kind: 'texture'; view: GPUTextureView };

const WG = 8;

const INGEST_EXTERNAL = /* wgsl */ `
@group(0) @binding(0) var ext: texture_external;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  textureStore(dst, id.xy, textureSampleBaseClampToEdge(ext, smp, uv));
}`;

const INGEST_TEXTURE = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(dst, id.xy, textureLoad(src, id.xy, 0));
}`;

const blurShader = (format: string) => /* wgsl */ `
override horizontal: bool;
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<${format}, write>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<uniform> radius: u32;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(src));
  if (id.x >= u32(size.x) || id.y >= u32(size.y)) { return; }
  let p = vec2i(id.xy);
  let dir = select(vec2i(0, 1), vec2i(1, 0), horizontal);
  let last = size - vec2i(1);
  var acc = weights[0] * textureLoad(src, p, 0);
  for (var k = 1u; k <= radius; k++) {
    let o = dir * i32(k);
    acc += weights[k] * (textureLoad(src, clamp(p - o, vec2i(0), last), 0) + textureLoad(src, clamp(p + o, vec2i(0), last), 0));
  }
  textureStore(dst, p, vec4f(acc.rgb, 1.0));
}`;

const POINT_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
const LUMA = vec3f(${LUMA.r}, ${LUMA.g}, ${LUMA.b});

@compute @workgroup_size(${WG}, ${WG}) fn gray(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(src);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let l = dot(textureLoad(src, id.xy, 0).rgb, LUMA);
  textureStore(dst, id.xy, vec4f(l, l, l, 1.0));
}

fn lum(p: vec2i, last: vec2i) -> f32 {
  return dot(textureLoad(src, clamp(p, vec2i(0), last), 0).rgb, LUMA);
}

@compute @workgroup_size(${WG}, ${WG}) fn sobel(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(src));
  if (id.x >= u32(size.x) || id.y >= u32(size.y)) { return; }
  let p = vec2i(id.xy);
  let last = size - vec2i(1);
  let tl = lum(p + vec2i(-1, -1), last); let tc = lum(p + vec2i(0, -1), last); let tr = lum(p + vec2i(1, -1), last);
  let ml = lum(p + vec2i(-1, 0), last);                                         let mr = lum(p + vec2i(1, 0), last);
  let bl = lum(p + vec2i(-1, 1), last);  let bc = lum(p + vec2i(0, 1), last);  let br = lum(p + vec2i(1, 1), last);
  let gx = tr + 2.0 * mr + br - tl - 2.0 * ml - bl;
  let gy = bl + 2.0 * bc + br - tl - 2.0 * tc - tr;
  let m = min(1.0, sqrt(gx * gx + gy * gy));
  textureStore(dst, id.xy, vec4f(m, m, m, 1.0));
}`;

export const PRESENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<f32>;
const TRI = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(TRI[i], 0, 1); }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return textureLoad(tex, vec2i(pos.xy), 0); }`;

/**
 * Compute-shader filter chain. Ingest writes the source into `a` (rgba16float), the filter reads `a` and
 * writes `output` (rgba8unorm); blur goes a -> b (horizontal) -> output (vertical). Edges clamp to the border.
 */
export class GpuFilter {
  readonly output: GPUTexture;
  #params: FilterParams = { filter: 'blur', radius: 1 };
  #sampler: GPUSampler;
  #a: GPUTexture;
  #b: GPUTexture;
  #weights: GPUBuffer;
  #radius: GPUBuffer;
  #ingestExternal: GPUComputePipeline;
  #ingestTexture: GPUComputePipeline;
  #blurH: GPUComputePipeline;
  #blurV: GPUComputePipeline;
  #gray: GPUComputePipeline;
  #sobel: GPUComputePipeline;
  #blurHGroup: GPUBindGroup;
  #blurVGroup: GPUBindGroup;
  #grayGroup: GPUBindGroup;
  #sobelGroup: GPUBindGroup;

  private constructor(
    readonly device: GPUDevice,
    readonly width: number,
    readonly height: number,
    pipelines: {
      ingestExternal: GPUComputePipeline;
      ingestTexture: GPUComputePipeline;
      blurH: GPUComputePipeline;
      blurV: GPUComputePipeline;
      gray: GPUComputePipeline;
      sobel: GPUComputePipeline;
    },
  ) {
    this.#ingestExternal = pipelines.ingestExternal;
    this.#ingestTexture = pipelines.ingestTexture;
    this.#blurH = pipelines.blurH;
    this.#blurV = pipelines.blurV;
    this.#gray = pipelines.gray;
    this.#sobel = pipelines.sobel;
    const size = { width, height };
    const mid = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.#a = device.createTexture({ size, format: 'rgba16float', usage: mid });
    this.#b = device.createTexture({ size, format: 'rgba16float', usage: mid });
    this.output = device.createTexture({ size, format: 'rgba8unorm', usage: mid | GPUTextureUsage.COPY_SRC });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.#weights = device.createBuffer({ size: (MAX_RADIUS + 1) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.#radius = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const a = this.#a.createView();
    const b = this.#b.createView();
    const out = this.output.createView();
    const buffers = [
      { binding: 2, resource: { buffer: this.#weights } },
      { binding: 3, resource: { buffer: this.#radius } },
    ];
    this.#blurHGroup = device.createBindGroup({
      layout: this.#blurH.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: a }, { binding: 1, resource: b }, ...buffers],
    });
    this.#blurVGroup = device.createBindGroup({
      layout: this.#blurV.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: b }, { binding: 1, resource: out }, ...buffers],
    });
    const pointEntries = [{ binding: 0, resource: a }, { binding: 1, resource: out }];
    this.#grayGroup = device.createBindGroup({ layout: this.#gray.getBindGroupLayout(0), entries: pointEntries });
    this.#sobelGroup = device.createBindGroup({ layout: this.#sobel.getBindGroupLayout(0), entries: pointEntries });
    this.setParams(this.#params);
  }

  static async create(device: GPUDevice, width: number, height: number): Promise<GpuFilter> {
    const compute = (code: string, entryPoint = 'main', constants?: Record<string, number>) =>
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint, constants } });
    const point = device.createShaderModule({ code: POINT_SHADER });
    const [ingestExternal, ingestTexture, blurH, blurV, gray, sobel] = await Promise.all([
      compute(INGEST_EXTERNAL),
      compute(INGEST_TEXTURE),
      compute(blurShader('rgba16float'), 'main', { horizontal: 1 }),
      compute(blurShader('rgba8unorm'), 'main', { horizontal: 0 }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: point, entryPoint: 'gray' } }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: point, entryPoint: 'sobel' } }),
    ]);
    return new GpuFilter(device, width, height, { ingestExternal, ingestTexture, blurH, blurV, gray, sobel });
  }

  setParams(params: FilterParams): void {
    this.#params = params;
    this.device.queue.writeBuffer(this.#weights, 0, gaussianWeights(params.radius) as GPUAllowSharedBufferSource);
    this.device.queue.writeBuffer(this.#radius, 0, new Uint32Array([params.radius]));
  }

  /** Records the ingest pass and the filter passes. `first` goes on the ingest pass. */
  encode(encoder: GPUCommandEncoder, source: IngestSource, first?: TimestampWrites): void {
    const dispatch = (pass: GPUComputePassEncoder) => pass.dispatchWorkgroups(Math.ceil(this.width / WG), Math.ceil(this.height / WG));
    const a = this.#a.createView();

    const ingest = encoder.beginComputePass({ timestampWrites: first });
    if (source.kind === 'external') {
      ingest.setPipeline(this.#ingestExternal);
      ingest.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.#ingestExternal.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: source.texture }, { binding: 1, resource: this.#sampler }, { binding: 2, resource: a }],
        }),
      );
    } else {
      ingest.setPipeline(this.#ingestTexture);
      ingest.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.#ingestTexture.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: source.view }, { binding: 2, resource: a }],
        }),
      );
    }
    dispatch(ingest);
    ingest.end();

    const run = (pipeline: GPUComputePipeline, group: GPUBindGroup) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      dispatch(pass);
      pass.end();
    };
    switch (this.#params.filter) {
      case 'blur':
        run(this.#blurH, this.#blurHGroup);
        run(this.#blurV, this.#blurVGroup);
        break;
      case 'sobel':
        run(this.#sobel, this.#sobelGroup);
        break;
      case 'grayscale':
        run(this.#gray, this.#grayGroup);
        break;
    }
  }

  dispose(): void {
    this.#a.destroy();
    this.#b.destroy();
    this.output.destroy();
    this.#weights.destroy();
    this.#radius.destroy();
  }
}
